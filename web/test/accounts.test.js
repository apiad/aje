import { test } from "node:test";
import assert from "node:assert/strict";
import { accounts, balanceFor } from "../core/accounts.js";

test("the deck lists a card per enabled currency, then a line per SIM", () => {
  const state = {
    settings: { bank: "METROPOLITANO", enabledCurrencies: ["CUP", "USD"], plans: { 4: "POSPAGO" } },
    mobileBalances: { 3: "185.00 CUP" },
    attempts: [],
  };
  const sims = [{ subId: 3, slot: 0, carrier: "Cubacel" }, { subId: 4, slot: 1, carrier: "Cubacel" }];
  const list = accounts(state, sims);
  assert.deepEqual(list.map((a) => a.id), ["card:CUP", "card:USD", "line:3", "line:4"]);
  assert.equal(list[0].label, "Tarjeta CUP");
  assert.equal(list[2].label, "SIM 1 · Cubacel");
  assert.equal(list[2].balance, "185.00 CUP");
  assert.equal(list[2].plan, "PREPAGO");
  assert.equal(list[3].plan, "POSPAGO");
});

test("a card's balance is its currency's latest verified query", () => {
  const attempts = [
    { op: "46", state: "replied", currency: "CUP", available: null },
    { op: "46", state: "verified", currency: "CUP", available: "1200.06 CUP" },
    { op: "46", state: "verified", currency: "CUP", available: "900.00 CUP" },
  ];
  assert.equal(balanceFor(attempts, "CUP"), "1200.06 CUP");
  assert.equal(balanceFor(attempts, "USD"), null);
});
