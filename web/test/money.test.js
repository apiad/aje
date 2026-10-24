import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePan, classifyPan, last4, MOBILE_PLANS, parseMobileBalance, parseMobileDetails, parseAmount } from "../core/money.js";

test("a card number is 16 digits, dashes and spaces allowed", () => {
  assert.equal(parsePan("9200-9500 0000-0001"), "9200950000000001");
  assert.throws(() => parsePan("920095000000001"), RangeError);
  assert.equal(last4("9200950000000001"), "0001");
});

test("PAN: bank from digits 5-6, currency from digits 3-4", () => {
  assert.deepEqual(classifyPan("9227 9599 0000 0001"), { pan: "9227959900000001", bank: "METROPOLITANO", currency: "CUP" });
  assert.deepEqual(classifyPan("9225-0699-0000-0001"), { pan: "9225069900000001", bank: "BANDEC", currency: "USD" });
  assert.equal(classifyPan("9235129900000001").currency, "USD");
  for (const d of ["25", "26", "28", "29", "35", "45"]) assert.equal(classifyPan(`92${d}959900000001`).currency, "USD");
  assert.equal(classifyPan("9227129900000001").bank, "BPA");
});

test("PAN with an unknown bank code is refused", () => {
  assert.match(classifyPan("9227779900000001").error, /banco/);
});

test("Clásica and classic business prefixes", () => {
  assert.deepEqual(classifyPan("9760 0300 0000 0001"), { pan: "9760030000000001", bank: "CLASICA", currency: "CUP" });
  assert.equal(classifyPan("9760040000000001").bank, "CLASICAEMP");
});

test("account number: currency from character 15", () => {
  assert.equal(classifyPan("0599000000000011").currency, "CUP");
  assert.equal(classifyPan("0599000000000021").currency, "CUC");
  assert.equal(classifyPan("0599000000000031").currency, "USD");
  assert.match(classifyPan("4000000000000001").error, /número/);
});

test("strips separators", () => {
  assert.equal(classifyPan(" 9227 9599-0000 0001\n").pan, "9227959900000001");
  assert.match(classifyPan("9227 9599").error, /16/);
});

test("mobile plan codes", () => {
  assert.equal(MOBILE_PLANS.PREPAGO, "*222#");
  assert.equal(MOBILE_PLANS.POSPAGO, "*111#");
});

test("prepaid reply yields the Saldo amount", () => {
  const reply = "Saldo: 250.50 CUP. Datos: 3.20 GB. Voz: 01:20:00. SMS: 100. Linea activa hasta 01-01-26 vence 02-02-26.";
  assert.equal(parseMobileBalance(reply), "250.50 CUP");
});

test("postpaid reply yields the first CUP amount", () => {
  const reply = "Voz: Saldo disponible 180.00 CUP. SMS: Saldo disponible 20.00 CUP. Datos: 5000 MB. Roaming:";
  assert.equal(parseMobileBalance(reply), "180.00 CUP");
});

test("a reply without a CUP amount is null", () => {
  assert.equal(parseMobileBalance("Servicio no disponible, intente mas tarde."), null);
});

test("an amount is a positive whole number; decimals and separators are refused, never truncated", () => {
  assert.equal(parseAmount("1500"), 1500);
  assert.equal(parseAmount(" 25 "), 25);
  for (const bad of ["150.50", "1,500", "1.500", "0", "-5", "", "abc", "1e3"]) assert.equal(parseAmount(bad), null, bad);
});

test("a prepaid reply yields every figure the line card shows", () => {
  const reply = "Saldo: 250.50 CUP. Datos: 3.20 GB. Voz: 01:20:00. SMS: 100. Linea activa hasta 01-01-26 vence 02-02-26.";
  assert.deepEqual(parseMobileDetails(reply), {
    balance: "250.50 CUP", data: "3.20 GB", voice: "01:20:00", sms: "100", activeUntil: "01-01-26", expires: "02-02-26",
  });
});

test("a postpaid reply yields the voice and SMS balances and the data", () => {
  const reply = "Voz: Saldo disponible 180.00 CUP. SMS: Saldo disponible 20.00 CUP. Datos: 5000 MB. Roaming:";
  assert.deepEqual(parseMobileDetails(reply), {
    balance: null, data: "5000 MB", voice: "180.00 CUP", sms: "20.00 CUP", activeUntil: null, expires: null,
  });
});

test("a reply with no figure has no details", () => {
  assert.equal(parseMobileDetails("Servicio no disponible, intente mas tarde."), null);
});
