// Comprar plan: the plans of the catalog by group. Choosing one shows Cubacel's own confirm text, and
// "Comprar en el marcador" dials the plan's shortcut; the person types 1 in the dialer to buy, and
// the screen waits for Cubacel's SMS, which confirms the purchase and brings the line's balance.
import { BUNDLED } from "../core/plancatalog.js";
import { fetchCatalog, newestCatalog, planCode } from "../core/plans.js";
import { h } from "./dom.js";

const cup = (n) => `${n.toFixed(2)} CUP`;
const known = (text) => (text ? Number.parseFloat(String(text).replace(",", ".")) : null);
const day = (iso) => iso.split("-").reverse().join("-");

export function renderPlans(ctx, r) {
  const subId = Number(r.query.get("sub") ?? ctx.sims[0]?.subId);
  const catalog = () => newestCatalog(ctx.store.state.planCatalog, BUNDLED);
  let chosen = null;
  let buying = false;
  let unsubscribe = null;

  const body = h("div", { id: "plan-body" });
  const back = h("button", { id: "plan-back", class: "btn ghost", hidden: true, onclick: () => list() }, "Atrás");
  const show = (...nodes) => body.replaceChildren(...nodes.filter(Boolean));

  function list() {
    if (buying) return;
    unsubscribe?.();
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
    if (res.outcome !== "dialer") {
      return show(h("div", { class: "reply", id: "plan-result", "data-outcome": "failed" },
        h("div", { class: "k status" }, h("span", { class: "dot" }), "No se pudo abrir el marcador.")));
    }
    waiting(res.attempt);
  }

  /** The purchase in the dialer, until Cubacel's SMS confirms it. */
  function waiting(attempt) {
    const status = h("div", { class: "reply pending", id: "plan-result", "data-outcome": "dialer" });
    show(status);
    const draw = () => {
      const a = ctx.store.state.attempts.find((x) => x.id === attempt.id) ?? attempt;
      const done = a.state === "verified";
      status.className = `reply${done ? "" : " pending"}`;
      status.dataset.outcome = done ? "bought" : "dialer";
      status.replaceChildren(
        h("div", { class: "k status" }, h("span", { class: done ? "dot" : "spin", "aria-hidden": "true" }),
          done ? `Plan comprado: ${a.plan.name}` : "Esperando el SMS de Cubacel"),
        h("div", { class: "m" }, done ? (a.balance ? `Saldo de la línea: ${a.balance}` : "Cubacel confirmó la compra.")
          : "Termina en el marcador: escribe 1 y envía. Cuando llegue el SMS de Cubacel, la compra queda confirmada aquí."));
      if (done) unsubscribe?.();
    };
    draw();
    unsubscribe = ctx.store.subscribe(() => (status.isConnected ? draw() : unsubscribe?.()));
  }

  // The hosted catalog replaces the stored one when it differs; the list redraws if it is showing.
  fetchCatalog({ fetch: (url) => globalThis.fetch(url) }).then(async (fresh) => {
    if (!fresh || JSON.stringify(fresh) === JSON.stringify(catalog())) return;
    await ctx.store.setPlanCatalog(fresh);
    if (!chosen && !buying && body.isConnected) list();
  }).catch(() => {});

  list();
  return h("div", { id: "plans" },
    h("div", { class: "sbar" },
      h("button", { class: "back", "aria-label": "Volver", onclick: () => history.back() }, "‹"),
      h("div", {}, h("h2", {}, "Comprar plan"), h("div", { class: "sub" }, "Con el saldo de la línea"))),
    body, back);
}
