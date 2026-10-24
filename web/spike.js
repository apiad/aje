// Phase 0 of the background-work spec, a throwaway: the page a Worker loads with no window. It reads
// the app's store from IndexedDB, sends the line's free balance USSD, and posts what happened to the
// shell, which logs it on the phone. The reply's digits are hidden; nothing leaves the phone.
import { idbBackend } from "./core/idb.js";
import { openStore } from "./core/store.js";

const native = globalThis.ajeSpike;
const out = { at: Date.now() };

function ussd(subId, code) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: "no answer in 60 s" }), 60_000);
    native.onmessage = (e) => {
      clearTimeout(timer);
      resolve(JSON.parse(e.data));
    };
    native.postMessage(JSON.stringify({ method: "sendUssd", subId, code }));
  });
}

let subId = -1;
let code = "*222#";
try {
  const store = await openStore(idbBackend("state"));
  out.cards = store.state.cards.filter((c) => !c.removed).length;
  subId = store.state.settings.subId;
  if (store.planFor(subId) === "POSPAGO") code = "*111#";
} catch (e) {
  out.error = `IndexedDB ${e.name}: ${e.message}`;
}
try {
  const r = await ussd(subId, code);
  out.ussd = { code, subId, ok: Boolean(r.ok), failureCode: r.failureCode ?? null, error: r.error || null,
    reply: r.reply ? r.reply.replace(/\d/g, "#").slice(0, 90) : null };
} catch (e) {
  out.ussd = { code, subId, ok: false, error: `${e.name}: ${e.message}` };
}
native.postMessage(JSON.stringify({ method: "result", result: out }));
