// Automático: the rules Ajé runs with no one in front (web/core/automations.js), grouped by type, each
// with its terms, its last run and a switch; and the form of one rule. Only "Pagar un servicio" exists
// in this phase; the other types show as coming.
import { KINDS } from "../core/bills.js";
import { h, icon } from "./dom.js";

const TYPES = [["bill", "Pagar un servicio", "bolt"], ["plan", "Comprar un plan", "plan"], ["line", "Recargar saldo", "phone"], ["transfer", "Transferir", "send"]];
const GROUPS = { bill: "Servicios" };
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

// Why a run paid nothing, after "No pagado: ".
const WHY = {
  max: "pasa de tu límite", min: "dejaría la tarjeta bajo el mínimo", cap: "pasa del tope del mes", unknown: "el banco no dijo cuánto debes",
  menu: "el banco pide confirmar en un menú", missed: "se cerró la ventana", failed: "el banco no respondió", stopped: "la clave guardada ya no sirve",
  "no-bill": "el servicio ya no está guardado", nokey: "falta la clave de su banco",
};

/** 200000 cents as "2 000.00 CUP", thousands apart with a no-break space. */
export function money(cents, currency = "CUP") {
  const [whole, frac] = (cents / 100).toFixed(2).split(".");
  return `${whole.replace(/\B(?=(\d{3})+$)/g, " ")}.${frac} ${currency}`;
}

const billOf = (ctx, rule) => ctx.store.state.bills.find((b) => b.id === rule.billId) ?? null;
const currencyOf = (ctx, bill) => ctx.store.state.cards.find((c) => c.id === bill?.cardId)?.currency ?? "CUP";
const billName = (bill) => (bill ? `${KINDS[bill.kind]?.label ?? "Servicio"} · ${bill.alias}` : "Servicio borrado");
const day = (t) => new Date(t).toLocaleDateString("es", { day: "numeric", month: "short" }).replace(".", "");

/** "Días 5 a 10 · hasta 800.00 CUP · deja 2 000.00 CUP" */
function terms(rule, currency) {
  const { from, to } = rule.window;
  return [from === to ? `Día ${from}` : `Días ${from} a ${to}`, `hasta ${money(rule.maxCents, currency)}`,
    rule.minLeftCents ? `deja ${money(rule.minLeftCents, currency)}` : null].filter(Boolean).join(" · ");
}

/** The last run, as the list shows it: a mark, a class and a line. */
function lastRun(rule, currency) {
  const { last, cycle } = rule;
  if (!last) return ["wait", "○ Aún no hizo falta"];
  const when = ` · ${day(last.at)}`;
  if (last.outcome === "paid") return ["ok", `✓ Pagado ${money(cycle?.paidCents ?? 0, currency)}${when}`];
  if (last.outcome === "unverified") return ["ok", `✓ Pagado ${money(cycle?.paidCents ?? 0, currency)}, sin confirmar${when}`];
  if (last.outcome === "no-debt") return ["wait", `○ Sin deuda${when}`];
  if (last.outcome === "already") return ["wait", `○ Ya hubo un pago este mes${when}`];
  return ["bad", `✕ No pagado: ${WHY[last.outcome] ?? "no se pudo"}${when}`];
}

export function renderAutomations(ctx) {
  const { store } = ctx;
  const s = store.state;
  const on = s.settings.automation?.on;
  const bar = h("div", { class: "sbar" }, h("h2", {}, "Automático"), h("span", { class: `pill${on ? "" : " off"}` }, on ? "● Activo" : "Apagado"));
  if (!on) {
    return h("div", { id: "auto" }, bar,
      h("div", { class: "empty" }, h("b", {}, "Las automatizaciones están apagadas."), h("br"),
        "Con el modo automático, Ajé paga tus servicios dentro de los días y los límites que pongas, sin que estés delante, y te avisa de cada cosa que hizo o no hizo."),
      h("button", { id: "auto-settings", class: "btn gold", onclick: () => ctx.go("settings") }, "Activarlo en Ajustes"));
  }
  const groups = Object.entries(GROUPS).map(([type, label]) => [label, s.automations.filter((r) => r.type === type)]).filter(([, list]) => list.length);
  return h("div", { id: "auto" }, bar,
    groups.length ? null : h("div", { class: "empty" }, "Aún no tienes automatizaciones. Crea una para pagar un servicio cada mes."),
    groups.map(([label, list]) => [
      h("div", { class: "group" }, label),
      list.map((rule) => {
        const bill = billOf(ctx, rule);
        const currency = currencyOf(ctx, bill);
        const [cls, line] = lastRun(rule, currency);
        return h("div", { class: "row rule", "data-rule": rule.id },
          icon(KINDS[bill?.kind]?.icon ?? "bolt", "ic"),
          h("div", { class: "tx", onclick: () => ctx.go(`auto-rule/${rule.id}`) },
            h("b", {}, billName(bill)), h("span", {}, terms(rule, currency)), h("div", { class: `last ${cls}` }, line)),
          h("button", { class: `toggle${rule.on ? " on" : ""}`, "aria-pressed": rule.on ? "true" : "false", "aria-label": billName(bill),
            onclick: () => store.patchAutomation(rule.id, { on: !rule.on }) }));
      }),
    ]),
    h("button", { id: "auto-new", class: "addrule", onclick: () => ctx.go("auto-rule") }, "+ Nueva automatización"));
}

export function renderAutomationRule(ctx, r) {
  const { store } = ctx;
  const editing = r.param ? store.state.automations.find((x) => x.id === r.param) : null;
  // A Nauta account has no debt to ask; a bill another rule pays is not offered twice.
  const bills = store.state.bills.filter((b) => b.kind !== "nauta" && !store.state.automations.some((x) => x.billId === b.id && x.id !== editing?.id));
  const s = editing
    ? { billId: editing.billId, from: editing.window.from, to: editing.window.to, max: String(editing.maxCents / 100), min: String(editing.minLeftCents / 100) }
    : { billId: bills[0]?.id ?? null, from: 1, to: 10, max: "", min: "" };
  let error = null;
  const root = h("div", { id: "auto-rule" });

  async function save() {
    const max = Number(s.max);
    const min = s.min.trim() === "" ? 0 : Number(s.min);
    if (!s.billId) return fail("Elige el servicio que se paga.");
    if (s.from > s.to) return fail("El primer día va antes del último.");
    if (!(max > 0)) return fail("Pon cuánto puede pagar como mucho cada mes.");
    if (!(min >= 0)) return fail("El mínimo que se deja en la tarjeta es un número.");
    const card = store.state.cards.find((c) => c.id === bills.find((b) => b.id === s.billId)?.cardId);
    if (!card) return fail("Ese servicio no tiene tarjeta para pagar. Elígela en Servicios.");
    if (!(await ctx.workflow.savedPin(ctx.workflow.sessionOf(card.bank))).unattended) {
      return fail("Ajé no tiene la clave del banco de esa tarjeta. Guárdala al consultar un saldo y activa el modo de nuevo en Ajustes.");
    }
    const window = { from: s.from, to: s.to };
    // The month's record stays with its bill, so editing a window or a limit never pays the month again.
    const changed = !editing || editing.billId !== s.billId;
    await store.saveAutomation({
      id: editing?.id ?? null, type: "bill", billId: s.billId, window, maxCents: Math.round(max * 100), minLeftCents: Math.round(min * 100),
      on: editing?.on ?? true, cycle: changed ? null : editing.cycle, last: changed ? null : editing.last,
    });
    ctx.go("auto");
  }
  function fail(text) {
    error = text;
    draw();
  }
  const select = (id, options, value, set) => h("select", { id, onchange: (e) => set(e.target.value) },
    options.map(([v, label]) => h("option", { value: v, selected: String(v) === String(value) }, label)));
  const input = (id, key) => h("input", { id, value: s[key], inputmode: "decimal", autocomplete: "off", placeholder: "0", oninput: (e) => { s[key] = e.target.value; } });

  function draw() {
    const bill = bills.find((b) => b.id === s.billId);
    const currency = currencyOf(ctx, bill);
    root.replaceChildren(h("div", { style: "display:contents" },
      h("div", { class: "sbar" },
        h("button", { class: "back", "aria-label": "Volver", onclick: () => ctx.go("auto") }, "‹"),
        h("div", {}, h("h2", {}, editing ? "Editar automatización" : "Nueva automatización"), h("div", { class: "sub" }, "Si se pasa de un límite, no paga y te avisa"))),
      h("div", { class: "types", id: "ar-type" }, TYPES.map(([type, label, ic]) => h("button", { class: type === "bill" ? "on" : null, disabled: type !== "bill" },
        icon(ic), h("span", {}, label), type === "bill" ? null : h("small", {}, "Pronto")))),
      bills.length ? [
        h("div", { class: "field" }, h("label", { for: "ar-bill" }, "Qué servicio"),
          select("ar-bill", bills.map((b) => [b.id, billName(b)]), s.billId, (v) => { s.billId = v; draw(); })),
        h("div", { class: "pair" },
          h("div", { class: "field" }, h("label", { for: "ar-from" }, "Desde el día"), select("ar-from", DAYS.map((d) => [d, d]), s.from, (v) => { s.from = Number(v); })),
          h("div", { class: "field" }, h("label", { for: "ar-to" }, "Hasta el día"), select("ar-to", DAYS.map((d) => [d, d]), s.to, (v) => { s.to = Number(v); }))),
        h("div", { class: "hint" }, "Cada día de esa ventana, a las 9:00, consulta la deuda y paga si hay. Un día que el mes no tiene cuenta como su último día."),
        h("div", { class: "field" }, h("label", { for: "ar-max" }, `Pagar como mucho, en ${currency}`), input("ar-max", "max")),
        h("div", { class: "field" }, h("label", { for: "ar-min" }, `Dejar en la tarjeta al menos, en ${currency}`), input("ar-min", "min")),
        error ? h("div", { class: "err", id: "ar-error" }, error) : null,
        h("button", { id: "ar-save", class: "btn gold", onclick: save }, "Guardar"),
        editing ? h("button", { id: "ar-delete", class: "btn ghost", onclick: async () => { await store.removeAutomation(editing.id); ctx.go("auto"); } }, "Borrar") : null,
      ] : [
        h("div", { class: "empty" }, "Primero guarda el servicio en Servicios: su número y la tarjeta que paga."),
        h("button", { class: "btn gold", onclick: () => ctx.go("bill") }, "Añadir un servicio"),
      ]));
  }
  draw();
  return root;
}
