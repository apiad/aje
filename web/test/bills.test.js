import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNumber, debtQuery, digitsOf, opOf, payBill, titleOf, billStatus } from "../core/bills.js";
import { dial, DEFAULT_CONFIG } from "../core/ussd.js";

const card = { bank: "METROPOLITANO", currency: "CUP", pan: "9227959900000001" };
const values = (c) => c.fields.map((f) => f.value);

test("electricity, phone and gas pay the whole debt from an explicit card", () => {
  assert.deepEqual([payBill({ kind: "electricity", number: "1234567890123" }, card).op, ...values(payBill({ kind: "electricity", number: "1234567890123" }, card))],
    ["41", "1234567890123", "0", "0", "9227959900000001"]);
  assert.deepEqual(values(payBill({ kind: "phone", number: "123456789012345" }, card)), ["123456789012345", "0", "0", "9227959900000001"]);
  assert.deepEqual(values(payBill({ kind: "gas", number: "123456789012" }, card)), ["123456789012", "0", "0", "1", "9227959900000001"]);
});

test("water picks the op by region and sends the amount as 0.0", () => {
  const c = payBill({ kind: "water", number: "12345678901", region: 1 }, card);
  assert.equal(c.op, "19");
  assert.deepEqual(values(c), ["1", "12345678901", "0.0", "1", "0", "9227959900000001"]);
  assert.equal(payBill({ kind: "water", number: "12345678901234", region: 2 }, card).op, "51");
  assert.equal(opOf({ kind: "water", region: 3 }), "21");
  // The 0.0 goes as a text segment, which the encoder accepts.
  assert.match(dial(c, DEFAULT_CONFIG, 7), /^\*444\*19\*07/);
});

test("a Nauta recharge carries the user, the type and a whole amount", () => {
  const c = payBill({ kind: "nauta", number: "ana.perez", nautaType: 2, amount: 100 }, card);
  assert.equal(c.op, "59");
  assert.deepEqual(values(c), ["ana.perez", "2", "100", "0", "0000", "9227959900000001", "1"]);
  assert.throws(() => payBill({ kind: "nauta", number: "ana", amount: 0 }, card), RangeError);
  assert.match(dial(c, DEFAULT_CONFIG, 7), /^\*444\*59\*07/);
});

test("bill numbers are checked by kind, bank and water region", () => {
  assert.deepEqual(digitsOf("electricity", { bank: "METROPOLITANO" }), [13]);
  assert.deepEqual(digitsOf("electricity", { bank: "BPA" }), [11, 13]);
  assert.deepEqual(checkNumber("electricity", "1234 5678 90123", { bank: "METROPOLITANO" }), { number: "1234567890123" });
  assert.match(checkNumber("electricity", "12345678901", { bank: "METROPOLITANO" }).error, /13 dígitos/);
  assert.deepEqual(checkNumber("water", "12345678901234", { region: 2 }), { number: "12345678901234" });
  assert.match(checkNumber("water", "12345678901", { region: 2 }).error, /14 o 16/);
  assert.deepEqual(checkNumber("nauta", " Ana.Perez@nauta.com.cu "), { number: "ana.perez" });
  assert.ok(checkNumber("nauta", "a b").error);
});

test("the debt query sends Metropolitano's type for each kind and the bill number", () => {
  const q = (b) => [debtQuery(b).op, ...values(debtQuery(b))];
  assert.deepEqual(q({ kind: "electricity", number: "1234567890123" }), ["47", "2", "1234567890123"]);
  assert.deepEqual(q({ kind: "phone", number: "123456789012345" }), ["47", "1", "123456789012345"]);
  assert.deepEqual(q({ kind: "gas", number: "123456789012" }), ["47", "11", "123456789012"]);
  assert.deepEqual(q({ kind: "water", number: "12345678901", region: 1 }), ["47", "AGUAHABANA", "12345678901"]);
  assert.deepEqual(q({ kind: "water", number: "12345678901234", region: 2 }), ["47", "AGUAPROVINCIAS", "12345678901234"]);
  assert.throws(() => debtQuery({ kind: "nauta", number: "ana" }), RangeError);
});

test("a bill's title skips an alias that repeats its kind", () => {
  assert.equal(titleOf({ kind: "electricity", alias: "Casa" }), "Luz · Casa");
  assert.equal(titleOf({ kind: "electricity", alias: "Luz" }), "Luz");
});

test("billStatus: never checked, no debt, debt, stale after 72 hours, paid after the last check", () => {
  const H = 3_600_000;
  const now = 1_000 * H;
  assert.deepEqual(billStatus({ kind: "water" }, now), { kind: "never" });
  assert.deepEqual(billStatus({ kind: "water", checked: { at: now - 2 * H, cents: 0 } }, now), { kind: "none", at: now - 2 * H, cents: 0, stale: false });
  assert.deepEqual(billStatus({ kind: "phone", checked: { at: now - H, cents: 8540 } }, now), { kind: "owe", at: now - H, cents: 8540, stale: false });
  assert.equal(billStatus({ kind: "gas", checked: { at: now - 73 * H, cents: 0 } }, now).stale, true);
  assert.equal(billStatus({ kind: "gas", checked: { at: now - H, cents: null } }, now).kind, "unknown");
  const paid = { kind: "electricity", checked: { at: now - 5 * H, cents: 8540 }, paid: { at: now - 4 * H, cents: 8540, verified: false } };
  assert.deepEqual(billStatus(paid, now), { kind: "paid", at: now - 4 * H, cents: 8540, verified: false, stale: false });
  assert.equal(billStatus({ ...paid, checked: { at: now - H, cents: 0 } }, now).kind, "none");
  assert.deepEqual(billStatus({ kind: "nauta" }, now), { kind: "never" });
  assert.equal(billStatus({ kind: "nauta", paid: { at: now - H, cents: 10000, verified: true } }, now).kind, "paid");
});
