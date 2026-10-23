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
  // The old domestic form, 05 and 7 digits, is today's number without its leading 0.
  else if (d.length === 9 && d.startsWith("0")) d = d.slice(1);
  return /^[56]\d{7}$/.test(d) ? d : null;
}

/** The transfer key: 4 digits. */
export const validKey = (k) => /^\d{4}$/.test(k);

/** `*234*1*número*clave*monto#`: passes `amount` whole CUP of this line's balance to `to`. */
export const transferBalance = (to, key, amount) =>
  plain([field("234"), field("1"), field(to), field(key, true), field(String(amount))]);

/** `*234*2*clave*nueva#`: changes the transfer key. */
export const changeKey = (old, next) => plain([field("234"), field("2"), field(old, true), field(next, true)]);

/** `*133*1*2#`: the plan menu at `path`, a list of option keys; `*133#` for the root. */
export const planPath = (path) => plain([field("133"), ...path.map((k) => field(k))]);

const OPTION = /^\s*(\d{1,2})\s*[.)-]\s*(.+?)\s*$/;
// When in doubt a reply reads as a confirm: a confirm only shows a button, while a menu option
// that is really "accept" would buy on a tap.
const ACCEPT = /^(aceptar|confirm(ar|o)|s[ií]|ok|comprar)(?!\p{L})/iu;
const DECLINE = /^(cancelar|no)(?!\p{L})/iu;
const ASKS = /va a comprar|confirm|desea (comprar|adquirir)/i;

/**
 * A network reply as a menu of numbered options, a screen that asks to confirm a purchase with 1,
 * or null for anything else. The confirm is checked first, since it is itself a numbered list.
 */
export function parseMenu(reply) {
  const lines = reply.split("\n").map((l) => l.trim()).filter(Boolean);
  const options = [];
  let title = "";
  for (const l of lines) {
    const m = OPTION.exec(l);
    if (m) options.push({ key: m[1], label: m[2] });
    else if (!title && !options.length) title = l;
  }
  if (options.some((o) => (o.key === "1" && ACCEPT.test(o.label)) || DECLINE.test(o.label)) || (options.length && ASKS.test(reply))) {
    // The plan's price follows "por"; otherwise the last amount, since a balance tends to come first.
    const price = /por\s+(\d+(?:[.,]\d+)?\s*CUP)/i.exec(reply)?.[1] ?? reply.match(/\d+(?:[.,]\d+)?\s*CUP/gi)?.at(-1) ?? null;
    return { kind: "confirm", text: reply, price };
  }
  return options.length >= 2 ? { kind: "menu", title, options } : null;
}

/** Whether the reply to a purchase says it went through, was refused, or neither. */
export function purchaseOutcome(reply) {
  if (/insuficiente|no es posible|no se pudo|error/i.test(reply)) return "refused";
  if (/exito|éxito|satisfactori|adquirid/i.test(reply)) return "bought";
  return null;
}
