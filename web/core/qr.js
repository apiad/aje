// The QR of a charge between Cubacel lines: aje:saldo?v=1&n=5XXXXXXX&m=150&a=Ana. It carries no key,
// signature or secret: someone holding another person's QR can only pay that person.
import { normalizeNumber } from "./lines.js";

const VERSION = 1;
const NAME_MAX = 40;
const PREFIX = "aje:saldo?";

/** The QR text for a charge to `number`, with an optional whole-CUP amount and name. */
export function chargeUri({ number, amount = null, name = null }) {
  const q = new URLSearchParams({ v: String(VERSION), n: number });
  if (amount !== null) q.set("m", String(amount));
  if (name) q.set("a", [...name.trim()].slice(0, NAME_MAX).join(""));
  // URLSearchParams writes a space as "+"; %20 reads the same and is what other readers expect.
  return PREFIX + q.toString().replaceAll("+", "%20");
}

/** A scanned text as a charge, or why it cannot be paid: not an Ajé charge, a newer format, or malformed. */
export function parseCharge(text) {
  if (!text.startsWith(PREFIX)) return { ok: false, reason: "not-aje" };
  const q = new URLSearchParams(text.slice(PREFIX.length));
  const v = Number(q.get("v"));
  if (!Number.isInteger(v) || v < 1) return { ok: false, reason: "bad" };
  if (v > VERSION) return { ok: false, reason: "newer" };
  const number = normalizeNumber(q.get("n") ?? "");
  if (!number || number !== q.get("n")) return { ok: false, reason: "bad" };
  let amount = null;
  if (q.has("m")) {
    // Whole CUP, at most six digits: more than any balance transfer carries.
    if (!/^\d{1,6}$/.test(q.get("m")) || Number(q.get("m")) <= 0) return { ok: false, reason: "bad" };
    amount = Number(q.get("m"));
  }
  // Format and control characters go, so a name cannot reorder itself to look like another number.
  const clean = (q.get("a") ?? "").replace(/[\p{Cf}\p{Cc}]/gu, "").trim();
  const name = clean ? [...clean].slice(0, NAME_MAX).join("") : null;
  return { ok: true, number, amount, name };
}
