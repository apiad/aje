// The shine layer: the foil sheen that follows the phone's tilt (or the pointer) across the cards,
// the glint when a card comes to the front or its balance changes, the balance counting up to its
// new figure, and the ripple under a pressed button. With reduce-motion on, none of it runs.
import { reduced } from "./motion.js";

const PRESSABLE = ".btn.gold,.btn.clay,.btn.river,.paybtn,.qa button,.nav .qrbtn,.chips button,.acct .acts button";

/** Sweeps a glint across `el` once. */
export function glint(el) {
  if (!el || reduced()) return;
  el.classList.remove("glint");
  void el.offsetWidth;
  el.classList.add("glint");
}

/** "1200.06 CUP" to 1200.06; null for anything else. */
const figure = (text) => {
  const m = /^(-?\d+(?:\.\d+)?)\s/.exec(text ?? "");
  return m ? Number(m[1]) : null;
};

/**
 * Counts `el`'s balance from `from` to `to` (both as "1200.06 CUP"), drawing each step with `draw`,
 * which turns such a text into the element's children. Any other text is drawn at once.
 */
export function roll(el, from, to, draw) {
  const [a, b] = [figure(from), figure(to)];
  const unit = to.replace(/^-?\d+(?:\.\d+)?/, "");
  if (a === null || b === null || reduced()) return;
  el.replaceChildren(...draw(from));
  const start = performance.now();
  const step = (now) => {
    const t = Math.min((now - start) / 900, 1);
    const v = a + (b - a) * (1 - (1 - t) ** 3);
    el.replaceChildren(...draw(`${v.toFixed(2)}${unit}`));
    if (t < 1 && el.isConnected) requestAnimationFrame(step);
    else el.replaceChildren(...draw(to));
  };
  requestAnimationFrame(step);
}

/** Starts the ripple on presses and the sheen that follows the tilt or the pointer. */
export function startShine(root = document) {
  root.addEventListener("pointerdown", (e) => {
    const b = e.target.closest?.(PRESSABLE);
    if (!b || b.disabled || reduced()) return;
    const r = b.getBoundingClientRect();
    const d = Math.max(r.width, r.height) * 2.2;
    const s = document.createElement("span");
    s.className = "ripple";
    s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    b.append(s);
    s.addEventListener("animationend", () => s.remove());
  }, true);

  const css = document.documentElement.style;
  let next = null;
  const sheen = (x, y) => {
    if (reduced()) return;
    if (!next) requestAnimationFrame(() => {
      css.setProperty("--sx", `${next[0].toFixed(1)}%`);
      css.setProperty("--sy", `${next[1].toFixed(1)}%`);
      next = null;
    });
    next = [x, y];
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  root.addEventListener("pointermove", (e) => {
    const card = e.target.closest?.(".acct");
    if (!card || e.pointerType === "touch") return;
    const r = card.getBoundingClientRect();
    sheen(((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100);
  });
  // Held upright, the phone's beta is about 45°; tilting moves the light across the foil.
  addEventListener("deviceorientation", (e) => {
    if (e.gamma === null || e.beta === null) return;
    sheen(50 + clamp(e.gamma, -30, 30) * (5 / 3), 50 + clamp(e.beta - 45, -30, 30) * (5 / 3));
  });
}
