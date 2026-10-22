import { test } from "node:test";
import assert from "node:assert/strict";
import { accounts, balanceFor } from "../core/accounts.js";

test("the deck lists the stored cards in order, then a line per SIM", () => {
  const state = {
    settings: { plans: { 4: "POSPAGO" } },
    cards: [
      { id: "a", alias: "Metro CUP", pan: "9227959900000001", bank: "METROPOLITANO", currency: "CUP", state: "linked", step: 5 },
      { id: "b", alias: "BANDEC CUP", pan: "9227069900000001", bank: "BANDEC", currency: "CUP", state: "pending", step: 2 },
    ],
    mobileBalances: { 3: "185.00 CUP" },
    attempts: [],
  };
  const sims = [{ subId: 3, slot: 0, carrier: "Cubacel" }, { subId: 4, slot: 1, carrier: "Cubacel" }];
  const list = accounts(state, sims);
  assert.deepEqual(list.map((a) => a.id), ["card:a", "card:b", "line:3", "line:4"]);
  assert.equal(list[0].label, "Metro CUP");
  assert.equal(list[0].cardId, "a");
  assert.equal(list[0].pan, "9227959900000001");
  assert.equal(list[1].pending, true);
  assert.equal(list[2].label, "SIM 1 · Cubacel");
  assert.equal(list[2].balance, "185.00 CUP");
  assert.equal(list[3].plan, "POSPAGO");
});

test("a card's balance is its latest verified query", () => {
  const attempts = [
    { op: "46", state: "replied", cardId: "a", available: null },
    { op: "46", state: "verified", cardId: "a", available: "1200.06 CUP" },
    { op: "46", state: "verified", cardId: "a", available: "900.00 CUP" },
  ];
  assert.equal(balanceFor(attempts, "a"), "1200.06 CUP");
  assert.equal(balanceFor(attempts, "b"), null);
});
