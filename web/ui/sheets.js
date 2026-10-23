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

/** How long a sheet shows a settled result before closing by itself. */
const AUTO_CLOSE_MS = 1200;

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

/** The status mark: a spinner while the operation still waits on the bank, a dot once it is settled. */
const mark = (waiting) => h("span", { class: waiting ? "spin" : "dot", "aria-hidden": "true" });

function attemptView(a) {
  const waiting = !a || a.state === "sent" || (a.op === "46" && a.state === "replied");
  return [
    h("div", { class: `reply${waiting ? " pending" : ""}` },
      h("div", { class: "k status" }, mark(waiting), waiting && a?.state === "replied" ? "Respuesta del banco; esperando su SMS…" : status(a)),
      a?.reply ? h("div", { class: "m" }, a.reply) : null),
    a?.state === "verified" && a.available ? h("div", { class: "kv" }, h("span", {}, "Saldo disponible"), h("b", {}, a.available)) : null,
    a?.transactionId ? h("div", { class: "kv" }, h("span", {}, "Transacción"), h("b", {}, a.transactionId)) : null,
  ];
}

/**
 * Balance query for a card. When the bank asks for a login, the sheet shows the key
 * form; after the login it follows the balance query the bank's auth SMS reruns.
 */
export async function balanceSheet(ctx, account) {
  let shownId = null;
  let phase = "query"; // query | unlocking | login | waiting
  let loginError = null;
  let loginReply = null;
  let saved = { available: false, saved: false };
  let usedSaved = false;
  let remember = true;
  let closing = null;
  // A Clásica logs in to MiTransfer, not to a bank of its own.
  const session = ctx.workflow.sessionOf(account.bank);
  const mitransfer = session === "MITRANSFER";
  const asks = mitransfer ? "MiTransfer pide abrir sesión. Escribe tu clave de MiTransfer." : "El banco pide abrir sesión. Escribe la clave de tu tarjeta.";
  // Until this sheet's query is stored, an older verified balance is not its answer.
  const latest = () => (shownId === null ? null : ctx.store.state.attempts.find((a) => a.op === "46" && a.cardId === account.cardId && a.id >= shownId));

  // Both login paths end here: the USSD went out, or the phone could not send it.
  function afterLogin(r) {
    loginReply = r.ok ? r.reply : null;
    if (!r.ok) {
      phase = "login";
      loginError = `El teléfono no la envió (código ${r.failureCode}).`;
    }
    sheet.redraw();
  }

  const sheet = openSheet(ctx, () => {
    const a = latest();
    const parts = [h("h3", {}, `Saldo · ${account.label}`)];
    if (phase === "unlocking") {
      parts.push(h("div", { class: "reply pending" },
        h("div", { class: "k status" }, mark(true), "Desbloquea la clave guardada con tu huella o el bloqueo del teléfono.")));
    } else if (phase === "login") {
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
        usedSaved = false;
        sheet.redraw();
        afterLogin(await ctx.workflow.login(session, key, { retryCardId: account.cardId, remember: saved.available && remember }));
      };
      const keep = saved.available ? h("label", { class: "remember" },
        h("button", { id: "pin-remember", class: `toggle${remember ? " on" : ""}`, "aria-pressed": remember ? "true" : "false", onclick: () => {
          remember = !remember;
          keep.querySelector(".toggle").classList.toggle("on", remember);
          keep.querySelector(".toggle").setAttribute("aria-pressed", String(remember));
        } }),
        h("span", {}, h("b", {}, "Recordarla en este teléfono"), "180 días; cada uso pide tu huella o el bloqueo del teléfono.")) : null;
      parts.push(
        h("p", { class: "lead" }, `${asks} ${saved.available ? "" : "Ajé no la guarda."}`.trim()),
        h("div", { class: "field" }, pin), err, keep,
        h("button", { id: "pin-submit", class: "btn gold", onclick: submit }, "Autenticarse"),
      );
      queueMicrotask(() => pin.focus());
    } else if (phase === "waiting" && (!a || a.id === shownId)) {
      // The bank's own words: a wrong key or a blocked card says so here, and no SMS will follow.
      parts.push(h("div", { class: "reply pending" },
        h("div", { class: "k status" }, mark(true), mitransfer ? "Abriendo sesión en MiTransfer…" : "Esperando el SMS del banco; luego Ajé repetirá la consulta."),
        loginReply ? h("div", { class: "m", id: "login-reply" }, `Respuesta del banco: ${loginReply}`) : null));
      if (loginReply) {
        parts.push(h("button", { id: "pin-retry", class: "btn ghost", onclick: () => {
          // The bank turned down the saved key: it is wrong now, so it goes.
          if (usedSaved) ctx.workflow.forgetPin(session);
          usedSaved = false;
          phase = "login";
          loginReply = null;
          sheet.redraw();
        } }, "Volver a escribir la clave"));
      }
    } else {
      parts.push(...attemptView(a));
      // The verified balance is now on the card: the sheet shows it for a moment and goes.
      if (a?.state === "verified" && !closing) closing = setTimeout(() => sheet.close(), AUTO_CLOSE_MS);
    }
    parts.push(h("button", { class: "btn ghost", onclick: () => sheet.close() }, "Cerrar"));
    return parts;
  });

  const { attempt, needsLogin } = await ctx.workflow.balance(account.cardId);
  shownId = attempt.id;
  if (!needsLogin) return sheet.redraw();
  saved = await ctx.workflow.savedPin(session);
  if (saved.saved) {
    phase = "unlocking";
    sheet.redraw();
    const r = await ctx.workflow.loginWithSaved(session, { retryCardId: account.cardId });
    if (r) {
      usedSaved = true;
      phase = "waiting";
      return afterLogin(r);
    }
    loginError = "No se desbloqueó la clave guardada. Escríbela.";
  }
  phase = "login";
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

/** A Clásica's last operations: a waiting sheet that shows the service's reply as it comes. */
export async function movementsSheet(ctx, account) {
  let r = null;
  const sheet = openSheet(ctx, () => [
    h("h3", {}, `Últimas operaciones · ${account.label}`),
    h("div", { class: `reply${r ? "" : " pending"}` }, h("div", { class: "k status" }, mark(!r),
      !r ? "Consultando…" : r.ok ? "Respuesta del banco" : `El teléfono no la envió (código ${r.failureCode}).`),
      r?.reply ? h("div", { class: "m" }, r.reply) : null),
    h("button", { class: "btn ghost", onclick: () => close?.() }, "Cerrar"),
  ]);
  r = await ctx.workflow.movements(account.cardId);
  sheet.redraw();
}

/** The line balance: a waiting sheet that closes once the figure is on the card, or keeps ETECSA's words. */
export async function mobileBalanceSheet(ctx, account) {
  let r = null;
  const sheet = openSheet(ctx, () => [
    h("h3", {}, `Saldo móvil · ${account.label}`),
    h("div", { class: `reply${r ? "" : " pending"}` }, h("div", { class: "k status" }, mark(!r),
      !r ? "Consultando a ETECSA…" : r.ok ? "Respuesta de ETECSA" : `El teléfono no la envió (código ${r.failureCode}).`),
      r?.reply ? h("div", { class: "m" }, r.reply) : null),
    h("button", { class: "btn ghost", onclick: () => close?.() }, "Cerrar"),
  ]);
  r = await ctx.workflow.mobileBalance(account.subId);
  sheet.redraw();
  if (r.ok && r.value) setTimeout(() => sheet.close(), AUTO_CLOSE_MS / 2);
}
