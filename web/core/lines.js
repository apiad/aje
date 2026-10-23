// The codes a Cubacel line answers to, and the rule for a Cubacel mobile number.
import { field, plain } from "./ussd.js";

/** What the network charges per balance transfer, and the balance it requires, in CUP. */
export const TRANSFER_FEE = 5;
export const MIN_BALANCE = 5.25;

/** A Cubacel mobile as 8 digits starting with 5 or 6, from a typed or contact number; null otherwise. */
export function normalizeNumber(raw) {
  if (!/^[\s\d+()-]*$/.test(raw)) return null;
  let d = raw.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("0053")) d = d.slice(4);
  else if (d.length === 10 && d.startsWith("53")) d = d.slice(2);
  return /^[56]\d{7}$/.test(d) ? d : null;
}

/** The transfer key: 4 digits. */
export const validKey = (k) => /^\d{4}$/.test(k);

/** `*234*1*número*clave*monto#`: passes `amount` whole CUP of this line's balance to `to`. */
export const transferBalance = (to, key, amount) =>
  plain([field("234"), field("1"), field(to), field(key, true), field(String(amount))]);

/** `*234*2*clave*nueva#`: changes the transfer key. */
export const changeKey = (old, next) => plain([field("234"), field("2"), field(old, true), field(next, true)]);

// Guesses until a phone captures the network's real replies; the first match wins.
const REPLY = [
  ["bad-key", /clave|contrase/i],
  ["no-balance", /saldo insuficiente|no tiene saldo/i],
  ["limit", /l[ií]mite|excedid/i],
  ["ok", /transferid|satisfactori|exito|éxito/i],
];

/** What a reply to `*234*1` says: "ok", "bad-key", "no-balance", "limit" or "unknown". */
export function parseLineReply(reply) {
  return REPLY.find(([, re]) => re.test(reply))?.[0] ?? "unknown";
}
