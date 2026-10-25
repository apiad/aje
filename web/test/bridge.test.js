import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../bridge.js";

function fakeNative() {
  const sent = [];
  const native = { onmessage: null, postMessage: (s) => sent.push(JSON.parse(s)) };
  const push = (msg) => native.onmessage({ data: JSON.stringify(msg) });
  return { native, sent, push };
}

// Review: the shell deletes its SMS queue on ready, so ready waits until the page can save them.
test("ready is sent when the first SMS handler registers, not before", async () => {
  const f = fakeNative();
  const b = await connect({ native: f.native });
  assert.equal(b.kind, "native");
  assert.equal(f.sent.length, 0);
  b.onSms(() => {});
  b.onSms(() => {});
  assert.deepEqual(f.sent.map((m) => m.method), ["ready"]);
});

test("a call the shell never answers rejects after the timeout", async () => {
  const f = fakeNative();
  const b = await connect({ native: f.native, timeoutMs: 10 });
  await assert.rejects(b.sendUssd(3, "*222#"), /no answer/);
});

test("sendUssd posts a request and resolves with its result", async () => {
  const f = fakeNative();
  const b = await connect({ native: f.native });
  const p = b.sendUssd(3, "*444*46#");
  const req = f.sent.at(-1);
  assert.deepEqual(req, { id: req.id, method: "sendUssd", args: { subId: 3, code: "*444*46#" } });
  f.push({ id: req.id, result: { ok: true, reply: "hola" } });
  assert.deepEqual(await p, { ok: true, reply: "hola" });
});

test("an error reply rejects", async () => {
  const f = fakeNative();
  const b = await connect({ native: f.native });
  const p = b.dial("not a code");
  f.push({ id: f.sent.at(-1).id, error: "bad code" });
  await assert.rejects(p, /bad code/);
});

// Review focus 1: the queue drains on ready, before the UI registers its handler.
test("an SMS pushed before a handler exists is delivered when one registers", async () => {
  const f = fakeNative();
  const b = await connect({ native: f.native });
  f.push({ event: "sms", sender: "PAGOxMOVIL", body: "texto", sentAt: 4, receivedAt: 5 });
  f.push({ event: "sms", sender: "ETECSA", body: "otro", sentAt: 6, receivedAt: 7, subId: 3 });
  const got = [];
  b.onSms((m) => got.push(m));
  assert.deepEqual(got, [{ sender: "PAGOxMOVIL", body: "texto", sentAt: 4, receivedAt: 5, subId: null },
    { sender: "ETECSA", body: "otro", sentAt: 6, receivedAt: 7, subId: 3 }]);
});

test("without a native object it loads the mock", async () => {
  const mock = { kind: "mock" };
  const b = await connect({ native: undefined, loadMock: async () => ({ createMock: () => mock }) });
  assert.equal(b, mock);
});

test("the secret calls post their name and wait on the person without a timeout", async () => {
  const f = fakeNative();
  const b = await connect({ native: f.native, timeoutMs: 10 });
  const save = b.secretSave("pin:BM", "1234", 180);
  assert.deepEqual(f.sent.at(-1).args, { name: "pin:BM", value: "1234", days: 180 });
  const load = b.secretLoad("pin:BM");
  assert.deepEqual([f.sent.at(-2).method, f.sent.at(-1).method, f.sent.at(-1).args], ["secretSave", "secretLoad", { name: "pin:BM" }]);
  await new Promise((r) => setTimeout(r, 30));
  f.push({ id: f.sent.at(-2).id, result: true });
  f.push({ id: f.sent.at(-1).id, result: "1234" });
  assert.deepEqual([await save, await load], [true, "1234"]);
});

test("an unattended secret call says so, and only then, and does not wait forever", async () => {
  const f = fakeNative();
  const b = await connect({ native: f.native, timeoutMs: 10 });
  const load = b.secretLoad("pin:BANDEC", { unattended: true });
  assert.deepEqual([f.sent.at(-1).method, f.sent.at(-1).args], ["secretLoad", { name: "pin:BANDEC", unattended: true }]);
  const save = b.secretSave("pin:BANDEC", "1234", 180, { unattended: true });
  assert.deepEqual(f.sent.at(-1).args, { name: "pin:BANDEC", value: "1234", days: 180, unattended: true });
  await assert.rejects(load, /no answer to secretLoad/);
  await assert.rejects(save, /no answer to secretSave/);
  b.secretForget("pin:BANDEC", { unattended: true });
  assert.deepEqual(f.sent.at(-1).args, { name: "pin:BANDEC", unattended: true });
  b.secretForget("pin:BANDEC");
  assert.deepEqual(f.sent.at(-1).args, { name: "pin:BANDEC" });
});

test("installUpdate posts the url and checksum and waits for the shell without a timeout", async () => {
  const f = fakeNative();
  const b = await connect({ native: f.native, timeoutMs: 10 });
  const done = b.installUpdate("https://github.com/x/aje-1.0.1-262.apk", "ab".repeat(32));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(f.sent[0].args, { url: "https://github.com/x/aje-1.0.1-262.apk", sha256: "ab".repeat(32) });
  assert.equal(f.sent[0].method, "installUpdate");
  f.push({ id: f.sent[0].id, result: { ok: true } });
  assert.deepEqual(await done, { ok: true });
});

test("pickContact waits for the person and resolves with the contact or null", async () => {
  const f = fakeNative();
  const b = await connect({ native: f.native, timeoutMs: 10 });
  const p = b.pickContact();
  const req = f.sent.at(-1);
  assert.deepEqual(req, { id: req.id, method: "pickContact", args: {} });
  await new Promise((r) => setTimeout(r, 30));
  f.push({ id: req.id, result: { name: "Ben", number: "+53 5100 0001" } });
  assert.deepEqual(await p, { name: "Ben", number: "+53 5100 0001" });
  const q = b.pickContact();
  f.push({ id: f.sent.at(-1).id, result: null });
  assert.equal(await q, null);
});

test("installUpdate reports download progress before it resolves", async () => {
  const f = fakeNative();
  const b = await connect({ native: f.native });
  const seen = [];
  const p = b.installUpdate("https://x/a.apk", "ab", (received, total) => seen.push([received, total]));
  const req = f.sent.at(-1);
  assert.deepEqual(req.args, { url: "https://x/a.apk", sha256: "ab" });
  f.push({ id: req.id, progress: { received: 1000, total: 4000 } });
  f.push({ id: req.id, progress: { received: 4000, total: 4000 } });
  f.push({ id: req.id, result: { ok: true } });
  assert.deepEqual(await p, { ok: true });
  assert.deepEqual(seen, [[1000, 4000], [4000, 4000]]);
});

// A tapped notification opens the app on its notice; the shell may push it before the page listens.
test("an open event pushed before a handler is delivered when onOpen registers", async () => {
  const f = fakeNative();
  const b = await connect({ native: f.native });
  f.push({ event: "open", route: "inbox/4:abc" });
  const got = [];
  b.onOpen((r) => got.push(r));
  assert.deepEqual(got, ["inbox/4:abc"]);
  f.push({ event: "open", route: "inbox/5:def" });
  assert.deepEqual(got, ["inbox/4:abc", "inbox/5:def"]);
  // An open event is not an SMS.
  const sms = [];
  b.onSms((m) => sms.push(m));
  assert.deepEqual(sms, []);
});

test("contactNames asks the shell with the numbers and whether to ask for the permission", async () => {
  const f = fakeNative();
  const b = await connect({ native: f.native });
  const p = b.contactNames(["51234567"], true);
  const req = f.sent.at(-1);
  assert.deepEqual(req, { id: req.id, method: "contactNames", args: { numbers: ["51234567"], ask: true } });
  f.push({ id: req.id, result: { 51234567: "Mamá" } });
  assert.deepEqual(await p, { 51234567: "Mamá" });
});
