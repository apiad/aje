// Settings: the SIM registered with the banks, the saved bank PINs, each line's balance code,
// and the dev build's telemetry.
import { PRIVACY_URL } from "./consent.js";
import { BANKS } from "../core/money.js";
import { h } from "./dom.js";
import { updateSettings } from "./updates.js";

function chips(options, isOn, pick) {
  return h("div", { class: "chips" }, options.map(([value, label]) =>
    h("button", { class: isOn(value) ? "on" : null, "aria-pressed": isOn(value) ? "true" : "false", onclick: () => pick(value) }, label)));
}

// Each bank's saved PIN, if any: when it lapses, and a way to drop it now. Filled in once the shell answers.
function pinRow(ctx, bank) {
  const box = h("div", { "data-pin": bank });
  ctx.workflow.savedPin(bank).then((st) => {
    if (!st.saved) return;
    const until = st.expiresAt ? new Date(st.expiresAt).toLocaleDateString("es") : null;
    box.replaceChildren(h("div", { class: "set-row" },
      h("div", { class: "tx" }, h("b", {}, `Clave guardada · ${BANKS[bank].name}`),
        h("span", {}, `Cifrada en este teléfono${until ? `; caduca el ${until}` : ""}.`)),
      h("button", { class: "addchip pin-forget", onclick: async () => {
        await ctx.workflow.forgetPin(bank);
        box.replaceChildren();
      } }, "Olvidar")));
  });
  return box;
}

export function renderSettings(ctx) {
  const { store, sims, config } = ctx;
  const s = store.state.settings;
  const simLabel = (sim) => `SIM ${sim.slot + 1} · ${sim.carrier || "Cubacel"}`;


  return h("div", { id: "settings" },
    h("div", { class: "topbar" }, h("div", { class: "t" }, "Ajustes")),

    h("div", { class: "group" }, "La línea registrada con los bancos"),
    chips([[-1, "La del sistema"], ...sims.map((sim) => [sim.subId, simLabel(sim)])],
      (v) => s.subId === v, (v) => store.update({ subId: v })),

    Object.keys(BANKS).filter((b) => BANKS[b].agency && !BANKS[b].session).map((b) => pinRow(ctx, b)),

    sims.length ? h("div", { class: "group" }, "Saldo móvil de cada línea") : null,
    sims.map((sim) => h("div", { class: "set-row", "data-line": sim.subId },
      h("div", { class: "tx" }, h("b", {}, simLabel(sim)),
        chips([["PREPAGO", "Prepago · *222#"], ["POSPAGO", "Pospago · *111#"]],
          (v) => store.planFor(sim.subId) === v, (v) => store.setPlan(sim.subId, v))))),

    updateSettings(ctx, chips),

    config.telemetryUrl ? [
      h("div", { class: "group" }, "Privacidad"),
      h("div", { class: "set-row" },
        h("div", { class: "tx" }, h("b", {}, "Enviar telemetría"),
          h("span", {}, "Errores y mensajes tachados, sin identificador. ", h("a", { href: PRIVACY_URL }, "Cómo funciona"))),
        h("button", { class: `toggle${s.telemetry ? " on" : ""}`, "aria-pressed": s.telemetry ? "true" : "false",
          "aria-label": "Enviar telemetría", onclick: () => store.update({ telemetry: !s.telemetry }) })),
      s.telemetry ? h("div", { id: "telemetry-history" },
        h("div", { class: "group" }, "Lo que se ha enviado"),
        ctx.telemetry.history().slice(0, 50).map((x) => h("div", { class: "set-row" },
          h("div", { class: "tx" }, h("b", {}, `${x.event.event} · ${x.sent ? "recibido" : "pendiente"}`),
            h("pre", { class: "ev" }, JSON.stringify(x.event, null, 2)))))) : null,
    ] : null,

    h("div", { class: "empty" }, `Ajé ${config.app} · ${ctx.bridge.kind === "mock" ? "simulador" : "Android"}`),
  );
}
