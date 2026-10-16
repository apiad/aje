import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../bridge.js";

function fakeNative() {
  const sent = [];
  const native = { onmessage: null, postMessage: (s) => sent.push(JSON.parse(s)) };
  const push = (msg) => native.onmessage({ data: JSON.stringify(msg) });
  return { native, sent, push };
}

test("connect says ready to the native object", async () => {
  const f = fakeNative();
  const b = await connect({ native: f.native });
  assert.equal(b.kind, "native");
  assert.equal(f.sent[0].method, "ready");
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
  const got = [];
  b.onSms((m) => got.push(m));
  assert.deepEqual(got, [{ sender: "PAGOxMOVIL", body: "texto", sentAt: 4, receivedAt: 5 }]);
});

test("without a native object it loads the mock", async () => {
  const mock = { kind: "mock" };
  const b = await connect({ native: undefined, loadMock: async () => ({ createMock: () => mock }) });
  assert.equal(b, mock);
});
