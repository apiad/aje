// The bottom sheet that follows one operation: sent, the bank's reply, verified by SMS, or
// failed. It lives outside the screen so redraws of the screen behind it never close it.
import { h } from "./dom.js";

let close = null;

/** Closes the open sheet, if any; a route change does this. */
export function closeSheet() {
  close?.();
}

/** Opens a sheet whose body `build()` redraws on every store change until it is closed. */
export function openSheet(ctx, build) {
  close?.();
  const body = h("div", { class: "sheet-body" });
  const sheet = h("div", { class: "sheet", id: "sheet", role: "dialog", "aria-modal": "true" }, h("div", { class: "grab" }), body);
  const scrim = h("div", { class: "scrim", onclick: () => close() });
  const draw = () => body.replaceChildren(...[build()].flat().filter(Boolean));
  const off = ctx.store.subscribe(draw);
  const esc = (e) => e.key === "Escape" && close();
  document.addEventListener("keydown", esc);
  close = () => {
    off();
    document.removeEventListener("keydown", esc);
    sheet.remove();
    scrim.remove();
    close = null;
  };
  document.getElementById("app").append(scrim, sheet);
  draw();
  return { redraw: draw, close: () => close?.() };
}

const STATUS = {
  sent: "Enviando…",
  replied: "Respuesta del banco",
  dialer: "Termina en el marcador: escribe 1 para confirmar. El SMS del banco la verificará.",
  verified: "Verificada por SMS",
};

function status(a) {
  if (!a) return "Enviando…";
  if (a.state === "failed") return `El teléfono no la envió (código ${a.failureCode}).`;
  return STATUS[a.state];
}

function attemptView(a) {
  return [
    h("div", { class: `reply${a && (a.state === "sent") ? " pending" : ""}` },
      h("div", { class: "k status" }, h("span", { class: "dot" }), status(a)),
      a?.reply ? h("div", { class: "m" }, a.reply) : null),
    a?.state === "verified" && a.available ? h("div", { class: "kv" }, h("span", {}, "Saldo disponible"), h("b", {}, a.available)) : null,
    a?.transactionId ? h("div", { class: "kv" }, h("span", {}, "Transacción"), h("b", {}, a.transactionId)) : null,
  ];
}

/**
 * Balance query for a card's currency. When the bank asks for a login, the sheet shows the key
 * form; after the login it follows the balance query the bank's auth SMS reruns.
 */
export async function balanceSheet(ctx, account) {
  let shownId = null;
  let phase = "query"; // query | login | waiting
  let loginError = null;
  let loginReply = null;
  const latest = () => ctx.store.state.attempts.find((a) => a.op === "46" && a.currency === account.currency && (shownId === null || a.id >= shownId));

  const sheet = openSheet(ctx, () => {
    const a = latest();
    const parts = [h("h3", {}, `Saldo · ${account.label}`)];
    if (phase === "login") {
      const pin = h("input", { id: "pin", type: "password", inputmode: "numeric", maxlength: "4", autocomplete: "off", "aria-label": "Clave del banco" });
      const err = h("div", { class: "err" }, loginError ?? "");
      const submit = async () => {
        const key = pin.value;
        pin.value = "";
        if (!/^[0-9]{4}$/.test(key)) {
          loginError = "La clave tiene 4 dígitos.";
          sheet.redraw();
          return;
        }
        phase = "waiting";
        loginError = null;
        sheet.redraw();
        const r = await ctx.workflow.login(key, { retryCurrency: account.currency });
        loginReply = r.ok ? r.reply : null;
        sheet.redraw();
        if (!r.ok) {
          phase = "login";
          loginError = `El teléfono no la envió (código ${r.failureCode}).`;
          sheet.redraw();
        }
      };
      parts.push(
        h("p", { class: "lead" }, "El banco pide abrir sesión. Escribe la clave de tu tarjeta; Ajé no la guarda."),
        h("div", { class: "field" }, pin), err,
        h("button", { id: "pin-submit", class: "btn gold", onclick: submit }, "Autenticarse"),
      );
      queueMicrotask(() => pin.focus());
    } else if (phase === "waiting" && (!a || a.id === shownId)) {
      // The bank's own words: a wrong key or a blocked card says so here, and no SMS will follow.
      parts.push(h("div", { class: "reply pending" },
        h("div", { class: "k status" }, h("span", { class: "dot" }), "Esperando el SMS del banco; luego Ajé repetirá la consulta."),
        loginReply ? h("div", { class: "m", id: "login-reply" }, `Respuesta del banco: ${loginReply}`) : null));
      if (loginReply) {
        parts.push(h("button", { id: "pin-retry", class: "btn ghost", onclick: () => {
          phase = "login";
          loginReply = null;
          sheet.redraw();
        } }, "Volver a escribir la clave"));
      }
    } else {
      parts.push(...attemptView(a));
    }
    parts.push(h("button", { class: "btn ghost", onclick: () => sheet.close() }, "Cerrar"));
    return parts;
  });

  const { attempt, needsLogin } = await ctx.workflow.balance(account.currency);
  shownId = attempt.id;
  if (needsLogin) phase = "login";
  sheet.redraw();
}

/** Follows a dialed transfer until the bank's SMS verifies it. */
export function transferSheet(ctx, attempt, title) {
  return openSheet(ctx, () => [
    h("h3", {}, title),
    ...attemptView(ctx.store.state.attempts.find((a) => a.id === attempt.id)),
    h("button", { class: "btn ghost", onclick: () => close?.() }, "Cerrar"),
  ]);
}

/** The line balance: the card shows the figure; the sheet opens only when there is none. */
export async function mobileBalanceSheet(ctx, account) {
  const r = await ctx.workflow.mobileBalance(account.subId);
  if (r.ok && r.value) return;
  openSheet(ctx, () => [
    h("h3", {}, `Saldo móvil · ${account.label}`),
    h("div", { class: "reply" }, h("div", { class: "k status" }, h("span", { class: "dot" }),
      r.ok ? "Respuesta de ETECSA" : `El teléfono no la envió (código ${r.failureCode}).`),
      r.reply ? h("div", { class: "m" }, r.reply) : null),
    h("button", { class: "btn ghost", onclick: () => close?.() }, "Cerrar"),
  ]);
}
