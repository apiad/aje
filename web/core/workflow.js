// The bank operations the app runs, and what each bank SMS does to them.
import { randomSeed } from "./encoder.js";
import { MOBILE_PLANS, parseMobileBalance, parseMobileDetails, BANKS, last4 } from "./money.js";
import { associateClasica as associateClasicaCode, balance as balanceCode, clasicaBalance, clasicaMovements, clasicaTransfer, link as linkCode, login as loginCode, needsLogin, register as registerCode, registerMiTransfer as registerMiTransferCode, transfer as transferCode } from "./ops.js";
import { debtQuery as debtQueryCode, opOf, payBill as payBillCode } from "./bills.js";
import { chargeUri } from "./qr.js";
import { changeKey, transferBalance as transferBalanceCode } from "./lines.js";
import { planCode } from "./plans.js";
import { fnv1a, noticeOf } from "./notice.js";
import { BANKISH, formatMoney, parseBankSms, parseLineSms, parsePlanSms, senderTag } from "./sms.js";
import { WINDOW_MS } from "./store.js";
import { DEFAULT_CONFIG, dial, display } from "./ussd.js";

/** How long a remembered bank PIN lasts before the app asks for it again. */
export const PIN_DAYS = 180;

/** A bank reply that confirms op 49 or op 60. Only guesses until real replies are captured. */
const REGISTERED = /proces|satisfactori|registrad/i;
const LINKED = /asociad|vinculad|satisfactori/i;
const REFUSED = /error|incorrect|no se pudo|denegad/i;
const ALREADY_AUTH = /ya se encuentra autenticad/i;
/** How far back settle reads the SMS inbox; the shell never reads further. */
export const SETTLE_MS = 72 * 60 * 60 * 1000;

export function createWorkflow({ bridge, store, telemetry, now = Date.now, seed = randomSeed, config = DEFAULT_CONFIG }) {
  const settings = () => store.state.settings;
  const cardOf = (id) => {
    const c = store.state.cards.find((x) => x.id === id);
    if (!c) throw new RangeError(`no card ${id}`);
    return c;
  };
  /** The bank whose login a card's operations need: its own, or MiTransfer for a Clásica. */
  const sessionOf = (bank) => BANKS[bank]?.session ?? bank;
  const authenticatedAt = (bank) => store.state.banks[bank]?.authenticatedAt ?? null;
  const current = (id) => store.state.attempts.find((a) => a.id === id);

  /** Sends a USSD on the chosen SIM and reports the reply; the result is the bridge's. */
  async function send(op, subId, code, redact = []) {
    const start = now();
    let r;
    try {
      r = await bridge.sendUssd(subId, code);
    } catch (e) {
      // The shell refused the call (a malformed code, an exception): the same code Ussd.kt uses.
      r = { ok: false, failureCode: -100, error: e.message };
    }
    if (r.ok) {
      // A reply to op 49 may echo the person's name: the names never reach telemetry.
      const text = redact.filter(Boolean).reduce((s, v) => s.replaceAll(v, "…"), r.reply);
      telemetry.event("ussd_reply", { op, ok: true, length: r.reply.length, latency_ms: now() - start, text });
    } else {
      telemetry.event("ussd_reply", { op, ok: false, failure_code: r.failureCode, error: r.error });
    }
    return r;
  }

  async function balance(cardId, { viaDialer = false } = {}) {
    const card = cardOf(cardId);
    const ussd = card.bank === "CLASICA" ? clasicaBalance(card) : balanceCode(card);
    const s = seed();
    const attempt = await store.add({
      id: null, startedAt: now(), code: display(ussd, config, s), state: viaDialer ? "dialer" : "sent", op: "46", cardId,
    });
    telemetry.event("ussd_sent", { op: "46", bank: card.bank, via: viaDialer ? "dialer" : "api" });
    if (viaDialer) {
      await bridge.dial(dial(ussd, config, s));
      return { attempt, needsLogin: false };
    }
    const r = await send("46", settings().subId, dial(ussd, config, s));
    if (!r.ok) {
      await store.patch(attempt.id, (a) => (a.state === "verified" ? a : { ...a, state: "failed", failureCode: r.failureCode }));
      return { attempt: current(attempt.id), needsLogin: false };
    }
    // The bank's SMS may have verified the attempt before this reply landed: keep it verified.
    await store.patch(attempt.id, (a) => (a.state === "verified" ? { ...a, reply: r.reply } : { ...a, state: "replied", reply: r.reply }));
    const lost = needsLogin(r.reply);
    if (lost) {
      const since = authenticatedAt(sessionOf(card.bank));
      telemetry.event("session_lost", { op: "46", bank: card.bank, age_ms: since === null ? null : now() - since });
    }
    return { attempt: current(attempt.id), needsLogin: lost };
  }
  /** Op 47: asks the bank what a saved bill owes; the answer is the bank's reply, kept on the attempt. */
  const debtQuery = (billId) => payBill(billId, { debt: true });

  /**
   * Sends op 40 with the key. The key goes into the dialed string only and nothing here keeps it.
   * With `retryCardId`, the bank's "se ha autenticado" SMS reruns that card's balance query.
   */
  // The bank of the last login sent, for the bank's "ya se encuentra autenticado" SMS, which names none.
  let lastLogin = null;

  async function login(bank, pin, { retryCardId = null, remember = false } = {}) {
    lastLogin = { bank, at: now() };
    if (retryCardId) await store.setRetryBalance({ cardId: retryCardId, at: now() });
    telemetry.event("ussd_sent", { op: "40", bank, via: "api" });
    const r = await send("40", settings().subId, dial(loginCode(bank, pin), config, seed()));
    if (!r.ok) {
      await store.setRetryBalance(null);
      return { ok: false, failureCode: r.failureCode };
    }
    const remembered = remember && bridge.secretSave ? await bridge.secretSave(pinName(bank), pin, PIN_DAYS).catch(() => false) : false;
    // A MiTransfer reply that does not refuse the login opens the session, unless it says to wait for
    // the SMS, as phones have seen it do: then that SMS opens it and reruns the balance (handleSms).
    // Any bank's reply that the session is already open opens it too: no SMS follows that one.
    const confirms = BANKS[bank]?.replyConfirmsLogin && !REFUSED.test(r.reply) && !/debe autentic|no es posible|espere un sms/i.test(r.reply);
    if (confirms || ALREADY_AUTH.test(r.reply)) {
      await store.authenticated(bank, now());
      const retry = store.state.retryBalance;
      if (retry) {
        await store.setRetryBalance(null);
        await balance(retry.cardId);
      }
    }
    return { ok: true, reply: r.reply, remembered };
  }

  /**
   * The bank PIN can live in the shell's secret store: encrypted with a device key that needs the
   * fingerprint or the screen lock on every use, and dropped after PIN_DAYS. Nothing else keeps it.
   */
  const pinName = (bank) => `pin:${bank}`;
  async function savedPin(bank) {
    if (!bridge.secretStatus) return { available: false, saved: false, expiresAt: null };
    return bridge.secretStatus(pinName(bank)).catch(() => ({ available: false, saved: false, expiresAt: null }));
  }
  /** Logs in with the saved PIN once the device unlocks it; null when there is none or the person cancels. */
  async function loginWithSaved(bank, options = {}) {
    const pin = bridge.secretLoad ? await bridge.secretLoad(pinName(bank)).catch(() => null) : null;
    return pin ? login(bank, pin, options) : null;
  }
  const forgetPin = (bank) => bridge.secretForget?.(pinName(bank));

  /**
   * Op 49: registers the phone with a bank. Name, surnames and carné go into the dialed string
   * only; nothing here keeps them. A confirming reply marks the bank registered.
   */
  async function registerBank(bank, person) {
    telemetry.event("ussd_sent", { op: "49", bank, via: "api" });
    const r = await send("49", settings().subId, dial(registerCode(bank, person), config, seed()),
      [person.name, person.surname1, person.surname2]);
    if (!r.ok) return { ok: false, failureCode: r.failureCode };
    const ok = REGISTERED.test(r.reply) && !REFUSED.test(r.reply);
    if (ok) await store.setBank(bank, { registered: true });
    return { ok, reply: r.reply };
  }

  /**
   * Op 49 for MiTransfer: the carné and the chosen key go into the dialed string only; the key is
   * a secret field, and the carné is kept out of telemetry. A confirming reply marks it registered.
   */
  async function registerMiTransfer(ci, pin) {
    telemetry.event("ussd_sent", { op: "49", bank: "MITRANSFER", via: "api" });
    const r = await send("49", settings().subId, dial(registerMiTransferCode({ ci, pin }), config, seed()), [ci]);
    if (!r.ok) return { ok: false, failureCode: r.failureCode };
    const ok = REGISTERED.test(r.reply) && !REFUSED.test(r.reply);
    if (ok) await store.setBank("MITRANSFER", { registered: true });
    return { ok, reply: r.reply };
  }

  /**
   * Op 60: links a card to its bank. The bank applies it to the session the last op 40 opened,
   * so it is sent only while that login is recent. The coordinate value is dialed, never kept.
   */
  async function linkCard(cardId, coordinate, value) {
    const card = cardOf(cardId);
    const at = authenticatedAt(card.bank);
    if (at === null || now() - at > WINDOW_MS) return { ok: false, needsLogin: true };
    telemetry.event("ussd_sent", { op: "60", bank: card.bank, via: "api" });
    const r = await send("60", settings().subId, dial(linkCode(card.bank, card.pan, coordinate, value), config, seed()));
    if (!r.ok) return { ok: false, failureCode: r.failureCode };
    if (needsLogin(r.reply)) return { ok: false, needsLogin: true, reply: r.reply };
    const ok = LINKED.test(r.reply) && !REFUSED.test(r.reply);
    if (ok) await store.updateCard(cardId, { state: "linked", step: 5 });
    return { ok, reply: r.reply };
  }

  /**
   * Dials op 45. The transfer ends in the bank's menu, where the person types 1 to confirm,
   * so it goes through the system dialer; the bank's transfer SMS verifies it.
   */
  async function transfer(cardId, toPan, amount) {
    const card = cardOf(cardId);
    const ussd = card.bank === "CLASICA" ? clasicaTransfer(card, toPan, amount) : transferCode(card, toPan, amount);
    const s = seed();
    const attempt = await store.add({
      id: null, startedAt: now(), code: display(ussd, config, s), state: "dialer", op: "45", cardId, to: toPan, amount,
    });
    telemetry.event("ussd_sent", { op: "45", bank: card.bank, via: "dialer" });
    try {
      await bridge.dial(dial(ussd, config, s));
    } catch (e) {
      // The dialer never opened (no call permission, no dialer): nothing can have been sent.
      await store.patch(attempt.id, (a) => ({ ...a, state: "failed", failureCode: -100 }));
      telemetry.event("ussd_reply", { op: "45", ok: false, failure_code: -100, error: e.message });
    }
    return current(attempt.id);
  }

  /**
   * Pays a saved bill from its card, on the chosen SIM: a Nauta recharge goes through with no menu.
   * When the bank answers with a menu the API cannot follow, the code goes to the dialer, where the
   * person answers it. `needsLogin` says the bank wants a session first; nothing was paid then.
   */
  async function payBill(billId, { debt = false } = {}) {
    const bill = store.state.bills.find((b) => b.id === billId);
    if (!bill) throw new RangeError(`no bill ${billId}`);
    const card = cardOf(bill.cardId);
    const ussd = debt ? debtQueryCode(bill) : payBillCode(bill, card);
    const op = debt ? "47" : opOf(bill);
    const s = seed();
    const attempt = await store.add({
      id: null, startedAt: now(), code: display(ussd, config, s), state: "sent", op, cardId: card.id, billId, kind: bill.kind, alias: bill.alias,
      to: bill.kind === "nauta" ? bill.number : null, amount: bill.kind === "nauta" ? bill.amount : null, debt,
    });
    telemetry.event("ussd_sent", { op, bank: card.bank, via: "api", kind: bill.kind });
    const r = await send(op, settings().subId, dial(ussd, config, s));
    if (!r.ok && r.failureCode === -1) {
      telemetry.event("ussd_sent", { op, bank: card.bank, via: "dialer", kind: bill.kind });
      try {
        await bridge.dial(dial(ussd, config, s));
        await store.patch(attempt.id, (a) => (a.state === "verified" ? a : { ...a, state: "dialer" }));
      } catch (e) {
        // The dialer never opened (no call permission, no dialer): nothing can have been sent.
        await store.patch(attempt.id, (a) => ({ ...a, state: "failed", failureCode: -100 }));
        telemetry.event("ussd_reply", { op, ok: false, failure_code: -100, error: e.message });
      }
      return { attempt: current(attempt.id), needsLogin: false };
    }
    if (!r.ok) {
      await store.patch(attempt.id, (a) => (a.state === "verified" ? a : { ...a, state: "failed", failureCode: r.failureCode }));
      return { attempt: current(attempt.id), needsLogin: false };
    }
    const lost = needsLogin(r.reply);
    // The bank's SMS may have verified it before this reply landed: keep it verified.
    await store.patch(attempt.id, (a) => (a.state === "verified" ? { ...a, reply: r.reply } : { ...a, state: lost ? "failed" : "replied", reply: r.reply }));
    return { attempt: current(attempt.id), needsLogin: lost };
  }

  /**
   * Op 111: associates a Clásica with the authorization number and terminal id from an ATM/POS
   * receipt. Both are dialed only; nothing here keeps them. A confirming reply marks it associated.
   */
  async function associateClasica(cardId, authorization, terminal) {
    const card = cardOf(cardId);
    telemetry.event("ussd_sent", { op: "111", bank: card.bank, via: "api" });
    const r = await send("111", settings().subId, dial(associateClasicaCode(card.pan, authorization, terminal), config, seed()));
    if (!r.ok) return { ok: false, failureCode: r.failureCode };
    // 111 runs on a MiTransfer session: without one the service answers "Debe autenticarse".
    if (needsLogin(r.reply)) return { ok: false, needsLogin: true, reply: r.reply };
    // 111 is accepted like a registration: the service answers "procesada" and confirms by SMS.
    const ok = REGISTERED.test(r.reply) && !REFUSED.test(r.reply);
    if (ok) await store.updateCard(cardId, { state: "associated", step: 5 });
    return { ok, reply: r.reply };
  }

  /** Op 48: a Clásica's last operations. The reply is shown as it comes; no SMS verifies it. */
  async function movements(cardId) {
    const card = cardOf(cardId);
    const ussd = clasicaMovements(card);
    const s = seed();
    const attempt = await store.add({ id: null, startedAt: now(), code: display(ussd, config, s), state: "sent", op: "48", cardId });
    telemetry.event("ussd_sent", { op: "48", bank: card.bank, via: "api" });
    const r = await send("48", settings().subId, dial(ussd, config, s));
    if (!r.ok) {
      await store.patch(attempt.id, (a) => ({ ...a, state: "failed", failureCode: r.failureCode }));
      return { ok: false, failureCode: r.failureCode };
    }
    await store.patch(attempt.id, (a) => ({ ...a, state: "replied", reply: r.reply }));
    return { ok: true, reply: r.reply };
  }

  /** Asks a line for its balance with its plan's code, and keeps the figure for its card. */
  async function mobileBalance(subId) {
    const code = MOBILE_PLANS[store.planFor(subId)];
    const op = code.slice(1, -1);
    telemetry.event("ussd_sent", { op, via: "api" });
    const r = await send(op, subId, code);
    if (!r.ok) return { ok: false, failureCode: r.failureCode };
    const value = parseMobileBalance(r.reply);
    if (value) await store.setMobileBalance(subId, value, parseMobileDetails(r.reply));
    return { ok: true, value, reply: r.reply };
  }

  /** Reads a line's balance again after an operation that moved it; a failure keeps the old figure. */
  async function refreshBalance(subId) {
    try {
      await mobileBalance(subId);
    } catch {
      // The figure on the card stays as it was.
    }
  }

  /**
   * The transfer key of a line lives in the shell's secret store like the bank PIN, one per line,
   * behind the fingerprint or the screen lock, and lapses after PIN_DAYS.
   */
  const lineKeyName = (subId) => `line-key:${subId}`;
  async function savedLineKey(subId) {
    if (!bridge.secretStatus) return { available: false, saved: false, expiresAt: null };
    return bridge.secretStatus(lineKeyName(subId)).catch(() => ({ available: false, saved: false, expiresAt: null }));
  }
  const forgetLineKey = (subId) => bridge.secretForget?.(lineKeyName(subId));

  /**
   * `*234*1`: passes `amount` CUP of line `subId` to `to`. The network answers with a menu that asks
   * to confirm with 1, which the USSD API cannot follow, so it goes through the dialer; Cubacel's
   * SMS verifies it. Without a key it unlocks the saved one; with none saved, or the unlock
   * cancelled, it dials nothing and answers "needs-key". The dialer hides the network's answer, so a
   * remembered key is kept once dialed, and the result sheet offers to forget it.
   */
  async function transferBalance(subId, to, amount, { key = null, remember = false } = {}) {
    const k = key === null ? (bridge.secretLoad ? await bridge.secretLoad(lineKeyName(subId)).catch(() => null) : null) : key;
    if (!k) return { ok: false, outcome: "needs-key", attempt: null, remembered: false };
    const ussd = transferBalanceCode(to, k, amount);
    const attempt = await store.add({ id: null, startedAt: now(), code: display(ussd, config), state: "dialer", op: "234", subId, to, amount });
    telemetry.event("ussd_sent", { op: "234*1", via: "dialer" });
    try {
      await bridge.dial(dial(ussd, config));
    } catch (e) {
      // The dialer never opened (no call permission, no dialer): nothing can have been sent.
      await store.patch(attempt.id, (a) => ({ ...a, state: "failed", failureCode: -100 }));
      telemetry.event("ussd_reply", { op: "234*1", ok: false, failure_code: -100, error: e.message });
      return { ok: false, outcome: "failed", attempt: current(attempt.id), remembered: false };
    }
    const remembered = key !== null && remember && bridge.secretSave
      ? await bridge.secretSave(lineKeyName(subId), k, PIN_DAYS).catch(() => false) : false;
    return { ok: true, outcome: "dialer", attempt: current(attempt.id), remembered };
  }

  /**
   * `*234*2`: changes a line's transfer key, and the saved one with it when one is saved. When the
   * API cannot follow the network's menu (-1), it goes to the dialer, and the saved key is dropped
   * since Ajé cannot see whether the change went through.
   */
  async function changeLineKey(subId, old, next) {
    telemetry.event("ussd_sent", { op: "234*2", via: "api" });
    const code = dial(changeKey(old, next), config);
    const r = await send("234*2", subId, code);
    if (!r.ok && r.failureCode === -1) {
      await forgetLineKey(subId);
      telemetry.event("ussd_sent", { op: "234*2", via: "dialer" });
      await bridge.dial(code).catch(() => null);
      return { ok: false, dialed: true };
    }
    if (!r.ok) return { ok: false, failureCode: r.failureCode };
    const ok = /cambiad|satisfactori|exito|éxito/i.test(r.reply) && !/incorrect/i.test(r.reply);
    if (ok && (await savedLineKey(subId)).saved) await bridge.secretSave(lineKeyName(subId), next, PIN_DAYS).catch(() => false);
    return { ok, reply: r.reply };
  }

  /**
   * Buys `plan` from the catalog: its shortcut goes to the dialer, which shows Cubacel's confirm, and
   * the person types 1 there. The API cannot follow these menus (-1); Cubacel's SMS after the
   * purchase confirms it and carries the line's new balance.
   */
  async function buyPlan(subId, plan) {
    const code = planCode(plan);
    const attempt = await store.add({
      id: null, startedAt: now(), code, state: "dialer", op: "133", subId,
      plan: { path: plan.path, name: plan.name, price: plan.price },
    });
    telemetry.event("ussd_sent", { op: "133", via: "dialer" });
    try {
      await bridge.dial(code);
    } catch {
      await store.patch(attempt.id, (a) => ({ ...a, state: "failed", failureCode: -100 }));
      return { outcome: "failed", attempt: current(attempt.id) };
    }
    return { outcome: "dialer", attempt: current(attempt.id) };
  }

  /** A charge to line `subId`: its QR text and the pending attempt the "recibido" SMS will close. */
  async function charge(subId, { amount = null, name = null } = {}) {
    const number = store.state.settings.lineNumbers[subId];
    if (!number) return { ok: false, reason: "no-number" };
    const attempt = await store.addCharge({ subId, number, amount, name });
    return { ok: true, uri: chargeUri({ number, amount, name }), attempt };
  }

  /** Today's balance transfers from a line that did not fail; the network caps them per day. */
  function transfersToday(subId) {
    const midnight = new Date(now()).setHours(0, 0, 0, 0);
    return store.state.attempts.filter((a) => a.op === "234" && a.subId === subId && a.state !== "failed" && a.startedAt >= midnight).length;
  }

  /** One incoming SMS. Texts the parser does not know are dropped here and never stored. */
  async function handleSms({ sender, body, sentAt = null, receivedAt = now(), subId = null }) {
    const tag = senderTag(sender);
    const line = parseLineSms(body);
    if (line) return handleLineSms(line, { sender, tag, body, sentAt, receivedAt });
    const plan = parsePlanSms(body);
    // A person's number can write the same text; only Cubacel's sender confirms a purchase.
    if (plan && tag !== "number") return handlePlanSms({ ...plan, subId }, { tag, body, sentAt, receivedAt });
    // A login while the session is still open: the bank answers that it already is, naming no bank.
    if (tag !== "number" && ALREADY_AUTH.test(body) && lastLogin && receivedAt - lastLogin.at < WINDOW_MS) {
      if (await store.seen(`${sentAt ?? receivedAt}:${fnv1a(body)}`)) return null;
      await sessionOpened(lastLogin.bank, receivedAt, { sender: tag, bank: lastLogin.bank, text: body });
      return { kind: "auth", bank: lastLogin.bank };
    }
    const sms = parseBankSms(body);
    if (!sms) {
      const notice = noticeOf(sender, body);
      if (notice) return handleNotice(notice, { body, sentAt, receivedAt });
      // Any service sender's text the parser does not know is reported, once: settle skips it later.
      if (tag !== "number" || BANKISH.test(body)) {
        if (tag !== "number" && (await store.seen(`${sentAt ?? receivedAt}:${fnv1a(body)}`))) return null;
        reportUnparsed(tag, body);
      }
      return null;
    }
    // The native queue and the live push, or a repeated broadcast, can deliver the same text
    // twice. The SMSC's timestamp and the text identify it; the arrival time differs per broadcast.
    if (await store.seen(`${sentAt ?? receivedAt}:${fnv1a(body)}`)) return sms;
    const base = { sender: tag, bank: sms.bank, text: body };
    switch (sms.kind) {
      case "balance": {
        const latency = await store.verifyBalance(sms, receivedAt);
        telemetry.event("sms", { kind: "balance", ...base, latency_ms: latency });
        break;
      }
      case "balance-failed": {
        const failed = await store.failBalance(sms, receivedAt);
        telemetry.event("sms", { kind: "balance_failed", ...base, ok: failed !== null });
        // An imported card the bank refuses is not linked to this line after all: it links again.
        const card = failed && store.state.cards.find((c) => c.id === failed.cardId);
        if (card?.unverified) await store.updateCard(card.id, { state: "pending", unverified: false });
        break;
      }
      case "transfer": {
        const latency = await store.verifyTransfer(sms, receivedAt);
        telemetry.event("sms", { kind: "transfer", ...base, ok: latency !== null, latency_ms: latency });
        break;
      }
      case "auth":
        await sessionOpened(sms.bank, receivedAt, base);
        break;
      case "nauta": {
        const latency = await store.verifyNauta(sms, receivedAt);
        telemetry.event("sms", { kind: "nauta", ...base, ok: latency !== null, latency_ms: latency });
        break;
      }
    }
    return sms;
  }

  function reportUnparsed(tag, body, via = null) {
    telemetry.event("sms", { kind: "unparsed_bank", sender: tag, via, length: body.length, lines: body.split("\n").length, text: body });
  }

  /**
   * Settles the history with the service SMS of the last 72 hours (issue #28). An SMS Ajé already
   * handled is skipped. Any other one confirms the unverified operation it matches, as if it had
   * arrived live, but adds no row, opens no session and gives no notice. One the parser does not
   * know goes to telemetry, redacted, while it is on. Both are remembered, so a second run skips
   * them. Returns how many SMS it read, verified and reported.
   */
  async function settle() {
    const list = await bridge.readSms(now() - SETTLE_MS);
    const result = { read: list.length, verified: 0, reported: 0 };
    for (const { sender, body, sentAt = null, receivedAt, subId = null } of list) {
      const tag = senderTag(sender);
      const key = `${sentAt ?? receivedAt}:${fnv1a(body)}`;
      if (tag === "number" || store.state.seenSms.includes(key)) continue;
      const known = await settleOne({ sender, body, receivedAt, subId });
      if (known === "verified") result.verified++;
      if (known === "unknown") {
        if (!settings().telemetry) continue;
        reportUnparsed(tag, body, "inbox");
        result.reported++;
      }
      await store.seen(key);
    }
    return result;
  }

  /** "verified" when the SMS confirmed an operation, "known" when the parser knows it, else "unknown". */
  async function settleOne({ sender, body, receivedAt: at, subId }) {
    const line = parseLineSms(body);
    if (line) return line.kind === "line-sent" && (await store.verifyLineTransfer(line, at)) ? "verified" : "known";
    const plan = parsePlanSms(body);
    if (plan) return (await store.verifyPlan({ ...plan, subId }, at)) ? "verified" : "known";
    const sms = parseBankSms(body);
    if (!sms) return noticeOf(sender, body) || ALREADY_AUTH.test(body) ? "known" : "unknown";
    // A refusal closes its query as failed: settled, but not verified.
    if (sms.kind === "balance-failed") {
      await store.failBalance(sms, at);
      return "known";
    }
    const verify = {
      balance: () => store.verifyBalance(sms, at, { add: false }),
      transfer: () => store.verifyTransfer(sms, at),
      nauta: () => store.verifyNauta(sms, at),
    }[sms.kind];
    return verify && (await verify()) !== null ? "verified" : "known";
  }

  /** A bank's session is open: note it, and rerun the balance query that asked for the login. */
  async function sessionOpened(bank, receivedAt, base) {
    await store.authenticated(bank, receivedAt);
    telemetry.event("sms", { kind: "auth", ...base });
    const retry = store.state.retryBalance;
    if (retry) {
      await store.setRetryBalance(null);
      // A queued SMS can be read hours later: rerun only while the login is recent.
      if (receivedAt - retry.at < WINDOW_MS && now() - retry.at < WINDOW_MS) await balance(retry.cardId);
    }
  }

  async function handlePlanSms(sms, { tag, body, sentAt, receivedAt }) {
    if (await store.seen(`${sentAt ?? receivedAt}:${fnv1a(body)}`)) return sms;
    const verified = await store.verifyPlan(sms, receivedAt);
    telemetry.event("sms", { kind: "plan", sender: tag, ok: verified !== null, latency_ms: verified?.latencyMs ?? null, text: body });
    if (verified && sms.balance) await store.setMobileBalance(verified.subId, sms.balance);
    else if (verified) await refreshBalance(verified.subId);
    return sms;
  }

  /** The inbox item of a notice; `row` is the history row it opens, if any. Telemetry gets only its kind. */
  async function addNotice(notice, id, row, at) {
    const { kind, amount, number, account, plan } = notice;
    if (await store.addNotice({ id, kind, at, amount, number, account, plan, rowId: row?.id ?? null, state: "pending" })) {
      telemetry.event("notice", { kind, ok: false });
    }
  }

  /** The person opened a notice: it is seen, and telemetry learns a notice of its kind was opened. */
  async function openNotice(id) {
    const n = store.state.inbox.find((x) => x.id === id);
    if (!n || n.state !== "pending") return;
    await store.setNoticeState(id, "seen");
    telemetry.event("notice", { kind: n.kind, ok: true });
  }

  /** The one saved card whose last four match the account a received transfer names, else null. */
  function cardOfAccount(account) {
    const cards = account ? store.state.cards.filter((c) => last4(c.pan) === last4(account)) : [];
    return cards.length === 1 ? cards[0].id : null;
  }

  /** Money or balance that came in: a history row, unless a plan only expires, and an inbox item. */
  async function handleNotice(notice, { body, sentAt, receivedAt }) {
    const id = `${sentAt ?? receivedAt}:${fnv1a(body)}`;
    if (store.state.inbox.some((n) => n.id === id) || (await store.seen(id))) return notice;
    const row = notice.kind === "plan-expiry" ? null : await store.addReceived(notice, receivedAt, { cardId: cardOfAccount(notice.account) });
    await addNotice(notice, id, row, receivedAt);
    return notice;
  }

  async function handleLineSms(sms, { sender, tag, body, sentAt, receivedAt }) {
    const id = `${sentAt ?? receivedAt}:${fnv1a(body)}`;
    if (await store.seen(id)) return sms;
    if (sms.kind === "line-sent") {
      const verified = await store.verifyLineTransfer(sms, receivedAt);
      telemetry.event("sms", { kind: sms.kind, sender: tag, ok: verified !== null, latency_ms: verified?.latencyMs ?? null, text: body });
      if (verified) await refreshBalance(verified.subId);
    } else {
      // A charge shown as a QR becomes the record of what arrived; otherwise the SMS gets its own row.
      const received = { kind: "line-received", amount: formatMoney(sms.amount), number: sms.number, account: null, plan: null };
      const row = (await store.closeCharge(sms, receivedAt)) ?? (await store.addReceived(received, receivedAt));
      // Only a service's sender gives a notice; a person's number can write the same text.
      if (noticeOf(sender, body)) await addNotice(received, id, row, receivedAt);
      telemetry.event("sms", { kind: sms.kind, sender: tag, ok: true, text: body });
    }
    return sms;
  }

  return { balance, login, loginWithSaved, savedPin, forgetPin, registerBank, registerMiTransfer, sessionOf, linkCard, associateClasica, movements, transfer, payBill, debtQuery, mobileBalance, refreshBalance, transferBalance, savedLineKey, forgetLineKey, changeLineKey, transfersToday, buyPlan, charge, handleSms, openNotice, settle };
}
