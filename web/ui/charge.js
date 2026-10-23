// Cobrar: a line shows a QR with its number and an optional amount and name; the payer scans it and
// passes the balance, and Cubacel's "recibido" SMS turns the status into what really arrived.
import { normalizeNumber } from "../core/lines.js";
import { qrSvg } from "../core/qrimage.js";
import { h } from "./dom.js";

/** The QR's SVG as a node, parsed rather than set as HTML. */
const svgNode = (svg) => document.importNode(new DOMParser().parseFromString(svg, "image/svg+xml").documentElement, true);

export function renderLineCharge(ctx, r) {
  const subId = Number(r.query.get("sub") ?? ctx.sims[0]?.subId);
  const root = h("div", { id: "line-charge" });
  let unsubscribe = null;

  function header() {
    return h("div", { class: "sbar" },
      h("button", { class: "back", "aria-label": "Volver", onclick: () => history.back() }, "‹"),
      h("div", {}, h("h2", {}, "Cobrar"), h("div", { class: "sub" }, "Quien te paga escanea el QR con Ajé")));
  }

  function form() {
    unsubscribe?.();
    const saved = ctx.store.state.settings.lineNumbers[subId];
    const error = h("div", { id: "lc-error", class: "err", hidden: true });
    const number = saved ? null : h("input", { id: "lc-number", inputmode: "tel", autocomplete: "off", placeholder: "5XXXXXXX" });
    const amount = h("input", { id: "lc-amount", inputmode: "numeric", autocomplete: "off" });
    const name = h("input", { id: "lc-name", autocomplete: "off", maxlength: "40" });
    const fail = (text) => { error.textContent = text; error.hidden = false; };

    async function show() {
      if (number) {
        const n = normalizeNumber(number.value);
        if (!n) return fail("Ese número no es un móvil Cubacel.");
        await ctx.store.setLineNumber(subId, n);
      }
      const m = amount.value.trim();
      if (m && !/^\d+$/.test(m)) return fail("El monto es un número entero de CUP, sin decimales.");
      if (m && Number(m) <= 0) return fail("El monto tiene que ser mayor que cero.");
      const res = await ctx.workflow.charge(subId, { amount: m ? Number(m) : null, name: name.value.trim() || null });
      if (!res.ok) return fail("Falta el número de esta línea.");
      shown(res);
    }

    root.replaceChildren(header(),
      number ? h("div", { class: "field" }, h("label", { for: "lc-number" }, "El número de esta línea"), number,
        h("div", { class: "hint" }, "Lo pide una vez: el teléfono casi nunca sabe su propio número.")) : null,
      h("div", { class: "field" }, h("label", { for: "lc-amount" }, "Monto en CUP (opcional)"), amount,
        h("div", { class: "hint" }, "Sin monto, quien paga lo escribe.")),
      h("div", { class: "field" }, h("label", { for: "lc-name" }, "Tu nombre (opcional)"), name,
        h("div", { class: "hint" }, "Para que quien paga vea a quién paga.")),
      error,
      h("button", { id: "lc-show", class: "btn gold", onclick: show }, "Mostrar QR"));
  }

  function shown({ uri, attempt }) {
    const status = h("div", { id: "lc-status", class: "reply pending" });
    const draw = () => {
      const a = ctx.store.state.attempts.find((x) => x.id === attempt.id) ?? attempt;
      const got = a.state === "verified";
      status.className = `reply${got ? "" : " pending"}`;
      status.replaceChildren(h("div", { class: "k status" }, h("span", { class: got ? "dot" : "spin", "aria-hidden": "true" }),
        got ? `Recibido ${a.receivedAmount} CUP de ${a.from}` : "Esperando el pago"));
      if (got) unsubscribe?.();
    };
    draw();
    // Cubacel's SMS lands in the store; this screen is a form, so it listens instead of redrawing whole.
    unsubscribe = ctx.store.subscribe(() => (root.isConnected ? draw() : unsubscribe?.()));
    root.replaceChildren(header(),
      h("div", { id: "lc-qr", class: "qrbox" }, svgNode(qrSvg(uri))),
      h("div", { class: "qrcap" }, h("b", {}, attempt.to),
        attempt.amount ? h("span", {}, ` · ${attempt.amount} CUP`) : null,
        attempt.name ? h("span", {}, ` · ${attempt.name}`) : null),
      status,
      h("button", { id: "lc-new", class: "btn ghost", onclick: form }, "Nuevo cobro"));
  }

  form();
  return root;
}
