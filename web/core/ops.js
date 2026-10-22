// Bank operations and the order of their parameters.
import { BANKS, selectorFields } from "./money.js";
import { bare, encoded, field } from "./ussd.js";

const fieldsOf = (values) => values.map((v) => field(v));

/** Opcode 46. BANDEC takes no parameters; the other banks take the card selector. */
export function balance(card) {
  return card.bank === "BANDEC" ? bare("46") : encoded("46", fieldsOf(selectorFields(card)));
}

/**
 * Opcode 40: opens a mobile-payments session with the bank, `agency*clave`. The bank
 * answers card operations with "debe autenticarse primero" until this has run.
 */
export function login(bank, pin) {
  const agency = BANKS[bank]?.agency;
  if (!agency) throw new RangeError(`${bank} has no agency code`);
  if (!/^[0-9]{4}$/.test(pin)) throw new RangeError("the bank key has 4 digits");
  return encoded("40", [field(agency), field(pin, true)]);
}

/**
 * Opcode 45, card to card, in the order of Metropolitano's transfer screen:
 * `cuentaDestino*importe*monedaImporte*monedaTarjeta*cuentaOrigen*movilConfirmar*enviarMiMovil*mensaje*enviarSaldo`,
 * with no confirmation phone, no SMS to the sender's phone, no message and no balance in the SMS.
 * The amount is in whole units of the card's currency: decimals need the second encoder.
 * It is dialed, not sent: the bank's last menu asks the person to type 1.
 */
export function transfer(from, toPan, amount) {
  if (!Number.isInteger(amount) || amount <= 0) throw new RangeError("the amount is a positive whole number");
  return encoded("45", fieldsOf([
    toPan, String(amount), String(selectorFields({ ...from, pan: null })[0]),
    ...selectorFields(from), "0000", "0", "0000", "0",
  ]));
}

/**
 * Opcode 49: registers the phone with a bank, once per bank, with the number of the bank's
 * coordinates card (Telebanca, Multibanca) and the holder's data, in each bank's form order.
 */
export function register(bank, { card, name, surname1, surname2, ci }) {
  const agency = BANKS[bank]?.agency;
  if (!agency) throw new RangeError(`${bank} has no agency code`);
  const params = bank === "BANDEC" ? [agency, card, name, ci] : [agency, card, name, surname1, surname2, ci];
  return encoded("49", fieldsOf(params));
}

/**
 * Opcode 60: links another card to the bank the person last authenticated with. The bank checks
 * the value at a coordinate of its matrix; BPA's form sends the card alone.
 */
export function link(bank, pan, coordinate, value) {
  if (bank === "BPA") return encoded("60", [field(pan)]);
  if (!coordinate || !/^[0-9]+$/.test(value ?? "")) throw new RangeError("linking needs a coordinate and its value");
  return encoded("60", [field(pan), field(coordinate), field(value, true)]);
}

/** A cell of the 10×10 coordinates matrix: a letter A–J and a row 1–10. */
export function drawCoordinate(random = Math.random) {
  return "ABCDEFGHIJ"[Math.floor(random() * 10)] + (Math.floor(random() * 10) + 1);
}

/** The bank's reply to an operation sent without an open session. */
export const needsLogin = (reply) => /autentic/i.test(reply);
