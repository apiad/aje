// Boot: config, bridge, store, telemetry and workflow, then a hash router over the screens.
import { connect } from "./bridge.js";
import { idbBackend } from "./core/idb.js";
import { openStore } from "./core/store.js";
import { openTelemetry } from "./core/telemetry.js";
import { createWorkflow } from "./core/workflow.js";
import { renderHome } from "./ui/deck.js";
import { h, icon, mount } from "./ui/dom.js";
import { renderSettings } from "./ui/settings.js";

const NAV = [["home", "Inicio", "home"], ["pay", "Pagar", "bolt"], ["qr", "QR", "qr"], ["history", "Historial", "history"], ["settings", "Ajustes", "settings"]];

const soon = (title) => () => h("div", {},
  h("div", { class: "topbar" }, h("div", { class: "t" }, title)),
  h("div", { class: "empty" }, "Próximamente."));

// `live` screens redraw when the store changes; forms do not, so typing is never lost.
const SCREENS = {
  home: { render: renderHome, live: true },
  settings: { render: renderSettings, live: true },
  pay: { render: soon("Pagar un servicio") },
  qr: { render: soon("Pagar y cobrar por QR") },
};

async function loadConfig() {
  try {
    const res = await fetch("./config.json");
    if (res.ok) return await res.json();
  } catch {
    // Served without a build: the browser during development.
  }
  return { app: "dev", telemetryUrl: "", telemetryToken: "" };
}

function route() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const [name, param] = path.split("/");
  return { name: SCREENS[name] ? name : "home", param, query: new URLSearchParams(query) };
}

async function boot() {
  const root = document.getElementById("app");
  const config = await loadConfig();
  const bridge = await connect();
  await bridge.requestPermissions().catch(() => null);
  const sims = await bridge.listSims().catch(() => []);
  const store = await openStore(idbBackend("state"));
  const telemetry = await openTelemetry({
    config, store, backend: idbBackend("telemetry"), fetch: globalThis.fetch.bind(globalThis), userAgent: navigator.userAgent,
  });
  const workflow = createWorkflow({ bridge, store, telemetry });

  const crash = (error) => telemetry.event("crash", { stack: String(error?.stack ?? error).slice(0, 4000) });
  window.addEventListener("error", (e) => crash(e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => crash(e.reason));
  bridge.onSms((sms) => workflow.handleSms(sms).catch(crash));

  const view = h("main", { id: "view" });
  const links = NAV.map(([name, label, ic]) => h("a", { href: `#/${name}`, "data-nav": name }, icon(ic), label));
  mount(root, h("div", { style: "display:contents" }, view, h("nav", { class: "nav" }, links)));

  const ctx = {
    config, bridge, store, telemetry, workflow, sims,
    go: (r) => { location.hash = `#/${r}`; },
    act: () => {},
    route,
  };

  let current = null;
  function draw() {
    const r = route();
    current = SCREENS[r.name];
    mount(view, current.render(ctx, r));
    for (const a of links) a.classList.toggle("on", a.dataset.nav === r.name);
  }
  window.addEventListener("hashchange", () => {
    draw();
    view.scrollTop = 0;
  });
  store.subscribe(() => current?.live && draw());

  telemetry.event("app_start");
  draw();
}

boot().catch((e) => {
  document.getElementById("app").replaceChildren(
    Object.assign(document.createElement("p"), { className: "err", textContent: `Ajé no pudo arrancar: ${e.message}` }));
});

export { SCREENS };
