import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, memoryBackend } from "../core/store.js";
import { openTelemetry } from "../core/telemetry.js";
import { createWorkflow } from "../core/workflow.js";
import { balanceFor } from "../core/accounts.js";
import { fakeBridge, SMS, POSTPAID_REPLY } from "./helpers.js";
import { balance as balanceCode, link as linkCode } from "../core/ops.js";
import { DEFAULT_CONFIG, dial } from "../core/ussd.js";

const MIN = 60_000;
const METRO_CARD = { alias: "Metro CUP", pan: "9227959900000001", bank: "METROPOLITANO", currency: "CUP" };
const tick = () => new Promise((r) => setImmediate(r));

async function world(replies = [], stateBackend = memoryBackend(), bridgeOptions = {}) {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  let ids = 0;
  const store = await openStore(stateBackend, { now, newId: () => (ids++ === 0 ? "install-1" : `card-${ids}`) });
  await store.update({ telemetry: true, subId: 3 });
  const card = store.state.cards[0] ?? await store.addCard(METRO_CARD);
  const telemetryBackend = memoryBackend();
  const posted = [];
  const telemetry = await openTelemetry({
    config: { app: "test", telemetryUrl: "https://collector.example/e", telemetryToken: "tok" },
    store, backend: telemetryBackend, now, userAgent: "Mozilla/5.0 (Linux; Android 14; Test Phone)",
    fetch: async (url, init) => { posted.push(init.body); return { ok: true, status: 204 }; },
  });
  const bridge = fakeBridge(replies, bridgeOptions);
  const wf = createWorkflow({ bridge, store, telemetry, now, seed: () => 61 });
  const sms = (body, sender = "PAGOxMOVIL") => wf.handleSms({ sender, body, receivedAt: clock.t });
  return { card, clock, now, store, telemetry, telemetryBackend, stateBackend, bridge, wf, posted, sms };
}

test("a balance query goes out on the chosen SIM and the SMS verifies it", async () => {
  const w = await world([{ ok: true, reply: "Su solicitud esta siendo procesada, espere un SMS" }]);
  const { needsLogin } = await w.wf.balance(w.card.id);
  assert.equal(needsLogin, false);
  assert.deepEqual(w.bridge.calls[0], { method: "sendUssd", args: { subId: 3, code: dial(balanceCode(METRO_CARD), DEFAULT_CONFIG, 61) } });
  assert.equal(w.store.state.attempts[0].state, "replied");
  w.clock.t += 30_000;
  await w.sms(SMS.BALANCE);
  assert.equal(w.store.state.attempts[0].state, "verified");
  assert.equal(balanceFor(w.store.state.attempts, w.card.id), "1200.06 CUP");
});

test("'debe autenticarse' asks for login, and the auth SMS reruns the balance", async () => {
  const w = await world([
    { ok: true, reply: "Debe autenticarse primero" },
    { ok: true, reply: "Su solicitud esta siendo procesada" },
    { ok: true, reply: "Su solicitud esta siendo procesada, espere un SMS" },
  ]);
  assert.equal((await w.wf.balance(w.card.id)).needsLogin, true);
  await w.wf.login("METROPOLITANO", "1234", { retryCardId: w.card.id });
  await w.sms(SMS.AUTH);
  assert.equal(w.bridge.calls.length, 3);
  assert.ok(w.bridge.calls[1].args.code.startsWith("*444*40*"));
  assert.ok(w.bridge.calls[2].args.code.startsWith("*444*46*"));
  assert.equal(w.store.state.retryBalance, null);
  assert.equal(w.store.state.banks.METROPOLITANO.authenticatedAt, w.clock.t);
});

test("a stale auth SMS does not rerun the balance", async () => {
  const w = await world([{ ok: true, reply: "ok" }]);
  await w.wf.login("METROPOLITANO", "1234", { retryCardId: w.card.id });
  w.clock.t += 21 * MIN;
  await w.sms(SMS.AUTH);
  assert.equal(w.bridge.calls.length, 1);
});

test("the PIN never reaches the store, the history or the telemetry", async () => {
  const w = await world([{ ok: true, reply: "Usted esta siendo autenticado" }]);
  await w.wf.login("METROPOLITANO", "4321");
  await w.telemetry.idle();
  const dialed = w.bridge.calls[0].args.code;
  const kept = JSON.stringify([w.store.state, w.stateBackend.saved, w.telemetryBackend.saved, w.posted]);
  assert.ok(!kept.includes("4321"));
  assert.ok(!kept.includes(dialed));
  assert.ok(w.store.state.attempts.every((a) => a.op !== "40"));
});

test("a transfer is dialed and the bank's SMS verifies it", async () => {
  const w = await world();
  await w.wf.transfer(w.card.id, "9200950000000001", 100);
  assert.equal(w.bridge.calls[0].method, "dial");
  assert.ok(w.bridge.calls[0].args.code.startsWith("*444*45*"));
  assert.equal(w.store.state.attempts[0].state, "dialer");
  await w.sms(SMS.TRANSFER);
  assert.equal(w.store.state.attempts[0].state, "verified");
  assert.equal(w.store.state.attempts[0].transactionId, "AB0000XYZ0001");
});

test("a transfer whose dial fails is marked failed, not left pending", async () => {
  const w = await world([], memoryBackend(), { dialFails: true });
  const a = await w.wf.transfer(w.card.id, "9200950000000001", 100);
  assert.equal(a.state, "failed");
  assert.equal(w.store.state.attempts[0].state, "failed");
  assert.equal(w.store.state.attempts[0].failureCode, -100);
});

test("a transfer SMS for another card verifies nothing", async () => {
  const w = await world();
  await w.wf.transfer(w.card.id, "9200950000000002", 100);
  await w.sms(SMS.TRANSFER);
  assert.equal(w.store.state.attempts[0].state, "dialer");
});

test("the mobile balance dials the line's plan and keeps the figure", async () => {
  const w = await world([{ ok: true, reply: POSTPAID_REPLY }]);
  await w.store.setPlan(3, "POSPAGO");
  const r = await w.wf.mobileBalance(3);
  assert.deepEqual(w.bridge.calls[0].args, { subId: 3, code: "*111#" });
  assert.equal(r.value, "180.00 CUP");
  assert.equal(w.store.state.mobileBalances[3], "180.00 CUP");
  assert.deepEqual(w.store.state.mobileDetails[3], {
    balance: null, data: "5000 MB", voice: "180.00 CUP", sms: "20.00 CUP", activeUntil: null, expires: null, at: w.clock.t,
  });
});

// Review focus 1: the SMS arrives after the app was killed behind the dialer.
test("the SMS that arrives after a restart still verifies the transfer", async () => {
  const backend = memoryBackend();
  const a = await world([], backend);
  await a.wf.transfer(a.card.id, "9200950000000001", 100);
  const b = await world([], backend);
  b.clock.t = a.clock.t + 25 * MIN;
  await b.wf.handleSms({ sender: "PAGOxMOVIL", body: SMS.TRANSFER, receivedAt: a.clock.t + 3 * MIN });
  assert.equal(b.store.state.attempts[0].state, "verified");
});

test("an SMS that arrived after the window verifies nothing, however soon it is read", async () => {
  const w = await world();
  await w.wf.transfer(w.card.id, "9200950000000001", 100);
  await w.wf.handleSms({ sender: "PAGOxMOVIL", body: SMS.TRANSFER, receivedAt: w.clock.t + 21 * MIN });
  assert.equal(w.store.state.attempts.at(-1).state, "dialer");
});

// Review focus 1, auth side: a queued auth SMS read hours later must not send op 46 on its own.
test("a queued auth SMS read hours later does not rerun the balance", async () => {
  const w = await world([{ ok: true, reply: "ok" }]);
  await w.wf.login("METROPOLITANO", "1234", { retryCardId: w.card.id });
  const loggedAt = w.clock.t;
  w.clock.t += 5 * 60 * MIN;
  await w.wf.handleSms({ sender: "PAGOxMOVIL", body: SMS.AUTH, receivedAt: loggedAt + MIN });
  assert.equal(w.bridge.calls.length, 1);
  assert.equal(w.store.state.retryBalance, null);
});

// Review focus 2: the queue drain and the live push deliver the same SMS.
test("an SMS delivered twice verifies once and adds one row", async () => {
  const w = await world();
  await w.sms(SMS.BALANCE);
  await w.sms(SMS.BALANCE);
  assert.equal(w.store.state.attempts.length, 1);
});

// Review focus 3: the USSD reply lands after the SMS.
test("a broadcast repeated with a new arrival time verifies once", async () => {
  const w = await world();
  await w.wf.handleSms({ sender: "PAGOxMOVIL", body: SMS.BALANCE, sentAt: 7, receivedAt: w.clock.t });
  await w.wf.handleSms({ sender: "PAGOxMOVIL", body: SMS.BALANCE, sentAt: 7, receivedAt: w.clock.t + 1 });
  assert.equal(w.store.state.attempts.length, 1);
});

test("two different texts in the same millisecond are both handled", async () => {
  const w = await world();
  await w.wf.handleSms({ sender: "PAGOxMOVIL", body: SMS.BALANCE, sentAt: 7, receivedAt: w.clock.t });
  await w.wf.handleSms({ sender: "PAGOxMOVIL", body: SMS.BALANCE.replace("1200.06", "1200.07"), sentAt: 7, receivedAt: w.clock.t });
  assert.equal(w.store.state.attempts.length, 2);
});

test("a reply that arrives after the SMS keeps the attempt verified", async () => {
  let release;
  const w = await world([() => new Promise((r) => (release = r))]);
  const pending = w.wf.balance(w.card.id);
  await tick();
  await w.sms(SMS.BALANCE);
  release({ ok: true, reply: "Su solicitud esta siendo procesada" });
  await pending;
  assert.equal(w.store.state.attempts[0].state, "verified");
  assert.equal(w.store.state.attempts[0].reply, "Su solicitud esta siendo procesada");
});

// Review focus 5: the phone does not send the code.
test("a failed send marks the attempt failed with its code", async () => {
  const w = await world([{ ok: false, failureCode: -1, error: null }]);
  await w.wf.balance(w.card.id);
  assert.equal(w.store.state.attempts[0].state, "failed");
  assert.equal(w.store.state.attempts[0].failureCode, -1);
});

test("a bridge call that rejects fails the attempt with -100", async () => {
  const w = await world([() => Promise.reject(new Error("bad code"))]);
  await w.wf.balance(w.card.id);
  assert.equal(w.store.state.attempts[0].state, "failed");
  assert.equal(w.store.state.attempts[0].failureCode, -100);
});

test("a login whose bridge call rejects clears the pending retry", async () => {
  const w = await world([() => Promise.reject(new Error("bad code"))]);
  const r = await w.wf.login("METROPOLITANO", "1234", { retryCardId: w.card.id });
  assert.deepEqual([r.ok, r.failureCode], [false, -100]);
  assert.equal(w.store.state.retryBalance, null);
});

test("a failed login clears the pending retry", async () => {
  const w = await world([{ ok: false, failureCode: -100, error: "SecurityException" }]);
  const r = await w.wf.login("METROPOLITANO", "1234", { retryCardId: w.card.id });
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, -100);
  assert.equal(w.store.state.retryBalance, null);
});

test("a text from a person is dropped and never stored or reported", async () => {
  const w = await world();
  assert.equal(await w.sms("Hola, nos vemos mañana", "55555555"), null);
  await w.telemetry.idle();
  assert.ok(!JSON.stringify([w.store.state, w.posted]).includes("Hola"));
});

test("a login with remember keeps the PIN in the device store for 180 days, under the bank", async () => {
  const w = await world([{ ok: true, reply: "Usted esta siendo autenticado" }]);
  const r = await w.wf.login("METROPOLITANO", "4321", { remember: true });
  assert.equal(r.remembered, true);
  assert.deepEqual(w.bridge.calls.at(-1), { method: "secretSave", args: { name: "pin:METROPOLITANO", days: 180 } });
  assert.deepEqual(await w.wf.savedPin("METROPOLITANO"), { available: true, saved: true, expiresAt: 180 * 86_400_000 });
});

test("a login the phone did not send does not remember the PIN", async () => {
  const w = await world([{ ok: false, failureCode: -1, error: null }]);
  await w.wf.login("METROPOLITANO", "4321", { remember: true });
  assert.ok(w.bridge.calls.every((c) => c.method !== "secretSave"));
  assert.equal((await w.wf.savedPin("METROPOLITANO")).saved, false);
});

test("a saved PIN logs in after the device unlocks it", async () => {
  const w = await world([{ ok: true, reply: "ok" }, { ok: true, reply: "Usted esta siendo autenticado" }]);
  await w.wf.login("METROPOLITANO", "4321", { remember: true });
  const r = await w.wf.loginWithSaved("METROPOLITANO", { retryCardId: w.card.id });
  assert.equal(r.ok, true);
  const dialed = w.bridge.calls.filter((c) => c.method === "sendUssd");
  assert.equal(dialed.length, 2);
  assert.equal(dialed[1].args.code, dialed[0].args.code);
  assert.equal(w.store.state.retryBalance.cardId, w.card.id);
});

test("a cancelled unlock sends nothing and asks for the PIN", async () => {
  const w = await world([], memoryBackend(), { unlock: false });
  const r = await w.wf.loginWithSaved("METROPOLITANO", { retryCardId: w.card.id });
  assert.equal(r, null);
  assert.ok(w.bridge.calls.every((c) => c.method !== "sendUssd"));
  assert.equal(w.store.state.retryBalance, null);
});

test("forgetting the PIN removes it from the device store", async () => {
  const w = await world([{ ok: true, reply: "ok" }]);
  await w.wf.login("METROPOLITANO", "4321", { remember: true });
  await w.wf.forgetPin("METROPOLITANO");
  assert.equal((await w.wf.savedPin("METROPOLITANO")).saved, false);
});

test("a shell with no secret store offers no remembering", async () => {
  const w = await world([{ ok: true, reply: "ok" }], memoryBackend(), { secrets: false });
  assert.deepEqual(await w.wf.savedPin("METROPOLITANO"), { available: false, saved: false, expiresAt: null });
  assert.equal((await w.wf.login("METROPOLITANO", "4321", { remember: true })).remembered, false);
  assert.equal(await w.wf.loginWithSaved("METROPOLITANO"), null);
});

test("a remembered PIN still never reaches the store, the history or the telemetry", async () => {
  const w = await world([{ ok: true, reply: "ok" }, { ok: true, reply: "ok" }]);
  await w.wf.login("METROPOLITANO", "4321", { remember: true });
  await w.wf.loginWithSaved("METROPOLITANO");
  await w.telemetry.idle();
  const kept = JSON.stringify([w.store.state, w.stateBackend.saved, w.telemetryBackend.saved, w.posted]);
  assert.ok(!kept.includes("4321"));
});

test("balance sends 0*pan", async () => {
  const w = await world([{ ok: true, reply: "ok" }]);
  await w.wf.balance(w.card.id);
  assert.equal(w.bridge.calls[0].args.code, dial(balanceCode({ bank: "METROPOLITANO", pan: METRO_CARD.pan }), DEFAULT_CONFIG, 61));
  assert.equal(w.store.state.attempts[0].cardId, w.card.id);
});

test("pin key per bank", async () => {
  const w = await world([{ ok: true, reply: "ok" }, { ok: true, reply: "ok" }]);
  await w.wf.login("METROPOLITANO", "1234", { remember: true });
  await w.wf.login("BANDEC", "5678", { remember: true });
  const saved = w.bridge.calls.filter((c) => c.method === "secretSave").map((c) => c.args.name);
  assert.deepEqual(saved, ["pin:METROPOLITANO", "pin:BANDEC"]);
});

test("linkCard asks for login first", async () => {
  const w = await world([]);
  const r = await w.wf.linkCard(w.card.id, "D7", "1234");
  assert.equal(r.needsLogin, true);
  assert.equal(w.bridge.calls.length, 0);
});

test("linkCard sends op 60 and links on a confirming reply", async () => {
  const w = await world([{ ok: true, reply: "Su cuenta ha sido asociada satisfactoriamente" }]);
  await w.store.authenticated("METROPOLITANO", w.clock.t);
  const r = await w.wf.linkCard(w.card.id, "D7", "1234");
  assert.equal(r.ok, true);
  assert.equal(w.bridge.calls[0].args.code, dial(linkCode("METROPOLITANO", METRO_CARD.pan, "D7", "1234"), DEFAULT_CONFIG, 61));
  assert.equal(w.store.state.cards[0].state, "linked");
});

test("linkCard keeps a card pending on a reply it does not know", async () => {
  const w = await world([{ ok: true, reply: "Operacion no permitida" }]);
  await w.store.authenticated("METROPOLITANO", w.clock.t);
  const r = await w.wf.linkCard(w.card.id, "D7", "1234");
  assert.equal(r.ok, false);
  assert.equal(r.reply, "Operacion no permitida");
  assert.equal(w.store.state.cards[0].state, "pending");
});

test("linkCard keeps the value out of history and telemetry", async () => {
  const w = await world([{ ok: true, reply: "asociada" }]);
  await w.store.authenticated("METROPOLITANO", w.clock.t);
  await w.wf.linkCard(w.card.id, "D7", "8642");
  await w.telemetry.idle();
  const kept = JSON.stringify([w.store.state, w.stateBackend.saved, w.telemetryBackend.saved, w.posted]);
  assert.ok(!kept.includes("8642"));
  assert.ok(!kept.includes(w.bridge.calls[0].args.code));
});

test("registerBank marks the bank on a known reply", async () => {
  const w = await world([{ ok: true, reply: "Su solicitud de registro esta siendo procesada" }]);
  const person = { card: "9227069900000009", name: "Ana", ci: "00000000000" };
  const r = await w.wf.registerBank("BANDEC", person);
  assert.equal(r.ok, true);
  assert.ok(w.bridge.calls[0].args.code.startsWith("*444*49*"));
  assert.equal(w.store.state.banks.BANDEC.registered, true);
  await w.telemetry.idle();
  assert.ok(!JSON.stringify([w.store.state, w.posted]).includes("00000000000"));
});

test("an auth SMS records its own bank", async () => {
  const w = await world([]);
  await w.sms(SMS.AUTH);
  assert.equal(w.store.state.banks.METROPOLITANO.authenticatedAt, w.clock.t);
});

const CLASICA_CARD = { alias: "Mi Clásica", pan: "9760030000000001", bank: "CLASICA", currency: "CUP" };

test("a Clásica associates, then its balance and movements go out under agency 08", async () => {
  const w = await world([
    { ok: true, reply: "Su solicitud esta siendo procesada" },
    { ok: true, reply: "Saldo de la cuenta: 500.00 CUP" },
    { ok: true, reply: "Ultimas operaciones: ..." },
  ]);
  const card = await w.store.addCard(CLASICA_CARD);
  const assoc = await w.wf.associateClasica(card.id, "044915", "00014049");
  assert.equal(assoc.ok, true);
  assert.equal(w.store.state.cards.find((c) => c.id === card.id).state, "associated");
  assert.ok(w.bridge.calls[0].args.code.startsWith("*444*111*"));

  await w.wf.balance(card.id);
  assert.ok(w.bridge.calls[1].args.code.startsWith("*444*46*"));
  assert.equal(w.store.state.attempts[0].op, "46");

  const mov = await w.wf.movements(card.id);
  assert.equal(mov.ok, true);
  assert.ok(w.bridge.calls[2].args.code.startsWith("*444*48*"));
  assert.equal(w.store.state.attempts[0].op, "48");
  assert.equal(w.store.state.attempts[0].reply, "Ultimas operaciones: ...");
});

test("a Clásica without a MiTransfer session is told to log in, not marked associated", async () => {
  const w = await world([{ ok: true, reply: "No es posible realizar la operacion. Debe autenticarse." }]);
  const card = await w.store.addCard(CLASICA_CARD);
  const r = await w.wf.associateClasica(card.id, "044915", "00014049");
  assert.deepEqual(r, { ok: false, needsLogin: true, reply: "No es posible realizar la operacion. Debe autenticarse." });
  assert.equal(w.store.state.cards.find((c) => c.id === card.id).state, "pending");
  assert.equal(w.wf.sessionOf("CLASICA"), "MITRANSFER");
});

test("a MiTransfer login opens the session on its reply and reruns a pending balance", async () => {
  const w = await world([
    { ok: true, reply: "Usted esta siendo autenticado" },
    { ok: true, reply: "Saldo de la cuenta: 500.00 CUP" },
  ]);
  const card = await w.store.addCard(CLASICA_CARD);
  const r = await w.wf.login("MITRANSFER", "1234", { retryCardId: card.id });
  assert.equal(r.ok, true);
  assert.ok(w.bridge.calls[0].args.code.startsWith("*444*40*"));
  assert.equal(w.store.state.banks.MITRANSFER.authenticatedAt, w.clock.t);
  assert.ok(w.bridge.calls[1].args.code.startsWith("*444*46*"));
  assert.equal(w.store.state.retryBalance, null);
});

test("a refused MiTransfer login opens no session", async () => {
  const w = await world([{ ok: true, reply: "Clave incorrecta" }]);
  await w.wf.login("MITRANSFER", "1234");
  assert.equal(w.store.state.banks.MITRANSFER?.authenticatedAt ?? null, null);
});

test("a bank login still waits for the SMS", async () => {
  const w = await world([{ ok: true, reply: "Usted esta siendo autenticado" }]);
  await w.wf.login("METROPOLITANO", "1234");
  assert.equal(w.store.state.banks.METROPOLITANO?.authenticatedAt ?? null, null);
});

test("MiTransfer registration marks it registered and keeps neither the carné nor the key", async () => {
  const w = await world([{ ok: true, reply: "Su solicitud de registro esta siendo procesada" }]);
  const r = await w.wf.registerMiTransfer("00000000000", "4321");
  assert.equal(r.ok, true);
  assert.ok(w.bridge.calls[0].args.code.startsWith("*444*49*"));
  assert.equal(w.store.state.banks.MITRANSFER.registered, true);
  await w.telemetry.idle();
  const kept = JSON.stringify([w.store.state, w.stateBackend.saved, w.telemetryBackend.saved, w.posted]);
  assert.ok(!kept.includes("00000000000"));
  assert.ok(!kept.includes("4321"));
});
