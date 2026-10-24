// Settings, history and session state, kept as one JSON document in a backend:
// IndexedDB in the WebView (idb.js), memory in tests.
import { formatMoney, transferMatches } from "./sms.js";

/** How long after an operation its bank SMS still verifies it. */
export const WINDOW_MS = 20 * 60 * 1000;
/** How long a plan bought in the dialer waits for Cubacel's SMS. */
const PLAN_MS = 30 * 60 * 1000;
/** How long a charge's QR waits for the payment that closes it. */
export const CHARGE_MS = 24 * 60 * 60 * 1000;
const HISTORY = 50;
// Every service SMS of the 72 hours settle reads back, with room to spare.
const SEEN = 500;
const INBOX = 200;
/** The history row each incoming kind leaves; an expiring plan leaves none. */
const RECEIVED_OPS = { "line-received": "234-in", "card-received": "in-card", "recharge-intl": "in-recharge", recharge: "in-recharge", "plan-gift": "in-plan" };

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
    cards: [], bills: [], banks: {}, attempts: [], mobileBalances: {}, mobileDetails: {}, planCatalog: null, retryBalance: null, seenSms: [], inbox: [],
    // What a Transfermóvil backup held that Ajé keeps for later: recipients, contracts, numbers.
    imported: null,
  };
  // A document written by an older build may lack newer keys; defaults fill them in.
  const state = { ...defaults, ...loaded, settings: { ...defaults.settings, ...loaded?.settings } };
  // Keys of the one-bank model, which stored cards replaced; nothing is migrated.
  for (const k of ["bank", "currency", "enabledCurrencies"]) delete state.settings[k];
  delete state.authenticatedAt;
  // Telemetry no longer carries an install id; an older build stored one.
  delete state.installId;
  // Levels of the *133 menu read over the API, which the plan catalog replaced.
  delete state.planMenus;
  const listeners = new Set();
  // An imported card is linked on trust until the bank serves it once (see trm.js and import.js).
  function confirmCard(cardId) {
    state.cards = state.cards.map((c) => (c.id === cardId && c.unverified ? { ...c, unverified: false } : c));
  }
  const current = (id) => state.attempts.find((a) => a.id === id) ?? null;

  async function commit() {
    await backend.save(state);
    for (const fn of listeners) fn(state);
  }

  function pendingWhere(at, test) {
    // An SMS read back from the inbox can be older than an operation; it never confirms a later one.
    return state.attempts.find((a) => a.state !== "verified" && at >= a.startedAt && at - a.startedAt < WINDOW_MS && test(a));
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

    /**
     * Verifies the latest pending balance query. Returns the latency, or null if none matched; then a
     * balance from Transfermóvil gets its own row, unless `add` is false.
     */
    async verifyBalance(sms, at = now(), { add = true } = {}) {
      const accounting = formatMoney(sms.accounting);
      const available = formatMoney(sms.available);
      const bankOf = (cardId) => state.cards.find((c) => c.id === cardId)?.bank;
      const pending = pendingWhere(at, (a) => a.op === "46" && bankOf(a.cardId) === sms.bank);
      if (!pending) {
        if (!add) return null;
        await store.add({ startedAt: at, state: "verified", op: "46", accounting, available, verifiedAt: at });
        return null;
      }
      confirmCard(pending.cardId);
      await store.patch(pending.id, (a) => ({ ...a, state: "verified", accounting, available, verifiedAt: at }));
      return at - pending.startedAt;
    },

    /** Fails the latest pending balance query of this bank, which the bank refused. Returns it, or null. */
    async failBalance(sms, at = now()) {
      const bankOf = (cardId) => state.cards.find((c) => c.id === cardId)?.bank;
      const pending = pendingWhere(at, (a) => a.op === "46" && bankOf(a.cardId) === sms.bank);
      if (!pending) return null;
      await store.patch(pending.id, (a) => ({ ...a, state: "failed" }));
      return current(pending.id);
    },

    /** Verifies the pending transfer this SMS confirms, by card and amount. Returns the latency, or null. */
    async verifyTransfer(sms, at = now()) {
      const pending = pendingWhere(at, (a) => a.op === "45" && a.to && a.amount && transferMatches(sms, a.to, a.amount * 100));
      if (!pending) return null;
      confirmCard(pending.cardId);
      await store.patch(pending.id, (a) => ({
        ...a, state: "verified", transactionId: sms.transactionId,
        available: sms.remaining ? formatMoney(sms.remaining) : null, verifiedAt: at,
      }));
      return at - pending.startedAt;
    },

    /** Verifies the pending Nauta payment to this account for this amount. Returns the latency, or null. */
    async verifyNauta(sms, at = now()) {
      const pending = pendingWhere(at, (a) => a.kind === "nauta" && a.billId && a.to === sms.user && a.amount * 100 === sms.amount.cents);
      if (!pending) return null;
      confirmCard(pending.cardId);
      await store.patch(pending.id, (a) => ({ ...a, state: "verified", transactionId: sms.transactionId, verifiedAt: at }));
      return at - pending.startedAt;
    },

    /** Verifies the pending balance transfer to this number for this amount. Returns the latency, or null. */
    async verifyLineTransfer(sms, at = now()) {
      const pending = pendingWhere(at, (a) => a.op === "234" && a.to === sms.number && a.amount * 100 === sms.amount.cents);
      if (!pending) return null;
      await store.patch(pending.id, (a) => ({ ...a, state: "verified", verifiedAt: at }));
      return { latencyMs: at - pending.startedAt, subId: pending.subId };
    },

    /**
     * Confirms a plan bought in the dialer in the last 30 minutes with Cubacel's SMS, on the SIM it came
     * in on when the shell says: the newest one of the SMS's price, else the only one waiting, since
     * the network's price may differ from the catalog's. The balance the SMS reported goes with it.
     */
    async verifyPlan(sms, at = now()) {
      const waiting = state.attempts.filter((a) => a.op === "133" && a.state === "dialer" && at - a.startedAt < PLAN_MS && at >= a.startedAt &&
        (sms.subId === null || sms.subId === undefined || a.subId === sms.subId)).sort((x, y) => y.startedAt - x.startedAt);
      const p = waiting.find((a) => Math.round((a.plan?.price ?? -1) * 100) === sms.price.cents) ?? (waiting.length === 1 ? waiting[0] : null);
      if (!p) return null;
      await store.patch(p.id, (a) => ({ ...a, state: "verified", verifiedAt: at, balance: sms.balance }));
      return { latencyMs: at - p.startedAt, subId: p.subId };
    },

    /** A charge shown as a QR, waiting for the payer's balance to arrive. `to` is this line's number. */
    addCharge({ subId, number, amount = null, name = null }, at = now()) {
      return store.add({ id: null, startedAt: at, state: "waiting", op: "234-charge", subId, to: number, amount, name });
    },

    /**
     * Closes the newest charge still waiting from the last 24 hours with a "recibido" SMS, whatever
     * its amount, since the payer may change it; null when none waits.
     */
    async closeCharge(sms, at = now()) {
      const c = state.attempts.find((a) => a.op === "234-charge" && a.state === "waiting" && at - a.startedAt < CHARGE_MS && at >= a.startedAt);
      if (!c) return null;
      await store.patch(c.id, (a) => ({ ...a, state: "verified", verifiedAt: at, receivedAmount: sms.amount.cents / 100, from: sms.number }));
      return state.attempts.find((a) => a.id === c.id);
    },

    /**
     * Records what a notice says came in (noticeOf): `to` holds the sender's number, `amount` and
     * `currency` the money, `account` the account a transfer named and `cardId` the card it matched.
     */
    addReceived(notice, at = now(), { cardId = null } = {}) {
      const [figure, currency] = notice.amount?.split(" ") ?? [null, null];
      return store.add({ startedAt: at, state: "verified", op: RECEIVED_OPS[notice.kind], to: notice.number, cardId,
        amount: figure === null ? null : Number(figure), currency, account: notice.account, plan: notice.plan, verifiedAt: at });
    },

    /** Adds a notice at the top of the inbox, which keeps the newest 200; false when its id is there. */
    async addNotice(item) {
      if (state.inbox.some((n) => n.id === item.id)) return false;
      state.inbox = [item, ...state.inbox].slice(0, INBOX);
      await commit();
      return true;
    },

    /** Moves a notice to "pending", "seen" or "dismissed". */
    async setNoticeState(id, value) {
      state.inbox = state.inbox.map((n) => (n.id === id ? { ...n, state: value } : n));
      await commit();
    },

    pendingNotices: () => state.inbox.filter((n) => n.state === "pending").length,

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

    /** The newest plan catalog read from aje.apiad.net, already validated. */
    async setPlanCatalog(catalog) {
      state.planCatalog = catalog;
      await commit();
    },

    /** Keeps what a backup held (see readBackup in trm.js), replacing an earlier import whole. */
    async saveImported({ exportedAt, recipients, bills, onat, phones, landlines, nauta }) {
      state.imported = { at: now(), exportedAt, recipients, bills, onat, phones, landlines, nauta };
      await commit();
    },

    async setPlan(subId, plan) {
      state.settings = { ...state.settings, plans: { ...state.settings.plans, [subId]: plan } };
      await commit();
    },

    /** Saves a bill or service account to pay later: `kind`, `alias`, `number`, `cardId`, and per kind `region`, `nautaType`, `amount`. */
    async saveBill(bill) {
      const saved = { ...bill, id: bill.id ?? newId() };
      if (state.bills.some((b) => b.id !== saved.id && b.kind === saved.kind && b.number === saved.number)) {
        throw new Error("Esa cuenta ya está guardada.");
      }
      state.bills = state.bills.some((b) => b.id === saved.id) ? state.bills.map((b) => (b.id === saved.id ? saved : b)) : [...state.bills, saved];
      await commit();
      return saved;
    },

    async removeBill(id) {
      state.bills = state.bills.filter((b) => b.id !== id);
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

    /** Records a delivery key; true if it was already seen. Keeps the last 500. */
    async seen(key) {
      if (state.seenSms.includes(key)) return true;
      state.seenSms = [...state.seenSms, key].slice(-SEEN);
      await commit();
      return false;
    },
  };
  return store;
}
