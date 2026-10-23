// Pasar saldo: one Cubacel line passes balance to another with *234*1 over the USSD API. The
// destination is typed or picked from the contacts; the transfer key can be remembered behind
// the fingerprint, and Cubacel's SMS verify the transfer afterwards.
import { MIN_BALANCE, normalizeNumber, TRANSFER_FEE, validKey } from "../core/lines.js";
import { parseAmount } from "../core/money.js";
import { h } from "./dom.js";
import { openSheet } from "./sheets.js";

const RESULT = {
  dialer: "Termina en el marcador: escribe 1 para confirmar. El SMS de Cubacel lo verificará.",
  failed: "El teléfono no pudo abrir el marcador.",
};

/** The figure of a line's balance as Ajé last read it, or null. */
const known = (text) => (text ? Number.parseFloat(String(text).replace(",", ".")) : null);

/** The last five distinct numbers this phone passed balance to. */
function recents(ctx) {
  const seen = [];
  for (const a of ctx.store.state.attempts) if (a.op === "234" && a.to && !seen.includes(a.to)) seen.push(a.to);
  return seen.slice(0, 5);
}

export function renderLineTransfer(ctx, r) {
  const sims = ctx.sims;
  let subId = Number(r.query.get("sub") ?? sims[0]?.subId);
  if (!sims.length) return h("div", { class: "empty" }, "Ajé no ve ninguna SIM en este teléfono.");
  let tab = "num";
  let dest = null; // {number, name}

  const error = h("div", { id: "lt-error", class: "err", hidden: true });
  const warn = h("div", { id: "lt-warn", class: "warn", hidden: true });
  const toLine = h("div", { id: "lt-to", class: "hint" });
  const total = h("b", { id: "lt-total" });
  const fail = (text) => {
    error.textContent = text;
    error.hidden = !text;
  };

  function setDest(number, name = null) {
    const n = normalizeNumber(number);
    dest = n ? { number: n, name } : null;
    toLine.textContent = dest ? `Para ${name ? `${name} · ` : ""}${n}` : "";
    fail(number && !n ? "Ese número no es un móvil Cubacel." : "");
    update();
  }

  const num = h("input", { id: "lt-num", inputmode: "tel", autocomplete: "off", placeholder: "5XXXXXXX o +53 5XXX XXXX",
    oninput: () => setDest(num.value) });
  const pick = h("button", { id: "lt-pick", class: "btn ghost", onclick: async () => {
    const c = await ctx.bridge.pickContact?.().catch(() => null);
    if (c) setDest(c.number, c.name || null);
  } }, "Elegir un contacto");
  const amount = h("input", { id: "lt-amount", inputmode: "numeric", autocomplete: "off", oninput: () => update() });
  const button = h("button", { id: "lt-submit", class: "btn gold", onclick: () => !button.disabled && submit() }, "Pasar saldo");

  const tabs = h("div", { class: "chips", role: "tablist" },
    h("button", { id: "lt-tab-num", class: "on", onclick: () => show("num") }, "Número"),
    h("button", { id: "lt-tab-con", onclick: () => show("con") }, "Contacto"));
  const paneNum = h("div", { class: "field" }, h("label", { for: "lt-num" }, "Número de destino"), num);
  const paneCon = h("div", { class: "field", hidden: true }, pick);
  function show(t) {
    tab = t;
    tabs.children[0].classList.toggle("on", t === "num");
    tabs.children[1].classList.toggle("on", t === "con");
    paneNum.hidden = t !== "num";
    paneCon.hidden = t !== "con";
  }

  const recent = recents(ctx);
  const recentRow = recent.length ? h("div", { class: "field" }, h("label", {}, "Recientes"),
    h("div", { id: "lt-recent", class: "chips" }, recent.map((n) => h("button", { onclick: () => {
      num.value = n;
      show("num");
      setDest(n);
    } }, n)))) : null;

  const lineChips = sims.length > 1 ? h("div", { class: "field" }, h("label", {}, "Pagar desde"),
    h("div", { id: "lt-line", class: "chips" }, sims.map((s) => h("button", { class: s.subId === subId ? "on" : null, onclick: (e) => {
      subId = s.subId;
      for (const b of e.currentTarget.parentNode.children) b.classList.toggle("on", b === e.currentTarget);
      update();
    } }, `SIM ${s.slot + 1} · ${s.carrier}`)))) : null;

  function update() {
    const n = parseAmount(amount.value);
    total.textContent = `${(n ?? 0) + TRANSFER_FEE} CUP`;
    const balance = known(ctx.store.state.mobileBalances[subId]);
    const notes = [];
    if (n && balance !== null && balance < n + MIN_BALANCE) notes.push(`El saldo que Ajé conoce de esta línea (${balance} CUP) no alcanza para ${n} CUP más el costo.`);
    if (ctx.workflow.transfersToday(subId) >= 3) notes.push("Hoy ya pasaste saldo 3 veces desde esta línea; Cubacel puede rechazar más.");
    warn.textContent = notes.join(" ");
    warn.hidden = !notes.length;
    button.textContent = dest && n ? `Pasar ${n} CUP` : "Pasar saldo";
  }

  async function submit() {
    if (!dest) return fail(tab === "con" ? "Elige un contacto con un móvil Cubacel." : "Escribe el número de destino.");
    const n = parseAmount(amount.value);
    if (n === null) return fail("El monto es un número entero de CUP, sin decimales.");
    fail("");
    button.disabled = true;
    try {
      const saved = await ctx.workflow.savedLineKey(subId);
      if (!saved.saved) return await keySheet(ctx, { subId, saved, send: (key, remember) => pay(n, key, remember) });
      await pay(n, null, false);
    } finally {
      button.disabled = false;
    }
  }

  async function pay(n, key, remember) {
    const r = await ctx.workflow.transferBalance(subId, dest.number, n, { key, remember });
    if (r.outcome === "needs-key") {
      const saved = await ctx.workflow.savedLineKey(subId);
      return keySheet(ctx, { subId, saved, send: (k, rem) => pay(n, k, rem) });
    }
    resultSheet(ctx, r, `Pasar saldo · ${n} CUP`, subId, key === null);
  }

  update();
  return h("div", { id: "line-transfer" },
    h("div", { class: "sbar" },
      h("button", { class: "back", "aria-label": "Volver", onclick: () => history.back() }, "‹"),
      h("div", {}, h("h2", {}, "Pasar saldo"), h("div", { class: "sub" }, "De tu línea a otro móvil Cubacel"))),
    tabs, paneNum, paneCon, toLine, recentRow,
    h("div", { class: "field" }, h("label", { for: "lt-amount" }, "Monto en CUP"), amount,
      h("div", { class: "hint" }, "Un número entero, sin decimales.")),
    lineChips,
    h("div", { class: "kv" }, h("span", {}, "Costo de la operación"), h("b", {}, `${TRANSFER_FEE} CUP`)),
    h("div", { class: "kv" }, h("span", {}, "Sale de tu saldo"), total),
    warn, error, button,
  );
}

/**
 * Asks for the line's transfer key, offers to remember it, and explains the factory key. The promise
 * settles once the send it starts has finished, or the sheet closes unused, so Pasar stays off meanwhile.
 */
function keySheet(ctx, { subId, saved, send }) {
  let settle;
  const settled = new Promise((r) => { settle = r; });
  let sending = false;
  let remember = true;
  let help = false;
  let error = null;
  let changed = null;
  const sheet = openSheet(ctx, () => {
    const key = h("input", { id: "key-input", type: "password", inputmode: "numeric", maxlength: "4", autocomplete: "off", "aria-label": "Clave de transferencia" });
    const submit = async () => {
      const k = key.value;
      key.value = "";
      if (!validKey(k)) {
        error = "La clave tiene 4 dígitos.";
        return sheet.redraw();
      }
      sending = true;
      sheet.close();
      try {
        await send(k, saved.available && remember);
      } finally {
        settle();
      }
    };
    const keep = saved.available ? h("label", { class: "remember" },
      h("button", { id: "key-remember", class: `toggle${remember ? " on" : ""}`, "aria-pressed": String(remember), onclick: (e) => {
        remember = !remember;
        e.currentTarget.classList.toggle("on", remember);
        e.currentTarget.setAttribute("aria-pressed", String(remember));
      } }),
      h("span", {}, h("b", {}, "Recordarla en este teléfono"), "180 días; cada uso pide tu huella o el bloqueo del teléfono.")) : null;
    const parts = [
      h("h3", {}, "Clave de transferencia"),
      h("p", { class: "lead" }, `La clave de 4 dígitos con que Cubacel autoriza pasar saldo.${saved.available ? "" : " Ajé no la guarda."}`),
      h("div", { class: "field" }, key), h("div", { class: "err" }, error ?? ""), keep,
      h("button", { id: "key-submit", class: "btn gold", onclick: submit }, "Pasar saldo"),
      h("button", { id: "key-help", class: "btn ghost", onclick: () => { help = !help; sheet.redraw(); } }, "¿No sabes tu clave?"),
    ];
    if (help) parts.push(changeForm(ctx, subId, (msg) => { changed = msg; sheet.redraw(); }), changed ? h("div", { id: "key-changed", class: "hint" }, changed) : null);
    queueMicrotask(() => key.focus());
    return parts;
  }, () => sending || settle());
  return settled;
}

/** The factory key, and a form to change the key with *234*2. */
function changeForm(ctx, subId, done) {
  const input = (id, label) => h("input", { id, type: "password", inputmode: "numeric", maxlength: "4", autocomplete: "off", "aria-label": label });
  const old = input("key-old", "Clave actual");
  const next = input("key-new", "Clave nueva");
  const again = input("key-new2", "Repite la clave nueva");
  return h("div", { class: "sheet-like" },
    h("p", { class: "lead" }, "Si nunca la cambiaste, es 1234. Cámbiala antes de pasar saldo: cualquiera que tenga tu teléfono podría usar la de fábrica."),
    h("div", { class: "field" }, old), h("div", { class: "field" }, next), h("div", { class: "field" }, again),
    h("button", { id: "key-change", class: "btn ghost", onclick: async () => {
      if (![old, next, again].every((i) => validKey(i.value))) return done("Cada clave tiene 4 dígitos.");
      if (next.value !== again.value) return done("Las dos claves nuevas no coinciden.");
      const r = await ctx.workflow.changeLineKey(subId, old.value, next.value);
      done(r.ok ? "Clave cambiada. Escríbela arriba para pasar saldo."
        : r.dialed ? "Termina en el marcador: escribe 1 para confirmar. Luego escribe la clave nueva arriba."
        : r.reply ? `Respuesta de Cubacel: ${r.reply}` : "El teléfono no pudo mandar el código.");
    } }, "Cambiar la clave"));
}

/**
 * The transfer went to the dialer, where the person confirms with 1; Cubacel's SMS verifies it
 * here. The dialer hides the network's answer, so a saved key that failed there can be forgotten.
 */
function resultSheet(ctx, r, title, subId, usedSaved) {
  const id = r.attempt?.id;
  let forgot = false;
  const sheet = openSheet(ctx, () => {
    const a = ctx.store.state.attempts.find((x) => x.id === id) ?? r.attempt;
    const verified = a?.state === "verified";
    const waiting = r.ok && !verified;
    return [
      h("h3", {}, title),
      h("div", { class: `reply${waiting ? " pending" : ""}`, id: "lt-result", "data-outcome": r.outcome },
        h("div", { class: "k status" }, h("span", { class: waiting ? "spin" : "dot", "aria-hidden": "true" }),
          verified ? "Verificada por SMS" : RESULT[r.outcome])),
      r.ok && usedSaved && !verified ? h("button", { id: "lt-forget", class: "btn ghost", disabled: forgot, onclick: async () => {
        await ctx.workflow.forgetLineKey(subId);
        forgot = true;
        sheet.redraw();
      } }, forgot ? "Clave olvidada: la próxima vez Ajé te la pedirá" : "Cubacel no aceptó la clave guardada") : null,
      h("button", { id: "lt-close", class: "btn ghost", onclick: () => sheet.close() }, "Cerrar"),
    ];
  });
  return sheet;
}
