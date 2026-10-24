// Card-to-card transfer from one of the stored cards. It is dialed: the bank's
// last menu asks the person to type 1, and the bank's SMS verifies it afterwards.
import { liveCards } from "../core/accounts.js";
import { BANKS, parseAmount, parsePan } from "../core/money.js";
import { h } from "./dom.js";
import { openScanner } from "./scanner.js";
import { transferSheet } from "./sheets.js";

export function renderTransfer(ctx, r) {
  const card = liveCards(ctx.store.state).find((c) => c.id === r.query.get("card")) ?? liveCards(ctx.store.state)[0];
  if (!card) return h("div", { class: "empty" }, "Añade una tarjeta para transferir.");
  const { currency } = card;
  const bank = BANKS[card.bank]?.name ?? "";
  const clasica = card.bank === "CLASICA";
  const to = h("input", { id: "tr-to", inputmode: "numeric", autocomplete: "off", placeholder: clasica ? "Cuenta del número de destino" : "9200 0000 0000 0000" });
  const amount = h("input", { id: "tr-amount", inputmode: "numeric", autocomplete: "off" });
  const error = h("div", { id: "tr-error", class: "err", hidden: true });
  const fail = (text) => {
    error.textContent = text;
    error.hidden = false;
  };

  async function submit() {
    let pan;
    if (clasica) {
      pan = to.value.replace(/[-\s]/g, "");
      if (!/^[0-9]{8,16}$/.test(pan)) return fail("Escribe la cuenta del número de destino.");
    } else {
      try {
        pan = parsePan(to.value);
      } catch {
        return fail("El número de tarjeta tiene 16 dígitos.");
      }
    }
    const n = parseAmount(amount.value);
    if (n === null) return fail("El monto es un número entero, sin decimales.");
    error.hidden = true;
    button.disabled = true;
    try {
      const attempt = await ctx.workflow.transfer(card.id, pan, n);
      if (attempt.state === "failed") return fail("El teléfono no pudo abrir el marcador.");
      transferSheet(ctx, attempt, `Transferencia · ${n} ${currency}`);
    } finally {
      button.disabled = false;
    }
  }

  // The destination card's number read by the camera, as in Añadir tarjeta; the person checks it before sending.
  const scanbox = h("div", { class: "scanbox", id: "tr-scanbox", hidden: true });
  const scan = h("button", { id: "tr-scan", class: "btn ghost", onclick: () => {
    error.hidden = true;
    scan.hidden = true;
    scanbox.hidden = false;
    const done = (pan) => {
      stop();
      scanbox.hidden = true;
      scan.hidden = false;
      if (pan) to.value = pan.replace(/(\d{4})(?=\d)/g, "$1 ");
      else fail("No se pudo leer la tarjeta. Escribe el número.");
      to.focus();
    };
    const stop = openScanner(scanbox, { onPan: done, onFallback: done });
  } }, "Escanear tarjeta");

  const button = h("button", { id: "tr-submit", class: "btn gold", onclick: (e) => !e.currentTarget.disabled && submit() }, "Transferir");

  return h("div", { id: "transfer" },
    h("div", { class: "sbar" },
      h("button", { class: "back", "aria-label": "Volver", onclick: () => history.back() }, "‹"),
      h("div", {}, h("h2", {}, "Transferir"), h("div", { class: "sub" }, `Desde ${card.alias} · ${bank}`))),
    h("div", { class: "field" }, h("label", { for: "tr-to" }, clasica ? "Cuenta del número de destino" : "Tarjeta de destino"), to),
    clasica ? null : [scan, scanbox],
    h("div", { class: "field" }, h("label", { for: "tr-amount" }, `Monto en ${currency}`), amount,
      h("div", { class: "hint" }, "Un número entero, sin decimales.")),
    error,
    button,
    h("div", { class: "warn" }, "La transferencia termina en el marcador del teléfono, donde confirmas con ", h("b", {}, "1"), "."),
  );
}
