// Reads bank confirmation SMS. Only Banco Metropolitano's texts, and MiTransfer's login, have been seen so far;
// a text from another bank, or one this parser does not know, returns null.

const MONEY = String.raw`(CR|DB)?\s*([0-9][0-9.,]*)\s*(CUP|CUC|USD|MLC|EUR)`;

/** Words that mark a text as probably from a bank, for reporting texts the parser does not know. */
export const BANKISH = /banco|bpa|bandec|metropolitano|transferm|saldo|autentic|pagos? m[oó]vil|cubacel|etecsa|transferid|recibid/i;

export function parseBankSms(body) {
  const text = body.replaceAll(" ", " ");
  const bank = bankOf(text);
  if (!bank) return null;
  if (/consulta de saldo fue completada/i.test(text)) {
    const accounting = money(text, "Saldo Contable");
    const available = money(text, "Saldo Disponible");
    return accounting && available ? { kind: "balance", bank, accounting, available } : null;
  }
  if (/fall[oó] la consulta de saldo/i.test(text)) return { kind: "balance-failed", bank };
  if (/transferencia fue completada/i.test(text)) {
    const date = field(text, "Fecha");
    const beneficiary = field(text, "Beneficiario");
    const amount = money(text, "Monto");
    const transactionId = field(text, String.raw`Nro\.? Transacci[oó]n`);
    if (!date || !beneficiary || !amount || !transactionId) return null;
    return { kind: "transfer", bank, date, beneficiary, amount, transactionId, remaining: money(text, "Saldo restante") };
  }
  if (/se ha autenticado en la plataforma de pagos m[oó]viles/i.test(text)) return { kind: "auth", bank };
  // A Nauta recharge ("recargada") or a Nauta Hogar bill ("pagada"): the amount is the one asked, before any discount.
  const nauta = /La cuenta\s*(Nauta Hogar)?\s*:\s*([^\s@:]+)@nauta\.com?\.cu ha sido (?:recargada|pagada) con ([0-9][0-9.,]*)\s*CUP/i.exec(text);
  if (nauta) {
    const cents = centsOf(nauta[3]);
    const transactionId = /Transacci[oó]n\s*:\s*([A-Z0-9]+)/i.exec(text)?.[1] ?? null;
    if (cents === null) return null;
    return { kind: "nauta", bank, user: nauta[2].toLowerCase(), hogar: Boolean(nauta[1]), amount: { cents, currency: "CUP" }, transactionId };
  }
  return null;
}

/** The line of a Cubacel balance transfer text: what was sent or received, from or to which number. */
const LINE = new RegExp(String.raw`(transferido|recibido)\s+([0-9][0-9.,]*)\s*CUP\s+(?:al|del)\s+(?:n[uú]mero\s+)?(?:\+?53)?([56]\d{7})`, "i");

/** Reads a Cubacel balance transfer SMS; anything else returns null. */
/**
 * The SMS that answers a debt query (op 47): `{kind: "debt", number, cents}`, where cents is 0 for
 * "no tiene deudas", the first amount after the bill's number otherwise, or null when it names none.
 * It names no bank. Only the no-debt form has been seen; the amount form is a guess.
 */
export function parseDebtSms(body) {
  const text = body.replaceAll("\u00a0", " ");
  if (!/Consulta de servicio completada/i.test(text)) return null;
  const m = /Factura\s*:?\s*([0-9A-Za-z]+)([\s\S]*)/i.exec(text);
  if (!m) return null;
  if (/no tiene deuda/i.test(m[2])) return { kind: "debt", number: m[1], cents: 0 };
  const amount = /(\d+(?:[.,]\d{1,2})?)\s*(?:CUP|pesos)?/i.exec(m[2]);
  return { kind: "debt", number: m[1], cents: amount ? centsOf(amount[1]) : null };
}

export function parseLineSms(body) {
  const m = LINE.exec(body.replaceAll("\u00a0", " "));
  if (!m) return null;
  const cents = centsOf(m[2]);
  if (cents === null) return null;
  return { kind: /^t/i.test(m[1]) ? "line-sent" : "line-received", number: m[3], amount: { cents, currency: "CUP" } };
}

/** `{cents: -500, currency: "CUP"}` as `-5.00 CUP`. */
export function formatMoney({ cents, currency }) {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")} ${currency}`;
}

/** Whether a transfer SMS confirms `cents` to `pan`; the bank masks the middle of the number with X. */
export function transferMatches(sms, pan, cents) {
  const b = sms.beneficiary;
  return sms.amount.cents === cents && b.length === pan.length && [...b].every((c, i) => c === "X" || c === pan[i]);
}

/**
 * Cubacel's SMS after a plan purchase: "Se ha … Plan <name> valido por <n> dias, … Se … <price> CUP.
 * Saldo … <balance> CUP". Telemetry brought it with some words hidden, so those match any word.
 */
const W = String.raw`(?:\S+\s+){1,2}?`;
const NUM = String.raw`([0-9][0-9.,]*)\s*CUP`;
// The price is the sentence right after the plan's; the balance, if any, right after the price.
const PLAN = new RegExp(String.raw`Se\s+ha\s+${W}(?:el\s+)?Plan\s+(.+?)\s+v[aá]lido\s+por\s+(\d+)\s+d[ií]as[^.]*\.\s*Se\s+${W}${NUM}` +
  String.raw`(?:[.,;]?\s*Saldo\s+(?:\S+\s+){0,2}?${NUM})?`, "i");

// Cubacel's 2025 format, which an old line may still send: "Ha comprado [un plan de] <name> valido por
// <n> dias, … Se desconto <price> [CUP] [de su cuenta principal]. Saldo actual <balance> [CUP]".
const FIGURE = String.raw`(\d+(?:[.,]\d+)*)`;
const PLAN_2025 = new RegExp(String.raw`Ha\s+comprado\s+(?:un\s+plan\s+de\s+)?(.+?)\s+v[aá]lido\s+por\s+(\d+)\s+d[ií]as[^.]*\.\s*` +
  String.raw`Se\s+descont[oó]\s+${FIGURE}(?:\s*CUP)?(?:\s+de\s+su\s+cuenta\s+principal)?(?:[.,;]?\s*Saldo\s+actual\s+${FIGURE})?`, "i");

/** Reads a plan purchase SMS; anything else returns null. */
export function parsePlanSms(body) {
  const text = body.replaceAll("\u00a0", " ");
  const m = PLAN.exec(text) ?? PLAN_2025.exec(text);
  const cents = m && centsOf(m[3]);
  if (!m || cents === null) return null;
  const left = m[4] ? centsOf(m[4]) : null;
  return { kind: "plan", name: m[1], days: Number(m[2]), price: { cents, currency: "CUP" },
    balance: left === null ? null : formatMoney({ cents: left, currency: "CUP" }) };
}

/** Short or alphanumeric senders are services; a long number is a person and is never reported. */
export function senderTag(sender) {
  return /\p{L}/u.test(sender) || sender.length <= 6 ? sender : "number";
}

function bankOf(text) {
  if (/Banco Metropolitano/i.test(text)) return "METROPOLITANO";
  // MiTransfer's login SMS names its wallet: "en el Monedero Mi Transfer".
  if (/Monedero\s+Mi\s*Transfer/i.test(text)) return "MITRANSFER";
  return null;
}

function field(text, label) {
  const m = new RegExp(String.raw`${label}\s*:\s*([^\n]+)`, "i").exec(text);
  return m ? m[1].trim() : null;
}

function money(text, label) {
  const m = new RegExp(String.raw`${label}\s*:\s*${MONEY}`, "i").exec(text);
  if (!m) return null;
  const [, sign, number, currency] = m;
  const cents = centsOf(number);
  if (cents === null) return null;
  return { cents: sign?.toUpperCase() === "DB" ? -cents : cents, currency: currency.toUpperCase() };
}

/**
 * `25904.29` or `25,904.29` to cents. A lone comma with two digits after it is a decimal comma.
 * A whole part over 12 digits is no amount anyone holds, and is refused (SmsNotice.kt does the same).
 */
export function centsOf(number) {
  const n = /^\d+,\d{2}$/.test(number) ? number.replace(",", ".") : number.replaceAll(",", "");
  const parts = n.split(".");
  const int = (s) => (/^\d+$/.test(s) ? Number(s) : null);
  if (parts[0].length > 12) return null;
  if (parts.length === 1) return int(parts[0]) === null ? null : int(parts[0]) * 100;
  if (parts.length === 2) {
    const whole = int(parts[0]);
    const frac = int(parts[1].padEnd(2, "0").slice(0, 2));
    return whole === null || frac === null ? null : whole * 100 + frac;
  }
  return null;
}
