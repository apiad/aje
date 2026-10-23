import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALLOWED, openTelemetry } from "../core/telemetry.js";
import { openStore, memoryBackend } from "../core/store.js";

const UA = "Mozilla/5.0 (Linux; Android 14; Test Phone Build/AB12; wv) AppleWebKit/537.36 AjeMaker/Acme";
const CONFIG = { app: "0.1.0-dev.9", commit: "abc1234", telemetryUrl: "https://collector.example/e", telemetryToken: "tok" };

async function world({ on = true, config = CONFIG, respond = () => ({ ok: true, status: 204 }), backend = memoryBackend() } = {}) {
  const store = await openStore(memoryBackend());
  await store.update({ telemetry: on });
  const posts = [];
  const fetch = async (url, init) => { posts.push({ url, init }); return respond(); };
  const t = await openTelemetry({ config, store, backend, fetch, userAgent: UA });
  return { store, t, posts, backend };
}

const bodies = (posts) => posts.map((p) => JSON.parse(p.init.body));

test("a field outside the allowlist is refused", async () => {
  const { t } = await world();
  assert.throws(() => t.event("x", { amount: 5 }), /not allowed/);
});

test("nothing is queued or sent when telemetry is off or has no URL", async () => {
  for (const w of [await world({ on: false }), await world({ config: { ...CONFIG, telemetryUrl: "" } })]) {
    w.t.event("app_start");
    await w.t.idle();
    assert.equal(w.posts.length, 0);
    assert.equal(w.t.history().length, 0);
  }
});

test("an event is one object with the base fields, redacted text and no id or time", async () => {
  const { t, posts } = await world();
  t.event("ussd_reply", { op: "46", ok: true, latency_ms: 2349, text: "Saldo: 1234.56 CUP ANA" });
  await t.idle();
  assert.deepEqual(bodies(posts), [{
    event: "ussd_reply", app: "0.1.0-dev.9", commit: "abc1234", android: "14", maker: "acme",
    op: "46", ok: true, latency_ms: 2300, text: "Saldo: ####.## CUP ‹w›",
  }]);
  assert.equal(posts[0].url, CONFIG.telemetryUrl);
  assert.equal(posts[0].init.headers["X-Aje-Token"], "tok");
});

test("a crash sends a redacted message and a reduced stack", async () => {
  const { t, posts } = await world();
  t.event("crash", { error: "TypeError: x is 5", stack: "TypeError\n    at f (https://appassets.androidplatform.net/assets/web/app.js:3:7)" });
  await t.idle();
  assert.equal(bodies(posts)[0].error, "‹w›: ‹w› ‹w› #");
  assert.equal(bodies(posts)[0].stack, "f@app.js:3:7");
});

test("three events are three requests", async () => {
  const { t, posts } = await world();
  for (const op of ["40", "46", "60"]) t.event("ussd_sent", { op });
  await t.idle();
  assert.deepEqual(bodies(posts).map((b) => b.op), ["40", "46", "60"]);
});

test("a failed send keeps the queue and the next event sends both, one per request", async () => {
  let up = false;
  const { t, posts } = await world({ respond: () => (up ? { ok: true, status: 204 } : Promise.reject(new Error("offline"))) });
  t.event("app_start");
  await t.idle();
  assert.equal(t.history()[0].sent, false);
  up = true;
  t.event("app_start");
  await t.idle();
  assert.equal(posts.length, 3);
  assert.ok(bodies(posts).every((b) => !Array.isArray(b)));
  assert.ok(t.history().every((h) => h.sent));
});

test("turning telemetry off drops the queue unsent", async () => {
  const { store, t, posts } = await world({ respond: () => Promise.reject(new Error("offline")) });
  t.event("app_start");
  await t.idle();
  await store.update({ telemetry: false });
  await store.update({ telemetry: true });
  t.flush();
  await t.idle();
  assert.equal(posts.length, 1);
});

test("a queue stored in the old shape is never sent", async () => {
  const backend = memoryBackend();
  await backend.save({ queue: [{ event: "app_start", t: 1, install: "x" }], log: [{ sent: false, e: { event: "app_start", t: 1, install: "x" } }] });
  const { t, posts } = await world({ backend });
  t.flush();
  await t.idle();
  assert.equal(posts.length, 0);
  assert.equal(t.history().length, 0);
});

test("the history keeps the newest two hundred", async () => {
  const { t } = await world({ respond: () => ({ ok: false, status: 500 }) });
  for (let i = 0; i < 205; i++) t.event("app_start", { length: i });
  await t.idle();
  assert.equal(t.history().length, 200);
  assert.equal(t.history()[0].event.length, 204);
});

test("the collector's allowlist mirrors the app's", () => {
  const py = readFileSync(new URL("../../telemetry/collector.py", import.meta.url), "utf8");
  const fields = [...py.match(/^ALLOWED = \{([^}]*)\}/m)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(new Set(fields), ALLOWED);
});
