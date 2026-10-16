// The bank operations the app runs, and what each bank SMS does to them.
import { randomSeed } from "./encoder.js";
import { MOBILE_PLANS, parseMobileBalance } from "./money.js";
import { balance as balanceCode, login as loginCode, needsLogin, transfer as transferCode } from "./ops.js";
import { BANKISH, parseBankSms, senderTag } from "./sms.js";
import { WINDOW_MS } from "./store.js";
import { DEFAULT_CONFIG, dial, display } from "./ussd.js";

/** How long a remembered bank PIN lasts before the app asks for it again. */
export const PIN_DAYS = 180;

export function createWorkflow({ bridge, store, telemetry, now = Date.now, seed = randomSeed, config = DEFAULT_CONFIG }) {
  const settings = () => store.state.settings;
  const card = (currency) => ({ bank: settings().bank, currency, pan: null });
  const current = (id) => store.state.attempts.find((a) => a.id === id);

  /** Sends a USSD on the chosen SIM and reports the reply; the result is the bridge's. */
  async function send(op, subId, code) {
    const start = now();
    let r;
    try {
      r = await bridge.sendUssd(subId, code);
    } catch (e) {
      // The shell refused the call (a malformed code, an exception): the same code Ussd.kt uses.
      r = { ok: false, failureCode: -100, error: e.message };
    }
    if (r.ok) {
      telemetry.event("ussd_reply", { op, ok: true, length: r.reply.length, latency_ms: now() - start, text: r.reply });
    } else {
      telemetry.event("ussd_reply", { op, ok: false, failure_code: r.failureCode, error: r.error });
    }
    return r;
  }

  async function balance(currency, { viaDialer = false } = {}) {
    const ussd = balanceCode(card(currency));
    const s = seed();
    const attempt = await store.add({
      id: null, startedAt: now(), code: display(ussd, config, s), state: viaDialer ? "dialer" : "sent", op: "46", currency,
    });
    telemetry.event("ussd_sent", { op: "46", bank: settings().bank, via: viaDialer ? "dialer" : "api" });
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
      const since = store.state.authenticatedAt;
      telemetry.event("session_lost", { op: "46", bank: settings().bank, age_ms: since === null ? null : now() - since });
    }
    return { attempt: current(attempt.id), needsLogin: lost };
  }

  /**
   * Sends op 40 with the key. The key goes into the dialed string only and nothing here keeps it.
   * With `retryCurrency`, the bank's "se ha autenticado" SMS reruns that balance query.
   */
  async function login(pin, { retryCurrency = null, remember = false } = {}) {
    if (retryCurrency) await store.setRetryBalance({ currency: retryCurrency, at: now() });
    telemetry.event("ussd_sent", { op: "40", bank: settings().bank, via: "api" });
    const r = await send("40", settings().subId, dial(loginCode(settings().bank, pin), config, seed()));
    if (!r.ok) {
      await store.setRetryBalance(null);
      return { ok: false, failureCode: r.failureCode };
    }
    const remembered = remember && bridge.secretSave ? await bridge.secretSave(pinName(), pin, PIN_DAYS).catch(() => false) : false;
    return { ok: true, reply: r.reply, remembered };
  }

  /**
   * The bank PIN can live in the shell's secret store: encrypted with a device key that needs the
   * fingerprint or the screen lock on every use, and dropped after PIN_DAYS. Nothing else keeps it.
   */
  const pinName = () => `pin:${settings().bank}`;
  async function savedPin() {
    if (!bridge.secretStatus) return { available: false, saved: false, expiresAt: null };
    return bridge.secretStatus(pinName()).catch(() => ({ available: false, saved: false, expiresAt: null }));
  }
  /** Logs in with the saved PIN once the device unlocks it; null when there is none or the person cancels. */
  async function loginWithSaved(options = {}) {
    const pin = bridge.secretLoad ? await bridge.secretLoad(pinName()).catch(() => null) : null;
    return pin ? login(pin, options) : null;
  }
  const forgetPin = () => bridge.secretForget?.(pinName());

  /**
   * Dials op 45. The transfer ends in the bank's menu, where the person types 1 to confirm,
   * so it goes through the system dialer; the bank's transfer SMS verifies it.
   */
  async function transfer(currency, toPan, amount) {
    const ussd = transferCode(card(currency), toPan, amount);
    const s = seed();
    const attempt = await store.add({
      id: null, startedAt: now(), code: display(ussd, config, s), state: "dialer", op: "45", currency, to: toPan, amount,
    });
    telemetry.event("ussd_sent", { op: "45", bank: settings().bank, via: "dialer" });
    try {
      await bridge.dial(dial(ussd, config, s));
    } catch (e) {
      // The dialer never opened (no call permission, no dialer): nothing can have been sent.
      await store.patch(attempt.id, (a) => ({ ...a, state: "failed", failureCode: -100 }));
      telemetry.event("ussd_reply", { op: "45", ok: false, failure_code: -100, error: e.message });
    }
    return current(attempt.id);
  }

  /** Asks a line for its balance with its plan's code, and keeps the figure for its card. */
  async function mobileBalance(subId) {
    const code = MOBILE_PLANS[store.planFor(subId)];
    const op = code.slice(1, -1);
    telemetry.event("ussd_sent", { op, via: "api" });
    const r = await send(op, subId, code);
    if (!r.ok) return { ok: false, failureCode: r.failureCode };
    const value = parseMobileBalance(r.reply);
    if (value) await store.setMobileBalance(subId, value);
    return { ok: true, value, reply: r.reply };
  }

  /** One incoming SMS. Texts the parser does not know are dropped here and never stored. */
  async function handleSms({ sender, body, sentAt = null, receivedAt = now() }) {
    const tag = senderTag(sender);
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
        await store.authenticated(receivedAt);
        telemetry.event("sms", { kind: "auth", ...base });
        const retry = store.state.retryBalance;
        if (retry) {
          await store.setRetryBalance(null);
          // A queued SMS can be read hours later: rerun only while the login is recent.
          if (receivedAt - retry.at < WINDOW_MS && now() - retry.at < WINDOW_MS) await balance(retry.currency);
        }
        break;
      }
    }
    return sms;
  }

  return { balance, login, loginWithSaved, savedPin, forgetPin, transfer, mobileBalance, handleSms };
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
