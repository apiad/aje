import { test } from "node:test";
import assert from "node:assert/strict";
import { balance, login, transfer, needsLogin } from "../core/ops.js";
import { dial, display, DEFAULT_CONFIG } from "../core/ussd.js";

const principal = { bank: "METROPOLITANO", currency: "CUP", pan: null };
const values = (c) => c.fields.map((f) => f.value);

test("balance by registered currency", () => {
  assert.equal(dial(balance(principal), DEFAULT_CONFIG, 61), "*444*46*61012*046615*1260416#");
});

test("balance by explicit card", () => {
  const card = { bank: "METROPOLITANO", currency: "USD", pan: "9200950000000000" };
  assert.deepEqual(values(balance(card)), ["0", "9200950000000000"]);
});

test("BANDEC balance is bare", () => {
  assert.deepEqual(balance({ bank: "BANDEC", currency: "CUP", pan: null }), { kind: "bare", op: "46" });
});

test("login sends agency and a masked key", () => {
  const c = login("METROPOLITANO", "1234");
  assert.equal(c.op, "40");
  assert.deepEqual(values(c), ["03", "1234"]);
  assert.deepEqual(c.fields.map((f) => f.secret), [false, true]);
  assert.ok(!display(c, DEFAULT_CONFIG, 5).includes("1234"));
});

test("login refuses a key that is not four digits and a bank with no agency", () => {
  assert.throws(() => login("METROPOLITANO", "12a4"), RangeError);
  assert.throws(() => login("MITRANSFER", "1234"), RangeError);
});

test("transfer from the registered card", () => {
  const c = transfer(principal, "9200950000000001", 1000);
  assert.equal(c.op, "45");
  assert.deepEqual(values(c), ["9200950000000001", "1000", "1", "1", "0000", "0000", "0", "0000", "0"]);
});

test("transfer from an explicit card", () => {
  const from = { bank: "METROPOLITANO", currency: "USD", pan: "9200950000000002" };
  assert.deepEqual(values(transfer(from, "9200950000000001", 25)).slice(2, 5), ["3", "0", "9200950000000002"]);
});

test("transfer amount is a positive whole number", () => {
  assert.throws(() => transfer(principal, "9200950000000001", 0), RangeError);
  assert.throws(() => transfer(principal, "9200950000000001", 1.5), RangeError);
});

test("reply that asks for login", () => {
  assert.ok(needsLogin("Respuesta del banco: Debe autenticarse primero"));
  assert.ok(!needsLogin("Su solicitud esta siendo procesada, espere un SMS"));
});
