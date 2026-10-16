// Bundles web/ into one self-contained HTML page that runs against the mock: the
// artifact for iterating on the interface without building an APK.
// Usage: node tools/build-preview.mjs <out.html> [--aegis]
// --aegis adds aegis's artifact script, so the page can be sent as a live artifact.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [out, flag] = process.argv.slice(2);
if (!out) throw new Error("usage: node tools/build-preview.mjs <out.html> [--aegis]");

const js = execFileSync("npx", ["-y", "esbuild@0.24.0", "web/app.js", "--bundle", "--format=iife", "--log-level=warning"],
  { encoding: "utf8", maxBuffer: 1 << 26 });
const css = readFileSync("web/ui/style.css", "utf8");
// The page reports its current screen, so the agent can read where the person is.
const aegis = flag === "--aegis" ? '<script src="/static/js/artifact.js"></script>\n<script>\n' +
  "aegis.ready(() => { const at = () => aegis.state({ screen: location.hash || \"#/home\" }); at(); addEventListener(\"hashchange\", at); });\n" +
  "</script>\n" : "";

// Escape `</script` so the bundle cannot close its own tag.
const html = readFileSync("web/index.html", "utf8")
  .replace('<link rel="stylesheet" href="./ui/style.css">', () => `${aegis}<style>\n${css}</style>`)
  .replace('<script type="module" src="./app.js"></script>', () => `<script>\n${js.replace(/<\/script/gi, "<\\/script")}</script>`);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`${out}: ${html.length} bytes`);
