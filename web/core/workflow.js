// The bank operations the app runs, and what each bank SMS does to them.
import { randomSeed } from "./encoder.js";
import { MOBILE_PLANS, parseMobileBalance, parseMobileDetails, BANKS } from "./money.js";
import { associateClasica as associateClasicaCode, balance as balanceCode, clasicaBalance, clasicaMovements, clasicaTransfer, link as linkCode, login as loginCode, needsLogin, register as registerCode, registerMiTransfer as registerMiTransferCode, transfer as transferCode } from "./ops.js";
import { changeKey, parseLineReply, transferBalance as transferBalanceCode } from "./lines.js";
import { BANKISH, parseBankSms, parseLineSms, senderTag } from "./sms.js";
import { WINDOW_MS } from "./store.js";
import { DEFAULT_CONFIG, dial, display } from "./ussd.js";

/** How long a remembered bank PIN lasts before the app asks for it again. */
export const PIN_DAYS = 180;

/** A bank reply that confirms op 49 or op 60. Only guesses until real replies are captured. */
const REGISTERED = /proces|satisfactori|registrad/i;
const LINKED = /asociad|vinculad|satisfactori/i;
const REFUSED = /error|incorrect|no se pudo|denegad/i;

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

  /**
   * Sends op 40 with the key. The key goes into the dialed string only and nothing here keeps it.
   * With `retryCardId`, the bank's "se ha autenticado" SMS reruns that card's balance query.
   */
  async function login(bank, pin, { retryCardId = null, remember = false } = {}) {
    if (retryCardId) await store.setRetryBalance({ cardId: retryCardId, at: now() });
    telemetry.event("ussd_sent", { op: "40", bank, via: "api" });
    const r = await send("40", settings().subId, dial(loginCode(bank, pin), config, seed()));
    if (!r.ok) {
      await store.setRetryBalance(null);
      return { ok: false, failureCode: r.failureCode };
    }
    const remembered = remember && bridge.secretSave ? await bridge.secretSave(pinName(bank), pin, PIN_DAYS).catch(() => false) : false;
    // MiTransfer sends no SMS for a login: a reply that does not refuse it opens the session.
    if (BANKS[bank]?.replyConfirmsLogin && !REFUSED.test(r.reply) && !/debe autentic|no es posible/i.test(r.reply)) {
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
   * `*234*1` over the USSD API: passes `amount` CUP of line `subId` to `to`. Without a key it
   * unlocks the saved one; with none saved, or the unlock cancelled, it sends nothing and answers
   * "needs-key". A reply that refuses the key drops the saved one.
   */
  async function transferBalance(subId, to, amount, { key = null, remember = false } = {}) {
    const saved = key === null;
    const k = saved ? (bridge.secretLoad ? await bridge.secretLoad(lineKeyName(subId)).catch(() => null) : null) : key;
    if (!k) return { ok: false, outcome: "needs-key", attempt: null, remembered: false };
    const ussd = transferBalanceCode(to, k, amount);
    const attempt = await store.add({ id: null, startedAt: now(), code: display(ussd, config), state: "sent", op: "234", subId, to, amount });
    telemetry.event("ussd_sent", { op: "234*1", via: "api" });
    const r = await send("234*1", subId, dial(ussd, config));
    if (!r.ok) {
      await store.patch(attempt.id, (a) => (a.state === "verified" ? a : { ...a, state: "failed", failureCode: r.failureCode }));
      return { ok: false, outcome: "failed", attempt: current(attempt.id), remembered: false };
    }
    const outcome = parseLineReply(r.reply);
    // A refusal moved no balance: it is failed, not waiting for an SMS that will never come.
    const refused = ["bad-key", "no-balance", "limit"].includes(outcome);
    await store.patch(attempt.id, (a) => (a.state === "verified" ? { ...a, reply: r.reply } : { ...a, state: refused ? "failed" : "replied", reply: r.reply }));
    if (outcome === "bad-key" && saved) await forgetLineKey(subId);
    const remembered = outcome === "ok" && remember && bridge.secretSave
      ? await bridge.secretSave(lineKeyName(subId), k, PIN_DAYS).catch(() => false) : false;
    return { ok: outcome === "ok", outcome, attempt: current(attempt.id), remembered };
  }

  /** `*234*2`: changes a line's transfer key, and the saved one with it when one is saved. */
  async function changeLineKey(subId, old, next) {
    telemetry.event("ussd_sent", { op: "234*2", via: "api" });
    const r = await send("234*2", subId, dial(changeKey(old, next), config));
    if (!r.ok) return { ok: false, failureCode: r.failureCode };
    const ok = /cambiad|satisfactori|exito|éxito/i.test(r.reply) && !/incorrect/i.test(r.reply);
    if (ok && (await savedLineKey(subId)).saved) await bridge.secretSave(lineKeyName(subId), next, PIN_DAYS).catch(() => false);
    return { ok, reply: r.reply };
  }

  /** Today's balance transfers from a line that did not fail; the network caps them per day. */
  function transfersToday(subId) {
    const midnight = new Date(now()).setHours(0, 0, 0, 0);
    return store.state.attempts.filter((a) => a.op === "234" && a.subId === subId && a.state !== "failed" && a.startedAt >= midnight).length;
  }

  /** One incoming SMS. Texts the parser does not know are dropped here and never stored. */
  async function handleSms({ sender, body, sentAt = null, receivedAt = now() }) {
    const tag = senderTag(sender);
    const line = parseLineSms(body);
    if (line) return handleLineSms(line, { tag, body, sentAt, receivedAt });
    const sms = parseBankSms(body);
    if (!sms) {
      if (BANKISH.test(body)) {
        telemetry.event("sms", { kind: "unparsed_bank", sender: tag, length: body.length, lines: body.split("\n").length, text: body });
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
      case "transfer": {
        const latency = await store.verifyTransfer(sms, receivedAt);
        telemetry.event("sms", { kind: "transfer", ...base, ok: latency !== null, latency_ms: latency });
        break;
      }
      case "auth": {
        await store.authenticated(sms.bank, receivedAt);
        telemetry.event("sms", { kind: "auth", ...base });
        const retry = store.state.retryBalance;
        if (retry) {
          await store.setRetryBalance(null);
          // A queued SMS can be read hours later: rerun only while the login is recent.
          if (receivedAt - retry.at < WINDOW_MS && now() - retry.at < WINDOW_MS) await balance(retry.cardId);
        }
        break;
      }
    }
    return sms;
  }

  async function handleLineSms(sms, { tag, body, sentAt, receivedAt }) {
    if (await store.seen(`${sentAt ?? receivedAt}:${fnv1a(body)}`)) return sms;
    if (sms.kind === "line-sent") {
      const latency = await store.verifyLineTransfer(sms, receivedAt);
      telemetry.event("sms", { kind: sms.kind, sender: tag, ok: latency !== null, latency_ms: latency, text: body });
    } else {
      await store.addReceived(sms, receivedAt);
      telemetry.event("sms", { kind: sms.kind, sender: tag, ok: true, text: body });
    }
    return sms;
  }

  return { balance, login, loginWithSaved, savedPin, forgetPin, registerBank, registerMiTransfer, sessionOf, linkCard, associateClasica, movements, transfer, mobileBalance, transferBalance, savedLineKey, forgetLineKey, changeLineKey, transfersToday, handleSms };
}

/** A 32-bit FNV-1a hash, so the seen list keeps no bank text. */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const c of text) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
