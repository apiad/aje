// Settings, history and session state, kept as one JSON document in a backend:
// IndexedDB in the WebView (idb.js), memory in tests.
import { formatMoney, transferMatches } from "./sms.js";

/** How long after an operation its bank SMS still verifies it. */
export const WINDOW_MS = 20 * 60 * 1000;
const HISTORY = 50;
const SEEN = 50;

const ATTEMPT = {
  id: null, startedAt: null, code: "", state: "sent", op: "46", cardId: null, subId: null, to: null, amount: null,
  transactionId: null, reply: null, failureCode: null, accounting: null, available: null, verifiedAt: null,
};

export function memoryBackend(initial = null) {
  const backend = {
    saved: initial,
    async load() { return backend.saved === null ? null : structuredClone(backend.saved); },
    async save(doc) { backend.saved = structuredClone(doc); },
  };
  return backend;
}

export async function openStore(backend, { now = Date.now, newId = () => crypto.randomUUID() } = {}) {
  const loaded = await backend.load();
  const defaults = {
    settings: { subId: -1, plans: {}, lineNumbers: {}, telemetry: false, telemetryAsked: false, channel: "stable" },
    update: { checkedAt: null, available: null },
    cards: [], banks: {}, attempts: [], mobileBalances: {}, mobileDetails: {}, planMenus: {}, retryBalance: null, seenSms: [],
  };
  // A document written by an older build may lack newer keys; defaults fill them in.
  const state = { ...defaults, ...loaded, settings: { ...defaults.settings, ...loaded?.settings } };
  // Keys of the one-bank model, which stored cards replaced; nothing is migrated.
  for (const k of ["bank", "currency", "enabledCurrencies"]) delete state.settings[k];
  delete state.authenticatedAt;
  // Telemetry no longer carries an install id; an older build stored one.
  delete state.installId;
  const listeners = new Set();

  async function commit() {
    await backend.save(state);
    for (const fn of listeners) fn(state);
  }

  function pendingWhere(at, test) {
    return state.attempts.find((a) => a.state !== "verified" && at - a.startedAt < WINDOW_MS && test(a));
  }

  const store = {
    get state() { return state; },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    planFor: (subId) => state.settings.plans[subId] ?? "PREPAGO",

    async update(patch) {
      state.settings = { ...state.settings, ...patch };
      await commit();
    },

    /** Adds an attempt at the top of the history; a null id becomes one more than the largest. */
    async add(attempt) {
      const a = { ...ATTEMPT, ...attempt };
      if (a.id === null) a.id = Math.max(0, ...state.attempts.map((x) => x.id)) + 1;
      state.attempts = [a, ...state.attempts].slice(0, HISTORY);
      await commit();
      return a;
    },

    async patch(id, fn) {
      const i = state.attempts.findIndex((a) => a.id === id);
      if (i < 0) return;
      state.attempts[i] = fn(state.attempts[i]);
      await commit();
    },

    /** Verifies the latest pending balance query. Returns the latency, or null if none matched. */
    async verifyBalance(sms, at = now()) {
      const accounting = formatMoney(sms.accounting);
      const available = formatMoney(sms.available);
      const bankOf = (cardId) => state.cards.find((c) => c.id === cardId)?.bank;
      const pending = pendingWhere(at, (a) => a.op === "46" && bankOf(a.cardId) === sms.bank);
      if (!pending) {
        await store.add({ startedAt: at, state: "verified", op: "46", accounting, available, verifiedAt: at });
        return null;
      }
      await store.patch(pending.id, (a) => ({ ...a, state: "verified", accounting, available, verifiedAt: at }));
      return at - pending.startedAt;
    },

    /** Verifies the pending transfer this SMS confirms, by card and amount. Returns the latency, or null. */
    async verifyTransfer(sms, at = now()) {
      const pending = pendingWhere(at, (a) => a.op === "45" && a.to && a.amount && transferMatches(sms, a.to, a.amount * 100));
      if (!pending) return null;
      await store.patch(pending.id, (a) => ({
        ...a, state: "verified", transactionId: sms.transactionId,
        available: sms.remaining ? formatMoney(sms.remaining) : null, verifiedAt: at,
      }));
      return at - pending.startedAt;
    },

    /** Verifies the pending balance transfer to this number for this amount. Returns the latency, or null. */
    async verifyLineTransfer(sms, at = now()) {
      const pending = pendingWhere(at, (a) => a.op === "234" && a.to === sms.number && a.amount * 100 === sms.amount.cents);
      if (!pending) return null;
      await store.patch(pending.id, (a) => ({ ...a, state: "verified", verifiedAt: at }));
      return { latencyMs: at - pending.startedAt, subId: pending.subId };
    },

    /** Records balance another line passed to this one; `to` holds the sender's number. */
    addReceived(sms, at = now()) {
      return store.add({ startedAt: at, state: "verified", op: "234-in", to: sms.number, amount: sms.amount.cents / 100, verifiedAt: at });
    },

    /** The number of one of the phone's own lines, which the phone rarely knows. */
    async setLineNumber(subId, number) {
      state.settings = { ...state.settings, lineNumbers: { ...state.settings.lineNumbers, [subId]: number } };
      await commit();
    },

    async setMobileBalance(subId, value, details = null) {
      state.mobileBalances = { ...state.mobileBalances, [subId]: value };
      if (details) state.mobileDetails = { ...state.mobileDetails, [subId]: { ...details, at: now() } };
      await commit();
    },

    /** The last view read of a *133 menu level, keyed by its path joined with "*". */
    async setPlanMenu(key, view) {
      state.planMenus = { ...state.planMenus, [key]: view };
      await commit();
    },

    async setPlan(subId, plan) {
      state.settings = { ...state.settings, plans: { ...state.settings.plans, [subId]: plan } };
      await commit();
    },

    /** Adds a card, pending at the first step of its bank's onboarding. A number already stored is refused. */
    async addCard({ alias, pan, bank, currency }) {
      if (state.cards.some((c) => c.pan === pan)) throw new Error("Esta tarjeta ya está en tus cuentas.");
      const card = { id: newId(), alias, pan, bank, currency, state: "pending", step: 1 };
      state.cards = [...state.cards, card];
      await commit();
      return card;
    },

    async updateCard(id, patch) {
      state.cards = state.cards.map((c) => (c.id === id ? { ...c, ...patch } : c));
      await commit();
    },

    async removeCard(id) {
      state.cards = state.cards.filter((c) => c.id !== id);
      await commit();
    },

    /** When the app last asked GitHub for releases, and the update it found, if any. */
    async setUpdate(patch) {
      state.update = { ...state.update, ...patch };
      await commit();
    },

    /** Patches what the app knows of a bank: `{registered, authenticatedAt}`; `registered` is null while unknown. */
    async setBank(bank, patch) {
      state.banks = { ...state.banks, [bank]: { registered: null, authenticatedAt: null, ...state.banks[bank], ...patch } };
      await commit();
    },

    /** When the bank's "se ha autenticado" SMS last arrived. */
    // A session the bank opened proves the phone is registered with it.
    authenticated: (bank, at) => store.setBank(bank, { registered: true, authenticatedAt: at }),

    /** `{cardId, at}` while a login should rerun a balance query once its SMS arrives, else null. */
    async setRetryBalance(value) {
      state.retryBalance = value;
      await commit();
    },

    /** Records a delivery key; true if it was already seen. Keeps the last fifty. */
    async seen(key) {
      if (state.seenSms.includes(key)) return true;
      state.seenSms = [...state.seenSms, key].slice(-SEEN);
      await commit();
      return false;
    },
  };
  return store;
}
