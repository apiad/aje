// The five native primitives, over the message channel the WebView shell injects as
// `ajeNative` (WebViewCompat.addWebMessageListener), or the browser mock when it is absent.
//
// JS to native: {"id": N, "method": "sendUssd"|"dial"|"listSims"|"requestPermissions"|"ready", "args": {...}}
// Native to JS: {"id": N, "result": ...} | {"id": N, "error": "..."} | {"event": "sms", "sender", "body", "receivedAt"}

export async function connect({ native = globalThis.ajeNative, loadMock = () => import("./mock.js") } = {}) {
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
      const sms = { sender: msg.sender, body: msg.body, receivedAt: msg.receivedAt };
      if (handler) handler(sms);
      else buffered.push(sms);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if ("error" in msg) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  };

  const call = (method, args = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    native.postMessage(JSON.stringify({ id, method, args }));
  });

  // Opens the push channel; the shell then delivers the SMS it queued while no page was alive.
  call("ready").catch(() => {});

  return {
    kind: "native",
    sendUssd: (subId, code) => call("sendUssd", { subId, code }),
    dial: (code) => call("dial", { code }),
    listSims: () => call("listSims"),
    requestPermissions: () => call("requestPermissions"),
    /** SMS that arrived before a handler existed are delivered to the first one. */
    onSms(fn) {
      handler = fn;
      for (const sms of buffered.splice(0)) fn(sms);
    },
  };
}
