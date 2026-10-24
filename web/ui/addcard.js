// Adding a card: read its number, review the bank and currency the number gives, then link it
// to its bank (ops 40 and 60) or, for a bank the person is not registered with, guide them
// through getting the coordinates card and registering (op 49) first. A pending card reopens here.
import { BANKS, classifyPan, last4 } from "../core/money.js";
import { drawCoordinate } from "../core/ops.js";
import { WINDOW_MS } from "../core/store.js";
import { h } from "./dom.js";
import { openScanner } from "./scanner.js";

const MATRIX = { METROPOLITANO: "Telebanca", BANDEC: "Multibanca", BPA: "tarjeta matriz del BPA" };
const LETTERS = "ABCDEFGHIJ";

/** The onboarding of a bank, one owner per step; a pending card remembers the step it reached. */
const GUIDE = (bank) => [
  ["tú", `Consigue tu ${MATRIX[bank]}`, `En una sucursal de ${BANKS[bank].name}, con el carné y esta tarjeta. Firmas el contrato y te dan la tarjeta de coordenadas.`],
  ["Ajé", `Regístrate con ${BANKS[bank].name}`, "Número de la tarjeta de coordenadas, nombre y carné. Ajé marca el registro."],
  ["banco", "Recibe el SMS con tu PIN", "Llega como dos coordenadas de tu tarjeta: el valor de cada una forma el PIN."],
  ["tú", "El cajero, si el banco lo pide", "Si el banco te lo pide, cambia en un cajero el PIN que te llegó por SMS."],
  ["Ajé", "Autentícate y asocia la tarjeta", "Ajé abre sesión con tu PIN y te pide el valor de una coordenada."],
];

export function renderAddCard(ctx, r) {
  const { store, workflow } = ctx;
  const root = h("div", { id: "addcard" });
  const s = { step: "scan", pan: "", alias: "", card: null, error: null, reply: null, coordinate: null, busy: false };
  let unsubscribe = null;

  const resumed = r.param && store.state.cards.find((c) => c.id === r.param);
  if (resumed) {
    s.card = resumed;
    s.step = resumed.bank === "CLASICA" ? null
      // An imported card has never answered whether its bank is registered: ask, as a new card does.
      : { true: "link", false: "guide" }[store.state.banks[resumed.bank]?.registered] ?? "ask";
  }

  const bank = () => s.card?.bank;
  // The bank a login goes to: the card's own, or MiTransfer for a Clásica.
  const loginBank = () => workflow.sessionOf(bank());
  const recentLogin = () => {
    const at = store.state.banks[loginBank()]?.authenticatedAt;
    return at !== null && at !== undefined && Date.now() - at < WINDOW_MS;
  };
  // A Clásica associates on a MiTransfer session: log in, or register in MiTransfer first.
  function clasicaStep() {
    if (recentLogin()) return "associate";
    return store.state.banks.MITRANSFER?.registered ? "login" : "mitransfer";
  }
  if (s.step === null) s.step = clasicaStep();
  function go(step, patch = {}) {
    Object.assign(s, { error: null, reply: null }, patch, { step });
    // Linking needs a recent login with the card's bank: op 60 goes to the session op 40 opened.
    if (step === "link") s.step = recentLogin() ? "coord" : "login";
    if (s.step === "coord" && !s.coordinate) s.coordinate = drawCoordinate();
    draw();
  }
  // A card the person already uses in Transfermóvil is linked to this line at the bank: it needs no
  // login or coordinate here. It is trusted until the bank serves it, as an imported card is.
  const trusted = () => (s.card ? h("button", { id: "add-trusted", class: "btn ghost", onclick: async () => {
    unsubscribe?.();
    await store.setBank(loginBank(), { registered: true });
    await store.updateCard(s.card.id, { state: bank() === "CLASICA" ? "associated" : "linked", step: 5, unverified: true });
    ctx.go("home");
  } }, "Ya la uso en Transfermóvil") : null);
  const bar = (title, sub, back) => h("div", { class: "sbar" },
    h("button", { class: "back", "aria-label": "Volver", onclick: back ?? (() => history.back()) }, "‹"),
    h("div", {}, h("h2", {}, title), sub ? h("div", { class: "sub" }, sub) : null));
  const err = () => (s.error ? h("div", { class: "err", id: "add-error" }, s.error) : null);
  const bankReply = () => (s.reply ? h("div", { class: "reply" }, h("div", { class: "k" }, "Respuesta del banco"), h("div", { class: "m", id: "add-reply" }, s.reply)) : null);

  const screens = {
    scan: () => {
      const box = h("div", { class: "scanbox", id: "add-scan" });
      queueMicrotask(() => {
        const stop = openScanner(box, {
          onPan: (pan) => { stop(); go("review", { pan }); },
          onFallback: (best) => { stop(); go("review", { pan: best ?? "" }); },
        });
        unsubscribe = stop;
      });
      return [bar("Foto de la tarjeta", "Por el frente, donde están los 16 dígitos"), box,
        h("p", { class: "hint" }, "La lectura se hace en el teléfono, sin red. La imagen no se guarda."),
        h("button", { id: "add-type", class: "btn ghost", onclick: () => { unsubscribe?.(); go("review"); } }, "Escribir el número a mano")];
    },

    review: () => {
      const pan = h("input", { id: "add-pan", inputmode: "numeric", autocomplete: "off", value: s.pan, placeholder: "9200 0000 0000 0000" });
      const alias = h("input", { id: "add-alias", autocomplete: "off", value: s.alias });
      const facts = h("div", { class: "sheet-like", id: "add-facts" });
      const next = h("button", { id: "add-next", class: "btn gold" }, "Continuar");
      const check = () => {
        s.pan = pan.value;
        const c = classifyPan(pan.value);
        const why = c.error ?? (c.bank === "MITRANSFER" || c.bank === "CLASICAEMP" ? "Este tipo de tarjeta llegará más adelante."
          : c.bank === null ? "Ajé aún no sabe de qué banco es esta cuenta: usa el número de la tarjeta." : null);
        next.disabled = Boolean(why);
        facts.replaceChildren(...(why ? [h("div", { class: "err" }, why)] : [
          h("div", { class: "kv" }, h("span", {}, "Banco"), h("b", {}, BANKS[c.bank].name)),
          h("div", { class: "kv" }, h("span", {}, "Moneda"), h("b", {}, c.currency)),
          // The Clásica is not registered with a bank, so it has no registration row.
          c.bank === "CLASICA" ? null : h("div", { class: "kv" }, h("span", {}, "Registro con el banco"), h("b", {},
            { true: "Sí", false: "No" }[store.state.banks[c.bank]?.registered] ?? "Por confirmar")),
        ].filter(Boolean)));
        if (!why && !s.alias) alias.placeholder = `${BANKS[c.bank].name} ${c.currency}`;
        return why ? null : c;
      };
      pan.addEventListener("input", check);
      alias.addEventListener("input", () => { s.alias = alias.value; });
      next.addEventListener("click", async () => {
        const c = check();
        if (!c || next.disabled) return;
        try {
          const card = await store.addCard({ alias: alias.value.trim() || alias.placeholder, pan: c.pan, bank: c.bank, currency: c.currency });
          if (c.bank === "CLASICA") return go(clasicaStep(), { card });
          const known = store.state.banks[c.bank]?.registered;
          go(known === true ? "link" : known === false ? "guide" : "ask", { card });
        } catch (e) {
          s.error = e.message;
          draw();
        }
      });
      queueMicrotask(check);
      return [bar("Revisa el número", "Corrige cualquier dígito", () => go("scan")),
        h("div", { class: "field" }, h("label", { for: "add-pan" }, "Número de tarjeta"), pan),
        facts,
        h("div", { class: "field" }, h("label", { for: "add-alias" }, "Alias"), alias),
        h("p", { class: "hint" }, "El banco y la moneda salen del número."),
        err(), next];
    },

    ask: () => [bar(`Tu registro con ${BANKS[bank()].name}`, null, () => go("review")),
      h("p", { class: "lead" }, `¿Ya estás registrado con ${BANKS[bank()].name} para pagos móviles, en Transfermóvil o en Ajé?`),
      h("button", { id: "add-registered", class: "btn gold", onclick: async () => { await store.setBank(bank(), { registered: true }); go("link"); } }, "Sí, ya lo estoy"),
      h("button", { id: "add-not-registered", class: "btn ghost", onclick: async () => { await store.setBank(bank(), { registered: false }); go("guide"); } }, "No, es mi primera tarjeta de este banco"),
      trusted()],

    guide: () => {
      const at = s.card.step;
      return [bar(`Primera tarjeta de ${BANKS[bank()].name}`, "Antes hay que registrarte con el banco", () => history.back()),
        h("ol", { class: "steps", id: "add-guide" }, GUIDE(bank()).map(([who, title, text], i) =>
          h("li", { class: i + 1 < at ? "done" : i + 1 === at ? "now" : null }, h("b", {}, title), h("span", { class: "who" }, who), h("small", {}, text)))),
        at <= 1 ? h("button", { id: "add-have-matrix", class: "btn gold", onclick: async () => { await store.updateCard(s.card.id, { step: 2 }); s.card = { ...s.card, step: 2 }; go("register"); } }, `Ya tengo la ${MATRIX[bank()]}`)
          : at === 2 ? h("button", { class: "btn gold", onclick: () => go("register") }, "Registrarme")
          : h("button", { id: "add-have-pin", class: "btn gold", onclick: async () => { await store.updateCard(s.card.id, { step: 5 }); s.card = { ...s.card, step: 5 }; go("link"); } }, "Ya tengo mi PIN"),
        h("button", { id: "add-later", class: "btn ghost", onclick: () => ctx.go("home") }, "Guardar la tarjeta y seguir luego")];
    },

    register: () => {
      const full = bank() !== "BANDEC";
      const field = (id, label, attrs = {}) => h("div", { class: "field" }, h("label", { for: id }, label), h("input", { id, autocomplete: "off", ...attrs }));
      const send = h("button", { id: "add-register", class: "btn gold" }, "Registrarme");
      send.addEventListener("click", async () => {
        const v = (id) => root.querySelector(`#${id}`)?.value.trim() ?? "";
        const matrix = classifyPan(v("reg-card"));
        const person = { card: matrix.pan, name: v("reg-name"), surname1: v("reg-s1"), surname2: v("reg-s2"), ci: v("reg-ci") };
        if (matrix.error) return go("register", { error: `Tarjeta de coordenadas: ${matrix.error}` });
        if (!person.name || (full && !person.surname1) || !/^[0-9]{11}$/.test(person.ci)) return go("register", { error: "Completa el nombre y los 11 dígitos del carné." });
        send.disabled = true;
        let res;
        try {
          res = await workflow.registerBank(bank(), person);
        } catch (e) {
          return go("register", { error: `No se pudo enviar: ${e.message}` });
        }
        if (res.ok) {
          await store.updateCard(s.card.id, { step: 3 });
          s.card = { ...s.card, step: 3 };
          return go("guide");
        }
        go("register", { reply: res.reply ?? null, error: res.reply ? null : `El teléfono no lo envió (código ${res.failureCode}).` });
      });
      return [bar(`Registro con ${BANKS[bank()].name}`, "Una sola vez por banco", () => go("guide")),
        field("reg-card", `Número de la ${MATRIX[bank()]}`, { inputmode: "numeric" }),
        field("reg-name", "Nombre"),
        full ? [field("reg-s1", "Primer apellido"), field("reg-s2", "Segundo apellido")] : null,
        field("reg-ci", "Carné de identidad", { inputmode: "numeric", maxlength: "11" }),
        h("p", { class: "hint" }, "Ajé no guarda estos datos: van solo en el código que marca."),
        bankReply(), err(), send];
    },

    login: () => {
      const pin = h("input", { id: "add-pin", type: "password", inputmode: "numeric", maxlength: "4", autocomplete: "off", "aria-label": "Clave del banco" });
      const waiting = s.busy;
      const submit = async (savedOnly = false) => {
        s.busy = true;
        draw();
        const res = savedOnly ? await workflow.loginWithSaved(loginBank()) : await workflow.login(loginBank(), pin.value);
        s.busy = Boolean(res?.ok);
        if (!res) return go("login", { error: "No se desbloqueó la clave guardada. Escríbela." });
        if (!res.ok) return go("login", { error: `El teléfono no la envió (código ${res.failureCode}).` });
        s.reply = res.reply;
        const after = bank() === "CLASICA" ? "associate" : "coord";
        // MiTransfer answers the login in its reply: no session means it turned the key down.
        if (BANKS[loginBank()].replyConfirmsLogin) {
          s.busy = false;
          return recentLogin() ? go(after) : go("login", { reply: res.reply });
        }
        // The bank's "se ha autenticado" SMS records the login; the link step follows it.
        unsubscribe?.();
        unsubscribe = store.subscribe(() => { if (recentLogin()) { unsubscribe(); s.busy = false; go(after); } });
        draw();
      };
      if (!waiting && s.savedTried === undefined) {
        s.savedTried = true;
        workflow.savedPin(loginBank()).then((st) => st.saved && submit(true));
      }
      const mt = loginBank() === "MITRANSFER";
      return [bar(`Sesión con ${BANKS[loginBank()].name}`, s.card.alias, () => ctx.go("home")),
        waiting ? h("div", { class: "reply pending" }, h("div", { class: "k status" }, "Esperando el SMS del banco…"), s.reply ? h("div", { class: "m" }, `Respuesta del banco: ${s.reply}`) : null)
          : [h("p", { class: "lead" }, mt ? "Para asociar la Clásica, Ajé abre sesión en MiTransfer. Escribe tu clave de MiTransfer; Ajé no la guarda."
              : "Para asociar la tarjeta, Ajé abre sesión con el banco. Escribe tu clave; Ajé no la guarda."),
            h("div", { class: "field" }, pin), bankReply(), err(),
            h("button", { id: "add-pin-submit", class: "btn gold", onclick: () => (/^[0-9]{4}$/.test(pin.value) ? submit() : go("login", { error: "La clave tiene 4 dígitos." })) }, "Autenticarse")],
        trusted()];
    },

    coord: () => {
      const bpa = bank() === "BPA";
      const value = h("input", { id: "add-coord", type: "password", inputmode: "numeric", maxlength: "4", autocomplete: "off" });
      const cell = s.coordinate;
      const grid = h("div", { class: "matrix", "aria-hidden": "true" }, h("i"), [...LETTERS].map((l) => h("i", {}, l)),
        Array.from({ length: 10 }, (_, r) => [h("i", {}, String(r + 1)), [...LETTERS].map((l) => h("span", { class: `${l}${r + 1}` === cell ? "hit" : null }, `${l}${r + 1}` === cell ? "?" : ""))]));
      const send = h("button", { id: "add-link", class: "btn gold" }, "Asociar tarjeta");
      send.addEventListener("click", async () => {
        if (!bpa && !/^[0-9]{1,4}$/.test(value.value)) return go("coord", { error: "Escribe el valor de la coordenada." });
        send.disabled = true;
        const res = await workflow.linkCard(s.card.id, bpa ? null : cell, bpa ? null : value.value);
        value.value = "";
        if (res.ok) return go("done");
        if (res.needsLogin) return go("login", { reply: res.reply ?? null });
        go("coord", { coordinate: drawCoordinate(), reply: res.reply ?? null, error: res.reply ? null : `El teléfono no lo envió (código ${res.failureCode}).` });
      });
      return [bar(`Asociar a ${BANKS[bank()].name}`, `${s.card.alias} · ···· ${last4(s.card.pan)}`, () => ctx.go("home")),
        bpa ? h("p", { class: "lead" }, "BPA asocia la tarjeta con su número; no pide coordenada.")
          : [h("p", { class: "lead" }, `Mira el reverso de tu ${MATRIX[bank()]} y escribe el valor de la coordenada `, h("b", { id: "add-cell" }, cell), "."), grid,
            h("div", { class: "field" }, h("label", { for: "add-coord" }, `Valor de ${cell}`), value)],
        bankReply(), err(), send, trusted()];
    },

    mitransfer: () => [bar("Tu Tarjeta Clásica", `${s.card.alias} · ···· ${last4(s.card.pan)}`, () => ctx.go("home")),
      h("p", { class: "lead" }, "La Clásica se opera desde MiTransfer, el monedero de Transfermóvil. Para asociarla, Ajé abre sesión en MiTransfer con tu clave."),
      h("p", { class: "lead" }, "¿Ya tienes clave de MiTransfer?"),
      h("button", { id: "mt-have-pin", class: "btn gold", onclick: async () => { await store.setBank("MITRANSFER", { registered: true }); go("login"); } }, "Sí, ya tengo clave"),
      h("button", { id: "mt-register", class: "btn ghost", onclick: () => go("mtregister") }, "No, quiero registrarme")],

    mtregister: () => {
      const ci = h("input", { id: "mt-ci", inputmode: "numeric", maxlength: "11", autocomplete: "off" });
      const pin = h("input", { id: "mt-pin", type: "password", inputmode: "numeric", maxlength: "4", autocomplete: "off" });
      const again = h("input", { id: "mt-pin2", type: "password", inputmode: "numeric", maxlength: "4", autocomplete: "off" });
      const send = h("button", { id: "mt-register-send", class: "btn gold" }, "Registrarme en MiTransfer");
      send.addEventListener("click", async () => {
        if (!/^[0-9]{11}$/.test(ci.value.trim())) return go("mtregister", { error: "El carné tiene 11 dígitos." });
        if (!/^[0-9]{4}$/.test(pin.value)) return go("mtregister", { error: "La clave tiene 4 dígitos." });
        if (pin.value !== again.value) return go("mtregister", { error: "Las dos claves no coinciden." });
        send.disabled = true;
        const res = await workflow.registerMiTransfer(ci.value.trim(), pin.value);
        pin.value = again.value = "";
        if (res.ok) return go("login", { reply: res.reply });
        go("mtregister", { reply: res.reply ?? null, error: res.reply ? null : `El teléfono no lo envió (código ${res.failureCode}).` });
      });
      return [bar("Registrarte en MiTransfer", `${s.card.alias} · ···· ${last4(s.card.pan)}`, () => go("mitransfer")),
        h("p", { class: "lead" }, "Elige una clave de 4 dígitos para MiTransfer. Con ella Ajé abrirá sesión cada vez que la Clásica lo pida."),
        h("div", { class: "field" }, h("label", { for: "mt-ci" }, "Carné de identidad"), ci),
        h("div", { class: "field" }, h("label", { for: "mt-pin" }, "Clave nueva (4 dígitos)"), pin),
        h("div", { class: "field" }, h("label", { for: "mt-pin2" }, "Repite la clave"), again),
        h("p", { class: "hint" }, "Ajé no guarda estos datos: van solo en el código que marca."),
        bankReply(), err(), send];
    },

    associate: () => {
      const auth = h("input", { id: "add-auth", inputmode: "numeric", maxlength: "6", autocomplete: "off" });
      const term = h("input", { id: "add-terminal", inputmode: "numeric", maxlength: "8", autocomplete: "off" });
      const send = h("button", { id: "add-associate", class: "btn gold" }, "Asociar tarjeta");
      send.addEventListener("click", async () => {
        if (!/^[0-9]{6}$/.test(auth.value.trim())) return go("associate", { error: "El número de autorización tiene 6 dígitos." });
        if (!/^[0-9]{8}$/.test(term.value.trim())) return go("associate", { error: "El identificador del terminal tiene 8 dígitos." });
        send.disabled = true;
        let res;
        try {
          res = await workflow.associateClasica(s.card.id, auth.value.trim(), term.value.trim());
        } catch (e) {
          return go("associate", { error: `No se pudo enviar: ${e.message}` });
        }
        if (res.ok) return go("done");
        if (res.needsLogin) return go("login", { reply: res.reply });
        go("associate", { reply: res.reply ?? null, error: res.reply ? null : `El teléfono no lo envió (código ${res.failureCode}).` });
      });
      return [bar("Asociar tu Tarjeta Clásica", `${s.card.alias} · ···· ${last4(s.card.pan)}`, () => ctx.go("home")),
        h("p", { class: "lead" }, "Haz una operación con la tarjeta en un cajero o un POS y guarda el ticket: trae el número de autorización y el identificador del terminal. No hay tarjeta de coordenadas."),
        h("div", { class: "field" }, h("label", { for: "add-auth" }, "Número de autorización (6 dígitos)"), auth),
        h("div", { class: "field" }, h("label", { for: "add-terminal" }, "Identificador del terminal (8 dígitos)"), term),
        h("p", { class: "hint" }, "Ajé no guarda estos datos: van solo en el código que marca."),
        bankReply(), err(), send];
    },

    done: () => [h("div", { class: "empty", id: "add-done" }, h("b", {}, "Tarjeta lista"), h("div", {}, `${s.card.alias} · ${BANKS[bank()].name} · ${s.card.currency}`)),
      h("button", { class: "btn gold", onclick: () => ctx.go("home") }, "Ver mis cuentas")],
  };

  function draw() {
    root.replaceChildren(...[screens[s.step]()].flat(3).filter(Boolean));
  }
  go(s.step);
  return root;
}
