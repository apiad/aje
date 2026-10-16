import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, memoryBackend } from "../core/store.js";
import { openTelemetry } from "../core/telemetry.js";
import { createWorkflow } from "../core/workflow.js";
import { balanceFor } from "../core/accounts.js";
import { fakeBridge, SMS, POSTPAID_REPLY } from "./helpers.js";

const MIN = 60_000;
const tick = () => new Promise((r) => setImmediate(r));

async function world(replies = [], stateBackend = memoryBackend(), bridgeOptions = {}) {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const store = await openStore(stateBackend, { now, newId: () => "install-1" });
  await store.update({ telemetry: true, subId: 3 });
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
  return { clock, now, store, telemetry, telemetryBackend, stateBackend, bridge, wf, posted, sms };
}

test("a balance query goes out on the chosen SIM and the SMS verifies it", async () => {
  const w = await world([{ ok: true, reply: "Su solicitud esta siendo procesada, espere un SMS" }]);
  const { needsLogin } = await w.wf.balance("CUP");
  assert.equal(needsLogin, false);
  assert.deepEqual(w.bridge.calls[0], { method: "sendUssd", args: { subId: 3, code: "*444*46*61012*046615*1260416#" } });
  assert.equal(w.store.state.attempts[0].state, "replied");
  w.clock.t += 30_000;
  await w.sms(SMS.BALANCE);
  assert.equal(w.store.state.attempts[0].state, "verified");
  assert.equal(balanceFor(w.store.state.attempts, "CUP"), "1200.06 CUP");
});

test("'debe autenticarse' asks for login, and the auth SMS reruns the balance", async () => {
  const w = await world([
    { ok: true, reply: "Debe autenticarse primero" },
    { ok: true, reply: "Su solicitud esta siendo procesada" },
    { ok: true, reply: "Su solicitud esta siendo procesada, espere un SMS" },
  ]);
  assert.equal((await w.wf.balance("CUP")).needsLogin, true);
  await w.wf.login("1234", { retryCurrency: "CUP" });
  await w.sms(SMS.AUTH);
  assert.equal(w.bridge.calls.length, 3);
  assert.ok(w.bridge.calls[1].args.code.startsWith("*444*40*"));
  assert.ok(w.bridge.calls[2].args.code.startsWith("*444*46*"));
  assert.equal(w.store.state.retryBalance, null);
  assert.equal(w.store.state.authenticatedAt, w.clock.t);
});

test("a stale auth SMS does not rerun the balance", async () => {
  const w = await world([{ ok: true, reply: "ok" }]);
  await w.wf.login("1234", { retryCurrency: "CUP" });
  w.clock.t += 21 * MIN;
  await w.sms(SMS.AUTH);
  assert.equal(w.bridge.calls.length, 1);
});

test("the PIN never reaches the store, the history or the telemetry", async () => {
  const w = await world([{ ok: true, reply: "Usted esta siendo autenticado" }]);
  await w.wf.login("4321");
  await w.telemetry.idle();
  const dialed = w.bridge.calls[0].args.code;
  const kept = JSON.stringify([w.store.state, w.stateBackend.saved, w.telemetryBackend.saved, w.posted]);
  assert.ok(!kept.includes("4321"));
  assert.ok(!kept.includes(dialed));
  assert.ok(w.store.state.attempts.every((a) => a.op !== "40"));
});

test("a transfer is dialed and the bank's SMS verifies it", async () => {
  const w = await world();
  await w.wf.transfer("CUP", "9200950000000001", 100);
  assert.equal(w.bridge.calls[0].method, "dial");
  assert.ok(w.bridge.calls[0].args.code.startsWith("*444*45*"));
  assert.equal(w.store.state.attempts[0].state, "dialer");
  await w.sms(SMS.TRANSFER);
  assert.equal(w.store.state.attempts[0].state, "verified");
  assert.equal(w.store.state.attempts[0].transactionId, "AB0000XYZ0001");
});

test("a transfer whose dial fails is marked failed, not left pending", async () => {
  const w = await world([], memoryBackend(), { dialFails: true });
  const a = await w.wf.transfer("CUP", "9200950000000001", 100);
  assert.equal(a.state, "failed");
  assert.equal(w.store.state.attempts[0].state, "failed");
  assert.equal(w.store.state.attempts[0].failureCode, -100);
});

test("a transfer SMS for another card verifies nothing", async () => {
  const w = await world();
  await w.wf.transfer("CUP", "9200950000000002", 100);
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
});

// Review focus 1: the SMS arrives after the app was killed behind the dialer.
test("the SMS that arrives after a restart still verifies the transfer", async () => {
  const backend = memoryBackend();
  const a = await world([], backend);
  await a.wf.transfer("CUP", "9200950000000001", 100);
  const b = await world([], backend);
  b.clock.t = a.clock.t + 25 * MIN;
  await b.wf.handleSms({ sender: "PAGOxMOVIL", body: SMS.TRANSFER, receivedAt: a.clock.t + 3 * MIN });
  assert.equal(b.store.state.attempts[0].state, "verified");
});

test("an SMS that arrived after the window verifies nothing, however soon it is read", async () => {
  const w = await world();
  await w.wf.transfer("CUP", "9200950000000001", 100);
  await w.wf.handleSms({ sender: "PAGOxMOVIL", body: SMS.TRANSFER, receivedAt: w.clock.t + 21 * MIN });
  assert.equal(w.store.state.attempts.at(-1).state, "dialer");
});

// Review focus 1, auth side: a queued auth SMS read hours later must not send op 46 on its own.
test("a queued auth SMS read hours later does not rerun the balance", async () => {
  const w = await world([{ ok: true, reply: "ok" }]);
  await w.wf.login("1234", { retryCurrency: "CUP" });
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
  const pending = w.wf.balance("CUP");
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
  await w.wf.balance("CUP");
  assert.equal(w.store.state.attempts[0].state, "failed");
  assert.equal(w.store.state.attempts[0].failureCode, -1);
});

test("a bridge call that rejects fails the attempt with -100", async () => {
  const w = await world([() => Promise.reject(new Error("bad code"))]);
  await w.wf.balance("CUP");
  assert.equal(w.store.state.attempts[0].state, "failed");
  assert.equal(w.store.state.attempts[0].failureCode, -100);
});

test("a login whose bridge call rejects clears the pending retry", async () => {
  const w = await world([() => Promise.reject(new Error("bad code"))]);
  const r = await w.wf.login("1234", { retryCurrency: "CUP" });
  assert.deepEqual([r.ok, r.failureCode], [false, -100]);
  assert.equal(w.store.state.retryBalance, null);
});

test("a failed login clears the pending retry", async () => {
  const w = await world([{ ok: false, failureCode: -100, error: "SecurityException" }]);
  const r = await w.wf.login("1234", { retryCurrency: "CUP" });
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
