// Home: the account deck (bank cards, then phone lines) and the front account's operations.
import { accounts } from "../core/accounts.js";
import { BANKS, MOBILE_PLANS } from "../core/money.js";
import { h, icon } from "./dom.js";

// The front account survives re-renders and screen changes.
let frontId = null;

const ACTIONS = {
  card: [
    ["balance", "Ver saldo", "card"],
    ["transfer", "Transferir", "send"],
    ["soon", "Pagar servicio", "bolt"],
    ["soon", "Cobrar o pagar con QR", "qr"],
  ],
  line: [
    ["mobile-balance", "Saldo móvil", "phone"],
    ["soon", "Recargar", "bolt"],
    ["soon", "Comprar plan", "plan"],
    ["soon", "Pasar saldo", "send"],
  ],
};
const CHIPS = { card: [["balance", "Saldo"], ["transfer", "Transferir"]], line: [["mobile-balance", "Saldo"]] };

function cardFace(a, ctx) {
  const kind = a.kind === "card" ? `Tarjeta · ${a.currency}` : `Línea · ${a.carrier || "Cubacel"}`;
  const no = a.kind === "card" ? BANKS[a.bank].name : `${a.plan === "POSPAGO" ? "Pospago" : "Prepago"} · ${MOBILE_PLANS[a.plan]}`;
  const tone = a.kind === "line" ? "line" : a.currency === "CUP" ? "cup" : "usd";
  return h("div", { class: `acct ${tone}`, "data-id": a.id },
    h("div", { class: "top" },
      h("div", {}, h("div", { class: "kind" }, kind), h("div", { class: "name" }, a.label)),
      h("div", { class: "acts" }, CHIPS[a.kind].map(([action, label]) =>
        h("button", { "data-action": action, onclick: () => ctx.act(action, a) }, label))),
    ),
    h("div", {},
      h("div", { class: `bal${a.balance ? "" : " none"}` }, a.balance ?? "—"),
      h("div", { class: "no" }, no),
    ),
  );
}

export function renderHome(ctx) {
  const list = accounts(ctx.store.state, ctx.sims);
  if (list.length === 0) return h("div", { class: "empty" }, "No hay cuentas: activa una moneda en Ajustes.");
  if (!list.some((a) => a.id === frontId)) frontId = list[0].id;

  const cards = list.map((a) => cardFace(a, ctx));
  const stack = h("div", { class: "stack", tabindex: "0", "aria-label": "Cuentas" }, cards);
  const dots = h("div", { class: "dots" }, list.map((a) =>
    h("button", { "data-go-acct": a.id, "aria-label": a.label, onclick: () => setFront(a.id) })));
  const qaLabel = h("div", { class: "section-label" });
  const qa = h("div", { class: "qa", id: "qa" });

  function place() {
    const i = list.findIndex((a) => a.id === frontId);
    list.forEach((a, k) => {
      const d = (k - i + list.length) % list.length;
      const el = cards[k];
      el.style.transform = `translate3d(0,${-d * 11}px,0) scale(${1 - d * 0.055})`;
      el.style.zIndex = String(10 - d);
      el.style.opacity = d < 4 ? "1" : "0";
      el.setAttribute("aria-hidden", d ? "true" : "false");
      el.inert = d !== 0;
    });
    [...dots.children].forEach((b, k) => b.classList.toggle("on", k === i));
    const a = list[i];
    qaLabel.textContent = `Operaciones · ${a.label}`;
    qa.replaceChildren(...ACTIONS[a.kind].map(([action, label, ic]) =>
      h("button", { class: action === "soon" ? "soon" : null, "data-qa": action, onclick: () => action !== "soon" && ctx.act(action, a) },
        icon(ic), h("span", {}, label))));
  }
  function setFront(id) {
    frontId = id;
    place();
  }
  const step = (by) => {
    const i = list.findIndex((a) => a.id === frontId);
    setFront(list[(i + by + list.length) % list.length].id);
  };

  // Swipe the front card left for the next account, right for the previous one.
  let drag = null;
  stack.addEventListener("pointerdown", (e) => {
    const el = cards[list.findIndex((a) => a.id === frontId)];
    if (e.button > 0 || e.target.closest("button") || !el.contains(e.target)) return;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, dx: 0, el, lock: null };
  });
  stack.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.lock) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      drag.lock = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (drag.lock === "x") {
        stack.setPointerCapture(e.pointerId);
        drag.el.classList.add("grabbing");
        drag.el.style.transition = "none";
      }
    }
    if (drag.lock !== "x") return;
    drag.dx = dx;
    drag.el.style.transform = `translate3d(${dx}px,0,0)`;
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    d.el.classList.remove("grabbing");
    d.el.style.transition = "";
    if (d.lock !== "x") return;
    const fast = Math.abs(d.dx) / Math.max(1, e.timeStamp - d.t0) > 0.5;
    if (Math.abs(d.dx) > stack.clientWidth * 0.3 || fast) step(d.dx < 0 ? 1 : -1);
    else place();
  };
  stack.addEventListener("pointerup", end);
  stack.addEventListener("pointercancel", end);
  stack.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") step(1);
    if (e.key === "ArrowLeft") step(-1);
  });

  place();
  return h("div", { id: "deck" },
    h("div", { class: "topbar" }, h("div", { class: "t" }, "Cuentas")),
    stack,
    h("div", { class: "stack-ctl" },
      h("button", { class: "sbtn", "aria-label": "Cuenta anterior", onclick: () => step(-1) }, "‹"),
      dots,
      h("button", { class: "sbtn", "aria-label": "Cuenta siguiente", onclick: () => step(1) }, "›"),
    ),
    qaLabel,
    qa,
  );
}
