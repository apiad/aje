// Reads bank confirmation SMS. Only Banco Metropolitano's texts have been seen so far;
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
  if (/transferencia fue completada/i.test(text)) {
    const date = field(text, "Fecha");
    const beneficiary = field(text, "Beneficiario");
    const amount = money(text, "Monto");
    const transactionId = field(text, String.raw`Nro\.? Transacci[oó]n`);
    if (!date || !beneficiary || !amount || !transactionId) return null;
    return { kind: "transfer", bank, date, beneficiary, amount, transactionId, remaining: money(text, "Saldo restante") };
  }
  if (/se ha autenticado en la plataforma de pagos m[oó]viles/i.test(text)) return { kind: "auth", bank };
  return null;
}

/** The line of a Cubacel balance transfer text: what was sent or received, from or to which number. */
const LINE = new RegExp(String.raw`(transferido|recibido)\s+([0-9][0-9.,]*)\s*CUP\s+(?:al|del)\s+(?:n[uú]mero\s+)?(?:\+?53)?([56]\d{7})`, "i");

/** Reads a Cubacel balance transfer SMS; anything else returns null. */
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

/** Short or alphanumeric senders are services; a long number is a person and is never reported. */
/**
 * Cubacel's SMS after a plan purchase: "Se ha … Plan <name> valido por <n> dias, … Se … <price> CUP.
 * Saldo … <balance> CUP". Telemetry brought it with some words hidden, so those match any word.
 */
const PLAN = new RegExp(String.raw`Se ha \S+ (?:el )?Plan\s+(.+?)\s+v[aá]lido por\s+(\d+)\s+d[ií]as[\s\S]*?\bSe\s+\S+\s+([0-9][0-9.,]*)\s*CUP` +
  String.raw`(?:[\s\S]*?\bSaldo\s+\S+\s+([0-9][0-9.,]*)\s*CUP)?`, "i");

/** Reads a plan purchase SMS; anything else returns null. */
export function parsePlanSms(body) {
  const m = PLAN.exec(body.replaceAll("\u00a0", " "));
  const cents = m && centsOf(m[3]);
  if (!m || cents === null) return null;
  return { kind: "plan", name: m[1], days: Number(m[2]), price: { cents, currency: "CUP" }, balance: m[4] ? `${m[4]} CUP` : null };
}

export function senderTag(sender) {
  return /\p{L}/u.test(sender) || sender.length <= 6 ? sender : "number";
}

function bankOf(text) {
  return /Banco Metropolitano/i.test(text) ? "METROPOLITANO" : null;
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

/** `25904.29` or `25,904.29` to cents. A lone comma with two digits after it is a decimal comma. */
function centsOf(number) {
  const n = /^\d+,\d{2}$/.test(number) ? number.replace(",", ".") : number.replaceAll(",", "");
  const parts = n.split(".");
  const int = (s) => (/^\d+$/.test(s) ? Number(s) : null);
  if (parts.length === 1) return int(parts[0]) === null ? null : int(parts[0]) * 100;
  if (parts.length === 2) {
    const whole = int(parts[0]);
    const frac = int(parts[1].padEnd(2, "0").slice(0, 2));
    return whole === null || frac === null ? null : whole * 100 + frac;
  }
  return null;
}
