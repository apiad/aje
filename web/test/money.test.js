import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePan, bankOfPan, last4, MOBILE_PLANS, parseMobileBalance, parseAmount } from "../core/money.js";

test("a card number is 16 digits, dashes and spaces allowed", () => {
  assert.equal(parsePan("9200-9500 0000-0001"), "9200950000000001");
  assert.throws(() => parsePan("920095000000001"), RangeError);
  assert.equal(last4("9200950000000001"), "0001");
});

test("the bank comes from the prefix", () => {
  assert.equal(bankOfPan("9200950000000001"), "METROPOLITANO");
  assert.equal(bankOfPan("9200120000000001"), "BPA");
  assert.equal(bankOfPan("9200060000000001"), "BANDEC");
  assert.equal(bankOfPan("9760030000000001"), "MITRANSFER");
  assert.equal(bankOfPan("4000000000000001"), null);
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
