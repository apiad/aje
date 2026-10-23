// The one-time question on first launch: telemetry stays off unless the person turns it on here
// or in Settings. Asking marks it asked, so closing the sheet any way counts as "not now".
import { h } from "./dom.js";
import { openSheet } from "./sheets.js";

export const PRIVACY_URL = "https://aje.apiad.net/privacidad";

export function askTelemetry(ctx) {
  const { config, store } = ctx;
  if (!config.telemetryUrl || store.state.settings.telemetryAsked) return;
  store.update({ telemetryAsked: true });
  const sheet = openSheet(ctx, () => [
    h("h3", {}, "¿Nos ayudas a encontrar fallos?"),
    h("p", { class: "consent" }, "Si lo activas, Ajé envía avisos de error y la forma de los mensajes del banco que no sabe leer. " +
      "Antes de salir del teléfono se tachan los números y los nombres. Ningún envío lleva un identificador tuyo ni se puede unir a otro."),
    h("a", { class: "consent-link", href: PRIVACY_URL }, "Cómo funciona"),
    h("div", { class: "pair" },
      h("button", { id: "consent-no", class: "btn ghost", onclick: () => sheet.close() }, "Ahora no"),
      h("button", { id: "consent-yes", class: "btn ghost", onclick: () => { store.update({ telemetry: true }); sheet.close(); } }, "Activar")),
  ]);
}
