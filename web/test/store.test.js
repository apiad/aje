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

test("seen remembers the last 500 keys", async () => {
  const s = await openStore(memoryBackend());
  assert.equal(await s.seen("a"), false);
  assert.equal(await s.seen("a"), true);
  for (let i = 0; i < 500; i++) await s.seen(`k${i}`);
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
  assert.deepEqual(s.state.cards.map((x) => x.removed), [true]);
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
  const line = parseLineSms(SMS.LINE_RECEIVED);
  await s.addReceived({ kind: "line-received", amount: "25.00 CUP", number: line.number, account: null, plan: null }, 5 * MIN);
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

const item = (id, over = {}) => ({ id, kind: "card-received", at: 0, amount: "1500.00 CUP", number: "51234567", account: null, plan: null, rowId: null, state: "pending", ...over });

test("the inbox keeps the newest 200 notices and refuses an id it has", async () => {
  const s = await openStore(memoryBackend());
  assert.deepEqual(s.state.inbox, []);
  for (let i = 0; i < 201; i++) assert.equal(await s.addNotice(item(`n${i}`)), true);
  assert.equal(s.state.inbox.length, 200);
  assert.equal(s.state.inbox[0].id, "n200");
  assert.ok(!s.state.inbox.some((n) => n.id === "n0"));
  assert.equal(await s.addNotice(item("n200")), false);
  assert.equal(s.state.inbox.length, 200);
});

test("pendingNotices counts only pending ones", async () => {
  const s = await openStore(memoryBackend());
  await s.addNotice(item("a"));
  await s.addNotice(item("b"));
  await s.addNotice(item("c"));
  await s.setNoticeState("a", "seen");
  await s.setNoticeState("b", "dismissed");
  assert.equal(s.pendingNotices(), 1);
  assert.equal(s.state.inbox.find((n) => n.id === "a").state, "seen");
});

test("addReceived gives each incoming kind its own row", async () => {
  const s = await openStore(memoryBackend(), { now: () => 0 });
  const n = (kind, over) => ({ kind, amount: null, number: null, account: null, plan: null, ...over });
  const card = await s.addReceived(n("card-received", { amount: "1500.00 CUP", number: "51234567", account: "9200XXXXXXXX0001" }), 1, { cardId: "c1" });
  assert.deepEqual([card.op, card.state, card.to, card.amount, card.currency, card.account, card.cardId], ["in-card", "verified", "51234567", 1500, "CUP", "9200XXXXXXXX0001", "c1"]);
  assert.deepEqual([(await s.addReceived(n("card-received", { amount: "25.00 USD", number: "51234567", account: "x" }), 1)).currency], ["USD"]);
  assert.equal((await s.addReceived(n("recharge-intl", { amount: "500.00 CUP" }), 1)).op, "in-recharge");
  assert.equal((await s.addReceived(n("recharge", { amount: "500.00 CUP" }), 1)).op, "in-recharge");
  const plan = await s.addReceived(n("plan-gift", { plan: "3GB" }), 1);
  assert.deepEqual([plan.op, plan.plan, plan.amount], ["in-plan", "3GB", null]);
  assert.deepEqual([(await s.addReceived(n("recharge-intl", { plan: "10GB" }), 1)).op], ["in-recharge"]);
});

test("a backup's lists are kept whole, and a second import replaces them", async () => {
  const backend = memoryBackend();
  const s = await openStore(backend, { now: () => 42 });
  assert.equal(s.state.imported, null);
  const backup = {
    exportedAt: "23/10/2026 18:44:20", cards: [{ pan: "9227959900000001" }], unreadable: 2,
    recipients: [{ name: "Ana", account: "9227959900000009", phone: "51234567" }],
    bills: [{ kind: "electricity", type: 1, contract: "100001", code: "C1" }],
    onat: [], phones: [{ number: "51234567" }], landlines: [], nauta: [{ user: "ana.perez", type: 1 }],
  };
  await s.saveImported(backup);
  const again = await openStore(backend);
  assert.deepEqual(again.state.imported, {
    at: 42, exportedAt: "23/10/2026 18:44:20", recipients: backup.recipients, bills: backup.bills,
    onat: [], phones: backup.phones, landlines: [], nauta: backup.nauta,
  });
  await again.saveImported({ ...backup, recipients: [{ name: "Ben", account: "9227959900000008", phone: "" }], nauta: [] });
  assert.deepEqual(again.state.imported.recipients.map((r) => r.name), ["Ben"]);
  assert.deepEqual(again.state.imported.nauta, []);
  assert.deepEqual(again.state.cards, []);
});

const CARD = (n) => ({ alias: `Tarjeta ${n}`, pan: `922795990000000${n}`, bank: "METROPOLITANO", currency: "CUP" });

test("removing a card marks it, hands its bills to another card and drops it as the default", async () => {
  let ids = 0;
  const s = await openStore(memoryBackend(), { newId: () => `id${++ids}` });
  const a = await s.addCard(CARD(1));
  const b = await s.addCard(CARD(2));
  const bill = await s.saveBill({ kind: "electricity", alias: "Casa", number: "1", cardId: a.id });
  await s.update({ defaultCard: a.id });
  await s.removeCard(a.id, { billsTo: b.id });
  assert.equal(s.state.cards.find((c) => c.id === a.id).removed, true);
  assert.equal(s.state.bills.find((x) => x.id === bill.id).cardId, b.id);
  assert.equal(s.state.settings.defaultCard, null);
});

test("adding a removed card's number brings it back under the new alias", async () => {
  const s = await openStore(memoryBackend());
  const a = await s.addCard(CARD(1));
  await s.updateCard(a.id, { state: "linked" });
  await s.removeCard(a.id);
  const again = await s.addCard({ ...CARD(1), alias: "Otra vez" });
  assert.deepEqual([again.id, again.alias, again.removed, again.state, s.state.cards.length], [a.id, "Otra vez", false, "linked", 1]);
  await assert.rejects(s.addCard(CARD(1)), /ya está/);
});

test("moveCard swaps a card with its live neighbour, skipping removed ones", async () => {
  const s = await openStore(memoryBackend());
  const [a, b, c] = [await s.addCard(CARD(1)), await s.addCard(CARD(2)), await s.addCard(CARD(3))];
  await s.removeCard(b.id);
  await s.moveCard(c.id, -1);
  assert.deepEqual(s.state.cards.filter((x) => !x.removed).map((x) => x.id), [c.id, a.id]);
  await s.moveCard(c.id, -1);
  assert.deepEqual(s.state.cards.filter((x) => !x.removed).map((x) => x.id), [c.id, a.id]);
});

test("a line keeps an alias and can be hidden", async () => {
  const s = await openStore(memoryBackend());
  await s.setLine(3, { alias: "Trabajo" });
  await s.setLine(3, { hidden: true });
  await s.setLine(3, { alias: "" });
  assert.deepEqual(s.state.settings.lines, { 3: { hidden: true } });
});

test("moveCard moves past the default card, which stays first", async () => {
  const s = await openStore(memoryBackend());
  const [a, d, b] = [await s.addCard(CARD(1)), await s.addCard(CARD(2)), await s.addCard(CARD(3))];
  await s.update({ defaultCard: d.id });
  await s.moveCard(b.id, -1);
  assert.deepEqual(s.state.cards.map((x) => x.id), [b.id, d.id, a.id]);
});
