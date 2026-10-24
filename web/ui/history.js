// History: every operation, logged when sent and verified when the bank's SMS arrives.
// The code shown is the display form, with any key masked; the dialed form is never kept.
import { KINDS, titleOf } from "../core/bills.js";
import { last4 } from "../core/money.js";
import { debtText } from "./pay.js";
import { formatMoney } from "../core/sms.js";
import { CHARGE_MS } from "../core/store.js";
import { h, icon, when } from "./dom.js";

const STATE = { verified: ["✓ verificada", "ok"], failed: ["fallida", "pend"], waiting: ["○ esperando", "pend"], expired: ["vencido", "pend"] };

/** A charge nobody paid within its 24 hours is no longer waiting. */
const stateOf = (a) => (a.op === "234-charge" && a.state === "waiting" && Date.now() - a.startedAt >= CHARGE_MS ? "expired" : a.state);

/** Money that came in, as the incoming rows keep it: `+1500.00 CUP`. */
const plus = (a) => `+${formatMoney({ cents: Math.round(a.amount * 100), currency: a.currency })}`;
const INCOMING = new Set(["234-in", "in-card", "in-recharge", "in-plan"]);

const card = (ctx, a) => ctx.store.state.cards.find((c) => c.id === a.cardId);

function title(ctx, a) {
  const card = ctx.store.state.cards.find((c) => c.id === a.cardId);
  if (a.billId) return a.debt ? `Deuda · ${titleOf(a)}` : `${titleOf(a)}${a.amount ? ` · ${a.amount} CUP` : ""}`;
  if (a.op === "45") return `Transferencia · ${a.amount} ${card?.currency ?? ""}`.trim();
  if (a.op === "234") return `Saldo a ${a.to} · −${a.amount} CUP`;
  if (a.op === "234-in") return `Saldo de ${a.to} · +${a.amount} CUP`;
  if (a.op === "133") return "Compra de plan";
  if (a.op === "in-card") return `Transferencia recibida · ${plus(a)}`;
  if (a.op === "in-recharge") return `Recarga recibida · ${a.amount !== null ? plus(a) : a.plan}`;
  if (a.op === "in-plan") return `Plan recibido · ${a.plan}`;
  if (a.op === "234-charge") return a.state === "verified" ? `Saldo de ${a.from} por QR · +${a.receivedAmount} CUP` : `QR para recibir saldo${a.amount ? ` · ${a.amount} CUP` : ""}`;
  return `Consulta de saldo${card ? ` · ${card.alias}` : ""}`;
}

/** One history row; the home screen's recent activity uses it too. */
export function row(ctx, a) {
  const [label, cls] = STATE[stateOf(a)] ?? ["○ sin verificar", "pend"];
  const detail = a.billId ? (card(ctx, a)?.alias ?? "") : a.op === "45" ? `a ····${last4(a.to)}` : a.op === "in-card" ? `de ${a.to}` : a.op.startsWith("234") || a.op === "133" || INCOMING.has(a.op) ? "" : (a.available ?? a.reply ?? "");
  return h("div", { class: "row", "data-state": a.state, "data-id": a.id, onclick: () => ctx.go(`history/${a.id}`) },
    icon(a.billId ? KINDS[a.kind]?.icon ?? "bolt" : a.op === "45" || a.op === "234" ? "send" : a.op === "234-in" || a.op === "234-charge" || a.op === "in-recharge" ? "phone" : a.op === "133" || a.op === "in-plan" ? "plan" : "card", "ic"),
    h("div", { class: "tx" }, h("b", {}, title(ctx, a)), h("span", {}, `${when(a.startedAt)}${detail ? ` · ${detail}` : ""}`)),
    h("span", { class: `st ${cls}` }, label),
    h("span", { class: "chev" }, "›"),
  );
}

/** What the last settle found, `{id, text}`, shown again on the screen that ran it: a row's or the list's (id null). */
let settled = null;

/**
 * The button that reads the last 72 hours of service SMS and settles the history with them. `a` is
 * the row whose detail shows it, to say whether that one was verified.
 */
function settleButton(ctx, a = null) {
  const id = a?.id ?? null;
  const note = h("div", { class: "hint", id: "settle-note" }, settled?.id === id ? settled.text : "");
  const btn = h("button", { class: "mini", id: "settle", onclick: async () => {
    btn.disabled = true;
    btn.textContent = "Revisando…";
    try {
      const r = await ctx.workflow.settle();
      const row = a && ctx.store.state.attempts.find((x) => x.id === a.id);
      settled = { id, text: row ? (row.state === "verified" ? "Un SMS verificó esta operación." : "Ningún SMS de las últimas 72 horas verifica esta operación.")
        : `Revisé ${r.read} SMS de las últimas 72 horas: ${r.verified === 1 ? "1 operación verificada" : `${r.verified} operaciones verificadas`}.` };
    } catch {
      settled = { id, text: "No pude leer los SMS. Ajé necesita el permiso de leer SMS para revisarlos." };
    }
    btn.disabled = false;
    btn.textContent = "Revisar SMS";
    // A verified row redraws the screen while settle runs: write to the note that is on screen now.
    (document.getElementById("settle-note") ?? note).textContent = settled.text;
  } }, icon("sms"), "Revisar SMS");
  return [btn, note];
}

function detail(ctx, a) {
  const kv = (k, v) => (v === null || v === undefined || v === "" ? null : h("div", { class: "kv" }, h("span", {}, k), h("b", {}, v)));
  return h("div", { id: "detail" },
    h("div", { class: "sbar" },
      h("button", { class: "back", "aria-label": "Volver", onclick: () => ctx.go("history") }, "‹"),
      h("div", {}, h("h2", {}, title(ctx, a)), h("div", { class: "sub" }, when(a.startedAt)))),
    h("div", { class: "sheet-like" },
      kv("Solicitada", when(a.startedAt)),
      kv("Verificada por SMS", a.verifiedAt ? when(a.verifiedAt) : null),
      kv("Estado", (STATE[stateOf(a)] ?? ["sin verificar"])[0]),
      kv("Fallo", a.failureCode !== null ? `código ${a.failureCode}` : null),
      // A charge keeps this line's own number in `to`; who paid is `from`.
      a.op === "234-charge" ? kv("Desde", a.from) : kv(INCOMING.has(a.op) ? "Desde" : "Destino", a.to ? (a.op.startsWith("234") || INCOMING.has(a.op) ? a.to : `····${last4(a.to)}`) : null),
      kv("A la cuenta", a.account ? `····${last4(a.account)}` : null),
      kv("Desde", a.billId ? card(ctx, a)?.alias : null),
      kv("Tarjeta", a.cardId && INCOMING.has(a.op) ? ctx.store.state.cards.find((c) => c.id === a.cardId)?.alias : null),
      kv("Transacción", a.transactionId),
      kv("Deuda", a.debt && a.state === "verified" ? debtText(a.debtCents) : null),
      kv("Saldo contable", a.accounting),
      kv("Saldo disponible", a.available)),
    a.reply ? h("div", { class: "reply" }, h("div", { class: "k" }, h("span", { class: "dot" }), a.op.startsWith("234") || a.op === "133" ? "Respuesta de Cubacel" : "Respuesta del banco"), h("div", { class: "m" }, a.reply)) : null,
    a.state === "verified" || INCOMING.has(a.op) ? null : h("div", { class: "settle" }, ...settleButton(ctx, a)),
    a.code ? h("details", { class: "codefold" }, h("summary", {}, "Ver el código que marcó Ajé"), h("div", { class: "cc" }, a.code)) : null,
  );
}

export function renderHistory(ctx, r) {
  const attempts = ctx.store.state.attempts;
  if (r.param) {
    const a = attempts.find((x) => String(x.id) === r.param);
    if (a) return detail(ctx, a);
  }
  const [btn, note] = settleButton(ctx);
  return h("div", { id: "history" },
    h("div", { class: "topbar" }, h("div", { class: "t" }, "Historial"), btn),
    note,
    attempts.length ? attempts.map((a) => row(ctx, a)) : h("div", { class: "empty" }, "Aún no hay operaciones."),
  );
}
