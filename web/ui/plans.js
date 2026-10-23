// Comprar plan: the plans of the catalog by group. Choosing one shows Cubacel's own confirm text, and
// "Comprar en el marcador" dials the plan's shortcut; the person types 1 in the dialer to buy.
import { BUNDLED } from "../core/plancatalog.js";
import { fetchCatalog, planCode } from "../core/plans.js";
import { h } from "./dom.js";

const cup = (n) => `${n.toFixed(2)} CUP`;
const known = (text) => (text ? Number.parseFloat(String(text).replace(",", ".")) : null);
const day = (iso) => iso.split("-").reverse().join("-");

export function renderPlans(ctx, r) {
  const subId = Number(r.query.get("sub") ?? ctx.sims[0]?.subId);
  const catalog = () => ctx.store.state.planCatalog ?? BUNDLED;
  let chosen = null;
  let buying = false;

  const body = h("div", { id: "plan-body" });
  const back = h("button", { id: "plan-back", class: "btn ghost", hidden: true, onclick: () => list() }, "Atrás");
  const show = (...nodes) => body.replaceChildren(...nodes.filter(Boolean));

  function list() {
    if (buying) return;
    chosen = null;
    back.hidden = true;
    const c = catalog();
    show(...c.groups.flatMap((g) => [
      h("div", { class: "group" }, g.label),
      ...g.plans.map((p) => h("button", { class: "row", id: `plan-${p.path.replaceAll("*", "-")}`, onclick: () => detail(p) },
        h("div", { class: "tx" }, h("b", {}, p.name)), h("span", { class: "price" }, cup(p.price)), h("span", { class: "chev" }, "›"))),
    ]), h("div", { class: "hint", id: "plan-captured" }, `Precios de Cubacel del ${day(c.captured)}.`));
  }

  function detail(plan) {
    chosen = plan;
    back.hidden = false;
    const balance = known(ctx.store.state.mobileBalances[subId]);
    const buy = h("button", { id: "plan-buy", class: "btn gold", onclick: () => purchase(plan, buy) }, "Comprar en el marcador");
    show(
      h("div", { class: "sheet-like" },
        h("div", { class: "kv" }, h("span", {}, "Plan"), h("b", {}, plan.name)),
        h("div", { class: "kv" }, h("span", {}, "Precio"), h("b", { id: "plan-price" }, cup(plan.price))),
        balance !== null ? h("div", { class: "kv" }, h("span", {}, "Saldo de la línea"), h("b", {}, cup(balance))) : null),
      balance !== null && balance < plan.price
        ? h("div", { class: "err", id: "plan-short" }, "El saldo de la línea no alcanza para este plan.") : null,
      plan.ask ? h("div", { class: "reply" }, h("div", { class: "k" }, h("span", { class: "dot" }), "Cubacel te preguntará"),
        h("div", { class: "m" }, plan.ask)) : null,
      buy,
      h("div", { class: "hint" }, `Se abre el marcador con ${planCode(plan)}. Escribe 1 y envía para comprar.`));
  }

  async function purchase(plan, button) {
    if (buying) return;
    buying = true;
    button.disabled = true;
    back.hidden = true;
    const res = await ctx.workflow.buyPlan(subId, plan);
    buying = false;
    back.hidden = false;
    show(h("div", { class: "reply", id: "plan-result", "data-outcome": res.outcome },
      h("div", { class: "k status" }, h("span", { class: "dot" }),
        res.outcome === "dialer" ? "Termina en el marcador: escribe 1 y envía." : "No se pudo abrir el marcador."),
      res.outcome === "dialer" ? h("div", { class: "m" }, "Al volver a Ajé se lee otra vez el saldo de la línea.") : null));
  }

  // The hosted catalog replaces the stored one when it differs; the list redraws if it is showing.
  fetchCatalog({ fetch: (url) => globalThis.fetch(url) }).then(async (fresh) => {
    if (!fresh || JSON.stringify(fresh) === JSON.stringify(catalog())) return;
    await ctx.store.setPlanCatalog(fresh);
    if (!chosen && !buying && body.isConnected) list();
  });

  list();
  return h("div", { id: "plans" },
    h("div", { class: "sbar" },
      h("button", { class: "back", "aria-label": "Volver", onclick: () => history.back() }, "‹"),
      h("div", {}, h("h2", {}, "Comprar plan"), h("div", { class: "sub" }, "Con el saldo de la línea"))),
    body, back);
}
