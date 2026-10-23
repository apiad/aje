// Comprar plan: walks the *133 menu by chained shortcuts over the USSD API and draws each level as
// buttons. Only the confirm view's "Comprar" buys, with the path plus 1, the network's confirm option.
import { planPath } from "../core/lines.js";
import { dial } from "../core/ussd.js";
import { h } from "./dom.js";

const RESULT = {
  bought: "Plan comprado.",
  refused: "Cubacel no hizo la compra.",
  dialer: "Termina en el marcador: escribe 1 para confirmar.",
  unknown: "Cubacel respondió algo que Ajé no reconoce. Revisa tu saldo antes de intentarlo otra vez.",
  failed: "No se pudo enviar la compra.",
};

/** An option the screen's own Atrás replaces: "0-Atras". */
const isBack = (o) => o.key === "0" && /^atr/i.test(o.label);

export function renderPlans(ctx, r) {
  const subId = Number(r.query.get("sub") ?? ctx.sims[0]?.subId);
  const path = [];
  const labels = [];
  let seq = 0; // a reply for a level the person already left is dropped
  let buying = false;

  const crumb = h("div", { id: "plan-path", class: "hint" });
  const body = h("div", { id: "plan-body" });
  const back = h("button", { id: "plan-back", class: "btn ghost", onclick: () => up() }, "Atrás");

  function show(...nodes) {
    crumb.textContent = labels.join(" › ");
    back.hidden = !path.length;
    body.replaceChildren(...nodes.filter(Boolean));
  }

  function menu(view, busy) {
    const opts = view.options.filter((o) => !isBack(o)).map((o) =>
      h("button", { id: `plan-opt-${o.key}`, class: "row", disabled: busy, onclick: () => !busy && down(o) },
        h("div", { class: "tx" }, h("b", {}, o.label)), h("span", { class: "chev" }, "›")));
    return [view.title ? h("div", { class: "hint" }, view.title) : null, h("div", { class: `opts${busy ? " busy" : ""}` }, opts)];
  }

  function confirm(view, busy) {
    const buy = h("button", { id: "plan-buy", class: "btn gold", disabled: busy, onclick: () => purchase(buy) },
      view.price ? `Comprar por ${view.price}` : "Comprar");
    return [h("div", { class: "reply" }, h("div", { class: "k" }, h("span", { class: "dot" }), "Cubacel pide confirmar"),
      h("div", { class: "m" }, view.text)),
      view.price ? h("div", { class: "kv" }, h("span", {}, "Precio"), h("b", { id: "plan-price" }, view.price)) : null,
      buy];
  }

  /** A reply that is neither a menu nor a confirm: its text, and the same shortcut in the dialer. */
  function raw(reply) {
    return [h("div", { class: "reply" }, h("div", { class: "k" }, h("span", { class: "dot" }), "Respuesta de Cubacel"),
      h("div", { class: "m" }, reply || "Sin texto.")),
      h("button", { id: "plan-dialer", class: "btn ghost", onclick: () => ctx.bridge.dial(dial(planPath(path))).catch(() => null) },
        "Seguir en el marcador")];
  }

  function draw(view, busy) {
    if (!view) return show(h("div", { class: "empty" }, "Consultando a Cubacel…"));
    show(...(view.kind === "confirm" ? confirm(view, busy) : menu(view, busy)));
  }

  async function load() {
    const mine = ++seq;
    const key = path.join("*");
    draw(ctx.store.state.planMenus[key] ?? null, true);
    const res = await ctx.workflow.planMenu(subId, [...path]);
    if (mine !== seq) return;
    if (!res.ok) {
      return show(h("div", { class: "err" }, `No se pudo consultar la red (código ${res.failureCode}).`),
        h("button", { id: "plan-retry", class: "btn ghost", onclick: () => load() }, "Reintentar"));
    }
    if (res.view) draw(res.view, false);
    else show(...raw(res.reply));
  }

  function down(o) {
    path.push(o.key);
    labels.push(o.label);
    load();
  }

  function up() {
    path.pop();
    labels.pop();
    load();
  }

  async function purchase(button) {
    if (buying) return;
    buying = true;
    button.disabled = true;
    seq++;
    const res = await ctx.workflow.buyPlan(subId, [...path]);
    buying = false;
    const balance = res.outcome === "bought" ? ctx.store.state.mobileBalances[subId] : null;
    show(h("div", { class: "reply", id: "plan-result", "data-outcome": res.outcome },
      h("div", { class: "k status" }, h("span", { class: "dot" }), RESULT[res.outcome]),
      res.reply && res.outcome !== "bought" ? h("div", { class: "m" }, res.reply) : null,
      balance ? h("div", { class: "m" }, `Saldo de la línea: ${balance}`) : null));
  }

  load();
  return h("div", { id: "plans" },
    h("div", { class: "sbar" },
      h("button", { class: "back", "aria-label": "Volver", onclick: () => history.back() }, "‹"),
      h("div", {}, h("h2", {}, "Comprar plan"), h("div", { class: "sub" }, "Con el saldo de la línea"))),
    crumb, body, back);
}
