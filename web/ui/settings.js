// Settings: the SIM registered with the banks, the saved bank PINs, each line's balance code,
// and the dev build's telemetry.
import { PRIVACY_URL } from "./consent.js";
import { simLabel as slotLabel } from "../core/accounts.js";
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

const hhmm = (ms) => new Date(ms).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });

// Phase 0 of the background-work spec, a throwaway: wake-ups with the app closed and what each one saw.
function spikeSection(ctx) {
  const list = h("div", { id: "spike-log" });
  const load = () => ctx.bridge.spikeLog().then((log) => {
    list.replaceChildren(...(log.length ? log.slice().reverse() : [null]).map((e) => (e ? h("div", { class: "set-row" },
      h("div", { class: "tx" },
        h("b", {}, `${e.n}/${e.of} · pedida ${hhmm(e.askedAt)} · llegó ${hhmm(e.startedAt)} (${Math.round(e.lateMin)} min tarde)`),
        h("span", {}, [
          `Pantalla ${e.screenOn ? "encendida" : "apagada"}${e.dozing ? ", en reposo" : ""}${e.appInFront ? ", Ajé delante" : ""}`,
          e.page?.error ? `Página: ${e.page.error}` : `Página en ${e.page?.loadMs ?? "?"} ms · IndexedDB: ${e.page?.cards ?? "?"} tarjetas`,
          e.page?.ussd ? `${e.page.ussd.code}: ${e.page.ussd.ok ? `ok · ${e.page.ussd.reply ?? ""}` : `falló ${e.page.ussd.failureCode ?? ""} ${e.page.ussd.error ?? ""}`}` : "USSD: no se probó",
          `Ahorro de batería: ${e.batteryExempt ? "Ajé excluida" : "activo"} · ${e.maker} · Android API ${e.android}`,
        ].join(" · ")))) : h("div", { class: "empty" }, "Aún no hay despertares."))));
  }).catch(() => list.replaceChildren(h("div", { class: "empty" }, "Esta versión no tiene la prueba.")));
  load();
  const btn = (id, label, fn) => h("button", { id, class: "addchip", onclick: async () => { await fn(); load(); } }, label);
  return [
    h("div", { class: "group" }, "Prueba de segundo plano (fase 0)"),
    h("div", { class: "set-row" }, h("div", { class: "tx" }, h("b", {}, "Cómo probar"),
      h("span", {}, "Programa los despertares, cierra Ajé (quítala de recientes) y apaga la pantalla. Cada uno consulta el saldo de la línea por USSD y deja una notificación."))),
    h("div", { class: "addrow" },
      btn("spike-1", "Uno en 2 min", () => ctx.bridge.spikeSchedule([2])),
      btn("spike-24", "24, uno por hora", () => ctx.bridge.spikeSchedule([...Array(24).keys()].map((i) => 60 * (i + 1)))),
      btn("spike-refresh", "Actualizar", async () => {}),
      btn("spike-clear", "Borrar y cancelar", () => ctx.bridge.spikeClear())),
    list,
  ];
}

// Settings redraws on every store change; the fold of the telemetry history keeps its state.
let historyOpen = false;

export function renderSettings(ctx) {
  const { store, sims, config } = ctx;
  const s = store.state.settings;
  const simLabel = (sim) => s.lines?.[sim.subId]?.alias || slotLabel(sim);
  const hidden = (sim) => Boolean(s.lines?.[sim.subId]?.hidden);


  return h("div", { id: "settings" },
    h("div", { class: "topbar" }, h("div", { class: "t" }, "Ajustes")),

    h("div", { class: "group" }, "La línea registrada con los bancos"),
    chips([[-1, "La del sistema"], ...sims.map((sim) => [sim.subId, simLabel(sim)])],
      (v) => s.subId === v, (v) => store.update({ subId: v })),

    Object.keys(BANKS).filter((b) => BANKS[b].agency && !BANKS[b].session).map((b) => pinRow(ctx, b)),

    sims.length ? h("div", { class: "group" }, "Saldo móvil de cada línea") : null,
    sims.map((sim) => h("div", { class: "set-row", "data-line": sim.subId },
      h("div", { class: "tx" }, h("b", {}, simLabel(sim), hidden(sim) ? " · oculta" : ""),
        chips([["PREPAGO", "Prepago · *222#"], ["POSPAGO", "Pospago · *111#"]],
          (v) => store.planFor(sim.subId) === v, (v) => store.setPlan(sim.subId, v))),
      hidden(sim) ? h("button", { class: "addchip", "data-unhide": sim.subId, onclick: () => store.setLine(sim.subId, { hidden: false }) }, "Mostrar") : null)),

    h("div", { class: "group" }, "Transfermóvil"),
    h("div", { class: "set-row" },
      h("div", { class: "tx" }, h("b", {}, "Importar de Transfermóvil"), h("span", {}, "Tus tarjetas, destinatarios y contratos, desde su respaldo.")),
      h("button", { id: "import-tm-settings", class: "addchip", onclick: () => ctx.go("import") }, "Importar")),

    updateSettings(ctx, chips),

    ctx.bridge.spikeLog ? spikeSection(ctx) : null,

    config.telemetryUrl ? [
      h("div", { class: "group" }, "Privacidad"),
      h("div", { class: "set-row" },
        h("div", { class: "tx" }, h("b", {}, "Enviar telemetría"),
          h("span", {}, "Errores y mensajes tachados, sin identificador. ", h("a", { href: PRIVACY_URL }, "Cómo funciona"))),
        h("button", { class: `toggle${s.telemetry ? " on" : ""}`, "aria-pressed": s.telemetry ? "true" : "false",
          "aria-label": "Enviar telemetría", onclick: () => store.update({ telemetry: !s.telemetry }) })),
      s.telemetry ? h("details", { id: "telemetry-history", open: historyOpen, ontoggle: (e) => { historyOpen = e.target.open; } },
        h("summary", { class: "group" }, "Lo que se ha enviado"),
        ctx.telemetry.history().slice(0, 50).map((x) => h("div", { class: "set-row" },
          h("div", { class: "tx" }, h("b", {}, `${x.event.event} · ${x.sent ? "recibido" : "pendiente"}`),
            h("pre", { class: "ev" }, JSON.stringify(x.event, null, 2)))))) : null,
    ] : null,

    h("div", { class: "empty" }, `Ajé ${config.app} · ${ctx.bridge.kind === "mock" ? "simulador" : "Android"}`),
  );
}
