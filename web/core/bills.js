// Bills and services paid from a card: the saved accounts' kinds, what each number looks like, and
// the dialed code that pays one. Every one ends in the bank's menu, where the person types 1.
import { selectorFields } from "./money.js";
import { encoded, field } from "./ussd.js";

/** `kind` ids match trm.js's BILL_KINDS, so an imported contract keeps its kind. */
export const KINDS = {
  electricity: { label: "Luz", icon: "bolt" },
  water: { label: "Agua", icon: "drop" },
  gas: { label: "Gas", icon: "flame" },
  phone: { label: "Teléfono fijo", icon: "phone" },
  nauta: { label: "Nauta", icon: "wifi" },
};

/** The water company, which picks the op: Aguas de La Habana 19, the rest of the country 51, Varadero 21. */
export const WATER_REGIONS = { 1: { label: "Aguas de La Habana", op: "19", digits: [11] }, 2: { label: "Resto del país", op: "51", digits: [14, 16] }, 3: { label: "Aguas Varadero", op: "21", digits: [11, 12, 13, 14, 15, 16] } };

/** Nauta account types, as the bank numbers them. */
export const NAUTA_TYPES = { 2: "Navegación nacional", 1: "Navegación internacional" };

/** How many digits a bill number has; Metropolitano wants 13 for electricity, the other banks 11 or 13. */
export function digitsOf(kind, { bank = null, region = 1 } = {}) {
  if (kind === "electricity") return bank === "METROPOLITANO" ? [13] : [11, 13];
  if (kind === "gas") return [12];
  if (kind === "phone") return [15];
  if (kind === "water") return WATER_REGIONS[region]?.digits ?? [];
  return [];
}

/** The account's number cleaned up, or an error to show; a Nauta account is the user part, lowercase. */
export function checkNumber(kind, text, opts = {}) {
  if (kind === "nauta") {
    const user = text.trim().toLowerCase().replace(/@nauta\.com?\.cu$/, "");
    return /^[a-z0-9._-]{2,40}$/.test(user) ? { number: user } : { error: "Escribe el usuario de la cuenta Nauta." };
  }
  const number = text.replace(/[\s-]/g, "");
  const digits = digitsOf(kind, opts);
  if (!/^[0-9]+$/.test(number) || !digits.includes(number.length)) {
    return { error: `El número de la factura tiene ${digits.join(" o ")} dígitos.` };
  }
  return { number };
}

/**
 * The code that pays `bill` from `card`. The bill kinds pay the whole debt (a 0 amount); Nauta
 * recharges `bill.amount` CUP. Field orders are those of Metropolitano's multi-card forms.
 */
export function payBill(bill, card) {
  const [currency, account] = selectorFields(card);
  const fields = (values) => values.map((v) => field(v));
  switch (bill.kind) {
    case "electricity": return encoded("41", fields([bill.number, "0", currency, account]));
    case "phone": return encoded("42", fields([bill.number, "0", currency, account]));
    // The payment type is the first of "Deuda Total", "Deuda Mensual".
    case "gas": return encoded("67", fields([bill.number, "0", currency, "1", account]));
    case "water": {
      const region = WATER_REGIONS[bill.region];
      if (!region) throw new RangeError(`no water region ${bill.region}`);
      // The amount is a float in the official app, written "0.0" when the whole debt is paid.
      return encoded(region.op, fields([String(bill.region), bill.number, "0.0", "1", currency, account]));
    }
    case "nauta": {
      if (!Number.isInteger(bill.amount) || bill.amount <= 0) throw new RangeError("the amount is a positive whole number");
      // No phone to notify, then the 1 that marks a recharge (2 pays Nauta Hogar).
      return encoded("59", fields([bill.number, String(bill.nautaType ?? 2), String(bill.amount), currency, "0000", account, "1"]));
    }
    default: throw new RangeError(`no bill kind ${bill.kind}`);
  }
}

/** The op a bill's payment dials, for history and telemetry. */
export const opOf = (bill) => (bill.kind === "water" ? WATER_REGIONS[bill.region]?.op : { electricity: "41", phone: "42", gas: "67", nauta: "59" }[bill.kind]);
