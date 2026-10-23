// Bundles web/ into one self-contained HTML page that runs against the mock: the
// artifact for iterating on the interface without building an APK.
// Usage: node tools/build-preview.mjs <out.html> [--aegis]
// --aegis adds aegis's artifact script, so the page can be sent as a live artifact.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [out, flag] = process.argv.slice(2);
if (!out) throw new Error("usage: node tools/build-preview.mjs <out.html> [--aegis]");

// ESM, not IIFE, so `import.meta.url` resolves (scanner.js reads it at load); the page embeds
// the bundle as a module script, as the app itself loads app.js.
const js = execFileSync("npx", ["-y", "esbuild@0.24.0", "web/app.js", "--bundle", "--format=esm", "--log-level=warning"],
  { encoding: "utf8", maxBuffer: 1 << 26 });
const css = readFileSync("web/ui/style.css", "utf8");
// An aegis artifact runs in a sandboxed frame with no IndexedDB, so the page gets an
// in-memory stand-in with the few calls web/core/idb.js makes; state lasts until reload.
const MEMORY_IDB = `(() => {
  const data = new Map();
  const later = (r, fn) => { setTimeout(() => { r.result = fn(); r.onsuccess?.(); }); return r; };
  const store = { get: (k) => later({}, () => data.get(k)), put: (v, k) => later({}, () => { data.set(k, v); return k; }) };
  const db = { createObjectStore: () => store, transaction: () => ({ objectStore: () => store }) };
  const open = () => { const r = {}; setTimeout(() => { r.result = db; r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; };
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open } });
})();`;

// Chrome reports "ResizeObserver loop completed" as an error when the host resizes the frame;
// it is benign, so it is kept from reaching aegis's error reporter.
const QUIET_RESIZE = 'addEventListener("error", (e) => { if (/ResizeObserver loop/.test(e.message)) e.stopImmediatePropagation(); }, true);';
// The filter goes before artifact.js, so it is registered ahead of aegis's own error listener.
// The page reports its current screen, so the agent can read where the person is.
const aegis = flag === "--aegis" ? `<script>${QUIET_RESIZE}</script>\n` + '<script src="/static/js/artifact.js"></script>\n<script>\n' + MEMORY_IDB + "\n" +
  "aegis.ready(() => { const at = () => aegis.state({ screen: location.hash || \"#/home\" }); at(); addEventListener(\"hashchange\", at); });\n" +
  "</script>\n" : "";

// Escape `</script` so the bundle cannot close its own tag.
const html = readFileSync("web/index.html", "utf8")
  .replace('<link rel="stylesheet" href="./ui/style.css">', () => `${aegis}<style>\n${css}</style>`)
  .replace('<script type="module" src="./app.js"></script>', () => `<script type="module">\n${js.replace(/<\/script/gi, "<\\/script")}</script>`);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`${out}: ${html.length} bytes`);
