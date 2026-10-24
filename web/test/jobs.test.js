import { test } from "node:test";
import assert from "node:assert/strict";
import { daytime, MAX_FAILS, nextSlot, nextWake, RETRY_MS, runDue, updateJob, wake } from "../core/jobs.js";
import { memoryBackend, openStore } from "../core/store.js";

// Local times, as the phone keeps them: October 2026.
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m).getTime();
const HOUR = 3_600_000;

const SHA = "a".repeat(64);
const release = (version, code, prerelease = false) => ({
  tag_name: `v${version}`, prerelease, draft: false, html_url: "",
  assets: [{ name: `aje-${version}-${code}.apk`, digest: `sha256:${SHA}`, browser_download_url: `https://github.com/apiad/aje/releases/download/v${version}/aje-${version}-${code}.apk` }],
});

function fakeBridge() {
  const calls = [];
  return {
    calls,
    wakeAt: async (t) => { calls.push(["wakeAt", t]); },
    notify: async (n) => { calls.push(["notify", n]); },
    done: async () => { calls.push(["done"]); },
  };
}

async function setup({ releases = [], fails = false, runs = {} } = {}) {
  const store = await openStore(memoryBackend({ jobRuns: runs }));
  const bridge = fakeBridge();
  let fetches = 0;
  const fetch = async () => {
    fetches++;
    if (fails) throw new Error("sin conexión");
    return { ok: true, json: async () => releases };
  };
  const ctx = { store, bridge, config: { versionCode: "300" }, fetch };
  return { store, bridge, ctx, fetches: () => fetches };
}

const job = (id, nextAt, run = async () => {}) => ({ id, nextAt, run });

test("slots: the next of the day's hours, and 7:00 tomorrow after the last", () => {
  assert.equal(nextSlot([7, 13, 19], at(6, 10)), at(6, 13));
  assert.equal(nextSlot([7, 13, 19], at(6, 13)), at(6, 19));
  assert.equal(nextSlot([7, 13, 19], at(6, 19, 30)), at(7, 7));
  // The last day of October rolls into November.
  assert.equal(nextSlot([7, 13, 19], at(31, 20)), new Date(2026, 10, 1, 7).getTime());
});

test("night hours move to 7:00", () => {
  assert.equal(daytime(at(6, 21, 59)), at(6, 21, 59));
  assert.equal(daytime(at(6, 22)), at(7, 7));
  assert.equal(daytime(at(7, 3)), at(7, 7));
  assert.equal(daytime(at(7, 7)), at(7, 7));
});

test("nextWake is the earliest job, never in the past, never at night", async () => {
  const { store } = await setup();
  const jobs = [job("a", () => at(6, 15)), job("b", () => at(6, 11)), job("c", () => at(6, 18))];
  assert.equal(nextWake(store.state, at(6, 10), jobs), at(6, 11));
  // A job already due wakes now.
  assert.equal(nextWake(store.state, at(6, 12), jobs), at(6, 12));
  // Due at night: the morning.
  assert.equal(nextWake(store.state, at(6, 23), [job("a", () => at(6, 21))]), at(7, 7));
  assert.equal(nextWake(store.state, at(6, 10), [job("a", () => at(6, 23, 30))]), at(7, 7));
});

test("the update job: never ran is due now, then 7:00, 13:00 and 19:00", async () => {
  const { store } = await setup();
  assert.equal(nextWake(store.state, at(6, 10)), at(6, 10));
  const ran = (t) => ({ jobRuns: { update: { at: t, ok: true, fails: 0 } } });
  assert.equal(updateJob.nextAt(ran(at(6, 7, 2))), at(6, 13));
  assert.equal(updateJob.nextAt(ran(at(6, 13, 5))), at(6, 19));
  assert.equal(updateJob.nextAt(ran(at(6, 19, 1))), at(7, 7));
});

test("a failed job retries an hour later, three times a day, then waits for its next slot", async () => {
  const { store, ctx } = await setup({ fails: true });
  await runDue(ctx, at(6, 7));
  assert.deepEqual(store.state.jobRuns.update, { at: at(6, 7), ok: false, fails: 1 });
  assert.equal(nextWake(store.state, at(6, 7)), at(6, 7) + RETRY_MS);
  await runDue(ctx, at(6, 8));
  await runDue(ctx, at(6, 9));
  assert.equal(store.state.jobRuns.update.fails, MAX_FAILS);
  assert.equal(nextWake(store.state, at(6, 9)), at(6, 13));
  // A new day starts the count again.
  await runDue(ctx, at(7, 7));
  assert.equal(store.state.jobRuns.update.fails, 1);
});

test("a job that failed three times in the evening waits for tomorrow", async () => {
  const { store, ctx } = await setup({ fails: true });
  for (const h of [19, 20, 21]) await runDue(ctx, at(6, h));
  assert.equal(store.state.jobRuns.update.fails, 3);
  assert.equal(nextWake(store.state, at(6, 21)), at(7, 7));
  // A retry that lands at night waits for the morning too.
  await store.setJobRun("update", { at: at(6, 21, 30), ok: false, fails: 1 });
  assert.equal(nextWake(store.state, at(6, 21, 30)), at(7, 7));
});

test("runDue runs only what is due, one job at a time, in order, and records each result", async () => {
  const { store, ctx } = await setup();
  const order = [];
  let running = 0;
  const slow = (id) => async () => {
    assert.equal(running, 0, "two jobs at once");
    running++;
    order.push(id);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return { seen: id };
  };
  const jobs = [
    job("a", () => at(6, 9), slow("a")),
    job("b", () => at(6, 11), slow("b")),
    job("c", () => at(6, 10), async () => { throw new Error("USSD -1"); }),
    job("d", () => at(6, 8), slow("d")),
  ];
  assert.deepEqual(await runDue(ctx, at(6, 10), jobs), ["a:ok", "c:error", "d:ok"]);
  assert.deepEqual(order, ["a", "d"]);
  assert.deepEqual(store.state.jobRuns.a, { seen: "a", at: at(6, 10), ok: true, fails: 0 });
  assert.deepEqual(store.state.jobRuns.c, { at: at(6, 10), ok: false, fails: 1 });
  assert.equal(store.state.jobRuns.b, undefined);
});

test("nothing runs at night", async () => {
  const { store, ctx } = await setup();
  assert.deepEqual(await runDue(ctx, at(6, 23)), []);
  assert.deepEqual(store.state.jobRuns, {});
});

test("an update notifies once per version", async () => {
  const { bridge, ctx, store } = await setup({ releases: [release("1.1.0", 310)] });
  await runDue(ctx, at(6, 7));
  const notices = () => bridge.calls.filter(([m]) => m === "notify").map(([, n]) => n);
  assert.deepEqual(notices(), [{
    id: "update:1.1.0", channel: "updates", route: "home", title: "Ajé 1.1.0 disponible", text: "Toca para actualizar.",
  }]);
  assert.equal(store.state.update.available.version, "1.1.0");
  assert.equal(store.state.update.checkedAt, at(6, 7));
  await runDue(ctx, at(6, 13));
  await runDue(ctx, at(6, 19));
  assert.equal(notices().length, 1);
  assert.equal(store.state.jobRuns.update.notified, "1.1.0");
});

test("a newer version notifies again; no update, or the stable channel's view of a beta, notifies nothing", async () => {
  const s = await setup({ releases: [release("1.2.0-beta.1", 320, true)] });
  await runDue(s.ctx, at(6, 7));
  assert.equal(s.bridge.calls.filter(([m]) => m === "notify").length, 0);
  await s.store.update({ channel: "beta" });
  await s.store.setUpdate({ checkedAt: null, available: null });
  await runDue(s.ctx, at(6, 13));
  const n = s.bridge.calls.filter(([m]) => m === "notify").map(([, x]) => x);
  assert.deepEqual(n.map((x) => [x.id, x.text]), [["update:1.2.0-beta.1", "Una beta nueva. Toca para actualizar."]]);
});

test("a check the open app made within the hour is reused, not repeated", async () => {
  const s = await setup({ releases: [release("1.1.0", 310)] });
  await s.store.setUpdate({ checkedAt: at(6, 12, 40), available: null });
  await runDue(s.ctx, at(6, 13));
  assert.equal(s.fetches(), 0);
  assert.equal(s.store.state.jobRuns.update.ok, true);
});

test("a failed check is a failed run and notifies nothing", async () => {
  const s = await setup({ fails: true, releases: [release("1.1.0", 310)] });
  assert.deepEqual(await runDue(s.ctx, at(6, 7)), ["update:error"]);
  assert.equal(s.bridge.calls.length, 0);
});

test("wake asks for the next wake-up and calls done, also when a job throws", async () => {
  const s = await setup();
  const events = [];
  const telemetry = { event: (name, f) => events.push([name, f]), flush: async () => {} };
  const ctx = { ...s.ctx, telemetry, now: () => at(6, 10, 30) };
  const jobs = [job("a", (st) => (st.jobRuns.a ? st.jobRuns.a.at + RETRY_MS : at(6, 10)), async () => { throw new Error("boom"); }),
    job("b", () => at(6, 15))];
  await wake(ctx, at(6, 10), jobs);
  assert.deepEqual(s.bridge.calls, [["wakeAt", at(6, 10, 30) + RETRY_MS], ["done"]]);
  assert.deepEqual(events, [["wake", { late_min: 30, jobs: "a:error" }]]);
});

test("wake calls done even when the store write fails", async () => {
  const s = await setup();
  s.store.setJobRun = async () => { throw new Error("IndexedDB closed"); };
  await assert.rejects(wake({ ...s.ctx, now: () => at(6, 10) }, null, [job("a", () => 0)]), /IndexedDB/);
  assert.deepEqual(s.bridge.calls.map(([m]) => m), ["wakeAt", "done"]);
});
