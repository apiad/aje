// Servicios: the saved bill and service accounts, each with what its last debt check or payment
// said and the one action that follows (check, pay or recharge), and the form that adds or edits one.
import { billStatus, checkNumber, digitsOf, KINDS, NAUTA_TYPES, titleOf, WATER_REGIONS } from "../core/bills.js";
import { BANKS, last4, parseAmount } from "../core/money.js";
import { billNumberFromText } from "../core/ocr.js";
import { formatMoney } from "../core/sms.js";
import { ago, h, icon } from "./dom.js";
import { openScanner, paperFrame } from "./scanner.js";
import { mark, openSheet } from "./sheets.js";

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

/**
 * What a saved account's row says and the action it offers: `[cls, head, sub, action]`, where action
 * is "pay" (filled), "check-due" (gold outline: never checked, stale or unconfirmed) or "check".
 */
function statusLine(bill, now = Date.now()) {
  const s = billStatus(bill, now);
  const money = (cents) => formatMoney({ cents, currency: "CUP" });
  const when = s.at ? ago(s.at, now) : "";
  const old = s.stale ? " · puede haber cambiado" : "";
  if (bill.kind === "nauta") {
    if (s.kind !== "paid") return ["", "Sin recargas", "Recarga con un toque", "pay"];
    return [s.verified ? "ok" : "", `${s.verified ? "✓ " : ""}Recargado ${money(s.cents)}`, `${when} · ${s.verified ? "verificado por SMS" : "sin verificar"}`, "pay"];
  }
  if (s.kind === "never") return ["", "Sin revisar", "Revisa para saber si debes", "check-due"];
  if (s.kind === "paid") return ["", s.cents ? `Pagado ${money(s.cents)}` : "Pago enviado", `${when} · revisa para confirmar`, "check-due"];
  if (s.kind === "owe") return ["owe", `Debe ${money(s.cents)}`, `revisado ${when}${old}`, "pay"];
  if (s.kind === "unknown") return ["", "El banco respondió", `revisado ${when} · mira su SMS`, "check-due"];
  return [s.stale ? "" : "ok", "✓ Sin deuda", `revisado ${when}${old}`, s.stale ? "check-due" : "check"];
}

/**
 * Pays a bill and follows it: the bank's reply, then its SMS for Nauta. When the bank wants a session,
 * the sheet asks for the key (or unlocks the saved one), waits for the session, and pays again.
 */
/** What a debt query's SMS said: none, an amount, or a debt it gave no figure for. */
export const debtText = (cents) => (cents === 0 ? "No tiene deuda." : cents ? `Debe ${formatMoney({ cents, currency: "CUP" })}.` : "El banco respondió; mira su SMS.");

async function billSheet(ctx, bill, { debt = false } = {}) {
  const card = ctx.store.state.cards.find((c) => c.id === bill.cardId);
  const session = ctx.workflow.sessionOf(card.bank);
  let phase = "paying"; // paying | unlocking | login | waiting
  let attemptId = null;
  let error = null;
  let loginReply = null;
  let saved = { available: false, saved: false };
  let unsubscribe = null;
  const attempt = () => ctx.store.state.attempts.find((a) => a.id === attemptId) ?? null;

  function view(a) {
    if (!a || a.state === "sent") return [true, debt ? "Consultando la deuda…" : "Pagando…"];
    if (debt && a.state === "verified") return [false, debtText(a.debtCents)];
    if (debt && a.state === "replied") return [true, "Respuesta del banco; esperando su SMS con la deuda…"];
    if (a.state === "verified") return [false, "Pagado. Verificado por el SMS del banco."];
    if (a.state === "dialer") return [false, "Termina en el marcador: responde al menú del banco. Su SMS lo verificará."];
    if (a.state === "failed") return [false, `El teléfono no lo envió (código ${a.failureCode}).`];
    // Only Nauta's confirmation SMS is known so far; the other kinds stop at the bank's reply.
    return bill.kind === "nauta" ? [true, "Respuesta del banco; esperando su SMS…"] : [false, "Respuesta del banco"];
  }

  const sheet = openSheet(ctx, () => {
    const parts = [h("h3", {}, debt ? `Deuda · ${titleOf(bill)}` : titleOf(bill))];
    if (phase === "unlocking") {
      parts.push(h("div", { class: "reply pending" }, h("div", { class: "k status" }, mark(true), "Desbloquea la clave guardada con tu huella o el bloqueo del teléfono.")));
    } else if (phase === "login") {
      const pin = h("input", { id: "pin", type: "password", inputmode: "numeric", maxlength: "4", autocomplete: "off", "aria-label": "Clave del banco" });
      parts.push(h("p", { class: "lead" }, `El banco pide abrir sesión. Escribe la clave de tu tarjeta; luego Ajé ${debt ? "consulta" : "paga"}.`),
        h("div", { class: "field" }, pin), h("div", { class: "err" }, error ?? ""),
        h("button", { id: "pin-submit", class: "btn gold", onclick: () => {
          const key = pin.value;
          pin.value = "";
          if (!/^[0-9]{4}$/.test(key)) { error = "La clave tiene 4 dígitos."; return sheet.redraw(); }
          login(() => ctx.workflow.login(session, key));
        } }, debt ? "Autenticarse y consultar" : "Autenticarse y pagar"));
      queueMicrotask(() => pin.focus());
    } else if (phase === "waiting") {
      parts.push(h("div", { class: "reply pending" }, h("div", { class: "k status" }, mark(true), `Esperando el SMS del banco; luego Ajé ${debt ? "consulta" : "paga"}.`),
        loginReply ? h("div", { class: "m", id: "login-reply" }, `Respuesta del banco: ${loginReply}`) : null));
    } else {
      const a = attempt();
      const [waiting, text] = view(a);
      // A check or payment that ended well shows on its row in Servicios: the sheet goes.
      if (a && (a.state === "verified" || (!debt && bill.kind !== "nauta" && a.state === "replied"))) queueMicrotask(() => sheet.closeSoon());
      parts.push(h("div", { class: `reply${waiting ? " pending" : ""}`, id: "bill-result", "data-state": a?.state ?? "sent" },
        h("div", { class: "k status" }, mark(waiting), text), a?.reply ? h("div", { class: "m" }, a.reply) : null),
      a?.transactionId ? h("div", { class: "kv" }, h("span", {}, "Transacción"), h("b", {}, a.transactionId)) : null);
    }
    parts.push(h("button", { class: "btn ghost", onclick: () => sheet.close() }, "Cerrar"));
    return parts;
  }, () => unsubscribe?.());

  async function pay() {
    phase = "paying";
    sheet.redraw();
    const r = await ctx.workflow.payBill(bill.id, { debt });
    attemptId = r.attempt.id;
    if (!r.needsLogin) return sheet.redraw();
    saved = await ctx.workflow.savedPin(session);
    if (saved.saved) {
      phase = "unlocking";
      sheet.redraw();
      if (await login(() => ctx.workflow.loginWithSaved(session))) return;
      error = "No se desbloqueó la clave guardada. Escríbela.";
    }
    phase = "login";
    sheet.redraw();
  }

  // Logs in, then pays again once the session is open: at once when the reply opened it, else on the bank's SMS.
  async function login(run) {
    const since = Date.now();
    const opened = () => (ctx.store.state.banks[session]?.authenticatedAt ?? 0) >= since;
    phase = "waiting";
    loginReply = null;
    sheet.redraw();
    const r = await run();
    if (!r) return false;
    if (!r.ok) {
      phase = "login";
      error = `El teléfono no la envió (código ${r.failureCode}).`;
      sheet.redraw();
      return true;
    }
    loginReply = r.reply;
    if (opened()) return pay().then(() => true);
    sheet.redraw();
    unsubscribe = ctx.store.subscribe(() => {
      if (!opened()) return;
      unsubscribe();
      unsubscribe = null;
      pay();
    });
    return true;
  }

  await pay();
}

export function renderPay(ctx) {
  const cards = payingCards(ctx);
  const { bills } = ctx.store.state;
  const top = h("div", { class: "topbar" }, h("div", { class: "t" }, "Servicios"));
  if (!cards.length) return h("div", { id: "pay" }, top, h("div", { class: "empty" }, "Añade y asocia una tarjeta para pagar la luz, el agua, el gas, el teléfono o Nauta."));

  async function pay(bill, debt = false) {
    if (inFlight.has(bill.id)) return;
    inFlight.add(bill.id);
    try {
      await billSheet(ctx, bill, { debt });
    } finally {
      inFlight.delete(bill.id);
    }
  }

  const rows = bills.map((b) => {
    const card = ctx.store.state.cards.find((c) => c.id === b.cardId);
    const [cls, head, sub, action] = statusLine(b);
    const button = action === "pay"
      ? h("button", { class: "paybtn", "data-pay": b.id, disabled: !card || null, onclick: () => pay(b) }, b.kind === "nauta" ? "Recargar" : "Pagar")
      : h("button", { class: `checkbtn${action === "check-due" ? " due" : ""}`, "data-debt": b.id, disabled: !card || null, onclick: () => pay(b, true) }, "Revisar");
    return h("div", { class: "row bill", "data-bill": b.id, "data-status": billStatus(b, Date.now()).kind },
      h("div", { class: "top", onclick: () => ctx.go(`bill/${b.id}`) }, icon(KINDS[b.kind].icon, "ic"),
        h("div", { class: "tx" }, h("b", {}, b.alias),
          h("span", {}, `${KINDS[b.kind].label} · ${describe(b)}${card ? ` · ${card.alias}` : " · sin tarjeta"}`)),
        h("span", { class: "chev" }, "›")),
      h("div", { class: "state" }, h("div", { class: `s ${cls}` }, head, h("small", {}, sub)), button));
  });
  const offered = suggestions(ctx);
  return h("div", { id: "pay" }, top,
    bills.length ? h("div", { class: "list", id: "bills" }, rows)
      : h("p", { class: "lead" }, "Guarda una vez cada cuenta: la luz de la casa, el agua, el gas, el teléfono fijo o tu cuenta Nauta. Ajé te dice si debes y pagas con un toque."),
    h("button", { id: "bill-add", class: "btn gold", onclick: () => ctx.go("bill") }, "Añadir una cuenta"),
    offered.length ? [h("div", { class: "group" }, "De tu respaldo de Transfermóvil"),
      h("div", { class: "list", id: "bill-offers" }, offered.map((o) => h("div", { class: "row" }, icon(KINDS[o.kind].icon, "ic"),
        h("div", { class: "tx" }, h("b", {}, KINDS[o.kind].label), h("span", {}, o.kind === "nauta" ? o.number : `····${last4(o.number)}`)),
        h("button", { class: "addchip", onclick: () => ctx.go(`bill?kind=${o.kind}&number=${encodeURIComponent(o.number)}${o.nautaType ? `&type=${o.nautaType}` : ""}`) }, "Añadir"))))] : null,
    h("div", { class: "warn" }, "Ajé paga por USSD en la línea elegida en Ajustes. Si el banco muestra un menú, termina en el marcador."));
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
    const bill = { id: editing?.id, kind: s.kind, alias: s.alias.trim() || (s.kind === "nauta" ? checked.number : KINDS[s.kind].label), number: checked.number, cardId: card.id,
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
