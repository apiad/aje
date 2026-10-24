// The receipt of an operation an SMS verified: the history detail shows it, "Mostrar" puts it full
// screen for the person across the counter, and "Compartir" sends it as text. Discreet mode, on by
// default, leaves out what is the person's own: the card that paid, the balance left, a line's dates.
import { last4 } from "./money.js";

/** `1500` as `1 500,00`, as a receipt shows money. */
export function money(n) {
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, " ")},${dec}`;
}

const pad = (n) => String(n).padStart(2, "0");
/** A local time as `24/10/2026 · 14:32`. */
export function stamp(ms) {
  const d = new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const shortStamp = (ms) => stamp(ms).replace(/\/\d{4}/, "");

/** The bank's masked number, `9200XXXXXXXX0001`, as `9200 •••• •••• 0001`. */
const maskedPan = (b) => b.replace(/X/g, "•").replace(/(.{4})(?=.)/g, "$1 ");

/** What the SMS says the line or card has left, as the text writes it. */
const SALDO = /(Saldo\s+(?:restante|principal|actual)\s*:?\s*(?:CR|DB)?\s*)([0-9][0-9.,]*)/gi;
const LINE_DATES = /((?:activa\s+hasta|vence)\s+)([0-9][0-9\-/]+)/gi;
const NAUTA_USER = /(:\s*)([^\s@:]+)(@nauta\.com?\.cu)/gi;

/** The SMS with what discreet mode hides turned into dots. */
export function maskSms(text) {
  const dots = (s) => "•".repeat(Math.min(s.length, 8));
  return text
    .replace(SALDO, (_, k, v) => k + dots(v))
    .replace(LINE_DATES, (_, k, v) => k + dots(v))
    .replace(NAUTA_USER, (_, k, u, d) => k + u[0] + "•••" + d);
}

/** The figure after "Saldo principal|actual" in a Cubacel SMS, as `1234.56 CUP`, or null. */
function saldoOf(text) {
  const m = /Saldo\s+(?:principal|actual)\s*:?\s*([0-9][0-9.,]*)\s*CUP/i.exec(text ?? "");
  return m ? `${m[1]} CUP` : null;
}

/**
 * The receipt of a verified operation: `{from, what, amount, currency, at, fields, show, sms}`, each
 * field `{label, value, private, short}` (`short` stands in for the value in discreet mode), `show`
 * the `[label, value]` pairs of the full-screen view. Null for anything without one.
 */
export function receipt(a, { cards = [] } = {}) {
  if (a.state !== "verified") return null;
  const at = a.verifiedAt ?? a.startedAt;
  const card = cards.find((c) => c.id === a.cardId);
  const from = card ? { label: "Desde tu tarjeta", value: `${card.alias} ···· ${last4(card.pan)}`, private: true } : null;
  const left = (value) => (value ? { label: "Saldo restante", value: value.replace(/^(-?)(\d+)\.(\d\d)/, (_, s, i, d) => money(Number(`${s}${i}.${d}`))), private: true } : null);
  const done = (r) => ({ at, sms: a.sms ?? null, ...r, fields: r.fields.filter(Boolean) });
  if (a.op === "45") {
    const beneficiary = /Beneficiario:\s*([0-9X]{16})/i.exec(a.sms ?? "")?.[1];
    return done({
      from: "Banco Metropolitano", what: "Transferencia completada", amount: a.amount, currency: card?.currency ?? "CUP",
      fields: [
        { label: "Beneficiario", value: beneficiary ? maskedPan(beneficiary) : `···· ${last4(a.to)}` },
        { label: "Fecha", value: stamp(at) },
        a.transactionId && { label: "Nro. transacción", value: a.transactionId },
        from, left(a.available),
      ],
      show: [["A la tarjeta", `···· ${last4(a.to)}`], ["Nro. transacción", a.transactionId], ["Fecha", shortStamp(at)]].filter(([, v]) => v),
    });
  }
  if (a.kind === "nauta" && a.billId) {
    const account = `${a.to}@nauta.com.cu`;
    return done({
      from: "Banco Metropolitano", what: "Recarga Nauta completada", amount: a.amount, currency: "CUP",
      fields: [
        { label: "Cuenta", value: account, short: `${a.to[0]}•••@nauta.com.cu` },
        { label: "Fecha", value: stamp(at) },
        a.transactionId && { label: "Nro. transacción", value: a.transactionId },
        from, left(a.available),
      ],
      show: [["Cuenta", account], ["Nro. transacción", a.transactionId], ["Fecha", shortStamp(at)]].filter(([, v]) => v),
    });
  }
  if (a.op === "234") {
    const saldo = saldoOf(a.sms);
    return done({
      from: "ETECSA", what: "Saldo transferido", amount: a.amount, currency: "CUP",
      fields: [
        { label: "Al número", value: a.to },
        { label: "Fecha", value: stamp(at) },
        saldo && { label: "Tu saldo principal", value: saldo, private: true },
      ],
      show: [["Al número", a.to], ["Fecha", shortStamp(at)]],
    });
  }
  if (a.op === "133" && a.plan) {
    return done({
      from: "Cubacel", what: `Plan ${a.plan.name} comprado`, amount: a.plan.price, currency: "CUP",
      fields: [
        { label: "Plan", value: a.plan.name },
        { label: "Fecha", value: stamp(at) },
        a.balance && { label: "Saldo que queda", value: a.balance, private: true },
      ],
      show: [["Plan", a.plan.name], ["Fecha", shortStamp(at)]],
    });
  }
  return null;
}

/** The fields as discreet mode leaves them: private ones out, `short` in place of the value. */
export function visibleFields(r, discreet) {
  return r.fields.filter((f) => !(discreet && f.private)).map((f) => ({ ...f, value: discreet && f.short ? f.short : f.value }));
}

/** The receipt as the text "Compartir" and "Copiar" send: what the screen shows, nothing more. */
export function receiptText(r, discreet) {
  return [`✅ ${r.what}`, r.from, "", `Monto: ${money(r.amount)} ${r.currency}`,
    ...visibleFields(r, discreet).map((f) => `${f.label}: ${f.value}`)].join("\n");
}
