// Settings: the SIM registered with the banks, the saved bank PINs, the automatic mode, each line's
// balance code, and the dev build's telemetry.
import { PRIVACY_URL } from "./consent.js";
import { simLabel as slotLabel } from "../core/accounts.js";
import { BANKS } from "../core/money.js";
import { pinName, PIN_DAYS } from "../core/workflow.js";
import { h } from "./dom.js";
import { openSheet } from "./sheets.js";
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

// The banks whose PIN Ajé can keep: those a card logs in to on its own.
const PIN_BANKS = Object.keys(BANKS).filter((b) => BANKS[b].agency && !BANKS[b].session);

/**
 * Turns the automatic mode on: each saved bank PIN is unlocked once with the fingerprint and saved
 * again under the key that needs none. Answers the reason it could not, or null.
 */
async function turnOn(ctx) {
  const { bridge, store } = ctx;
  const statuses = await Promise.all(PIN_BANKS.map((b) => bridge.secretStatus(pinName(b)).catch(() => null)));
  const saved = PIN_BANKS.filter((b, i) => statuses[i]?.saved);
  if (!saved.length) return "Primero guarda la clave del banco: consulta un saldo y marca Recordar.";
  if (statuses.some((st) => st && st.deviceSecure === false)) return "Ponle bloqueo de pantalla al teléfono primero.";
  for (const bank of saved) {
    const pin = await bridge.secretLoad(pinName(bank)).catch(() => null);
    if (!pin) return "No se pudo abrir la clave guardada. Prueba otra vez.";
    if (!(await bridge.secretSave(pinName(bank), pin, PIN_DAYS, { unattended: true }).catch(() => false))) {
      return "Ponle bloqueo de pantalla al teléfono primero.";
    }
  }
  await store.update({ automation: { ...store.state.settings.automation, on: true } });
  return null;
}

/** Turns it off: the copies that need no fingerprint go, and every rule stops. */
async function turnOff(ctx) {
  await Promise.all(PIN_BANKS.map((b) => ctx.bridge.secretForget(pinName(b), { unattended: true }).catch(() => null)));
  await ctx.store.update({ automation: { ...ctx.store.state.settings.automation, on: false } });
}

// The consent the mode asks for before it turns on.
function consentSheet(ctx) {
  let understood = false;
  let msg = null;
  let busy = false;
  const sheet = openSheet(ctx, () => h("div", { class: "consent-box" },
    h("h3", {}, "¿Activar el modo automático?"),
    h("p", {}, "Ajé podrá pagar tus servicios sin que estés delante, según las reglas y los límites que pongas."),
    h("div", { class: "warn" }, "La clave del banco quedará guardada en el teléfono sin pedir la huella. Quien tenga tu teléfono desbloqueado podría usar Ajé para mover dinero. Ponle bloqueo de pantalla al teléfono."),
    h("p", { style: "margin-top:10px" }, "Cada operación automática te llega como notificación. Si apagas el modo, la clave vuelve a pedir la huella y todas las reglas se detienen."),
    h("label", { class: "remember" },
      h("input", { type: "checkbox", id: "auto-understand", checked: understood, onchange: (e) => { understood = e.target.checked; sheet.redraw(); } }),
      h("b", {}, "Entiendo el riesgo y quiero activarlo")),
    msg ? h("div", { class: "err", id: "auto-msg" }, msg) : null,
    h("button", { id: "auto-activate", class: "btn gold", disabled: !understood || busy, onclick: activate }, busy ? "Esperando la huella…" : "Activar con huella"),
    h("button", { id: "auto-cancel", class: "btn ghost", onclick: () => sheet.close() }, "Ahora no")));
  async function activate() {
    busy = true;
    msg = null;
    sheet.redraw();
    msg = await turnOn(ctx);
    busy = false;
    if (msg === null) sheet.close();
    else sheet.redraw();
  }
}

// Settings redraws on every store change; the fold of the telemetry history keeps its state.
let historyOpen = false;

export function renderSettings(ctx) {
  const { store, sims, config } = ctx;
  const s = store.state.settings;
  const simLabel = (sim) => s.lines?.[sim.subId]?.alias || slotLabel(sim);
  const hidden = (sim) => Boolean(s.lines?.[sim.subId]?.hidden);
  const auto = s.automation;


  return h("div", { id: "settings" },
    h("div", { class: "topbar" }, h("div", { class: "t" }, "Ajustes")),

    h("div", { class: "group" }, "La línea registrada con los bancos"),
    chips([[-1, "La del sistema"], ...sims.map((sim) => [sim.subId, simLabel(sim)])],
      (v) => s.subId === v, (v) => store.update({ subId: v })),

    PIN_BANKS.map((b) => pinRow(ctx, b)),

    h("div", { class: "group" }, "Automatización"),
    h("div", { class: "set-row" },
      h("div", { class: "tx" }, h("b", {}, "Modo automático"),
        h("span", {}, auto.on ? "Ajé paga tus servicios según tus reglas, sin pedir la huella." : "Apagado: ninguna regla se ejecuta sola.")),
      h("button", { id: "auto-mode", class: `toggle${auto.on ? " on" : ""}`, "aria-pressed": auto.on ? "true" : "false", "aria-label": "Modo automático",
        onclick: () => (auto.on ? turnOff(ctx) : consentSheet(ctx)) })),
    h("div", { class: "set-row" },
      h("div", { class: "tx" }, h("b", {}, "Tope mensual"),
        h("span", {}, `Lo más que pueden mover todas las automatizaciones juntas en un mes, por moneda.`)),
      h("input", { id: "auto-cap", class: "cap", inputmode: "numeric", value: String(auto.capCents / 100), "aria-label": "Tope mensual",
        onchange: (e) => {
          const v = Number(e.target.value);
          if (v > 0) store.update({ automation: { ...store.state.settings.automation, capCents: Math.round(v * 100) } });
        } })),

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
