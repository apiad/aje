// Card-to-card transfer from the registered card in one currency. It is dialed: the bank's
// last menu asks the person to type 1, and the bank's SMS verifies it afterwards.
import { BANKS, parseAmount, parsePan } from "../core/money.js";
import { h } from "./dom.js";
import { transferSheet } from "./sheets.js";

export function renderTransfer(ctx, r) {
  const currency = r.query.get("from") || "CUP";
  const bank = BANKS[ctx.store.state.settings.bank].name;
  const to = h("input", { id: "tr-to", inputmode: "numeric", autocomplete: "off", placeholder: "9200 0000 0000 0000" });
  const amount = h("input", { id: "tr-amount", inputmode: "numeric", autocomplete: "off" });
  const error = h("div", { id: "tr-error", class: "err", hidden: true });
  const fail = (text) => {
    error.textContent = text;
    error.hidden = false;
  };

  async function submit() {
    let pan;
    try {
      pan = parsePan(to.value);
    } catch {
      return fail("El número de tarjeta tiene 16 dígitos.");
    }
    const n = parseAmount(amount.value);
    if (n === null) return fail("El monto es un número entero, sin decimales.");
    error.hidden = true;
    button.disabled = true;
    try {
      const attempt = await ctx.workflow.transfer(currency, pan, n);
      if (attempt.state === "failed") return fail("El teléfono no pudo abrir el marcador.");
      transferSheet(ctx, attempt, `Transferencia · ${n} ${currency}`);
    } finally {
      button.disabled = false;
    }
  }

  const button = h("button", { id: "tr-submit", class: "btn gold", onclick: (e) => !e.currentTarget.disabled && submit() }, "Transferir");

  return h("div", { id: "transfer" },
    h("div", { class: "sbar" },
      h("button", { class: "back", "aria-label": "Volver", onclick: () => history.back() }, "‹"),
      h("div", {}, h("h2", {}, "Transferir"), h("div", { class: "sub" }, `Desde Tarjeta ${currency} · ${bank}`))),
    h("div", { class: "field" }, h("label", { for: "tr-to" }, "Tarjeta de destino"), to),
    h("div", { class: "field" }, h("label", { for: "tr-amount" }, `Monto en ${currency}`), amount,
      h("div", { class: "hint" }, "Un número entero, sin decimales.")),
    error,
    button,
    h("div", { class: "warn" }, "La transferencia termina en el marcador del teléfono, donde confirmas con ", h("b", {}, "1"), "."),
  );
}
