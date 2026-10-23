import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeNumber, transferBalance, changeKey, validKey, parseLineReply } from "../core/lines.js";
import { DEFAULT_CONFIG, dial, display } from "../core/ussd.js";

test("normalizeNumber", () => {
  for (const raw of ["55555555", "+53 5555 5555", "0053-5555-5555", "(53) 5555 5555", " 65555555\n"]) {
    assert.match(normalizeNumber(raw), /^[56]\d{7}$/, raw);
  }
  for (const raw of ["7555555", "75555555", "5555555", "555555555", "", "abc"]) assert.equal(normalizeNumber(raw), null, raw);
});

test("transferBalance dials the key and displays it masked", () => {
  const c = transferBalance("55555555", "9876", 25);
  assert.equal(dial(c, DEFAULT_CONFIG, 0), "*234*1*55555555*9876*25#");
  assert.equal(display(c, DEFAULT_CONFIG, 0), "*234*1*55555555*••••*25#");
});

test("changeKey masks both keys", () => {
  assert.equal(display(changeKey("1234", "4321"), DEFAULT_CONFIG, 0), "*234*2*••••*••••#");
});

test("validKey", () => {
  assert.ok(validKey("0000"));
  for (const k of ["123", "12345", "12a4", ""]) assert.ok(!validKey(k));
});

test("parseLineReply", () => {
  assert.equal(parseLineReply("Usted ha transferido 25.00 CUP al 55555555."), "ok");
  assert.equal(parseLineReply("Clave incorrecta."), "bad-key");
  assert.equal(parseLineReply("Saldo insuficiente para realizar la operacion."), "no-balance");
  assert.equal(parseLineReply("Ha excedido el limite de transferencias diarias."), "limit");
  assert.equal(parseLineReply("Servicio no disponible"), "unknown");
});
