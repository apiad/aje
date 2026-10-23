// The inbox: every notice of money or balance that came in, the newest first, Pendientes over Vistos.
// "Ver" opens the history row and marks the notice seen; "Descartar" clears it without opening.
// Names come from the phone's contacts, one lookup for the numbers on screen; the permission is
// asked the first time a money notice shows, since the shell's SMS receiver cannot ask for it.
import { noticeText } from "../core/notice.js";
import { h, icon, when } from "./dom.js";

const MONEY = new Set(["card-received", "line-received"]);
const ICON = { "card-received": "card", "line-received": "phone", "recharge-intl": "phone", recharge: "phone", "plan-gift": "plan", "plan-expiry": "cal" };
/** Contact names already looked up, by number; null when the number is not in the contacts. */
const names = new Map();

export function renderInbox(ctx, r) {
  const inbox = ctx.store.state.inbox;

  const open = async (n, to) => {
    await ctx.workflow.openNotice(n.id);
    ctx.go(to);
  };
  const item = (n) => {
    const text = h("b", {}, noticeText(n, names.get(n.number) ?? null).text);
    const actions = [
      n.rowId !== null ? h("button", { class: "linkbtn", onclick: () => open(n, `history/${n.rowId}`) }, "Ver") : null,
      n.kind === "plan-expiry" ? h("button", { class: "linkbtn", onclick: () => open(n, "plans") }, "Comprar plan") : null,
      n.state === "pending" ? h("button", { class: "linkbtn dim", onclick: () => ctx.store.setNoticeState(n.id, "dismissed") }, "Descartar") : null,
    ];
    return h("div", { class: `notice${r.param === n.id ? " hl" : ""}`, "data-id": n.id, "data-state": n.state },
      icon(ICON[n.kind] ?? "sms", "ic"),
      h("div", { class: "tx" }, text, h("span", {}, when(n.at)), h("div", { class: "acts" }, actions)));
  };

  const pending = inbox.filter((n) => n.state === "pending");
  const rest = inbox.filter((n) => n.state !== "pending");
  const view = h("div", { id: "inbox" },
    h("div", { class: "sbar" },
      h("button", { class: "back", "aria-label": "Volver", onclick: () => ctx.go("home") }, "‹"),
      h("div", {}, h("h2", {}, "Avisos"), h("div", { class: "sub" }, pending.length ? `${pending.length} pendientes` : "Nada pendiente"))),
    inbox.length === 0 ? h("div", { class: "empty" }, "Aquí aparecerá el dinero y el saldo que te llegue.") : null,
    pending.length ? h("div", { id: "inbox-pending" }, h("div", { class: "group" }, "Pendientes"), pending.map(item)) : null,
    rest.length ? h("div", { id: "inbox-seen" }, h("div", { class: "group" }, "Vistos"), rest.map(item)) : null,
  );

  // The answer may land after a redraw, so it fills whichever notices are on screen then.
  lookUp(ctx, inbox, () => {
    for (const el of document.querySelectorAll("#inbox .notice")) {
      const n = ctx.store.state.inbox.find((x) => x.id === el.dataset.id);
      if (n) el.querySelector(".tx b").textContent = noticeText(n, names.get(n.number) ?? null).text;
    }
  });
  if (r.param) requestAnimationFrame(() => view.querySelector(".notice.hl")?.scrollIntoView({ block: "center" }));
  return view;
}

/** Looks up the names of the numbers not looked up yet, then calls `done`. */
function lookUp(ctx, inbox, done) {
  const numbers = [...new Set(inbox.map((n) => n.number).filter((x) => x && !names.has(x)))];
  if (!numbers.length || !ctx.bridge.contactNames) return;
  const ask = !ctx.store.state.settings.contactsAsked && inbox.some((n) => MONEY.has(n.kind));
  for (const x of numbers) names.set(x, null);
  ctx.bridge.contactNames(numbers, ask)
    .then((found) => {
      for (const [x, name] of Object.entries(found ?? {})) names.set(x, name);
      done();
    })
    // A shell without the lookup leaves the numbers; the next screen tries again.
    .catch(() => { for (const x of numbers) names.delete(x); });
  if (ask) ctx.store.update({ contactsAsked: true });
}
