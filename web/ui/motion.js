// Gesture followers from the design mockup: a critically damped (slightly overdamped)
// spring per property, integrated per frame, so a flung card keeps the finger's speed
// and settles without overshoot. With reduce-motion on, every change is instant.

const EPS = { x: 0.25, y: 0.25, s: 0.0006, r: 0.04, o: 0.004, sh: 0.004 };
export const FIRM = { k: 300, c: 40 };
export const FLY = { k: 160, c: 28 };
export const LAND = { k: 220, c: 34 };

const mq = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
export const reduced = () => Boolean(mq?.matches);

const bodies = new Set();
let raf = 0;
let last = 0;

/** A body animates `props` (name -> start value) and calls `apply(values)` each frame. */
export function body(props, apply) {
  const b = { p: {}, apply: () => apply(Object.fromEntries(Object.entries(b.p).map(([k, s]) => [k, s.x]))), step: null, dragging: false };
  for (const [k, v] of Object.entries(props)) b.p[k] = { x: v, v: 0, t: v, ...FIRM };
  return b;
}

export function kick(b) {
  bodies.add(b);
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }
}

/** Move toward `vals` with the spring `cfg`. */
export function set(b, vals, cfg) {
  for (const [k, v] of Object.entries(vals)) {
    const s = b.p[k];
    s.t = v;
    if (cfg) Object.assign(s, cfg);
    if (reduced()) { s.x = v; s.v = 0; }
  }
  b.apply();
  kick(b);
}

/** Jump to `vals` with no motion, as under a finger. */
export function hold(b, vals) {
  for (const [k, v] of Object.entries(vals)) Object.assign(b.p[k], { x: v, t: v, v: 0 });
  b.apply();
}

function tick(now) {
  const dt = Math.min((now - last) / 1000, 1 / 30);
  last = now;
  const n = Math.max(1, Math.round(dt * 240));
  const h = dt / n;
  for (const b of bodies) {
    let moving = false;
    for (const [key, s] of Object.entries(b.p)) {
      for (let i = 0; i < n; i++) {
        s.v += (-s.k * (s.x - s.t) - s.c * s.v) * h;
        s.x += s.v * h;
      }
      const e = EPS[key] ?? 0.01;
      if (Math.abs(s.x - s.t) < e && Math.abs(s.v) < e * 20) { s.x = s.t; s.v = 0; }
      if (s.x !== s.t || s.v !== 0) moving = true;
    }
    b.step?.();
    b.apply();
    if (!moving && !b.dragging) bodies.delete(b);
  }
  raf = bodies.size ? requestAnimationFrame(tick) : 0;
}
