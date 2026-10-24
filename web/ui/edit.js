// The sheet behind an account's "⋯": rename, make default, reorder or remove a card; rename, number,
// plan, make default or hide a line.
import { liveCards, simLabel } from "../core/accounts.js";
import { BANKS, last4 } from "../core/money.js";
import { h } from "./dom.js";
import { openSheet } from "./sheets.js";

function chips(options, isOn, pick, id) {
  return h("div", { class: "chips", id }, options.map(([value, label, disabled]) =>
    h("button", { class: isOn(value) ? "on" : null, disabled: disabled || null, "aria-pressed": isOn(value) ? "true" : "false", onclick: () => pick(value) }, label)));
}

function switchRow(id, on, title, text, flip) {
  return h("label", { class: "remember" },
    h("button", { id, class: `toggle${on ? " on" : ""}`, "aria-pressed": on ? "true" : "false", onclick: flip }),
    h("span", {}, h("b", {}, title), text));
}

export function editSheet(ctx, account) {
  return account.kind === "card" ? cardSheet(ctx, account.cardId) : lineSheet(ctx, account);
}

function cardSheet(ctx, cardId) {
  const { store } = ctx;
  const card = () => store.state.cards.find((c) => c.id === cardId);
  const s = { phase: "edit", alias: card().alias, billsTo: null, forget: true, pinSaved: false };
  const bank = BANKS[card().bank]?.name ?? card().bank;
  // A bank's saved PIN is only worth forgetting with its last card; the shell answers later.
  const lastOfBank = () => !liveCards(store.state).some((c) => c.id !== cardId && c.bank === card().bank);
  if (lastOfBank()) ctx.workflow.savedPin(card().bank).then((st) => { s.pinSaved = st.saved; sheet.redraw(); }).catch(() => {});

  function edit() {
    const live = liveCards(store.state).map((c) => c.id);
    const isDefault = store.state.settings.defaultCard === cardId;
    const i = live.indexOf(cardId);
    const alias = h("input", { id: "edit-alias", value: s.alias, autocomplete: "off", oninput: (e) => { s.alias = e.target.value; } });
    return [
      h("h3", {}, "Editar tarjeta"),
      h("div", { class: "lead" }, `${bank} · ${card().currency} · ···· ${last4(card().pan)}`),
      h("div", { class: "field" }, h("label", { for: "edit-alias" }, "Nombre"), alias),
      switchRow("edit-default", isDefault, "Tarjeta por defecto", "Sale primero en Inicio y viene elegida al transferir y al pagar.",
        () => store.update({ defaultCard: isDefault ? null : cardId })),
      live.length > 1 ? h("div", { class: "field" }, h("label", {}, isDefault ? "Orden · la de por defecto va primero" : "Orden en Inicio"),
        chips([[-1, "↑ Antes", isDefault || i <= (store.state.settings.defaultCard ? 1 : 0)], [1, "↓ Después", isDefault || i === live.length - 1]],
          () => false, (by) => store.moveCard(cardId, by), "edit-order")) : null,
      h("button", { id: "edit-save", class: "btn gold", onclick: async () => {
        await store.updateCard(cardId, { alias: s.alias.trim() || card().alias });
        sheet.close();
      } }, "Guardar"),
      h("button", { id: "edit-remove", class: "btn ghost", onclick: () => { s.phase = "remove"; sheet.redraw(); } }, "Eliminar tarjeta"),
    ];
  }

  function remove() {
    const bills = store.state.bills.filter((b) => b.cardId === cardId);
    const others = liveCards(store.state).filter((c) => c.id !== cardId && c.state === "linked" && c.bank !== "CLASICA");
    if (s.billsTo === null && others.length) s.billsTo = others[0].id;
    return [
      h("h3", {}, `¿Eliminar ${card().alias}?`),
      h("div", { class: "lead" }, "Sale de Inicio y de las listas. El historial la sigue nombrando, y si la vuelves a añadir vuelve como estaba."),
      bills.length ? h("div", { class: "field" },
        h("label", {}, bills.length === 1 ? `${bills[0].alias} pagará con` : `Sus ${bills.length} servicios pagarán con`),
        chips([...others.map((c) => [c.id, `${c.alias} · ···· ${last4(c.pan)}`]), ["none", "Ninguna por ahora"]],
          (v) => (s.billsTo ?? "none") === v, (v) => { s.billsTo = v === "none" ? "none" : v; sheet.redraw(); }, "edit-bills-to")) : null,
      s.pinSaved && lastOfBank() ? switchRow("edit-forget", s.forget, `Olvidar también la clave de ${bank}`, "No te queda otra tarjeta de este banco.",
        () => { s.forget = !s.forget; sheet.redraw(); }) : null,
      h("button", { id: "edit-remove-confirm", class: "btn clay", onclick: async () => {
        const forget = s.pinSaved && lastOfBank() && s.forget;
        await store.removeCard(cardId, { billsTo: s.billsTo === "none" ? null : s.billsTo });
        if (forget) await ctx.workflow.forgetPin(card().bank);
        sheet.close();
      } }, "Eliminar"),
      h("button", { class: "btn ghost", onclick: () => { s.phase = "edit"; sheet.redraw(); } }, "Cancelar"),
    ];
  }

  const sheet = openSheet(ctx, () => (s.phase === "edit" ? edit() : remove()));
  return sheet;
}

function lineSheet(ctx, account) {
  const { store } = ctx;
  const { subId } = account;
  const st = store.state.settings;
  const s = { alias: st.lines?.[subId]?.alias ?? "", number: st.lineNumbers[subId] ?? "" };

  const sheet = openSheet(ctx, () => {
    const isDefault = store.state.settings.subId === subId;
    const alias = h("input", { id: "edit-alias", value: s.alias, autocomplete: "off", placeholder: simLabel(account), oninput: (e) => { s.alias = e.target.value; } });
    const number = h("input", { id: "edit-number", value: s.number, inputmode: "numeric", autocomplete: "off", placeholder: "5XXXXXXX",
      oninput: (e) => { s.number = e.target.value; } });
    return [
      h("h3", {}, "Editar línea"),
      h("div", { class: "lead" }, simLabel(account)),
      h("div", { class: "field" }, h("label", { for: "edit-alias" }, "Nombre"), alias),
      h("div", { class: "field" }, h("label", { for: "edit-number" }, "Tu número"), number,
        h("div", { class: "hint" }, "El teléfono casi nunca lo sabe; Ajé lo usa para cobrar con QR.")),
      h("div", { class: "field" }, h("label", {}, "Plan"),
        chips([["PREPAGO", "Prepago · *222#"], ["POSPAGO", "Pospago · *111#"]], (v) => store.planFor(subId) === v, (v) => store.setPlan(subId, v), "edit-plan")),
      switchRow("edit-default", isDefault, "Línea por defecto", "La que Ajé usa con los bancos, y la primera de tus líneas en Inicio.",
        () => store.update({ subId: isDefault ? -1 : subId })),
      h("button", { id: "edit-save", class: "btn gold", onclick: async () => {
        await store.setLine(subId, { alias: s.alias.trim() });
        const n = s.number.replace(/\D/g, "");
        if (n !== (st.lineNumbers[subId] ?? "")) await store.setLineNumber(subId, n);
        sheet.close();
      } }, "Guardar"),
      h("button", { id: "edit-hide", class: "btn ghost", onclick: async () => {
        await store.setLine(subId, { hidden: true });
        sheet.close();
      } }, "Ocultar de Inicio"),
      h("div", { class: "hint" }, "Una línea oculta vuelve desde Ajustes."),
    ];
  });
  return sheet;
}
