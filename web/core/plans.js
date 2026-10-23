// The *133 plan catalog. Android's USSD API cannot read Cubacel's plan menus (-1), but the dialer
// takes a plan's shortcut and lands on its confirm, where the person types 1. The catalog comes from
// a capture of the menu (tools/plan-catalog.py); aje.apiad.net serves the newest copy, and the app
// keeps the one it was built with for when that fails.
import { planPath } from "./lines.js";
import { dial } from "./ussd.js";

export const PLANS_URL = "https://aje.apiad.net/plans.json";

const PATH = /^\d{1,2}(\*\d{1,2}){0,5}$/;
const text = (s, max) => typeof s === "string" && s.length > 0 && s.length <= max;
const validPlan = (p) => p && typeof p.path === "string" && PATH.test(p.path) && text(p.name, 80) && Number.isFinite(p.price) && p.price > 0 &&
  p.price < 10000 && (p.ask === undefined || text(p.ask, 300));

/**
 * The catalog when every plan dials a short chain of digits under *133 and carries a name and a
 * price in range; null otherwise. A hosted copy decides what gets dialed, so nothing else passes.
 */
export function validCatalog(c) {
  const ok = c?.v === 1 && typeof c.captured === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.captured) && Array.isArray(c.groups) && c.groups.length > 0 && c.groups.every((g) =>
    text(g?.label, 40) && Array.isArray(g.plans) && g.plans.length > 0 && g.plans.every(validPlan));
  return ok ? c : null;
}

/** The stored hosted copy, unless the build bundles a later capture; on the same date the hosted copy wins. */
export const newestCatalog = (stored, bundled) => (stored && stored.captured >= bundled.captured ? stored : bundled);

export const findPlan = (catalog, path) => catalog.groups.flatMap((g) => g.plans).find((p) => p.path === path) ?? null;

/** `*133*1*4*1#`: the shortcut to the plan's confirm screen. */
export const planCode = (plan) => dial(planPath(plan.path.split("*")));

/** The hosted catalog, or null when it cannot be read or does not validate. */
export async function fetchCatalog({ fetch }) {
  try {
    const res = await fetch(PLANS_URL);
    return res.ok ? validCatalog(await res.json()) : null;
  } catch {
    return null;
  }
}
