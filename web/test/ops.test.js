import { test } from "node:test";
import assert from "node:assert/strict";
import { associateClasica, balance, clasicaBalance, clasicaMovements, clasicaTransfer, drawCoordinate, link, login, register, transfer, needsLogin } from "../core/ops.js";
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

const person = { card: "9227959900000001", name: "Ana", surname1: "Gil", surname2: "Paz", ci: "00000000000" };

test("register: op 49 with each bank's fields", () => {
  assert.equal(register("METROPOLITANO", person).op, "49");
  assert.deepEqual(values(register("METROPOLITANO", person)), ["03", person.card, "Ana", "Gil", "Paz", person.ci]);
  assert.deepEqual(values(register("BPA", person)), ["01", person.card, "Ana", "Gil", "Paz", person.ci]);
  assert.deepEqual(values(register("BANDEC", person)), ["02", person.card, "Ana", person.ci]);
  assert.throws(() => register("MITRANSFER", person), RangeError);
});

test("link: op 60, card * coordinate * value, value secret", () => {
  const c = link("METROPOLITANO", "9227959900000002", "D7", "1234");
  assert.equal(c.op, "60");
  assert.deepEqual(values(c), ["9227959900000002", "D7", "1234"]);
  assert.deepEqual(c.fields.map((f) => f.secret), [false, false, true]);
  assert.match(display(c, DEFAULT_CONFIG, 7), /••••/);
  assert.doesNotMatch(display(c, DEFAULT_CONFIG, 7), /1234/);
});

test("link: BPA sends the card only; other banks need the coordinate", () => {
  assert.deepEqual(values(link("BPA", "9227129900000002")), ["9227129900000002"]);
  assert.throws(() => link("BANDEC", "9227069900000002"), RangeError);
});

const clasica = { bank: "CLASICA", currency: "CUP", pan: "9760030000000001" };

test("associateClasica: op 111, agency * account * authorization * terminal", () => {
  const c = associateClasica(clasica.pan, "044915", "00014049");
  assert.equal(c.op, "111");
  assert.deepEqual(values(c), ["08", "9760030000000001", "044915", "00014049"]);
});

test("associateClasica refuses a wrong number, authorization or terminal", () => {
  assert.throws(() => associateClasica("9200950000000001", "044915", "00014049"), RangeError);
  assert.throws(() => associateClasica(clasica.pan, "4491", "00014049"), RangeError);
  assert.throws(() => associateClasica(clasica.pan, "044915", "140"), RangeError);
});

test("Clásica balance and movements are type * account * bag", () => {
  assert.equal(clasicaBalance(clasica).op, "46");
  assert.deepEqual(values(clasicaBalance(clasica)), ["1", "9760030000000001", "1"]);
  assert.equal(clasicaMovements(clasica).op, "48");
  assert.deepEqual(values(clasicaMovements(clasica)), ["1", "9760030000000001", "1"]);
});

test("Clásica transfer: op 45, eight fields, no key", () => {
  const c = clasicaTransfer(clasica, "53000000", 500);
  assert.equal(c.op, "45");
  assert.deepEqual(values(c), ["1", "9760030000000001", "53000000", "500", "0", "0", "0", "1"]);
  assert.ok(c.fields.every((f) => !f.secret));
  assert.throws(() => clasicaTransfer(clasica, "53000000", 0), RangeError);
});

test("drawCoordinate covers A-J by 1-10", () => {
  assert.equal(drawCoordinate(() => 0), "A1");
  assert.equal(drawCoordinate(() => 0.999), "J10");
});
