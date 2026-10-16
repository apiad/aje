// Opt-in development telemetry. Every event carries the app version, Android version,
// device model and a random install id, plus only the fields in ALLOWED. Message texts
// (USSD replies, bank SMS) go through mask first, so every digit leaves the phone as #:
// the words arrive, numbers, amounts and balances do not.

/** Mirrored in telemetry/collector.py; web/test/telemetry.test.js checks the two match. */
export const ALLOWED = new Set([
  "op", "ok", "failure_code", "latency_ms", "kind", "sender", "length", "lines",
  "error", "stack", "bank", "via", "default_sub", "text", "age_ms",
]);

const LOG_SIZE = 200;

/** Every digit becomes #, in any script. */
export const mask = (text) => text.replace(/\p{Nd}/gu, "#");

function deviceOf(userAgent) {
  const m = /Android ([\d.]+); ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(userAgent ?? "");
  return m ? { sdk: m[1], device: m[2] } : { sdk: "unknown", device: "unknown" };
}

export async function openTelemetry({ config, store, backend, fetch, now = Date.now, userAgent }) {
  const doc = (await backend.load()) ?? { queue: [], log: [] };
  const { sdk, device } = deviceOf(userAgent);
  let chain = Promise.resolve();

  async function send() {
    if (doc.queue.length === 0) return;
    const batch = [...doc.queue];
    try {
      const res = await fetch(config.telemetryUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Aje-Token": config.telemetryToken },
        body: JSON.stringify(batch),
      });
      if (!res.ok) return;
      doc.queue = doc.queue.slice(batch.length);
      for (const entry of doc.log) if (batch.includes(entry.e)) entry.sent = true;
      await backend.save(doc);
    } catch {
      // Offline: the queue keeps the events for the next try.
    }
  }

  const enqueue = (step) => (chain = chain.then(step).catch(() => {}));

  return {
    event(name, fields = {}) {
      for (const k of Object.keys(fields)) if (!ALLOWED.has(k)) throw new Error(`telemetry field not allowed: ${k}`);
      if (!store.state.settings.telemetry || !config.telemetryUrl) return;
      const e = { event: name, t: now(), app: config.app, sdk, device, install: store.state.installId };
      for (const [k, v] of Object.entries(fields)) {
        if (v !== null && v !== undefined) e[k] = k === "text" && typeof v === "string" ? mask(v) : v;
      }
      doc.queue.push(e);
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
