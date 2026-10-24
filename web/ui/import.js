// Importing a Transfermóvil backup: how to export it, pick the .trm, tick the cards to add, keep
// the rest. The file is read here, on the phone; nothing of it is sent anywhere. Cards from a backup
// of this phone were linked to this line by the bank already: they come in linked, on trust, and the
// workflow sends one back to pending if the bank refuses its first balance query.
import { liveCards } from "../core/accounts.js";
import { readFile } from "../core/trm.js";
import { BANKS, last4 } from "../core/money.js";
import { h } from "./dom.js";

const ERRORS = {
  format: "Este archivo no es un respaldo de Transfermóvil.",
  hash: "El respaldo está dañado.",
  empty: "Este respaldo no trae nada que importar.",
  read: "No se pudo leer el archivo.",
};
const KEPT = [
  ["recipients", "Destinatarios"], ["bills", "Contratos de luz, agua, gas y teléfono"], ["onat", "ONAT"],
  ["phones", "Móviles"], ["landlines", "Fijos"], ["nauta", "Cuentas Nauta"],
];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function renderImport(ctx) {
  const { store, telemetry } = ctx;
  const root = h("div", { id: "import" });
  const s = { step: "intro", backup: null, ticked: new Set(), error: null, added: [], busy: false, reading: false, samePhone: true };
  const event = (fields) => telemetry.event("import", fields);

  const file = h("input", { type: "file", id: "import-file", class: "sr", tabindex: "-1", "aria-hidden": "true" });
  file.addEventListener("cancel", () => event({ ok: false, failure_code: "cancel" }));
  file.addEventListener("change", async () => {
    const f = file.files[0];
    file.value = "";
    if (!f || s.busy || s.reading) return;
    s.reading = true;
    draw();
    const { backup, code } = await readFile(f);
    s.reading = false;
    if (backup) {
      const have = new Set(liveCards(store.state).map((c) => c.pan));
      s.ticked = new Set(backup.cards.filter((c) => !c.reason && !have.has(c.pan)).map((c) => c.pan));
      Object.assign(s, { step: "review", backup, error: null });
    } else {
      event({ ok: false, failure_code: code });
      Object.assign(s, { step: "intro", error: ERRORS[code] });
    }
    draw();
  });

  async function save() {
    if (s.busy) return;
    s.busy = true;
    const b = s.backup;
    for (const c of b.cards.filter((x) => s.ticked.has(x.pan))) {
      try {
        const card = await store.addCard({ alias: c.alias, pan: c.pan, bank: c.bank, currency: c.currency });
        if (s.samePhone) {
          await store.updateCard(card.id, { state: c.bank === "CLASICA" ? "associated" : "linked", step: 5, unverified: true });
          await store.setBank(BANKS[c.bank].session ?? c.bank, { registered: true });
        }
        s.added.push(card);
      } catch {
        // Already in Ajé: added since the review was drawn.
      }
    }
    await store.saveImported(b);
    const kept = KEPT.reduce((n, [k]) => n + b[k].length, 0);
    event({ ok: true, cards: b.cards.length, added: s.added.length, kept });
    Object.assign(s, { step: "done", busy: false });
    draw();
  }

  const bar = () => h("div", { class: "sbar" },
    h("button", { class: "back", "aria-label": "Volver", onclick: () => history.back() }, "‹"),
    h("div", {}, h("h2", {}, "Importar de Transfermóvil"),
      h("div", { class: "sub" }, `Paso ${{ intro: 1, review: 2, done: 3 }[s.step]} de 3`)));

  const VIEWS = {
    intro: () => [
      h("ol", { class: "steps" },
        h("li", {}, "En Transfermóvil, abre \"Respaldo y Restauras de los datos\"."),
        h("li", {}, "Toca respaldar y guarda el archivo en Documentos."),
        h("li", {}, "Vuelve aquí y elige ese archivo.")),
      h("div", { class: "empty" }, "Ajé lee el archivo en este teléfono. No sale de aquí."),
      s.error ? h("div", { class: "err", id: "import-error" }, s.error) : null,
      h("button", { id: "import-pick", class: "btn gold", disabled: s.reading ? "" : null, onclick: () => file.click() }, s.reading ? "Leyendo…" : "Elegir el archivo"),
    ],
    review: () => {
      const b = s.backup;
      const have = new Set(liveCards(store.state).map((c) => c.pan));
      const n = s.ticked.size;
      const kept = KEPT.filter(([k]) => b[k].length);
      const row = (c) => {
        const can = !c.reason && !have.has(c.pan);
        const box = can ? h("input", { type: "checkbox", checked: s.ticked.has(c.pan) ? "" : null, "aria-label": c.alias }) : h("span", { class: "nobox" });
        if (can) box.addEventListener("change", () => { box.checked ? s.ticked.add(c.pan) : s.ticked.delete(c.pan); draw(); });
        const tag = can ? ["new", "nueva"] : have.has(c.pan) ? ["", "ya está en Ajé"] : ["bad", c.reason];
        return h("label", { class: "chk", "data-pan-last4": last4(c.pan) }, box,
          h("span", { class: "t" }, c.alias, h("small", {}, [BANKS[c.bank]?.name, c.currency, `····${last4(c.pan)}`].filter(Boolean).join(" · "))),
          h("span", { class: `tag ${tag[0]}` }, tag[1]));
      };
      return [
        b.exportedAt ? h("div", { class: "group" }, `Respaldo del ${b.exportedAt}`) : null,
        b.cards.length ? [h("div", { class: "group" }, "Tarjetas"), h("div", { id: "import-cards", class: "box" }, b.cards.map(row))] : null,
        kept.length ? [h("div", { class: "group" }, "Se guarda para más adelante"),
          h("div", { id: "import-kept", class: "box" }, kept.map(([k, label]) => h("div", { class: "kept" }, h("span", {}, label), h("b", {}, String(b[k].length)))))] : null,
        n ? h("label", { class: "chk same" },
          h("input", { type: "checkbox", id: "import-same-phone", checked: s.samePhone ? "" : null,
            onchange: (e) => { s.samePhone = e.target.checked; } }),
          h("span", { class: "t" }, "Este respaldo es de este teléfono",
            h("small", {}, "Sus tarjetas ya están asociadas a tu línea y entran listas para usar."))) : null,
        b.unreadable ? h("div", { class: "empty", id: "import-unreadable" },
          b.unreadable === 1 ? "1 fila no se pudo leer." : `${b.unreadable} filas no se pudieron leer.`) : null,
        h("button", { id: "import-go", class: "btn gold", disabled: n || kept.length ? null : "", onclick: save },
          n ? `Importar ${plural(n, "tarjeta", "tarjetas")}` : "Guardar"),
        h("button", { class: "btn ghost", onclick: () => file.click() }, "Elegir otro archivo"),
      ];
    },
    done: () => [
      h("div", { class: "reply", id: "import-done" }, h("div", { class: "m" },
        !s.added.length ? "Quedó guardado."
          : s.samePhone ? `${plural(s.added.length, "tarjeta lista", "tarjetas listas")} para usar. Si el banco no reconoce alguna en tu línea al consultar su saldo, Ajé te pedirá asociarla. Lo demás quedó guardado.`
          : `${plural(s.added.length, "tarjeta añadida", "tarjetas añadidas")}, pendientes de autenticar con su banco. Lo demás quedó guardado.`)),
      s.added.length && !s.samePhone ? h("button", { id: "import-first", class: "btn gold", onclick: () => ctx.go(`add/${s.added[0].id}`) }, `Autenticar ${s.added[0].alias}`) : null,
      h("button", { class: "btn ghost", onclick: () => ctx.go("home") }, "Ir a Inicio"),
    ],
  };

  function draw() {
    root.replaceChildren(bar(), file, ...VIEWS[s.step]().flat().filter(Boolean));
  }
  draw();
  return root;
}
