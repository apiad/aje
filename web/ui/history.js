// History: every operation, logged when sent and verified when the bank's SMS arrives.
// The code shown is the display form, with any key masked; the dialed form is never kept.
import { last4 } from "../core/money.js";
import { CHARGE_MS } from "../core/store.js";
import { h, icon, when } from "./dom.js";

const STATE = { verified: ["✓ verificada", "ok"], failed: ["fallida", "pend"], waiting: ["○ esperando", "pend"], expired: ["vencido", "pend"] };

/** A charge nobody paid within its 24 hours is no longer waiting. */
const stateOf = (a) => (a.op === "234-charge" && a.state === "waiting" && Date.now() - a.startedAt >= CHARGE_MS ? "expired" : a.state);

function title(ctx, a) {
  const card = ctx.store.state.cards.find((c) => c.id === a.cardId);
  if (a.op === "45") return `Transferencia · ${a.amount} ${card?.currency ?? ""}`.trim();
  if (a.op === "234") return `Saldo a ${a.to} · −${a.amount} CUP`;
  if (a.op === "234-in") return `Saldo de ${a.to} · +${a.amount} CUP`;
  if (a.op === "133") return "Compra de plan";
  if (a.op === "234-charge") return a.state === "verified" ? `Cobro de ${a.from} · +${a.receivedAmount} CUP` : `Cobro${a.amount ? ` · ${a.amount} CUP` : ""}`;
  return `Consulta de saldo${card ? ` · ${card.alias}` : ""}`;
}

/** One history row; the home screen's recent activity uses it too. */
export function row(ctx, a) {
  const [label, cls] = STATE[stateOf(a)] ?? ["○ sin verificar", "pend"];
  const detail = a.op === "45" ? `a ····${last4(a.to)}` : a.op.startsWith("234") || a.op === "133" ? "" : (a.available ?? a.reply ?? "");
  return h("div", { class: "row", "data-state": a.state, "data-id": a.id, onclick: () => ctx.go(`history/${a.id}`) },
    icon(a.op === "45" || a.op === "234" ? "send" : a.op === "234-in" || a.op === "234-charge" ? "phone" : a.op === "133" ? "plan" : "card", "ic"),
    h("div", { class: "tx" }, h("b", {}, title(ctx, a)), h("span", {}, `${when(a.startedAt)}${detail ? ` · ${detail}` : ""}`)),
    h("span", { class: `st ${cls}` }, label),
    h("span", { class: "chev" }, "›"),
  );
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
      a.op === "234-charge" ? kv("Desde", a.from) : kv(a.op === "234-in" ? "Desde" : "Destino", a.to ? (a.op.startsWith("234") ? a.to : `····${last4(a.to)}`) : null),
      kv("Transacción", a.transactionId),
      kv("Saldo contable", a.accounting),
      kv("Saldo disponible", a.available)),
    a.reply ? h("div", { class: "reply" }, h("div", { class: "k" }, h("span", { class: "dot" }), a.op.startsWith("234") || a.op === "133" ? "Respuesta de Cubacel" : "Respuesta del banco"), h("div", { class: "m" }, a.reply)) : null,
    a.code ? h("details", { class: "codefold" }, h("summary", {}, "Ver el código que marcó Ajé"), h("div", { class: "cc" }, a.code)) : null,
  );
}

export function renderHistory(ctx, r) {
  const attempts = ctx.store.state.attempts;
  if (r.param) {
    const a = attempts.find((x) => String(x.id) === r.param);
    if (a) return detail(ctx, a);
  }
  return h("div", { id: "history" },
    h("div", { class: "topbar" }, h("div", { class: "t" }, "Historial")),
    attempts.length ? attempts.map((a) => row(ctx, a)) : h("div", { class: "empty" }, "Aún no hay operaciones."),
  );
}
