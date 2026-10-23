import { test } from "node:test";
import assert from "node:assert/strict";
import { chargeUri, parseCharge } from "../core/qr.js";

test("a charge round-trips through its QR text", () => {
  const text = chargeUri({ number: "55555555", amount: 150, name: "Ana" });
  assert.equal(text, "aje:saldo?v=1&n=55555555&m=150&a=Ana");
  assert.deepEqual(parseCharge(text), { ok: true, number: "55555555", amount: 150, name: "Ana" });
});

test("amount and name are optional", () => {
  const text = chargeUri({ number: "65555555" });
  assert.equal(text, "aje:saldo?v=1&n=65555555");
  assert.deepEqual(parseCharge(text), { ok: true, number: "65555555", amount: null, name: null });
});

test("a name round-trips", () => {
  const name = "Ñico & Cía = 😀";
  assert.equal(parseCharge(chargeUri({ number: "55555555", name })).name, name);
  assert.equal(parseCharge(chargeUri({ number: "55555555", name: "x".repeat(60) })).name.length, 40);
});

test("parseCharge refuses what it cannot pay", () => {
  assert.deepEqual(parseCharge("aje:saldo?v=2&n=55555555"), { ok: false, reason: "newer" });
  for (const t of ["https://example.com/?n=55555555", "TRANSFERMOVIL_ETECSA,9200000000000001", "", "aje:otra?v=1&n=55555555"]) {
    assert.deepEqual(parseCharge(t), { ok: false, reason: "not-aje" }, t);
  }
  for (const t of ["aje:saldo?v=1&n=7555555", "aje:saldo?v=1&n=55555555&m=10.5", "aje:saldo?v=1&n=55555555&m=-5",
    "aje:saldo?v=1&n=55555555&m=0", "aje:saldo?v=1&m=10", "aje:saldo?n=55555555"]) {
    assert.deepEqual(parseCharge(t), { ok: false, reason: "bad" }, t);
  }
});
