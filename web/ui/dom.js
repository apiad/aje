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
  for (const c of children.flat(Infinity)) {
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
  drop: '<path d="M12 3c3.5 4.5 6 7.6 6 11a6 6 0 0 1-12 0c0-3.4 2.5-6.5 6-11z"/>',
  flame: '<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.2-4 2.5-5 .3 2 1.3 3 2.5 3 0-3 .5-5.5 0-8z"/>',
  wifi: '<path d="M3 9.5a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9 16.5a4 4 0 0 1 6 0"/><circle cx="12" cy="19.5" r="1"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/>',
  plan: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
  data: '<path d="M5 20v-3M10 20v-7M15 20V9M20 20V4"/>',
  voice: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1"/>',
  sms: '<path d="M4 5h16v11H9l-5 4z"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 13.3 7.6 4.4M15.8 6.3l-7.6 4.4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
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

/** How long ago, as the person says it: "hace unos minutos", "hace 3 h", "hace 2 días". */
export function ago(ms, now = Date.now()) {
  const hours = (now - ms) / 3_600_000;
  if (hours < 1) return "hace unos minutos";
  if (hours < 24) return `hace ${Math.floor(hours)} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "hace 1 día" : `hace ${days} días`;
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
