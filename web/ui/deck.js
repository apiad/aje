// Home: the account deck (bank cards, then phone lines) and the front account's operations.
import { accounts } from "../core/accounts.js";
import { BANKS, MOBILE_PLANS, last4 } from "../core/money.js";
import { h, icon } from "./dom.js";
import { body, FIRM, FLY, hold, kick, LAND, reduced, set } from "./motion.js";
import { row } from "./history.js";
import { updateBanner } from "./updates.js";

// The front account survives re-renders and screen changes.
let frontId = null;

const ACTIONS = {
  card: [
    ["balance", "Ver saldo", "card"],
    ["transfer", "Transferir", "send"],
    ["soon", "Pagar servicio", "bolt"],
    ["soon", "Cobrar o pagar con QR", "qr"],
  ],
  clasica: [
    ["balance", "Ver saldo", "card"],
    ["movements", "Últimas operaciones", "history"],
    ["transfer", "Transferir", "send"],
    ["soon", "Pagar servicio", "bolt"],
  ],
  line: [
    ["mobile-balance", "Saldo móvil", "phone"],
    ["soon", "Recargar", "bolt"],
    ["plans", "Comprar plan", "plan"],
    ["line-transfer", "Pasar saldo", "send"],
    ["line-charge", "Cobrar", "qr"],
  ],
};
const CHIPS = { card: [["balance", "Saldo"], ["transfer", "Transferir"]], pending: [["resume", "Continuar"]], line: [["mobile-balance", "Saldo"]] };

/** "1200.06 CUP" as the card shows it: "1 200,06" with the currency small after it. */
export function amount(text) {
  const m = /^(-?)([0-9]+)(?:\.([0-9]+))?\s*(.*)$/.exec(text);
  if (!m) return [text];
  const whole = m[2].replace(/\B(?=([0-9]{3})+$)/g, "\u202f");
  return [`${m[1]}${whole}${m[3] ? `,${m[3]}` : ""}`, h("small", {}, ` ${m[4]}`)];
}

// "3.20 GB" -> "3,2 GB", "180.00 CUP" -> "180 CUP"; whole numbers are left alone.
const short = (n) => n.replace(/^(\d+)[.,](\d*?)0*( .*)$/, (_, i, f, u) => `${i}${f ? `,${f}` : ""}${u}`);
const minutes = (hms) => {
  const [hh, mm] = hms.split(":").map(Number);
  return hh ? `${hh} h${mm ? ` ${mm} min` : ""}` : `${mm} min`;
};
const day = (dmy) => dmy.split("-").slice(0, 2).map(Number).join("/");

/** A line's figures as icons: data, voice, SMS and the date the balance expires. */
function stats(d) {
  const items = [
    d.data && ["data", short(d.data)],
    // Postpaid has no "Saldo": its voice balance is the card's big figure, so it is not repeated here.
    d.voice && d.voice.includes(":") && ["voice", minutes(d.voice)],
    d.sms && ["sms", d.sms.includes("CUP") ? short(d.sms) : d.sms],
    d.expires && ["cal", day(d.expires)],
  ].filter(Boolean);
  return h("div", { class: "stats" }, items.map(([ic, text]) => h("span", { "data-stat": ic }, icon(ic), text)));
}

function cardFace(a, ctx) {
  const kind = a.kind === "card" ? `Tarjeta · ${a.currency ?? "—"}${a.pending ? " · pendiente" : ""}` : `Línea · ${a.carrier || "Cubacel"}`;
  const no = a.kind === "card" ? `${BANKS[a.bank]?.name ?? "Cuenta"} · ···· ${last4(a.pan)}` : `${a.plan === "POSPAGO" ? "Pospago" : "Prepago"} · ${MOBILE_PLANS[a.plan]}`;
  const tone = a.kind === "line" ? "line" : a.currency === "USD" ? "usd" : "cup";
  const chips = a.pending ? CHIPS.pending : CHIPS[a.kind];
  return h("div", { class: `acct ${tone}`, "data-id": a.id },
    h("div", { class: "top" },
      h("div", {}, h("div", { class: "kind" }, kind), h("div", { class: "name" }, a.label)),
      h("div", { class: "acts" }, chips.map(([action, label]) =>
        h("button", { "data-action": action, onclick: () => ctx.act(action, a) }, label))),
    ),
    h("div", {},
      a.balance ? h("div", { class: "bal" }, ...amount(a.balance))
        : h("div", { class: "bal none" }, a.pending ? "Falta asociarla con el banco" : "Toca Saldo para consultarlo"),
      a.kind === "line" && a.details ? stats(a.details) : h("div", { class: "no" }, no),
    ),
  );
}

/** The inbox's bell, with the number of pending notices; no count at zero. */
function bell(ctx) {
  const n = ctx.store.pendingNotices();
  return h("button", { id: "bell", class: "bell", "aria-label": n ? `Avisos, ${n} pendientes` : "Avisos", onclick: () => ctx.go("inbox") },
    icon("bell"), n ? h("span", { class: "count" }, String(n)) : null);
}

export function renderHome(ctx) {
  const list = accounts(ctx.store.state, ctx.sims);
  const add = h("div", { class: "addrow" },
    h("button", { id: "add-card", class: "addchip", onclick: () => ctx.go("add") }, "＋ Añadir tarjeta"),
    h("button", { id: "import-tm", class: "addchip", onclick: () => ctx.go("import") }, "Importar de Transfermóvil"));
  if (list.length === 0) return h("div", { id: "deck" }, updateBanner(ctx), h("div", { class: "topbar" }, h("div", { class: "t" }, "Cuentas"), bell(ctx)),
    h("div", { class: "empty" }, "Aún no hay tarjetas. Añade la primera con una foto."), add);
  if (!list.some((a) => a.id === frontId)) frontId = list[0].id;

  const cards = list.map((a) => cardFace(a, ctx));
  const stack = h("div", { class: "stack", tabindex: "0", "aria-label": "Cuentas" }, cards);
  const dots = h("div", { class: "dots" }, list.map((a) =>
    h("button", { "data-go-acct": a.id, "aria-label": a.label, onclick: () => setFront(a.id) })));
  const qaLabel = h("div", { class: "section-label" });
  const qa = h("div", { class: "qa", id: "qa" });
  const recent = h("div", { id: "recent" });

  const n = list.length;
  const at = () => list.findIndex((a) => a.id === frontId);
  const depth = (k) => (k - at() + n) % n;
  const rest = (d) => ({ x: 0, y: -d * 11, s: 1 - d * 0.055, r: 0, o: d < 4 ? 1 : 0, sh: Math.min(d * 0.2, 0.6) });
  const bodies = cards.map((el) => {
    const shade = h("span", { class: "shade" });
    el.append(shade);
    return body({ x: 0, y: 0, s: 1, r: 0, o: 1, sh: 0 }, (p) => {
      el.style.transform = `translate3d(${p.x.toFixed(2)}px,${p.y.toFixed(2)}px,0) rotate(${p.r.toFixed(3)}deg) scale(${p.s.toFixed(4)})`;
      el.style.opacity = String(p.o);
      shade.style.opacity = String(p.sh);
    });
  });

  // Every card but `skip` settles at its depth.
  function layout(skip, cfg = FIRM) {
    cards.forEach((el, k) => {
      if (k === skip) return;
      bodies[k].step = null;
      el.style.zIndex = String(10 - depth(k));
      set(bodies[k], rest(depth(k)), cfg);
    });
  }
  function front() {
    const i = at();
    cards.forEach((el, k) => {
      el.setAttribute("aria-hidden", k === i ? "false" : "true");
      el.inert = k !== i;
    });
    [...dots.children].forEach((b, k) => b.classList.toggle("on", k === i));
    const a = list[i];
    qaLabel.textContent = `Operaciones · ${a.label}`;
    const actions = a.kind === "card" && a.bank === "CLASICA" ? ACTIONS.clasica : ACTIONS[a.kind];
    qa.replaceChildren(...actions.map(([action, label, ic]) =>
      h("button", { class: action === "soon" ? "soon" : null, "data-qa": action, onclick: () => action !== "soon" && ctx.act(action, a) },
        icon(ic), h("span", {}, label))));
    const mine = a.kind === "card" ? ctx.store.state.attempts.filter((x) => x.cardId === a.cardId).slice(0, 3) : [];
    recent.replaceChildren(...(mine.length ? [
      h("div", { class: "section-label" }, "Actividad reciente", h("a", { onclick: () => ctx.go("history") }, "Ver todo")),
      ...mine.map((x) => row(ctx, x)),
    ] : []));
  }

  // The front card rises, flies out left and tucks under the deck halfway through the flight.
  function sendToBack(vx) {
    if (n < 2) return layout();
    const k = at();
    frontId = list[(k + 1) % n].id;
    const c = bodies[k];
    const el = cards[k];
    if (reduced()) { layout(); return front(); }
    const w = stack.clientWidth || 300;
    el.style.zIndex = "20";
    if (vx) c.p.x.v = vx;
    set(c, { x: -w * 0.95, y: -14, s: 1, r: 0, o: 1, sh: 0 }, FLY);
    c.step = () => {
      if (c.p.x.x < -w * 0.48) { c.step = null; el.style.zIndex = String(10 - (n - 1)); set(c, rest(n - 1), LAND); }
    };
    layout(k);
    front();
  }
  // The mirror of sendToBack: the bottom card slides out left from under the deck, then lands on top.
  function bringFromBack(vx, onTop = false) {
    if (n < 2) return layout();
    const k = (at() - 1 + n) % n;
    frontId = list[k].id;
    const c = bodies[k];
    const el = cards[k];
    if (reduced()) { layout(); return front(); }
    const w = stack.clientWidth || 300;
    if (onTop) {
      el.style.zIndex = "20";
      if (vx) c.p.x.v = vx;
      set(c, rest(0), LAND);
    } else {
      el.style.zIndex = "0";
      set(c, { x: -w * 0.95, y: -14, s: 1, r: 0, o: 1, sh: 0 }, FLY);
      c.step = () => {
        if (c.p.x.x < -w * 0.48) { c.step = null; el.style.zIndex = "20"; set(c, rest(0), LAND); }
      };
    }
    layout(k);
    front();
  }
  const step = (by) => (by > 0 ? sendToBack(-900) : bringFromBack(900));
  function setFront(id) {
    const d = depth(list.findIndex((a) => a.id === id));
    if (d === 0) return;
    const forward = d <= n / 2;
    for (let j = 0; j < (forward ? d : n - d); j++) setTimeout(() => step(forward ? 1 : -1), j * 110);
  }

  // Drag left pulls the front card off; drag right pulls the bottom card out from underneath.
  let drag = null;
  stack.addEventListener("pointerdown", (e) => {
    const k = at();
    if (e.button > 0 || e.target.closest("button") || !cards[k].contains(e.target)) return;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, k, inc: null, lock: null, samples: [[e.timeStamp, e.clientX]] };
  });
  stack.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    const c = bodies[drag.k];
    const w = stack.clientWidth || 300;
    if (!drag.lock) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      drag.lock = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (drag.lock === "x") {
        stack.setPointerCapture(e.pointerId);
        cards[drag.k].classList.add("grabbing");
        c.dragging = true;
        c.step = null;
        cards[drag.k].style.zIndex = "20";
        kick(c);
      }
    }
    if (drag.lock !== "x" || n < 2) return;
    e.preventDefault();
    drag.dx = dx;
    drag.samples.push([e.timeStamp, e.clientX]);
    while (drag.samples.length > 2 && e.timeStamp - drag.samples[0][0] > 90) drag.samples.shift();
    const next = bodies[(drag.k + 1) % n];
    const [a, b] = [rest(1), rest(0)];
    if (dx <= 0) {
      if (drag.inc !== null) {
        const ic = bodies[drag.inc];
        ic.dragging = false;
        cards[drag.inc].style.zIndex = String(10 - (n - 1));
        set(ic, rest(n - 1));
        drag.inc = null;
      }
      hold(c, { x: dx, y: -Math.min(-dx * 0.05, 10), r: 0, s: 1, sh: 0 });
      const p = Math.min(-dx / (w * 0.6), 1);
      set(next, { y: a.y + (b.y - a.y) * p, s: a.s + (b.s - a.s) * p, sh: a.sh * (1 - p) });
    } else {
      set(next, rest(1));
      if (drag.inc === null) {
        drag.inc = (drag.k - 1 + n) % n;
        const ic = bodies[drag.inc];
        ic.dragging = true;
        ic.step = null;
        cards[drag.inc].style.zIndex = "0";
        kick(ic);
      }
      const q = Math.min(dx / (w * 0.5), 1);
      const z = rest(n - 1);
      const out = Math.min(q / 0.5, 1);
      drag.incTop = q >= 0.5;
      cards[drag.inc].style.zIndex = drag.incTop ? "20" : "0";
      const x = drag.incTop ? -w * 0.95 * (1 - (q - 0.5) / 0.5) : -w * 0.95 * out;
      hold(c, { x: 0, r: 0, y: 0, s: 1 });
      hold(bodies[drag.inc], { x, y: z.y + (-14 - z.y) * out, s: z.s + (1 - z.s) * out, r: 0, sh: z.sh * (1 - out), o: 1 });
    }
  });
  const end = (e, cancel) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    cards[d.k].classList.remove("grabbing");
    bodies[d.k].dragging = false;
    if (d.inc !== null) bodies[d.inc].dragging = false;
    if (d.lock !== "x") return;
    const [f, l] = [d.samples[0], d.samples[d.samples.length - 1]];
    const vx = l[0] > f[0] ? ((l[1] - f[1]) / (l[0] - f[0])) * 1000 : 0;
    const w = stack.clientWidth || 300;
    if (!cancel && d.dx < 0 && (d.dx < -w * 0.3 || vx < -500)) sendToBack(Math.min(vx, 0));
    else if (!cancel && d.dx > 0 && (d.dx > w * 0.3 || vx > 500)) bringFromBack(Math.max(vx, 0), d.incTop);
    else layout();
  };
  stack.addEventListener("pointerup", (e) => end(e, false));
  stack.addEventListener("pointercancel", (e) => end(e, true));
  stack.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") step(1);
    if (e.key === "ArrowLeft") step(-1);
  });

  cards.forEach((el, k) => { el.style.zIndex = String(10 - depth(k)); hold(bodies[k], rest(depth(k))); });
  front();
  return h("div", { id: "deck" },
    updateBanner(ctx),
    h("div", { class: "topbar" }, h("div", { class: "t" }, "Cuentas"), bell(ctx)),
    stack,
    h("div", { class: "stack-ctl" },
      h("button", { class: "sbtn", "aria-label": "Cuenta anterior", onclick: () => step(-1) }, "‹"),
      dots,
      h("button", { class: "sbtn", "aria-label": "Cuenta siguiente", onclick: () => step(1) }, "›"),
    ),
    add,
    qaLabel,
    qa,
    recent,
  );
}
