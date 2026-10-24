// History: every operation, logged when sent and verified when the bank's SMS arrives.
// The code shown is the display form, with any key masked; the dialed form is never kept.
import { KINDS, titleOf } from "../core/bills.js";
import { last4 } from "../core/money.js";
import { debtText } from "./pay.js";
import { formatMoney } from "../core/sms.js";
import { maskSms, money, receipt, receiptText, visibleFields } from "../core/receipt.js";
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

// The one receipt whose discreet mode the person turned off; any redraw, or another receipt, keeps it on otherwise.
let revealed = null;

/** Copies `text`: the Clipboard API, or the older copy command where the WebView refuses it. */
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = h("textarea", { style: "position:fixed;opacity:0" }, text);
    document.body.append(t);
    t.select();
    const ok = document.execCommand("copy");
    t.remove();
    if (!ok) throw new Error("copy refused");
  }
}

/** "Mostrar": the receipt full screen and large, for the person across the counter. Never the balance. */
function showFull(r) {
  const close = () => { layer.remove(); removeEventListener("hashchange", close); };
  const layer = h("div", { class: "rshow", id: "receipt-show" },
    h("button", { class: "close", onclick: close }, "Cerrar"),
    h("div", { class: "ok" }, h("i", {}, "✓"), r.what),
    h("div", { class: "bank" }, `${r.from} · verificada por SMS`),
    h("div", { class: "amt" }, money(r.amount), h("small", {}, r.currency)),
    h("div", { class: "big" }, r.show.map(([k, v]) => h("div", {}, h("span", {}, k), h("b", {}, v)))));
  addEventListener("hashchange", close);
  document.body.append(layer);
}

/** The confirmation SMS as a receipt: discreet mode, Mostrar, Compartir, Copiar and the original text. */
function receiptView(ctx, a, r) {
  const discreet = revealed !== a.id;
  const note = h("div", { class: "hint", id: "receipt-note" });
  const say = (t) => { note.textContent = t; };
  const fields = discreet ? r.fields : visibleFields(r, false);
  const view = h("div", { class: "receipt" },
    h("div", { class: "rc", id: "receipt" },
      h("div", { class: "from" }, r.from, h("span", { class: "vtag" }, "✓ verificada por SMS")),
      h("div", { class: "what" }, r.what),
      h("div", { class: "amt" }, money(r.amount), h("small", {}, r.currency)),
      h("div", { class: "kvs" }, fields.map((f) => discreet && f.private
        ? h("div", { class: "kv hid" }, h("span", {}, f.label), h("b", {}, "oculto"))
        : h("div", { class: "kv" }, h("span", {}, f.label), h("b", {}, discreet && f.short ? f.short : f.value))))),
    h("button", { class: `disc${discreet ? " on" : ""}`, id: "receipt-discreet", "aria-pressed": String(discreet),
      onclick: () => { revealed = discreet ? a.id : null; view.replaceWith(receiptView(ctx, a, r)); } },
      h("span", { class: "t" }, h("b", {}, "Discreto"),
        h("span", {}, discreet ? "Oculta tu saldo y lo que te identifica" : "Se ve todo, también tu saldo")),
      h("span", { class: "sw" })),
    h("div", { class: "racts" },
      h("button", { class: "main", id: "receipt-show-btn", onclick: () => showFull(r) }, icon("plan"), "Mostrar"),
      h("button", { id: "receipt-share", onclick: () => ctx.bridge.share(receiptText(r, discreet)).catch(() => say("No se pudo abrir la lista de apps.")) }, icon("share"), "Compartir"),
      h("button", { id: "receipt-copy", onclick: () => copy(receiptText(r, discreet)).then(() => say("Copiado."), () => say("No se pudo copiar.")) }, icon("copy"), "Copiar")),
    note,
    r.sms ? h("details", { class: "codefold" }, h("summary", {}, "Ver el SMS original"),
      h("div", { class: "rsms", id: "receipt-sms" }, discreet ? maskSms(r.sms) : r.sms)) : null);
  return view;
}

function detail(ctx, a) {
  const kv = (k, v) => (v === null || v === undefined || v === "" ? null : h("div", { class: "kv" }, h("span", {}, k), h("b", {}, v)));
  const r = receipt(a, { cards: ctx.store.state.cards });
  return h("div", { id: "detail" },
    h("div", { class: "sbar" },
      h("button", { class: "back", "aria-label": "Volver", onclick: () => ctx.go("history") }, "‹"),
      h("div", {}, h("h2", {}, title(ctx, a)), h("div", { class: "sub" }, when(a.startedAt)))),
    r ? receiptView(ctx, a, r) : null,
    h("div", { class: "sheet-like" },
      kv("Solicitada", when(a.startedAt)),
      kv("Verificada por SMS", a.verifiedAt ? when(a.verifiedAt) : null),
      kv("Estado", (STATE[stateOf(a)] ?? ["sin verificar"])[0]),
      kv("Fallo", a.failureCode !== null ? `código ${a.failureCode}` : null),
      // A charge keeps this line's own number in `to`; who paid is `from`.
      a.op === "234-charge" ? kv("Desde", a.from) : kv(INCOMING.has(a.op) ? "Desde" : "Destino", a.to ? (a.op.startsWith("234") || INCOMING.has(a.op) ? a.to : `····${last4(a.to)}`) : null),
      kv("A la cuenta", a.account ? `····${last4(a.account)}` : null),
      kv("Desde", a.billId && !r ? card(ctx, a)?.alias : null),
      kv("Tarjeta", a.cardId && INCOMING.has(a.op) ? ctx.store.state.cards.find((c) => c.id === a.cardId)?.alias : null),
      kv("Transacción", a.transactionId),
      kv("Deuda", a.debt && a.state === "verified" ? debtText(a.debtCents) : null),
      kv("Saldo contable", a.accounting),
      // The receipt shows the balance a verified operation left, under discreet mode.
      r ? null : kv("Saldo disponible", a.available)),
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
