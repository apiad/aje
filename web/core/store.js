// Settings, history and session state, kept as one JSON document in a backend:
// IndexedDB in the WebView (idb.js), memory in tests.
import { CURRENCIES } from "./money.js";
import { formatMoney, transferMatches } from "./sms.js";

/** How long after an operation its bank SMS still verifies it. */
export const WINDOW_MS = 20 * 60 * 1000;
const HISTORY = 50;
const SEEN = 50;

const ATTEMPT = {
  id: null, startedAt: null, code: "", state: "sent", op: "46", currency: null, to: null, amount: null,
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
    settings: { subId: -1, bank: "METROPOLITANO", currency: "CUP", enabledCurrencies: ["CUP", "CUC", "USD"], plans: {}, telemetry: false },
    attempts: [], mobileBalances: {}, mobileDetails: {}, authenticatedAt: null, retryBalance: null, installId: null, seenSms: [],
  };
  // A document written by an older build may lack newer keys; defaults fill them in.
  const state = { ...defaults, ...loaded, settings: { ...defaults.settings, ...loaded?.settings } };
  const listeners = new Set();

  async function commit() {
    await backend.save(state);
    for (const fn of listeners) fn(state);
  }

  if (!state.installId) {
    state.installId = newId();
    await backend.save(state);
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
      const pending = pendingWhere(at, (a) => a.op === "46");
      if (!pending) {
        const currency = sms.available.currency in CURRENCIES ? sms.available.currency : null;
        await store.add({ startedAt: at, state: "verified", op: "46", currency, accounting, available, verifiedAt: at });
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

    async setMobileBalance(subId, value, details = null) {
      state.mobileBalances = { ...state.mobileBalances, [subId]: value };
      if (details) state.mobileDetails = { ...state.mobileDetails, [subId]: { ...details, at: now() } };
      await commit();
    },

    async setPlan(subId, plan) {
      state.settings = { ...state.settings, plans: { ...state.settings.plans, [subId]: plan } };
      await commit();
    },

    /** When the bank's "se ha autenticado" SMS last arrived. */
    async authenticated(at) {
      state.authenticatedAt = at;
      await commit();
    },

    /** `{currency, at}` while a login should rerun a balance query once its SMS arrives, else null. */
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
