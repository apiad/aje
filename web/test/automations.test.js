import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLimits, inWindow, monthOf, nextAt, noticeOf, PAY_HOUR, spentThisMonth, windowClosed } from "../core/automations.js";

// Local times, as the phone keeps them: `m` is the month index, 9 for October 2026.
const at = (m, day, h, min = 0) => new Date(2026, m, day, h, min).getTime();
const rule = (p = {}) => ({ id: "r1", type: "bill", billId: "b1", window: { from: 5, to: 10 }, maxCents: 80000, minLeftCents: 200000, on: true, cycle: null, last: null, ...p });

test("before the window, due on its first day at 9:00", () => assert.equal(nextAt(rule(), at(9, 2, 12)), at(9, 5, 9)));
test("inside the window after 9:00 with no run today, due now", () => assert.equal(nextAt(rule(), at(9, 6, 15)), at(9, 6, 15)));
test("inside the window before 9:00, due at 9:00", () => assert.equal(nextAt(rule(), at(9, 6, 7)), at(9, 6, PAY_HOUR)));
test("a rule that is off is never due", () => assert.equal(nextAt(rule({ on: false }), at(9, 6, 15)), null));
test("a done cycle waits for next month's window", () => assert.equal(nextAt(rule({ cycle: { month: "2026-10", state: "done" } }), at(9, 6, 15)), at(10, 5, 9)));
test("a transient failure retries an hour later, three times a day", () => {
  assert.equal(nextAt(rule({ last: { at: at(9, 6, 9), outcome: "failed", failsToday: 1 } }), at(9, 6, 9, 5)), at(9, 6, 10));
  assert.equal(nextAt(rule({ last: { at: at(9, 6, 11), outcome: "failed", failsToday: 3 } }), at(9, 6, 11, 5)), at(9, 7, 9));
});
test("no debt today: due again tomorrow at 9:00", () =>
  assert.equal(nextAt(rule({ cycle: { month: "2026-10", state: "open" }, last: { at: at(9, 6, 9), outcome: "no-debt", failsToday: 0 } }), at(9, 6, 9, 1)), at(9, 7, 9)));
test("an open cycle is due once its window ends, to close it", () => {
  const open = rule({ cycle: { month: "2026-10", state: "open" }, last: { at: at(9, 10, 9), outcome: "no-debt", failsToday: 0 } });
  assert.equal(nextAt(open, at(9, 10, 9, 1)), at(9, 11, 0));
  assert.equal(windowClosed(open, at(9, 10, 20)), false);
  assert.equal(windowClosed(open, at(9, 11, 7)), true);
  assert.equal(nextAt(open, at(9, 11, 7)), at(9, 11, 7));
  assert.equal(windowClosed(rule({ cycle: { month: "2026-10", state: "done" } }), at(9, 11, 7)), false);
});
test("after the window, with no cycle, due next month", () => assert.equal(nextAt(rule(), at(9, 20, 12)), at(10, 5, 9)));
test("a window to day 31 ends on February's last day", () => {
  assert.equal(inWindow(rule({ window: { from: 25, to: 31 } }), at(1, 28, 10)), true);
  assert.equal(nextAt(rule({ window: { from: 25, to: 31 }, cycle: { month: "2026-02", state: "open" } }), at(1, 28, 10)), at(1, 28, 10));
});
test("a window across the end of the month is cut at the month's last day", () => assert.equal(inWindow(rule({ window: { from: 28, to: 31 } }), at(10, 30, 10)), true));
test("monthOf is local", () => assert.equal(monthOf(at(9, 31, 23)), "2026-10"));
test("limits: max, then cap, then min", () => {
  const r = rule();
  assert.deepEqual(checkLimits({ amountCents: 90000, balanceCents: 1e7, rule: r, spentCents: 0, capCents: 1e6 }), { ok: false, reason: "max" });
  assert.deepEqual(checkLimits({ amountCents: 50000, balanceCents: 1e7, rule: r, spentCents: 960000, capCents: 1e6 }), { ok: false, reason: "cap" });
  assert.deepEqual(checkLimits({ amountCents: 50000, balanceCents: 240000, rule: r, spentCents: 0, capCents: 1e6 }), { ok: false, reason: "min" });
  assert.deepEqual(checkLimits({ amountCents: 34000, balanceCents: 600000, rule: r, spentCents: 0, capCents: 1e6 }), { ok: true });
});
test("spent this month sums the paid cycles of this month in one currency", () => {
  const state = { automations: [
    rule({ cycle: { month: "2026-10", state: "done", paidCents: 34000, currency: "CUP" } }),
    rule({ id: "r2", cycle: { month: "2026-10", state: "open", paidCents: 1000, currency: "CUP" } }),
    rule({ id: "r3", cycle: { month: "2026-09", state: "done", paidCents: 5000, currency: "CUP" } }),
    rule({ id: "r4", cycle: { month: "2026-10", state: "done", paidCents: 7000, currency: "MLC" } }),
    rule({ id: "r5" }),
  ] };
  assert.equal(spentThisMonth(state, at(9, 20, 12), "CUP"), 35000);
});
test("the notice copy", () => assert.deepEqual(noticeOf("max", { name: "Agua · Casa", amount: "900.00 CUP", max: "500.00 CUP" }),
  { title: "No pagué Agua · Casa", text: "La factura es de 900.00 CUP y tu límite es 500.00 CUP. No vuelvo a intentarlo este mes." }));
test("every notice kind has its copy", () => {
  for (const kind of ["paid", "unverified", "max", "min", "cap", "unknown", "menu", "failed", "missed", "stopped"]) {
    const n = noticeOf(kind, { name: "N", amount: "1.00 CUP", max: "2.00 CUP", left: "3.00 CUP", min: "4.00 CUP", spent: "5.00 CUP", cap: "6.00 CUP", card: "Ahorro" });
    assert.ok(n.title && n.text && !/[{}]/.test(n.title + n.text), kind);
  }
});
test("a failure today does not retry a cycle that closed this month", () =>
  assert.equal(nextAt(rule({ cycle: { month: "2026-10", state: "done" }, last: { at: at(9, 6, 10), outcome: "failed", failsToday: 2 } }), at(9, 6, 10, 5)), at(10, 5, 9)));
