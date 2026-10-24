// Importing a Transfermóvil backup: how to export it, pick the .trm, tick the cards to add, keep
// the rest. The file is read here, on the phone; nothing of it is sent anywhere.
import { BackupError, readBackup } from "../core/trm.js";
import { BANKS, last4 } from "../core/money.js";
import { h } from "./dom.js";

const ERRORS = {
  format: "Este archivo no es un respaldo de Transfermóvil.",
  hash: "El respaldo está dañado.",
  empty: "Este respaldo no trae nada que importar.",
};
const KEPT = [
  ["recipients", "Destinatarios"], ["bills", "Contratos de luz, agua, gas y teléfono"], ["onat", "ONAT"],
  ["phones", "Móviles"], ["landlines", "Fijos"], ["nauta", "Cuentas Nauta"],
];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function renderImport(ctx) {
  const { store, telemetry } = ctx;
  const root = h("div", { id: "import" });
  const s = { step: "intro", backup: null, ticked: new Set(), error: null, added: [], busy: false };
  const event = (fields) => telemetry.event("import", fields);

  const file = h("input", { type: "file", id: "import-file", class: "sr", tabindex: "-1", "aria-hidden": "true" });
  file.addEventListener("cancel", () => event({ ok: false, failure_code: "cancel" }));
  file.addEventListener("change", async () => {
    const f = file.files[0];
    file.value = "";
    if (!f) return;
    try {
      s.backup = await readBackup(await f.text());
      const have = new Set(store.state.cards.map((c) => c.pan));
      s.ticked = new Set(s.backup.cards.filter((c) => !c.reason && !have.has(c.pan)).map((c) => c.pan));
      Object.assign(s, { step: "review", error: null });
    } catch (e) {
      if (!(e instanceof BackupError)) throw e;
      event({ ok: false, failure_code: e.code });
      Object.assign(s, { step: "intro", error: ERRORS[e.code] });
    }
    draw();
  });

  async function save() {
    if (s.busy) return;
    s.busy = true;
    const b = s.backup;
    for (const c of b.cards.filter((x) => s.ticked.has(x.pan))) {
      try {
        s.added.push(await store.addCard({ alias: c.alias, pan: c.pan, bank: c.bank, currency: c.currency }));
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
      h("button", { id: "import-pick", class: "btn gold", onclick: () => file.click() }, "Elegir el archivo"),
    ],
    review: () => {
      const b = s.backup;
      const have = new Set(store.state.cards.map((c) => c.pan));
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
        h("button", { id: "import-go", class: "btn gold", disabled: n || kept.length ? null : "", onclick: save },
          n ? `Importar ${plural(n, "tarjeta", "tarjetas")}` : "Guardar"),
        h("button", { class: "btn ghost", onclick: () => file.click() }, "Elegir otro archivo"),
      ];
    },
    done: () => [
      h("div", { class: "reply", id: "import-done" }, h("div", { class: "m" },
        s.added.length ? `${plural(s.added.length, "tarjeta añadida", "tarjetas añadidas")}, pendientes de autenticar con su banco. Lo demás quedó guardado.` : "Quedó guardado.")),
      s.added.length ? h("button", { id: "import-first", class: "btn gold", onclick: () => ctx.go(`add/${s.added[0].id}`) }, `Autenticar ${s.added[0].alias}`) : null,
      h("button", { class: "btn ghost", onclick: () => ctx.go("home") }, "Ir a Inicio"),
    ],
  };

  function draw() {
    root.replaceChildren(bar(), file, ...VIEWS[s.step]().flat().filter(Boolean));
  }
  draw();
  return root;
}
