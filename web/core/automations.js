// Automation rules: when each one is due, and whether a payment fits its limits. Pure, with no I/O;
// web/core/autorun.js runs a rule, and jobs.js wakes Ajé for it.
//
// A rule pays a saved bill once a month, inside a window of days: {id, type: "bill", billId,
// window: {from, to}, maxCents, minLeftCents, on, cycle, last}. `cycle` is this month's attempt,
// {month, state: "open" | "done" | "stopped", reason, paidCents, currency}; `last` the last run,
// {at, outcome, failsToday}, `outcome` a notice kind below or "no-debt".
import { MAX_FAILS, RETRY_MS } from "./jobs.js";

/** A rule runs at 9:00 on each day of its window until the month's bill is paid. */
export const PAY_HOUR = 9;
const SEARCH_DAYS = 70;

const pad = (n) => String(n).padStart(2, "0");
const dayOf = (t) => new Date(t).toDateString();

/** "YYYY-MM", in local time. */
export function monthOf(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

// The window's first and last day in a month; a day past the month's end means its last day.
function windowDays(rule, year, month) {
  const last = new Date(year, month + 1, 0).getDate();
  return [Math.min(rule.window.from, last), Math.min(rule.window.to, last)];
}

export function inWindow(rule, t) {
  const d = new Date(t);
  const [from, to] = windowDays(rule, d.getFullYear(), d.getMonth());
  return d.getDate() >= from && d.getDate() <= to;
}

// The first moment after the window of "YYYY-MM": midnight after its last day.
function windowEnd(rule, month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, windowDays(rule, y, m - 1)[1] + 1).getTime();
}

/** The rule's cycle is still open and the window of its month has ended. */
export function windowClosed(rule, now) {
  return rule.cycle?.state === "open" && now >= windowEnd(rule, rule.cycle.month);
}

/**
 * When the rule is due next, or null when it is off: now if its open cycle's window has ended (to close
 * it); an hour after a transient failure while it has retries left today; else the next day of a window
 * at 9:00 (now, if today's 9:00 passed in the window and today has no run), skipping this month once
 * its cycle is done or stopped, and never past the end of an open cycle's window.
 */
export function nextAt(rule, now) {
  if (!rule.on) return null;
  if (windowClosed(rule, now)) return now;
  const { last, cycle } = rule;
  const ranToday = last && dayOf(last.at) === dayOf(now);
  if (ranToday && last.outcome === "failed" && last.failsToday < MAX_FAILS) return last.at + RETRY_MS;
  const d = new Date(now);
  const closed = cycle && cycle.month === monthOf(now) && cycle.state !== "open";
  const start = closed ? new Date(d.getFullYear(), d.getMonth() + 1, 1) : new Date(d.getFullYear(), d.getMonth(), d.getDate());
  let slot = null;
  for (let add = 0; add < SEARCH_DAYS && slot === null; add++) {
    const t = new Date(start.getFullYear(), start.getMonth(), start.getDate() + add, PAY_HOUR).getTime();
    if (!inWindow(rule, t)) continue;
    if (dayOf(t) !== dayOf(now)) slot = t;
    else if (!ranToday) slot = Math.max(now, t);
  }
  return cycle?.state === "open" ? Math.min(slot ?? Infinity, windowEnd(rule, cycle.month)) : slot;
}

/** Whether paying `amountCents` fits the rule's maximum, the monthly cap and the minimum to leave, in that order. */
export function checkLimits({ amountCents, balanceCents, rule, spentCents, capCents }) {
  if (amountCents > rule.maxCents) return { ok: false, reason: "max" };
  if (spentCents + amountCents > capCents) return { ok: false, reason: "cap" };
  if (balanceCents - amountCents < rule.minLeftCents) return { ok: false, reason: "min" };
  return { ok: true };
}

/** What the rules paid in the month of `now` from accounts in `currency`, in cents. */
export function spentThisMonth(state, now, currency) {
  const month = monthOf(now);
  return state.automations
    .filter((r) => r.cycle?.month === month && r.cycle.currency === currency)
    .reduce((sum, r) => sum + (r.cycle.paidCents ?? 0), 0);
}

const NOTICES = {
  paid: ["Pagaste {name}: {amount}", "De la tarjeta {card}. Quedan {left}."],
  unverified: ["Pagué {name}: {amount}, sin confirmar", "El banco no mandó el SMS. Revisa el Historial antes de pagar otra vez."],
  max: ["No pagué {name}", "La factura es de {amount} y tu límite es {max}. No vuelvo a intentarlo este mes."],
  min: ["No pagué {name}", "Pagar {amount} dejaría {left} en la tarjeta, menos del mínimo de {min}. No vuelvo a intentarlo este mes."],
  cap: ["No pagué {name}", "Las automatizaciones ya movieron {spent} este mes y el tope es {cap}."],
  unknown: ["No pagué {name}", "El banco dice que hay deuda pero no cuánto. Págala desde Servicios."],
  menu: ["Toca para pagar {name}", "El banco pide confirmar en un menú: {amount}."],
  failed: ["No pude pagar {name} hoy", "El banco no respondió. Lo intento mañana."],
  missed: ["No pagué {name} este mes", "Se cerró la ventana sin poder pagar."],
  stopped: ["Las automatizaciones están detenidas", "La clave guardada ya no sirve. Actívalas de nuevo en Ajustes."],
};

/** The notice of an outcome; `v` holds {name, amount, max, left, min, spent, cap, card} as formatted strings. */
export function noticeOf(kind, v) {
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");
  const [title, text] = NOTICES[kind];
  return { title: fill(title), text: fill(text) };
}
