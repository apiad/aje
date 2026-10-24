import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openStore, memoryBackend } from "../core/store.js";
import { openTelemetry } from "../core/telemetry.js";
import { createWorkflow, PIN_DAYS } from "../core/workflow.js";
import { balanceFor } from "../core/accounts.js";
import { fakeBridge, SMS, PLAN_BOUGHT, POSTPAID_REPLY, PREPAID_REPLY } from "./helpers.js";
import { balance as balanceCode, link as linkCode } from "../core/ops.js";
import { DEFAULT_CONFIG, dial } from "../core/ussd.js";

const MIN = 60_000;
const METRO_CARD = { alias: "Metro CUP", pan: "9227959900000001", bank: "METROPOLITANO", currency: "CUP" };
const tick = () => new Promise((r) => setImmediate(r));

async function world(replies = [], stateBackend = memoryBackend(), bridgeOptions = {}) {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  let ids = 0;
  const store = await openStore(stateBackend, { now, newId: () => `card-${++ids + 1}` });
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

test("transferBalance dials *234*1, since the network asks to confirm with 1", async () => {
  const w = await world();
  const r = await w.wf.transferBalance(3, "55555555", 25, { key: "9876" });
  assert.deepEqual([r.ok, r.outcome], [true, "dialer"]);
  assert.deepEqual(w.bridge.calls[0], { method: "dial", args: { code: "*234*1*55555555*9876*25#" } });
  assert.ok(!w.bridge.calls.some((c) => c.method === "sendUssd"));
  const a = w.store.state.attempts[0];
  assert.deepEqual([a.op, a.subId, a.to, a.amount, a.state, a.code], ["234", 3, "55555555", 25, "dialer", "*234*1*55555555*••••*25#"]);
  await w.telemetry.idle();
  const sent = JSON.stringify([w.telemetryBackend.saved, w.posted]);
  assert.ok(sent.includes('"via":"dialer"'));
  assert.ok(!sent.includes("9876"));
  assert.ok(!sent.includes("55555555"));
  assert.ok(!JSON.stringify(w.store.state).includes("9876"));
});

test("remember saves the transfer key under line-key once it is dialed", async () => {
  const w = await world();
  const r = await w.wf.transferBalance(3, "55555555", 25, { key: "9876", remember: true });
  assert.equal(r.remembered, true);
  assert.deepEqual(w.bridge.calls.find((c) => c.method === "secretSave"), { method: "secretSave", args: { name: "line-key:3", days: PIN_DAYS } });
});

test("a saved transfer key is used when none is given", async () => {
  const w = await world();
  w.bridge.vault.set("line-key:3", { value: "4444", expiresAt: null });
  const r = await w.wf.transferBalance(3, "55555555", 10);
  assert.equal(r.outcome, "dialer");
  assert.equal(w.bridge.calls.find((c) => c.method === "dial").args.code, "*234*1*55555555*4444*10#");
});

test("a cancelled unlock asks for the key and dials nothing", async () => {
  const w = await world([], memoryBackend(), { unlock: false });
  const r = await w.wf.transferBalance(3, "55555555", 10);
  assert.deepEqual([r.ok, r.outcome], [false, "needs-key"]);
  assert.ok(!w.bridge.calls.some((c) => c.method === "dial"));
  assert.equal(w.store.state.attempts.length, 0);
});

test("a dialer that does not open fails the transfer and keeps no key", async () => {
  const w = await world([], memoryBackend(), { dialFails: true });
  const r = await w.wf.transferBalance(3, "55555555", 10, { key: "9876", remember: true });
  assert.deepEqual([r.ok, r.outcome, r.remembered], [false, "failed", false]);
  assert.equal(w.store.state.attempts[0].state, "failed");
  assert.equal(w.bridge.vault.has("line-key:3"), false);
});

test("Cubacel's SMS verifies a dialed transfer", async () => {
  const w = await world();
  await w.wf.transferBalance(3, "55555555", 25, { key: "9876" });
  await w.sms(SMS.LINE_SENT, "ETECSA");
  assert.equal(w.store.state.attempts[0].state, "verified");
});

test("a received transfer SMS adds a history entry and a redacted event", async () => {
  const w = await world();
  const sms = await w.sms(SMS.LINE_RECEIVED, "ETECSA");
  assert.equal(sms.kind, "line-received");
  assert.equal(w.store.state.attempts[0].op, "234-in");
  await w.telemetry.idle();
  const sent = JSON.stringify(w.telemetryBackend.saved);
  assert.ok(sent.includes("line-received"));
  assert.ok(!sent.includes("56666666"));
});

test("changeLineKey replaces a saved key on a confirming reply", async () => {
  const w = await world([{ ok: true, reply: "Su clave ha sido cambiada satisfactoriamente." }]);
  w.bridge.vault.set("line-key:3", { value: "1234", expiresAt: null });
  const r = await w.wf.changeLineKey(3, "1234", "4321");
  assert.equal(r.ok, true);
  assert.equal(w.bridge.calls[0].args.code, "*234*2*1234*4321#");
  assert.equal(w.bridge.vault.get("line-key:3").value, "4321");
});

test("transfersToday counts today's transfers on the line that did not fail", async () => {
  const w = await world();
  const midnight = new Date(w.now()).setHours(0, 0, 0, 0);
  await w.store.add({ op: "234", subId: 3, startedAt: midnight - 1 });
  await w.store.add({ op: "234", subId: 3, startedAt: midnight + 1 });
  await w.store.add({ op: "234", subId: 3, startedAt: midnight + 2, state: "failed" });
  await w.store.add({ op: "234", subId: 4, startedAt: midnight + 3 });
  assert.equal(w.wf.transfersToday(3), 1);
});

test("changeLineKey falls back to the dialer when the API cannot follow the network's menu", async () => {
  const w = await world([{ ok: false, failureCode: -1, error: null }]);
  w.bridge.vault.set("line-key:3", { value: "1234", expiresAt: null });
  const r = await w.wf.changeLineKey(3, "1234", "4321");
  assert.deepEqual([r.ok, r.dialed], [false, true]);
  assert.equal(w.bridge.calls.at(-1).method === "dial" || w.bridge.calls.some((c) => c.method === "dial" && c.args.code === "*234*2*1234*4321#"), true);
  assert.equal(w.bridge.vault.has("line-key:3"), false);
});

test("a verified balance transfer reads the line's balance again", async () => {
  const w = await world([{ ok: true, reply: PREPAID_REPLY }]);
  await w.wf.transferBalance(2, "55555555", 25, { key: "9876" });
  w.clock.t += 16_000;
  await w.wf.handleSms({ sender: "ETECSA", body: SMS.LINE_SENT, receivedAt: w.clock.t });
  assert.deepEqual(w.bridge.calls.at(-1), { method: "sendUssd", args: { subId: 2, code: "*222#" } });
  assert.equal(w.store.state.mobileBalances[2], "250.50 CUP");
});

test("a transfer SMS that matches nothing reads no balance", async () => {
  const w = await world([]);
  await w.wf.handleSms({ sender: "ETECSA", body: SMS.LINE_SENT, receivedAt: w.clock.t });
  assert.equal(w.bridge.calls.filter((c) => c.method === "sendUssd").length, 0);
});

test("refreshBalance swallows a failure and keeps the old figure", async () => {
  const w = await world([() => { throw new Error("radio off"); }]);
  await w.store.setMobileBalance(2, "10.00 CUP");
  await w.wf.refreshBalance(2);
  await w.store.setPlan(2, "NO-SUCH-PLAN");
  await w.wf.refreshBalance(2);
  assert.equal(w.store.state.mobileBalances[2], "10.00 CUP");
});

const PLAN_45 = { path: "1*4*3", name: "4GB +35min +40SMS", price: 240, ask: "¿Desea comprar el Plan de 4GB + 35min + 40 SMS + bono.cu x 240.00 CUP? Marque 1 para confirmar." };

test("buyPlan dials the plan's shortcut and records the purchase on that line", async () => {
  const w = await world();
  const r = await w.wf.buyPlan(2, PLAN_45);
  assert.equal(r.outcome, "dialer");
  assert.deepEqual(w.bridge.calls, [{ method: "dial", args: { code: "*133*1*4*3#" } }]);
  const a = w.store.state.attempts[0];
  assert.deepEqual([a.op, a.subId, a.state, a.code], ["133", 2, "dialer", "*133*1*4*3#"]);
  assert.deepEqual(a.plan, { path: "1*4*3", name: "4GB +35min +40SMS", price: 240 });
});

test("buyPlan reports a dialer that would not open", async () => {
  const w = await world([], memoryBackend(), { dialFails: true });
  assert.equal((await w.wf.buyPlan(2, PLAN_45)).outcome, "failed");
  assert.deepEqual([w.store.state.attempts[0].state, w.store.state.attempts[0].failureCode], ["failed", -100]);
});

test("Cubacel's plan SMS confirms the purchase and leaves the line's balance from its text", async () => {
  const w = await world();
  await w.wf.buyPlan(2, PLAN_45);
  w.clock.t += MIN;
  const sms = await w.sms(PLAN_BOUGHT, "ETECSA");
  assert.equal(sms.kind, "plan");
  const a = w.store.state.attempts[0];
  assert.deepEqual([a.state, a.verifiedAt], ["verified", w.clock.t]);
  assert.equal(w.store.state.mobileBalances[2], "1234.56 CUP");
  // The balance came in the SMS: nothing is sent.
  assert.equal(w.bridge.calls.length, 1);
  await w.telemetry.idle();
  const ev = w.posted.flatMap((b) => [JSON.parse(b)].flat()).filter((e) => e.event === "sms");
  assert.deepEqual(ev.map((e) => [e.kind, e.ok, e.latency_ms]), [["plan", true, MIN]]);
});

test("the plan SMS matches the purchase by its price, and only within 30 minutes", async () => {
  const w = await world();
  await w.wf.buyPlan(2, PLAN_45);
  await w.wf.buyPlan(3, { ...PLAN_45, path: "2*1", price: 15 });
  w.clock.t += MIN;
  await w.sms(PLAN_BOUGHT, "ETECSA");
  assert.deepEqual(w.store.state.attempts.map((a) => [a.subId, a.state]).sort(), [[2, "verified"], [3, "dialer"]]);
  const late = await world();
  await late.wf.buyPlan(2, PLAN_45);
  late.clock.t += 31 * MIN;
  await late.sms(PLAN_BOUGHT, "ETECSA");
  assert.equal(late.store.state.attempts[0].state, "dialer");
  assert.equal(late.store.state.mobileBalances[2], undefined);
});

test("a plan SMS whose price differs confirms only the one purchase waiting on its line", async () => {
  const w = await world();
  await w.wf.buyPlan(2, { ...PLAN_45, price: 200 });
  await w.sms(PLAN_BOUGHT, "ETECSA");
  assert.equal(w.store.state.attempts[0].state, "verified");
  const two = await world();
  await two.wf.buyPlan(2, { ...PLAN_45, price: 200 });
  await two.wf.buyPlan(2, { ...PLAN_45, price: 100 });
  await two.sms(PLAN_BOUGHT, "ETECSA");
  assert.deepEqual(two.store.state.attempts.map((a) => a.state), ["dialer", "dialer"]);
});

// Review: the SMS says which SIM it came in on; a purchase on the other line is not its own.
test("a plan SMS confirms only a purchase on the SIM it arrived on", async () => {
  const w = await world();
  await w.wf.buyPlan(3, PLAN_45);
  await w.wf.buyPlan(2, PLAN_45);
  await w.wf.handleSms({ sender: "ETECSA", body: PLAN_BOUGHT, subId: 3, receivedAt: w.clock.t });
  assert.deepEqual(w.store.state.attempts.map((a) => [a.subId, a.state]).sort(), [[2, "dialer"], [3, "verified"]]);
  assert.equal(w.store.state.mobileBalances[3], "1234.56 CUP");
  assert.equal(w.store.state.mobileBalances[2], undefined);
});

// Review: a person's number cannot confirm a purchase.
test("a plan text from a phone number confirms nothing", async () => {
  const w = await world();
  await w.wf.buyPlan(2, PLAN_45);
  await w.sms(PLAN_BOUGHT, "+5355555555");
  assert.equal(w.store.state.attempts[0].state, "dialer");
});

// Review: the confirmation carries the balance from the SMS, so the screen never shows the old one beside it.
test("the confirmed purchase keeps the balance its SMS reported", async () => {
  const w = await world();
  await w.store.setMobileBalance(2, "1474.56 CUP");
  await w.wf.buyPlan(2, PLAN_45);
  const seen = [];
  w.store.subscribe((st) => { const a = st.attempts[0]; if (a.state === "verified") seen.push(a.balance); });
  await w.sms(PLAN_BOUGHT, "ETECSA");
  assert.deepEqual([...new Set(seen)], ["1234.56 CUP"]);
});

// Review: an attempt from the build that walked *133 has no plan.
test("a plan SMS tolerates an older purchase without a plan", async () => {
  const w = await world();
  await w.store.add({ id: null, startedAt: w.clock.t, code: "*133*1*1*1#", state: "dialer", op: "133", subId: 2 });
  await w.sms(PLAN_BOUGHT, "ETECSA");
  assert.equal(w.store.state.attempts[0].state, "verified");
});

test("a plan SMS read twice confirms once", async () => {
  const w = await world();
  await w.wf.buyPlan(2, PLAN_45);
  await w.wf.buyPlan(2, PLAN_45);
  await w.wf.handleSms({ sender: "ETECSA", body: PLAN_BOUGHT, sentAt: 5, receivedAt: w.clock.t });
  await w.wf.handleSms({ sender: "ETECSA", body: PLAN_BOUGHT, sentAt: 5, receivedAt: w.clock.t + 1 });
  assert.equal(w.store.state.attempts.filter((a) => a.state === "verified").length, 1);
});

test("a charge needs the line's number, and its QR carries it", async () => {
  const w = await world([]);
  assert.deepEqual(await w.wf.charge(2, { amount: 150 }), { ok: false, reason: "no-number" });
  await w.store.setLineNumber(2, "55555555");
  const r = await w.wf.charge(2, { amount: 150, name: "Ana" });
  assert.equal(r.uri, "aje:saldo?v=1&n=55555555&m=150&a=Ana");
  assert.equal(r.attempt.op, "234-charge");
  assert.equal(r.attempt.state, "waiting");
});

test("the received SMS closes the newest waiting charge with the amount that arrived", async () => {
  const w = await world([]);
  await w.store.setLineNumber(2, "55555555");
  const old = (await w.wf.charge(2, { amount: 10 })).attempt;
  w.clock.t += MIN;
  const last = (await w.wf.charge(2, { amount: 150 })).attempt;
  w.clock.t += MIN;
  await w.wf.handleSms({ sender: "ETECSA", body: SMS.LINE_RECEIVED, receivedAt: w.clock.t });
  const byId = (id) => w.store.state.attempts.find((a) => a.id === id);
  assert.equal(byId(last.id).state, "verified");
  assert.equal(byId(last.id).receivedAmount, 25);
  assert.equal(byId(last.id).from, "56666666");
  assert.equal(byId(old.id).state, "waiting");
  // The closed charge is the record of what arrived: no second row for the same money.
  assert.equal(w.store.state.attempts.filter((a) => a.op === "234-in").length, 0);
});

test("a charge older than 24 hours is never closed, and the SMS is still recorded", async () => {
  const w = await world([]);
  await w.store.setLineNumber(2, "55555555");
  const c = (await w.wf.charge(2, {})).attempt;
  w.clock.t += 25 * 60 * MIN;
  await w.wf.handleSms({ sender: "ETECSA", body: SMS.LINE_RECEIVED, receivedAt: w.clock.t });
  assert.equal(w.store.state.attempts.find((a) => a.id === c.id).state, "waiting");
  assert.equal(w.store.state.attempts.filter((a) => a.op === "234-in").length, 1);
});

// Notices of incoming money: a history row and an inbox item, once per SMS.
const VECTORS = JSON.parse(readFileSync(new URL("./fixtures/notice-vectors.json", import.meta.url), "utf8"));
const vector = (kind, pred = () => true) => VECTORS.find((v) => v.out?.kind === kind && pred(v));

test("a card-received SMS adds one in-card row and one pending notice that points at it", async () => {
  const w = await world();
  const v = vector("card-received");
  await w.wf.handleSms({ sender: v.sender, body: v.body, sentAt: v.sentAt, receivedAt: w.clock.t });
  const rows = w.store.state.attempts.filter((a) => a.op === "in-card");
  assert.equal(rows.length, 1);
  assert.equal(w.store.state.inbox.length, 1);
  const n = w.store.state.inbox[0];
  assert.deepEqual([n.id, n.kind, n.state, n.rowId, n.amount, n.number], [v.id, "card-received", "pending", rows[0].id, "1500.00 CUP", "51234567"]);
  // Delivered again, live and from the queue, with the same send time: nothing new.
  await w.wf.handleSms({ sender: v.sender, body: v.body, sentAt: v.sentAt, receivedAt: w.clock.t + 5 });
  assert.equal(w.store.state.attempts.filter((a) => a.op === "in-card").length, 1);
  assert.equal(w.store.state.inbox.length, 1);
});

test("a line-received SMS still closes a waiting charge and also adds a notice for it", async () => {
  const w = await world([]);
  await w.store.setLineNumber(2, "55555555");
  const c = (await w.wf.charge(2, { amount: 150 })).attempt;
  await w.wf.handleSms({ sender: "ETECSA", body: SMS.LINE_RECEIVED, sentAt: 9, receivedAt: w.clock.t });
  assert.equal(w.store.state.attempts.find((a) => a.id === c.id).state, "verified");
  assert.deepEqual(w.store.state.inbox.map((n) => [n.kind, n.rowId, n.amount]), [["line-received", c.id, "25.00 CUP"]]);
});

test("a line-received SMS with no charge gets a row and a notice; from a person's number, no notice", async () => {
  const w = await world([]);
  await w.wf.handleSms({ sender: "ETECSA", body: SMS.LINE_RECEIVED, sentAt: 9, receivedAt: w.clock.t });
  const row = w.store.state.attempts.find((a) => a.op === "234-in");
  assert.equal(w.store.state.inbox[0].rowId, row.id);
  await w.wf.handleSms({ sender: "55555555", body: SMS.LINE_RECEIVED, sentAt: 10, receivedAt: w.clock.t });
  assert.equal(w.store.state.inbox.length, 1);
});

test("the received account links the one saved card with its last four, never two or none", async () => {
  const v = vector("card-received");
  const run = async (pans) => {
    const w = await world();
    await w.store.removeCard(w.card.id);
    for (const [i, pan] of pans.entries()) await w.store.addCard({ alias: `c${i}`, pan, bank: "METROPOLITANO", currency: "CUP" });
    await w.wf.handleSms({ sender: v.sender, body: v.body, sentAt: v.sentAt, receivedAt: w.clock.t });
    const row = w.store.state.attempts.find((a) => a.op === "in-card");
    return { w, row };
  };
  const one = await run(["9227959900000001", "9227959900000002"]);
  assert.equal(one.row.cardId, one.w.store.state.cards[0].id);
  assert.equal((await run(["9227959900000001", "9205129900000001"])).row.cardId, null);
  assert.equal((await run(["9227959900000002"])).row.cardId, null);
});

test("a plan-expiry notice adds an item and no row; a promotion adds nothing", async () => {
  const w = await world();
  const v = vector("plan-expiry");
  await w.wf.handleSms({ sender: v.sender, body: v.body, sentAt: v.sentAt, receivedAt: w.clock.t });
  assert.deepEqual(w.store.state.inbox.map((n) => [n.kind, n.rowId]), [["plan-expiry", null]]);
  assert.equal(w.store.state.attempts.length, 0);
  const promo = VECTORS.find((x) => x.out === null && /Bono Promocional/.test(x.body));
  await w.wf.handleSms({ sender: promo.sender, body: promo.body, sentAt: promo.sentAt, receivedAt: w.clock.t });
  assert.equal(w.store.state.inbox.length, 1);
  assert.equal(w.store.state.attempts.length, 0);
});

test("every incoming kind of the vectors gives one item, and a row unless it is an expiry", async () => {
  const w = await world();
  const given = VECTORS.filter((v) => v.out);
  for (const v of given) await w.wf.handleSms({ sender: v.sender, body: v.body, sentAt: v.sentAt, receivedAt: w.clock.t });
  assert.equal(w.store.state.inbox.length, given.length);
  assert.equal(w.store.state.attempts.length, given.filter((v) => v.out.kind !== "plan-expiry").length);
});

test("a notice reports its kind when created and when opened, never its amount or number", async () => {
  const w = await world();
  const v = vector("card-received");
  await w.wf.handleSms({ sender: v.sender, body: v.body, sentAt: v.sentAt, receivedAt: w.clock.t });
  await w.wf.openNotice(v.id);
  assert.equal(w.store.state.inbox[0].state, "seen");
  // Opening it again reports nothing more.
  await w.wf.openNotice(v.id);
  await w.telemetry.idle();
  const events = w.posted.map((p) => JSON.parse(p)).filter((e) => e.event === "notice");
  assert.deepEqual(events.map((e) => [e.kind, e.ok]), [["card-received", false], ["card-received", true]]);
  const sent = JSON.stringify(w.posted);
  for (const secret of ["1500", "51234567", "0001", "KW123"]) assert.ok(!sent.includes(secret), secret);
});

// Seen on a phone: MiTransfer answers op 40 with "espere un sms", and its SMS opens the session.
const MITRANSFER_WAIT = "Su solicitud esta siendo procesada, espere un sms con los datos de usuario y fecha de la transaccion realizada.";

test("a MiTransfer login that says to wait for the SMS opens the session only when the SMS comes", async () => {
  const w = await world([
    { ok: true, reply: MITRANSFER_WAIT },
    { ok: true, reply: "Saldo de la cuenta MiTransfer: 1 500,00 CUP" },
  ]);
  const card = await w.store.addCard(CLASICA_CARD);
  const r = await w.wf.login("MITRANSFER", "1234", { retryCardId: card.id });
  assert.equal(r.ok, true);
  assert.equal(w.store.state.banks.MITRANSFER?.authenticatedAt ?? null, null);
  assert.equal(w.bridge.calls.filter((c) => c.method === "sendUssd").length, 1);
  w.clock.t += MIN;
  assert.deepEqual(await w.sms(SMS.MITRANSFER_AUTH), { kind: "auth", bank: "MITRANSFER" });
  assert.equal(w.store.state.banks.MITRANSFER.authenticatedAt, w.clock.t);
  const sent = w.bridge.calls.filter((c) => c.method === "sendUssd");
  assert.equal(sent.length, 2);
  assert.ok(sent[1].args.code.startsWith("*444*46*"));
  assert.equal(w.store.state.retryBalance, null);
});

test("MiTransfer's login SMS is not reported as an unknown bank text", async () => {
  const w = await world();
  await w.sms(SMS.MITRANSFER_AUTH);
  await w.telemetry.idle();
  assert.ok(!JSON.stringify(w.posted).includes("unparsed_bank"));
});

test("an imported card the bank refuses goes back to pending; one it serves is confirmed", async () => {
  const w = await world([
    { ok: true, reply: "Su solicitud esta siendo procesada, espere un SMS" },
    { ok: true, reply: "Su solicitud esta siendo procesada, espere un SMS" },
  ]);
  await w.store.updateCard(w.card.id, { state: "linked", step: 5, unverified: true });
  await w.wf.balance(w.card.id);
  w.clock.t += 20_000;
  await w.sms(SMS.BALANCE_FAILED);
  let card = w.store.state.cards[0];
  assert.equal(card.state, "pending");
  assert.equal(card.unverified, false);
  assert.equal(w.store.state.attempts[0].state, "failed");

  await w.store.updateCard(w.card.id, { state: "linked", step: 5, unverified: true });
  w.clock.t += 60_000;
  await w.wf.balance(w.card.id);
  w.clock.t += 20_000;
  await w.sms(SMS.BALANCE);
  card = w.store.state.cards[0];
  assert.equal(card.state, "linked");
  assert.equal(card.unverified, false);
});

test("a card added by hand stays linked when the bank refuses a balance query", async () => {
  const w = await world([{ ok: true, reply: "Su solicitud esta siendo procesada, espere un SMS" }]);
  await w.store.updateCard(w.card.id, { state: "linked", step: 5 });
  await w.wf.balance(w.card.id);
  w.clock.t += 20_000;
  await w.sms(SMS.BALANCE_FAILED);
  assert.equal(w.store.state.cards[0].state, "linked");
  assert.equal(w.store.state.attempts[0].state, "failed");
});

test("'ya se encuentra autenticado' opens the session of the bank just logged into, and reruns the balance", async () => {
  const w = await world([
    { ok: true, reply: "Debe autenticarse primero" },
    { ok: true, reply: "Su solicitud esta siendo procesada" },
    { ok: true, reply: "Su solicitud esta siendo procesada, espere un SMS" },
  ]);
  assert.equal((await w.wf.balance(w.card.id)).needsLogin, true);
  await w.wf.login("METROPOLITANO", "1234", { retryCardId: w.card.id });
  w.clock.t += 10_000;
  await w.sms(SMS.ALREADY_AUTH);
  assert.equal(w.store.state.banks.METROPOLITANO.authenticatedAt, w.clock.t);
  assert.equal(w.bridge.calls.length, 3, "the balance ran again");
});

test("a login answered by USSD 'ya se encuentra autenticado' opens the session and reruns the balance", async () => {
  const w = await world([{ ok: true, reply: "Debe autenticarse" }, { ok: true, reply: SMS.ALREADY_AUTH }, { ok: true, reply: "Su solicitud esta siendo procesada" }]);
  assert.equal((await w.wf.balance(w.card.id)).needsLogin, true);
  await w.wf.login("METROPOLITANO", "1234", { retryCardId: w.card.id });
  assert.equal(w.store.state.banks.METROPOLITANO.authenticatedAt, w.clock.t);
  assert.equal(w.bridge.calls.length, 3, "the balance ran again");
});

test("'ya se encuentra autenticado' with no recent login, or from a person, opens nothing", async () => {
  const w = await world([{ ok: true, reply: "Su solicitud esta siendo procesada" }]);
  await w.sms(SMS.ALREADY_AUTH);
  assert.equal(w.store.state.banks.METROPOLITANO?.authenticatedAt ?? null, null);
  await w.wf.login("METROPOLITANO", "1234");
  await w.sms(SMS.ALREADY_AUTH, "51234567");
  assert.equal(w.store.state.banks.METROPOLITANO?.authenticatedAt ?? null, null);
  w.clock.t += 60 * 60_000;
  await w.sms(SMS.ALREADY_AUTH);
  assert.equal(w.store.state.banks.METROPOLITANO?.authenticatedAt ?? null, null, "the login is too old");
});
