// The native primitives, over the message channel the WebView shell injects as
// `ajeNative` (WebViewCompat.addWebMessageListener), or the browser mock when it is absent.
//
// JS to native: {"id": N, "method": "sendUssd"|"dial"|"listSims"|"requestPermissions"|"ready"|"secretStatus"|"secretSave"|"secretLoad"|"secretForget"|"pickContact"|"installUpdate", "args": {...}}
// Native to JS: {"id": N, "result": ...} | {"id": N, "error": "..."} | {"id": N, "progress": {received, total}} | {"event": "sms", "sender", "body", "sentAt", "receivedAt", "subId"?}

/** How long a USSD may go unanswered; some phones never call back. */
const USSD_TIMEOUT_MS = 60_000;

export async function connect({ native = globalThis.ajeNative, loadMock = () => import("./mock.js"), timeoutMs = USSD_TIMEOUT_MS } = {}) {
  if (!native) {
    const { createMock } = await loadMock();
    return createMock();
  }

  let nextId = 1;
  const pending = new Map();
  const buffered = [];
  let handler = null;

  native.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.event === "sms") {
      const sms = { sender: msg.sender, body: msg.body, sentAt: msg.sentAt ?? null, receivedAt: msg.receivedAt, subId: msg.subId ?? null };
      if (handler) handler(sms);
      else buffered.push(sms);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    // A long call (an update download) reports progress before its result.
    if ("progress" in msg) return p.onProgress?.(msg.progress.received, msg.progress.total);
    pending.delete(msg.id);
    if ("error" in msg) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  };

  const call = (method, args = {}, timeout = null, onProgress = null) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = timeout && setTimeout(() => {
      pending.delete(id);
      reject(new Error(`no answer to ${method}`));
    }, timeout);
    const done = (fn) => (v) => {
      clearTimeout(timer);
      fn(v);
    };
    pending.set(id, { resolve: done(resolve), reject: done(reject), onProgress });
    native.postMessage(JSON.stringify({ id, method, args }));
  });

  return {
    kind: "native",
    sendUssd: (subId, code) => call("sendUssd", { subId, code }, timeoutMs),
    dial: (code) => call("dial", { code }),
    listSims: () => call("listSims"),
    requestPermissions: () => call("requestPermissions"),
    // The secret store. Save and load show the fingerprint or screen-lock prompt, so they wait on
    // the person with no timeout; load answers null when nothing is saved or the person cancels.
    secretStatus: (name) => call("secretStatus", { name }),
    secretSave: (name, value, days) => call("secretSave", { name, value, days }),
    secretLoad: (name) => call("secretLoad", { name }),
    // The system contact picker: the one contact the person picks, {name, number}, or null; no timeout.
    pickContact: () => call("pickContact"),
    secretForget: (name) => call("secretForget", { name }),
    // Downloads a release APK, checks its SHA-256 and signing certificate, and opens Android's
    // installer. A download can take minutes on a mobile line, so it has no timeout.
    // Downloads, verifies and opens the installer; `onProgress(received, total)` follows the download.
    installUpdate: (url, sha256, onProgress = null) => call("installUpdate", { url, sha256 }, null, onProgress),
    /**
     * The first handler sends `ready`, which opens the push channel and makes the shell deliver,
     * then delete, the SMS it queued while no page was alive: so only a page that can save them
     * asks for them. SMS that arrived before a handler existed are delivered to it.
     */
    onSms(fn) {
      const first = handler === null;
      handler = fn;
      for (const sms of buffered.splice(0)) fn(sms);
      if (first) call("ready").catch(() => {});
    },
  };
}
