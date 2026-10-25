// The native primitives, over the message channel the WebView shell injects as
// `ajeNative` (WebViewCompat.addWebMessageListener), or the browser mock when it is absent.
//
// JS to native: {"id": N, "method": "sendUssd"|"dial"|"listSims"|"requestPermissions"|"ready"|"secretStatus"|"secretSave"|"secretLoad"|"secretForget" (args.unattended on the last three)|"pickContact"|"contactNames"|"readSms"|"installUpdate"|"wakeAt"|"notify"|"done"|"share", "args": {...}}
// Native to JS: {"id": N, "result": ...} | {"id": N, "error": "..."} | {"id": N, "progress": {received, total}} | {"event": "sms", "sender", "body", "sentAt", "receivedAt", "subId"?}
//   | {"event": "open", "route": "inbox/<id>"}, when a tapped notification opens the app
//   | {"event": "wake", "at": ms}, when the shell wakes the open page for its background jobs (web/core/jobs.js)

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
  const opens = [];
  let openHandler = null;
  const wakes = [];
  let wakeHandler = null;

  native.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.event === "open") {
      if (openHandler) openHandler(msg.route);
      else opens.push(msg.route);
      return;
    }
    if (msg.event === "wake") {
      if (wakeHandler) wakeHandler(msg.at);
      else wakes.push(msg.at);
      return;
    }
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
    // With `unattended`, they work on the second copy, under a key that needs no authentication:
    // no prompt, so a job with no window can load it. Save answers false on a phone with no screen lock.
    secretStatus: (name) => call("secretStatus", { name }),
    secretSave: (name, value, days, { unattended = false } = {}) =>
      call("secretSave", { name, value, days, ...(unattended && { unattended }) }, unattended ? timeoutMs : null),
    secretLoad: (name, { unattended = false } = {}) => call("secretLoad", { name, ...(unattended && { unattended }) }, unattended ? timeoutMs : null),
    // The system contact picker: the one contact the person picks, {name, number}, or null; no timeout.
    pickContact: () => call("pickContact"),
    // Forgets both copies; with `unattended`, only the second one.
    secretForget: (name, { unattended = false } = {}) => call("secretForget", { name, ...(unattended && { unattended }) }),
    // The contact names of these numbers, `{number: name}` for those in the contacts. With `ask`, the
    // shell first asks for the contacts permission, so it waits on the person: no timeout.
    contactNames: (numbers, ask) => call("contactNames", { numbers, ask }),
    // The inbox SMS since `since` from service senders, oldest first, never older than 72 hours, as
    // {sender, body, sentAt, receivedAt, subId?}. The shell first asks for the SMS permission: no timeout.
    readSms: (since) => call("readSms", { since }),
    // Downloads a release APK, checks its SHA-256 and signing certificate, and opens Android's
    // installer. A download can take minutes on a mobile line, so it has no timeout.
    // Downloads, verifies and opens the installer; `onProgress(received, total)` follows the download.
    installUpdate: (url, sha256, onProgress = null) => call("installUpdate", { url, sha256 }, null, onProgress),
    // Background work: the time to wake Ajé next (null cancels it), a notification a job posts as
    // {id, channel, title, text, route}, and done, which tells the shell this wake-up is over.
    // Android's share sheet with this text; it waits on the person, so no timeout.
    share: (text) => call("share", { text }),
    wakeAt: (at) => call("wakeAt", { at }),
    notify: (n) => call("notify", n),
    done: () => call("done"),
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
    /** A wake-up the shell sends the open page: `fn(at)`, `at` the time it was asked for. */
    onWake(fn) {
      wakeHandler = fn;
      for (const at of wakes.splice(0)) fn(at);
    },
    /** The route a tapped notification opens; one pushed before a handler is delivered to it. */
    onOpen(fn) {
      openHandler = fn;
      for (const route of opens.splice(0)) fn(route);
    },
  };
}
