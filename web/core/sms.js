// Reads bank confirmation SMS. Only Banco Metropolitano's texts have been seen so far;
// a text from another bank, or one this parser does not know, returns null.

const MONEY = String.raw`(CR|DB)?\s*([0-9][0-9.,]*)\s*(CUP|CUC|USD|MLC|EUR)`;

/** Words that mark a text as probably from a bank, for reporting texts the parser does not know. */
export const BANKISH = /banco|bpa|bandec|metropolitano|transferm|saldo|autentic|pagos? m[oó]vil/i;

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
