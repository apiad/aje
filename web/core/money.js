/** The currency index the bank's USSD uses (`monedaTarjeta`). USD also covers MLC cards. */
export const CURRENCIES = { CUP: 1, CUC: 2, USD: 3 };

/** Each bank, with the two-digit agency code PIN operations lead with. */
export const BANKS = {
  BPA: { agency: "01", name: "BPA" },
  BANDEC: { agency: "02", name: "BANDEC" },
  METROPOLITANO: { agency: "03", name: "Banco Metropolitano" },
  MITRANSFER: { agency: null, name: "MiTransfer" },
};

/** A 16-digit card number from text that may carry dashes and spaces. */
export function parsePan(text) {
  const digits = text.replace(/[- ]/g, "");
  if (!/^[0-9]{16}$/.test(digits)) throw new RangeError("a card number has 16 digits");
  return digits;
}

export const last4 = (pan) => pan.slice(-4);

/** The bank a card number belongs to, or null when the prefix does not say. */
export function bankOfPan(pan) {
  if (pan.startsWith("976003")) return "MITRANSFER";
  if (pan.startsWith("92")) return { 12: "BPA", "06": "BANDEC", 95: "METROPOLITANO" }[pan.slice(4, 6)] ?? null;
  return null;
}

/**
 * The `monedaTarjeta*cuentaOrigen` pair that ends every card operation: an explicit card by
 * number, or the card registered with the bank for this phone in a currency.
 */
export function selectorFields(card) {
  return card.pan ? ["0", card.pan] : [String(CURRENCIES[card.currency]), "0000"];
}

/** A Cubacel line's balance code: prepaid dials *222#, postpaid (enterprise) dials *111#. */
export const MOBILE_PLANS = { PREPAGO: "*222#", POSPAGO: "*111#" };

/**
 * The line balance in a mobile balance reply. Prepaid carries it after "Saldo:", postpaid after
 * "Voz: Saldo disponible"; both put it first, so the first CUP figure is the balance.
 */
export function parseMobileBalance(reply) {
  const m = /(\d+[.,]\d{2})\s*CUP/.exec(reply);
  return m ? `${m[1]} CUP` : null;
}

/**
 * Every figure of an ETECSA balance reply. Prepaid (*222#) gives the balance, data, voice time,
 * SMS count and the line's dates; postpaid (*111#) gives voice and SMS balances and data.
 * Null when the reply carries none of them.
 */
export function parseMobileDetails(reply) {
  const get = (re) => re.exec(reply)?.[1] ?? null;
  const d = {
    balance: get(/^\s*Saldo:\s*(\d+[.,]\d{2}\s*CUP)/i),
    data: get(/Datos:\s*(\d+(?:[.,]\d+)?\s*[GMK]B)/i),
    voice: get(/Voz:\s*(\d{1,3}:\d{2}:\d{2})/i) ?? get(/Voz:\s*Saldo disponible\s*(\d+[.,]\d{2}\s*CUP)/i),
    sms: get(/SMS:\s*(\d+)\b(?![.,]\d)/i) ?? get(/SMS:\s*Saldo disponible\s*(\d+[.,]\d{2}\s*CUP)/i),
    activeUntil: get(/activa hasta\s*(\d{2}-\d{2}-\d{2})/i),
    expires: get(/vence\s*(\d{2}-\d{2}-\d{2})/i),
  };
  return Object.values(d).some(Boolean) ? d : null;
}

/** A transfer amount in whole units, or null: decimals and separators are refused, never truncated. */
export function parseAmount(text) {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const n = Number(text.trim());
  return n > 0 ? n : null;
}
