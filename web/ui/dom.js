// A tiny element builder. Text children are always text nodes; only the icon constants
// below go through innerHTML, never data from the store or the bank.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function mount(el, node) {
  el.replaceChildren(node);
}

const PATHS = {
  card: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/>',
  send: '<path d="M21 4 3 11l6 2 2 6 10-15Z"/>',
  bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/>',
  plan: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
  home: '<path d="M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M12 8v4l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/>',
};

export function icon(name, cls = "") {
  const span = document.createElement("span");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`;
  if (cls) span.firstChild.setAttribute("class", cls);
  return span.firstChild;
}

/** Local date and time as the person reads it: "hoy 9:41", "ayer 18:05", or "3/10 9:41". */
export function when(ms, now = Date.now()) {
  const d = new Date(ms);
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x) => new Date(x).toDateString();
  if (day(ms) === day(now)) return `hoy ${time}`;
  if (day(ms) === day(now - 86_400_000)) return `ayer ${time}`;
  return `${d.getDate()}/${d.getMonth() + 1} ${time}`;
}
