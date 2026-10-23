// Reads the SMS that tell of money or balance coming in, and the copy of their notices.
// SmsNotice.kt in the shell reads the same texts the same way: both are held to
// web/test/fixtures/notice-vectors.json, so a change here changes the Kotlin too.
// The regexes stay flat (no lookbehind, no named groups) so they port as they are.
import { centsOf, formatMoney, parseLineSms, senderTag } from "./sms.js";

const AMOUNT = String.raw`([0-9][0-9.,]*)\s*`;
const CARD = new RegExp(String.raw`El titular del tel[eé]fono\s+(\d+)\s+le ha realizado una transferencia a la cuenta\s+(\S+)\s+de\s+${AMOUNT}(CUP|USD|MLC|CUC|EUR)`, "i");
const INTL = /Recarga Internacional/i;
const INTL_AMOUNT = new RegExp(String.raw`(?:recibi[oó]|recibido|recargada con)\s+${AMOUNT}CUP`, "i");
const INTL_PLAN = /recibi[oó]\s+(.+?)\s+v[aá]lidos?\s/i;
const RECHARGE = new RegExp(String.raw`recarga de saldo m[oó]vil por un monto de\s+${AMOUNT}CUP`, "i");
const GIFT = /Ha recibido un plan de\s+(.+?)\s+v[aá]lido/i;
const EXPIRY = /Su\s+(plan|bonificaci[oó]n)\s+de\s+(.+?)\s+vence el\s+(\d{2}-\d{2}-\d{2,4})/i;

/**
 * The notice an incoming SMS gives, or null: `{kind, amount, number, account, plan}`, where
 * kind is card-received, line-received, recharge-intl, recharge, plan-gift or plan-expiry and
 * amount is written as formatMoney writes it. A person's number never gives one.
 */
export function noticeOf(sender, body) {
  if (senderTag(sender) === "number") return null;
  const text = body.replaceAll(" ", " ");
  const n = (kind, fields) => ({ kind, amount: null, number: null, account: null, plan: null, ...fields });
  const money = (number, currency = "CUP") => {
    const cents = centsOf(number);
    return cents === null ? null : formatMoney({ cents, currency: currency.toUpperCase() });
  };
  let m;
  if ((m = CARD.exec(text))) {
    const amount = money(m[3], m[4]);
    return amount && n("card-received", { amount, number: m[1], account: m[2] });
  }
  const line = parseLineSms(text);
  if (line?.kind === "line-received") return n("line-received", { amount: formatMoney(line.amount), number: line.number });
  if (INTL.test(text)) {
    if ((m = INTL_AMOUNT.exec(text))) return money(m[1]) && n("recharge-intl", { amount: money(m[1]) });
    if ((m = INTL_PLAN.exec(text))) return n("recharge-intl", { plan: m[1] });
    return null;
  }
  if ((m = RECHARGE.exec(text))) return money(m[1]) && n("recharge", { amount: money(m[1]) });
  if ((m = GIFT.exec(text))) return n("plan-gift", { plan: m[1] });
  if ((m = EXPIRY.exec(text))) {
    const what = /^p/i.test(m[1]) ? "plan" : "bonificación";
    return n("plan-expiry", { plan: `${what} de ${m[2].toLowerCase()} vence el ${m[3]}` });
  }
  return null;
}

/** The notice's title (its Android channel) and its sentence; `name` is the contact's, or null. */
export function noticeText(n, name) {
  const from = () => `de ${name ?? `${n.number} (desconocido)`}`;
  switch (n.kind) {
    case "card-received": return { title: "Dinero recibido", text: `Recibiste ${n.amount} ${from()}` };
    case "line-received": return { title: "Saldo recibido", text: `Recibiste ${n.amount} ${from()}` };
    case "recharge-intl": return n.amount
      ? { title: "Saldo recibido", text: `Recibiste una recarga internacional de ${n.amount}` }
      : { title: "Recargas y planes", text: `Recibiste una recarga internacional: ${n.plan}` };
    case "recharge": return { title: "Saldo recibido", text: `Recibiste una recarga de ${n.amount}` };
    case "plan-gift": return { title: "Recargas y planes", text: `Recibiste un plan de ${n.plan}` };
    case "plan-expiry": return { title: "Recargas y planes", text: `Tu ${n.plan}` };
  }
  return null;
}

/** A 32-bit FNV-1a hash over code points, in lowercase hex: an SMS's id keeps no bank text. */
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const c of text) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
