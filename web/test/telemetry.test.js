import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALLOWED, mask, openTelemetry } from "../core/telemetry.js";
import { openStore, memoryBackend } from "../core/store.js";

const UA = "Mozilla/5.0 (Linux; Android 14; Test Phone Build/AB12; wv) AppleWebKit/537.36";
const CONFIG = { app: "0.1.0-dev.9", telemetryUrl: "https://collector.example/e", telemetryToken: "tok" };

async function world({ on = true, config = CONFIG, respond = () => ({ ok: true, status: 204 }) } = {}) {
  const store = await openStore(memoryBackend());
  await store.update({ telemetry: on });
  const posts = [];
  const fetch = async (url, init) => { posts.push({ url, init }); return respond(); };
  const t = await openTelemetry({ config, store, backend: memoryBackend(), fetch, now: () => 42, userAgent: UA });
  return { store, t, posts };
}

test("every digit becomes #, whatever its script", () => {
  assert.equal(mask("Saldo: 1234.56 CUP"), "Saldo: ####.## CUP");
  assert.equal(mask("١٢"), "##");
});

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

test("an event carries the base fields and a masked text, with the token header", async () => {
  const { store, t, posts } = await world();
  t.event("ussd_reply", { op: "46", ok: true, text: "Saldo: 1234.56 CUP" });
  await t.idle();
  const [e] = JSON.parse(posts[0].init.body);
  assert.deepEqual(e, {
    event: "ussd_reply", t: 42, app: "0.1.0-dev.9", sdk: "14", device: "Test Phone",
    install: store.state.installId, op: "46", ok: true, text: "Saldo: ####.## CUP",
  });
  assert.equal(posts[0].url, CONFIG.telemetryUrl);
  assert.equal(posts[0].init.headers["X-Aje-Token"], "tok");
});

test("a failed send keeps the queue and the next one sends both", async () => {
  let up = false;
  const { t, posts } = await world({ respond: () => (up ? { ok: true, status: 204 } : Promise.reject(new Error("offline"))) });
  t.event("app_start");
  await t.idle();
  assert.equal(t.history()[0].sent, false);
  up = true;
  t.event("app_start");
  await t.idle();
  assert.equal(JSON.parse(posts.at(-1).init.body).length, 2);
  assert.ok(t.history().every((h) => h.sent));
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
