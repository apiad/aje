// Opt-in telemetry. Each event leaves the phone alone, in its own request, with no install id and
// no time: the collector stamps the hour it arrived. It carries the app version and commit, the
// Android major version and the maker, plus only the fields in ALLOWED. Texts and error messages go
// through redact and stacks through reduceStack before they are queued, so the queue, the history
// in Settings and the collector only ever see the redacted form. See docs/telemetry.md.

import { redact, redactMenu, reduceStack } from "./redact.js";

/** Mirrored in telemetry/collector.py; web/test/telemetry.test.js checks the two match. */
export const ALLOWED = new Set([
  "op", "bank", "via", "ok", "failure_code", "latency_ms", "age_ms", "kind", "sender", "length", "lines",
  "text", "error", "stack", "menu", "cards", "added", "kept", "late_min", "jobs",
]);

const LOG_SIZE = 200;
const QUEUE_SIZE = 200;
const round100 = (ms) => Math.round(ms / 100) * 100;

function deviceOf(userAgent) {
  const android = /Android (\d+)/.exec(userAgent ?? "");
  const maker = /AjeMaker\/(\S+)/.exec(userAgent ?? "");
  return { android: android ? android[1] : "unknown", maker: maker ? maker[1].toLowerCase() : "unknown" };
}

function clean(fields) {
  const e = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    if (k === "text" || k === "error") e[k] = redact(String(v));
    else if (k === "menu") e[k] = redactMenu(String(v));
    else if (k === "stack") e[k] = reduceStack(v);
    else if (k === "latency_ms" || k === "age_ms") e[k] = round100(v);
    else e[k] = v;
  }
  return e;
}

export async function openTelemetry({ config, store, backend, fetch, userAgent }) {
  const loaded = await backend.load();
  // A queue written before events lost their install id and time is never sent.
  const old = (e) => "install" in e || "t" in e;
  const doc = { queue: (loaded?.queue ?? []).filter((e) => !old(e)), log: (loaded?.log ?? []).filter((l) => !old(l.e)) };
  const base = { app: config.app, commit: config.commit ?? "", ...deviceOf(userAgent) };
  let chain = Promise.resolve();

  async function send() {
    while (doc.queue.length > 0 && store.state.settings.telemetry) {
      const e = doc.queue[0];
      try {
        const res = await fetch(config.telemetryUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Aje-Token": config.telemetryToken },
          body: JSON.stringify(e),
        });
        if (!res.ok) return;
      } catch {
        return; // Offline: the queue keeps the events for the next try.
      }
      doc.queue.shift();
      for (const entry of doc.log) if (entry.e === e) entry.sent = true;
      await backend.save(doc);
    }
  }

  const enqueue = (step) => (chain = chain.then(step).catch(() => {}));

  store.subscribe((state) => {
    if (state.settings.telemetry || doc.queue.length === 0) return;
    doc.queue = [];
    enqueue(() => backend.save(doc));
  });

  return {
    event(name, fields = {}) {
      for (const k of Object.keys(fields)) if (!ALLOWED.has(k)) throw new Error(`telemetry field not allowed: ${k}`);
      if (!store.state.settings.telemetry || !config.telemetryUrl) return;
      const e = { event: name, ...base, ...clean(fields) };
      doc.queue = [...doc.queue, e].slice(-QUEUE_SIZE);
      doc.log = [...doc.log, { sent: false, e }].slice(-LOG_SIZE);
      enqueue(() => backend.save(doc));
      enqueue(send);
    },

    flush: () => enqueue(send),

    /** The last events, newest first, with whether each one reached the server. */
    history: () => [...doc.log].reverse().map((l) => ({ event: l.e, sent: l.sent })),

    /** Resolves once every pending save and send has settled. */
    async idle() {
      for (let c = chain; ; c = chain) {
        await c;
        if (c === chain) return;
      }
    },
  };
}
