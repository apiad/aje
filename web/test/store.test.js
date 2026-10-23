import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, memoryBackend } from "../core/store.js";
import { parseBankSms, parseLineSms } from "../core/sms.js";
import { SMS } from "./helpers.js";

const MIN = 60_000;
const attempt = (over) => ({
  id: over.id, startedAt: over.startedAt ?? 0, code: "", state: "sent", op: "46", cardId: "c1",
  to: null, amount: null, transactionId: null, reply: null, failureCode: null,
  accounting: null, available: null, verifiedAt: null, ...over,
});

test("defaults, and a second open keeps the install id and the history", async () => {
  const backend = memoryBackend();
  const a = await openStore(backend, { now: () => 1 });
  assert.equal(a.state.settings.subId, -1);
  assert.deepEqual(a.state.cards, []);
  assert.deepEqual(a.state.banks, {});
  assert.equal(a.planFor(3), "PREPAGO");
  await a.add(attempt({ id: 7 }));
  const b = await openStore(backend);
  assert.equal("installId" in b.state, false);
  assert.equal(b.state.attempts[0].id, 7);
});

test("history keeps the newest fifty", async () => {
  const s = await openStore(memoryBackend());
  for (let i = 0; i < 55; i++) await s.add(attempt({ id: i }));
  assert.equal(s.state.attempts.length, 50);
  assert.equal(s.state.attempts[0].id, 54);
});

test("a balance SMS verifies the latest pending query inside twenty minutes", async () => {
  const s = await openStore(memoryBackend());
  const card = await s.addCard(metro);
  await s.add(attempt({ id: 1, startedAt: 0, cardId: card.id }));
  const latency = await s.verifyBalance(parseBankSms(SMS.BALANCE), 5 * MIN);
  assert.equal(latency, 5 * MIN);
  assert.equal(s.state.attempts[0].state, "verified");
  assert.equal(s.state.attempts[0].available, "1200.06 CUP");
});

test("a balance SMS outside the window adds its own verified row", async () => {
  const s = await openStore(memoryBackend());
  await s.add(attempt({ id: 1, startedAt: 0 }));
  assert.equal(await s.verifyBalance(parseBankSms(SMS.BALANCE), 21 * MIN), null);
  assert.equal(s.state.attempts.length, 2);
  assert.equal(s.state.attempts[0].state, "verified");
  assert.equal(s.state.attempts[1].state, "sent");
});

test("a transfer SMS verifies the pending transfer to that card for that amount", async () => {
  const s = await openStore(memoryBackend());
  await s.add(attempt({ id: 1, op: "45", state: "dialer", to: "9200950000000002", amount: 100 }));
  await s.add(attempt({ id: 2, op: "45", state: "dialer", to: "9200950000000001", amount: 100 }));
  assert.equal(await s.verifyTransfer(parseBankSms(SMS.TRANSFER), MIN), MIN);
  const byId = Object.fromEntries(s.state.attempts.map((a) => [a.id, a]));
  assert.equal(byId[2].state, "verified");
  assert.equal(byId[2].transactionId, "AB0000XYZ0001");
  assert.equal(byId[2].available, "1134.56 CUP");
  assert.equal(byId[1].state, "dialer");
});

test("seen remembers the last fifty keys", async () => {
  const s = await openStore(memoryBackend());
  assert.equal(await s.seen("a"), false);
  assert.equal(await s.seen("a"), true);
  for (let i = 0; i < 50; i++) await s.seen(`k${i}`);
  assert.equal(await s.seen("a"), false);
});

test("subscribers hear every change", async () => {
  const s = await openStore(memoryBackend());
  let calls = 0;
  const off = s.subscribe(() => calls++);
  await s.update({ currency: "USD" });
  off();
  await s.update({ currency: "CUP" });
  assert.equal(calls, 1);
  assert.equal(s.state.settings.currency, "CUP");
});

const metro = { alias: "Metro CUP", pan: "9227959900000001", bank: "METROPOLITANO", currency: "CUP" };
const bandec = { alias: "BANDEC CUP", pan: "9227069900000001", bank: "BANDEC", currency: "CUP" };

test("a card is added pending at step 1, and a number already stored is refused", async () => {
  let n = 0;
  const s = await openStore(memoryBackend(), { newId: () => `id${++n}` });
  const c = await s.addCard(metro);
  assert.deepEqual(c, { id: "id1", ...metro, state: "pending", step: 1 });
  await assert.rejects(s.addCard({ ...metro, alias: "otra" }), /ya está/);
  await s.updateCard(c.id, { state: "linked" });
  assert.equal(s.state.cards[0].state, "linked");
  await s.removeCard(c.id);
  assert.deepEqual(s.state.cards, []);
});

test("a bank's record is patched, and authenticated is per bank", async () => {
  const s = await openStore(memoryBackend());
  await s.setBank("BANDEC", { registered: true });
  await s.authenticated("BANDEC", 42);
  assert.deepEqual(s.state.banks.BANDEC, { registered: true, authenticatedAt: 42 });
});

test("a balance SMS verifies the pending query of a card of its bank", async () => {
  const s = await openStore(memoryBackend());
  const m = await s.addCard(metro);
  const b = await s.addCard(bandec);
  await s.add(attempt({ id: 1, startedAt: 0, cardId: m.id }));
  await s.add(attempt({ id: 2, startedAt: 1, cardId: b.id }));
  await s.verifyBalance(parseBankSms(SMS.BALANCE), 5 * MIN);
  assert.equal(s.state.attempts.find((a) => a.id === 1).state, "verified");
  assert.equal(s.state.attempts.find((a) => a.id === 2).state, "sent");
});

test("verifyBalance picks the latest pending card", async () => {
  const s = await openStore(memoryBackend());
  const m = await s.addCard(metro);
  const m2 = await s.addCard({ ...metro, pan: "9227959900000002" });
  await s.add(attempt({ id: 1, startedAt: 0, cardId: m.id }));
  await s.add(attempt({ id: 2, startedAt: 1, cardId: m2.id }));
  await s.verifyBalance(parseBankSms(SMS.BALANCE), 5 * MIN);
  assert.deepEqual(s.state.attempts.map((a) => a.state), ["verified", "sent"]);
});

test("old settings keys are dropped on load", async () => {
  const s = await openStore(memoryBackend({ settings: { bank: "BPA", currency: "USD", enabledCurrencies: ["CUP"], subId: 3 } }));
  assert.equal(s.state.settings.subId, 3);
  assert.equal("bank" in s.state.settings, false);
  assert.equal("enabledCurrencies" in s.state.settings, false);
  assert.equal("currency" in s.state.settings, false);
});

test("an auth from a bank marks it registered; a bank only patched otherwise stays unknown", async () => {
  const s = await openStore(memoryBackend());
  await s.authenticated("METROPOLITANO", 7);
  assert.deepEqual(s.state.banks.METROPOLITANO, { registered: true, authenticatedAt: 7 });
  await s.setBank("BPA", { authenticatedAt: null });
  assert.equal(s.state.banks.BPA.registered, null);
});

test("the update channel defaults to stable, and the last check is kept", async () => {
  const backend = memoryBackend();
  const s = await openStore(backend);
  assert.equal(s.state.settings.channel, "stable");
  assert.deepEqual(s.state.update, { checkedAt: null, available: null });
  await s.setUpdate({ checkedAt: 9, available: { version: "1.0.1" } });
  assert.equal((await openStore(backend)).state.update.available.version, "1.0.1");
});

test("verifyLineTransfer matches number and amount", async () => {
  const s = await openStore(memoryBackend(), { now: () => 0 });
  await s.add(attempt({ id: 1, op: "234", subId: 3, to: "56666666", amount: 10, startedAt: 1 * MIN }));
  await s.add(attempt({ id: 2, op: "234", subId: 3, to: "55555555", amount: 25, startedAt: 2 * MIN }));
  assert.deepEqual(await s.verifyLineTransfer(parseLineSms(SMS.LINE_SENT), 3 * MIN), { latencyMs: MIN, subId: 3 });
  assert.equal(s.state.attempts.find((a) => a.id === 2).state, "verified");
  assert.equal(s.state.attempts.find((a) => a.id === 1).state, "sent");
});

test("verifyLineTransfer ignores old attempts", async () => {
  const s = await openStore(memoryBackend(), { now: () => 0 });
  await s.add(attempt({ id: 1, op: "234", subId: 3, to: "55555555", amount: 25, startedAt: 0 }));
  assert.equal(await s.verifyLineTransfer(parseLineSms(SMS.LINE_SENT), 21 * MIN), null);
  assert.equal(s.state.attempts[0].state, "sent");
});

test("addReceived records an incoming transfer", async () => {
  const s = await openStore(memoryBackend(), { now: () => 0 });
  await s.add(attempt({ id: 1 }));
  await s.addReceived(parseLineSms(SMS.LINE_RECEIVED), 5 * MIN);
  const a = s.state.attempts[0];
  assert.deepEqual([a.op, a.state, a.to, a.amount, a.verifiedAt], ["234-in", "verified", "56666666", 25, 5 * MIN]);
});

test("lineNumbers persist", async () => {
  const backend = memoryBackend();
  const a = await openStore(backend);
  assert.deepEqual(a.state.settings.lineNumbers, {});
  await a.setLineNumber(3, "55555555");
  const b = await openStore(backend);
  assert.deepEqual(b.state.settings.lineNumbers, { 3: "55555555" });
});
