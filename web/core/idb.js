// The store backend in the WebView: one JSON document per key in IndexedDB.

let opened = null;

function db() {
  opened ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("aje", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opened;
}

function run(mode, op) {
  return db().then((d) => new Promise((resolve, reject) => {
    const req = op(d.transaction("kv", mode).objectStore("kv"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export function idbBackend(key) {
  return {
    load: () => run("readonly", (s) => s.get(key)).then((doc) => doc ?? null),
    save: (doc) => run("readwrite", (s) => s.put(structuredClone(doc), key)).then(() => undefined),
  };
}
