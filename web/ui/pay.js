// Pagar: the saved bill and service accounts, each paid with one tap, and the form that adds or
// edits one. A payment is dialed: the bank's menu shows the debt and the person confirms with 1.
import { checkNumber, digitsOf, KINDS, NAUTA_TYPES, WATER_REGIONS } from "../core/bills.js";
import { BANKS, last4, parseAmount } from "../core/money.js";
import { billNumberFromText } from "../core/ocr.js";
import { h, icon } from "./dom.js";
import { openScanner, paperFrame } from "./scanner.js";
import { transferSheet } from "./sheets.js";

/** Cards a bill can be paid from: linked bank cards; the Clásica's bills go through MiTransfer, not here. */
const payingCards = (ctx) => ctx.store.state.cards.filter((c) => c.state === "linked" && c.bank !== "CLASICA");

function chips(options, isOn, pick, id) {
  return h("div", { class: "chips", id }, options.map(([value, label]) =>
    h("button", { type: "button", "data-value": value, class: isOn(value) ? "on" : null, "aria-pressed": isOn(value) ? "true" : "false", onclick: () => pick(value) }, label)));
}

const describe = (b) => (b.kind === "nauta" ? `${b.number} · ${b.amount} CUP` : `····${last4(b.number)}`);

/** Contracts and Nauta accounts from a Transfermóvil backup that are not saved yet. */
function suggestions(ctx) {
  const { imported, bills } = ctx.store.state;
  if (!imported) return [];
  const saved = new Set(bills.map((b) => `${b.kind}:${b.number}`));
  const fromBills = (imported.bills ?? []).filter((b) => KINDS[b.kind]).map((b) => ({ kind: b.kind, number: b.contract }));
  const fromNauta = (imported.nauta ?? []).map((n) => ({ kind: "nauta", number: n.user, nautaType: n.type }));
  return [...fromBills, ...fromNauta].filter((s) => !saved.has(`${s.kind}:${s.number}`));
}

const inFlight = new Set();

export function renderPay(ctx) {
  const cards = payingCards(ctx);
  const { bills } = ctx.store.state;
  const top = h("div", { class: "topbar" }, h("div", { class: "t" }, "Pagar"));
  if (!cards.length) return h("div", { id: "pay" }, top, h("div", { class: "empty" }, "Añade y asocia una tarjeta para pagar la luz, el agua, el gas, el teléfono o Nauta."));

  async function pay(bill) {
    if (inFlight.has(bill.id)) return;
    inFlight.add(bill.id);
    try {
      const attempt = await ctx.workflow.payBill(bill.id);
      transferSheet(ctx, attempt, `${KINDS[bill.kind].label} · ${bill.alias}`);
    } finally {
      inFlight.delete(bill.id);
    }
  }

  const rows = bills.map((b) => {
    const card = ctx.store.state.cards.find((c) => c.id === b.cardId);
    return h("div", { class: "row bill", "data-bill": b.id },
      icon(KINDS[b.kind].icon, "ic"),
      h("div", { class: "tx", onclick: () => ctx.go(`bill/${b.id}`) }, h("b", {}, b.alias),
        h("span", {}, `${KINDS[b.kind].label} · ${describe(b)}${card ? ` · ${card.alias}` : " · sin tarjeta"}`)),
      h("button", { class: "paybtn", "data-pay": b.id, disabled: !card || null, onclick: () => pay(b) }, "Pagar"));
  });
  const offered = suggestions(ctx);
  return h("div", { id: "pay" }, top,
    bills.length ? h("div", { class: "list", id: "bills" }, rows)
      : h("p", { class: "lead" }, "Guarda una vez cada cuenta: la luz de la casa, el agua, el gas, el teléfono fijo o tu cuenta Nauta. Después se paga con un toque."),
    h("button", { id: "bill-add", class: "btn gold", onclick: () => ctx.go("bill") }, "Añadir una cuenta"),
    offered.length ? [h("div", { class: "group" }, "De tu respaldo de Transfermóvil"),
      h("div", { class: "list", id: "bill-offers" }, offered.map((o) => h("div", { class: "row" }, icon(KINDS[o.kind].icon, "ic"),
        h("div", { class: "tx" }, h("b", {}, KINDS[o.kind].label), h("span", {}, o.kind === "nauta" ? o.number : `····${last4(o.number)}`)),
        h("button", { class: "addchip", onclick: () => ctx.go(`bill?kind=${o.kind}&number=${encodeURIComponent(o.number)}${o.nautaType ? `&type=${o.nautaType}` : ""}`) }, "Añadir"))))] : null,
    h("div", { class: "warn" }, "El pago termina en el marcador del teléfono: el banco muestra lo que debes y confirmas con ", h("b", {}, "1"), "."));
}

export function renderBill(ctx, r) {
  const cards = payingCards(ctx);
  const editing = r.param ? ctx.store.state.bills.find((b) => b.id === r.param) : null;
  const q = r.query;
  const s = editing ? { ...editing, amount: String(editing.amount ?? "") } : {
    kind: KINDS[q.get("kind")] ? q.get("kind") : "electricity", alias: "", number: q.get("number") ?? "", region: 1,
    nautaType: Number(q.get("type")) || 2, amount: "", cardId: cards[0]?.id ?? null,
  };
  let error = null;
  let stopScan = null;
  const root = h("div", { id: "bill" });
  const cardOf = () => cards.find((c) => c.id === s.cardId) ?? null;
  const opts = () => ({ bank: cardOf()?.bank ?? null, region: s.region });

  function scan(box, button) {
    button.hidden = true;
    box.hidden = false;
    const done = (n) => {
      stopScan?.();
      stopScan = null;
      if (n) s.number = n;
      else error = "No se pudo leer la factura. Escribe el número.";
      draw();
    };
    stopScan = openScanner(box, { parse: (text) => billNumberFromText(text, digitsOf(s.kind, opts())), crop: paperFrame, onPan: done, onFallback: done });
  }

  async function save() {
    const card = cardOf();
    if (!card) return fail("Elige la tarjeta con la que pagas.");
    const checked = checkNumber(s.kind, s.number, opts());
    if (checked.error) return fail(checked.error);
    const amount = s.kind === "nauta" ? parseAmount(s.amount) : null;
    if (s.kind === "nauta" && !(amount > 0)) return fail("El importe es un número entero de CUP, sin decimales.");
    const bill = { id: editing?.id, kind: s.kind, alias: s.alias.trim() || KINDS[s.kind].label, number: checked.number, cardId: card.id,
      ...(s.kind === "water" ? { region: s.region } : {}), ...(s.kind === "nauta" ? { nautaType: s.nautaType, amount } : {}) };
    try {
      await ctx.store.saveBill(bill);
    } catch (e) {
      return fail(e.message);
    }
    ctx.go("pay");
  }
  function fail(text) {
    error = text;
    draw();
  }

  function draw() {
    stopScan?.();
    stopScan = null;
    const nauta = s.kind === "nauta";
    const number = h("input", { id: "bill-number", value: s.number, autocomplete: "off", inputmode: nauta ? "email" : "numeric",
      placeholder: nauta ? "usuario" : "0".repeat(digitsOf(s.kind, opts())[0] ?? 11), oninput: (e) => { s.number = e.target.value; } });
    const box = h("div", { class: "scanbox", id: "bill-scanbox", hidden: true });
    const scanBtn = h("button", { type: "button", id: "bill-scan", class: "btn ghost", onclick: () => scan(box, scanBtn) }, "Escanear la factura");
    const amount = h("input", { id: "bill-amount", value: s.amount, inputmode: "numeric", autocomplete: "off", oninput: (e) => { s.amount = e.target.value; } });
    const alias = h("input", { id: "bill-alias", value: s.alias, autocomplete: "off", placeholder: nauta ? "Mi Nauta" : "Casa", oninput: (e) => { s.alias = e.target.value; } });
    root.replaceChildren(h("div", { style: "display:contents" },
      h("div", { class: "sbar" },
        h("button", { class: "back", "aria-label": "Volver", onclick: () => ctx.go("pay") }, "‹"),
        h("div", {}, h("h2", {}, editing ? "Editar cuenta" : "Añadir una cuenta"), h("div", { class: "sub" }, "Se guarda en este teléfono"))),
      h("div", { class: "field" }, h("label", {}, "Servicio"),
        chips(Object.entries(KINDS).map(([k, v]) => [k, v.label]), (k) => k === s.kind, (k) => { s.kind = k; error = null; draw(); }, "bill-kind")),
      s.kind === "water" ? h("div", { class: "field" }, h("label", {}, "Empresa"),
        chips(Object.entries(WATER_REGIONS).map(([k, v]) => [Number(k), v.label]), (k) => k === s.region, (k) => { s.region = k; draw(); }, "bill-region")) : null,
      h("div", { class: "field" }, h("label", { for: "bill-number" }, nauta ? "Usuario de la cuenta Nauta" : "Número de la factura"), number,
        h("div", { class: "hint" }, nauta ? "Sin @nauta.com.cu." : `${digitsOf(s.kind, opts()).join(" o ")} dígitos, como aparece en la factura.`)),
      nauta ? null : [scanBtn, box],
      nauta ? [h("div", { class: "field" }, h("label", {}, "Tipo de cuenta"),
        chips(Object.entries(NAUTA_TYPES).map(([k, v]) => [Number(k), v]), (k) => k === s.nautaType, (k) => { s.nautaType = k; draw(); }, "bill-nauta-type")),
        h("div", { class: "field" }, h("label", { for: "bill-amount" }, "Importe de cada recarga, en CUP"), amount)] : null,
      h("div", { class: "field" }, h("label", { for: "bill-alias" }, "Nombre"), alias),
      h("div", { class: "field" }, h("label", {}, "Pagar con"),
        chips(cards.map((c) => [c.id, `${c.alias} · ${BANKS[c.bank]?.name ?? c.bank}`]), (id) => id === s.cardId, (id) => { s.cardId = id; draw(); }, "bill-card")),
      error ? h("div", { class: "err", id: "bill-error" }, error) : null,
      h("button", { id: "bill-save", class: "btn gold", onclick: save }, "Guardar"),
      editing ? h("button", { id: "bill-delete", class: "btn ghost", onclick: async () => { await ctx.store.removeBill(editing.id); ctx.go("pay"); } }, "Eliminar esta cuenta") : null));
  }
  if (!cards.length) return h("div", { class: "empty" }, "Añade y asocia una tarjeta para pagar servicios.");
  draw();
  return root;
}
