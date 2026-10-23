// Boot: config, bridge, store, telemetry and workflow, then a hash router over the screens.
import { connect } from "./bridge.js";
import { idbBackend } from "./core/idb.js";
import { openStore } from "./core/store.js";
import { openTelemetry } from "./core/telemetry.js";
import { createWorkflow } from "./core/workflow.js";
import { renderAddCard } from "./ui/addcard.js";
import { renderHome } from "./ui/deck.js";
import { renderHistory } from "./ui/history.js";
import { h, icon, mount } from "./ui/dom.js";
import { renderSettings } from "./ui/settings.js";
import { balanceSheet, closeSheet, mobileBalanceSheet } from "./ui/sheets.js";
import { renderTransfer } from "./ui/transfer.js";
import { autoCheck } from "./ui/updates.js";

const NAV = [["home", "Inicio", "home"], ["pay", "Pagar", "bolt"], ["qr", "QR", "qr"], ["history", "Historial", "history"], ["settings", "Ajustes", "settings"]];

const soon = (title) => () => h("div", {},
  h("div", { class: "topbar" }, h("div", { class: "t" }, title)),
  h("div", { class: "empty" }, "Próximamente."));

// `live` screens redraw when the store changes; forms do not, so typing is never lost.
const SCREENS = {
  home: { render: renderHome, live: true },
  settings: { render: renderSettings, live: true },
  transfer: { render: renderTransfer },
  add: { render: renderAddCard },
  history: { render: renderHistory, live: true },
  pay: { render: soon("Pagar un servicio") },
  qr: { render: soon("Pagar y cobrar por QR") },
};

// A form or a detail sits one level inside its tab: it slides in from the right and back out.
const DEPTH = (r) => (r.name === "transfer" || r.name === "add" || (r.name === "history" && r.param) ? 1 : 0);
const tabOf = (r) => (r.name === "transfer" || r.name === "add" ? "home" : r.name);
const TABS = NAV.map(([name]) => name);
const EASE = "cubic-bezier(.2,0,0,1)";

/** Moves into a screen: push and pop slide within a tab, a tab change fades in from its side. */
function enter(view, from, to) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const sameTab = tabOf(from) === tabOf(to);
  const dx = sameTab ? (DEPTH(to) >= DEPTH(from) ? 36 : -36) : (TABS.indexOf(tabOf(to)) > TABS.indexOf(tabOf(from)) ? 16 : -16);
  view.animate([{ opacity: 0, transform: `translateX(${dx}px)` }, { opacity: 1, transform: "none" }], { duration: 360, easing: EASE });
}

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
  const links = NAV.map(([name, label, ic]) => h("a", { href: `#/${name}`, "data-nav": name },
    name === "qr" ? h("span", { class: "qrbtn" }, icon(ic)) : icon(ic), label));
  const ind = h("span", { class: "ind", "aria-hidden": "true" });
  const nav = h("nav", { class: "nav" }, ind, links);
  mount(root, h("div", { style: "display:contents" }, view, nav));

  const inFlight = new Set();
  // The smoke test seeds cards through the store; only under the mock, never in the APK.
  if (bridge.kind === "mock") globalThis.ajeDev = { store };
  const ctx = {
    config, bridge, store, telemetry, workflow, sims,
    go: (r) => { location.hash = `#/${r}`; },
    act(action, account) {
      if (action === "transfer") return ctx.go(`transfer?card=${account.cardId}`);
      if (action === "resume") return ctx.go(`add/${account.cardId}`);
      const run = { balance: balanceSheet, "mobile-balance": mobileBalanceSheet }[action];
      // A second tap while the USSD is in flight would send it again.
      const key = `${action}:${account.id}`;
      if (!run || inFlight.has(key)) return;
      inFlight.add(key);
      run(ctx, account).catch(crash).finally(() => inFlight.delete(key));
    },
    route,
  };

  let current = null;
  let shown = null;
  function draw() {
    const r = route();
    current = SCREENS[r.name];
    mount(view, current.render(ctx, r));
    const tab = tabOf(r);
    for (const a of links) a.classList.toggle("on", a.dataset.nav === tab);
    const on = links.find((a) => a.dataset.nav === tab);
    ind.style.opacity = on ? "1" : "0";
    if (on) ind.style.transform = `translateX(${on.offsetLeft + on.offsetWidth / 2 - 13}px)`;
    return r;
  }
  window.addEventListener("hashchange", () => {
    closeSheet();
    const from = shown;
    shown = draw();
    view.scrollTop = 0;
    if (from) enter(view, from, shown);
  });
  store.subscribe(() => current?.live && draw());

  telemetry.event("app_start");
  shown = draw();
  autoCheck(ctx);
  // Android keeps the WebView alive in the background, so a return to the app checks again too.
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && autoCheck(ctx));
}

boot().catch((e) => {
  document.getElementById("app").replaceChildren(
    Object.assign(document.createElement("p"), { className: "err", textContent: `Ajé no pudo arrancar: ${e.message}` }));
});

export { SCREENS };
