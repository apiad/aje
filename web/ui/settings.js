// Settings: the SIM registered with the bank, the bank, the deck's currencies, each line's
// balance code, and the dev build's telemetry.
import { BANKS, CURRENCIES } from "../core/money.js";
import { h } from "./dom.js";

function chips(options, isOn, pick) {
  return h("div", { class: "chips" }, options.map(([value, label]) =>
    h("button", { class: isOn(value) ? "on" : null, "aria-pressed": isOn(value) ? "true" : "false", onclick: () => pick(value) }, label)));
}

export function renderSettings(ctx) {
  const { store, sims, config } = ctx;
  const s = store.state.settings;
  const simLabel = (sim) => `SIM ${sim.slot + 1} · ${sim.carrier || "Cubacel"}`;

  const toggleCurrency = (c) => {
    const on = s.enabledCurrencies.includes(c);
    if (on && s.enabledCurrencies.length === 1) return;
    const next = Object.keys(CURRENCIES).filter((x) => (x === c ? !on : s.enabledCurrencies.includes(x)));
    store.update({ enabledCurrencies: next });
  };

  return h("div", { id: "settings" },
    h("div", { class: "topbar" }, h("div", { class: "t" }, "Ajustes")),

    h("div", { class: "group" }, "La línea registrada con el banco"),
    chips([[-1, "La del sistema"], ...sims.map((sim) => [sim.subId, simLabel(sim)])],
      (v) => s.subId === v, (v) => store.update({ subId: v })),

    h("div", { class: "group" }, "Banco"),
    chips(Object.entries(BANKS).filter(([, b]) => b.agency).map(([k, b]) => [k, b.name]),
      (v) => s.bank === v, (v) => store.update({ bank: v })),

    h("div", { class: "group" }, "Monedas en la baraja"),
    chips(Object.keys(CURRENCIES).map((c) => [c, c]), (v) => s.enabledCurrencies.includes(v), toggleCurrency),

    sims.length ? h("div", { class: "group" }, "Saldo móvil de cada línea") : null,
    sims.map((sim) => h("div", { class: "set-row", "data-line": sim.subId },
      h("div", { class: "tx" }, h("b", {}, simLabel(sim)),
        chips([["PREPAGO", "Prepago · *222#"], ["POSPAGO", "Pospago · *111#"]],
          (v) => store.planFor(sim.subId) === v, (v) => store.setPlan(sim.subId, v))))),

    config.telemetryUrl ? [
      h("div", { class: "group" }, "Privacidad"),
      h("div", { class: "set-row" },
        h("div", { class: "tx" }, h("b", {}, "Enviar telemetría"),
          h("span", {}, "Compilación de desarrollo. Los textos del banco salen con cada dígito cambiado por #.")),
        h("button", { class: `toggle${s.telemetry ? " on" : ""}`, "aria-pressed": s.telemetry ? "true" : "false",
          "aria-label": "Enviar telemetría", onclick: () => store.update({ telemetry: !s.telemetry }) })),
      ctx.extraSettings?.(ctx),
    ] : null,

    h("div", { class: "empty" }, `Ajé ${config.app} · ${ctx.bridge.kind === "mock" ? "simulador" : "Android"}`),
  );
}
