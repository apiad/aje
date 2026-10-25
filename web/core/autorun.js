// Runs one automation rule with no one in front (spec section 06): the debt and the balance read
// fresh, the limits, the payment and the bank's SMS, and one notice per outcome. jobs.js calls it for
// each due rule; web/core/automations.js decides when a rule is due and whether a payment fits.
import { checkLimits, inWindow, monthOf, noticeOf, spentThisMonth, windowClosed } from "./automations.js";
import { KINDS } from "./bills.js";
import { MAX_FAILS } from "./jobs.js";
import { centsOf, formatMoney } from "./sms.js";

/** How long a run waits for each bank SMS. */
export const SMS_MS = 180_000;

const dayOf = (t) => new Date(t).toDateString();

/**
 * Runs `rule` at `now` and returns its outcome: a notice kind, "no-debt", "no-bill", or null when the
 * mode is off or the rule had nothing to do. Every run that sent anything writes `last`, so a rule is
 * never due twice for the same reason. Once the payment is sent the month's cycle is done, before its
 * SMS is awaited: a run cut short there can never pay it again.
 */
export async function runRule({ store, bridge, workflow, smsMs = SMS_MS }, rule, now) {
  const settings = () => store.state.settings.automation;
  if (!settings().on) return null;
  const bill = store.state.bills.find((b) => b.id === rule.billId);
  const card = bill && store.state.cards.find((c) => c.id === bill.cardId && !c.removed);
  const name = bill ? `${KINDS[bill.kind]?.label ?? "Servicio"} · ${bill.alias}` : "un servicio";
  const money = (cents) => formatMoney({ cents, currency: card?.currency ?? "CUP" });
  const current = () => store.state.automations.find((r) => r.id === rule.id);
  const save = (patch) => store.patchAutomation(rule.id, (r) => ({ ...r, ...patch(r) }));
  const notify = (kind, month, v = {}) =>
    bridge.notify({ id: `auto:${rule.id}:${month}:${kind}`, channel: "automations", route: "auto", ...noticeOf(kind, { name, ...v }) }).catch(() => {});
  const month = monthOf(now);
  const failsToday = rule.last && dayOf(rule.last.at) === dayOf(now) ? rule.last.failsToday : 0;
  const last = (outcome, fails = failsToday) => ({ last: { at: now, outcome, failsToday: fails } });
  const close = (state, reason) => (r) => ({ cycle: { ...r.cycle, state, reason } });
  // Ends the run on a stop that closes this month's cycle, with its notice.
  async function stop(kind, v = {}, state = "stopped") {
    await save((r) => ({ ...close(state, kind)(r), ...last(kind) }));
    await notify(kind, month, v);
    return kind;
  }
  // Nothing was paid: try again in an hour, and say so on the day's last try.
  async function transient() {
    await save(() => last("failed", failsToday + 1));
    if (failsToday + 1 >= MAX_FAILS) await notify("failed", month);
    return "failed";
  }

  // The saved PIN no longer works: every rule stops until the person turns the mode on again.
  async function stopAll() {
    await save(() => last("stopped"));
    await store.update({ automation: { ...settings(), on: false } });
    await notify("stopped", month);
    return "stopped";
  }

  // An earlier window that closed with its cycle open: say so unless the bill never had a debt.
  let outcome = null;
  if (windowClosed(rule, now)) {
    const missed = rule.last?.outcome !== "no-debt";
    if (missed) await notify("missed", rule.cycle.month);
    await save((r) => ({ ...close("stopped", missed ? "missed" : "no-debt")(r), last: missed ? { ...r.last, outcome: "missed" } : r.last }));
    outcome = missed ? "missed" : null;
  }
  if (!inWindow(rule, now)) return outcome;
  if (current().cycle?.month === month && current().cycle.state !== "open") return outcome;
  if (!card) {
    await save(() => ({ cycle: { month, state: "stopped", reason: "no-bill", paidCents: 0, currency: null }, ...last("no-bill") }));
    return "no-bill";
  }
  if (current().cycle?.month !== month) {
    await save(() => ({ cycle: { month, state: "open", reason: null, paidCents: 0, currency: card.currency } }));
  }

  // The bank's session: without the unattended PIN nothing can log in, so nothing is sent.
  const bank = workflow.sessionOf(card.bank);
  if (!(await workflow.savedPin(bank)).unattended) return stopAll();

  // The debt, read now; a closed session logs in first.
  let debt = await workflow.freshDebt(bill.id, { ruleId: rule.id, timeoutMs: smsMs });
  if (debt.error === "needs-login") {
    const login = await workflow.loginUnattended(bank, { timeoutMs: smsMs });
    if (login === "no-key") return stopAll();
    if (login !== "ok") return transient();
    debt = await workflow.freshDebt(bill.id, { ruleId: rule.id, timeoutMs: smsMs });
  }
  if (debt.error) return transient();
  if (debt.cents === 0) {
    await save(() => last("no-debt"));
    return "no-debt";
  }
  if (debt.cents === null) return stop("unknown");
  const amount = debt.cents;

  // The balance, read now: never one read before this run.
  const balance = await workflow.freshBalance(card.id, { ruleId: rule.id, timeoutMs: smsMs });
  if (balance.error) return transient();
  const limits = checkLimits({ amountCents: amount, balanceCents: balance.cents, rule: current(), spentCents: spentThisMonth(store.state, now, card.currency), capCents: settings().capCents });
  if (!limits.ok) {
    return stop(limits.reason, {
      amount: money(amount), max: money(rule.maxCents), left: money(balance.cents - amount), min: money(rule.minLeftCents),
      spent: money(spentThisMonth(store.state, now, card.currency)), cap: money(settings().capCents),
    });
  }

  const paid = await workflow.payBill(bill.id, { debt: false, unattended: true, ruleId: rule.id });
  if (paid.needsMenu) return stop("menu", { amount: money(amount) });
  if (paid.needsLogin) return transient();
  // Sent: the month is done, verified or not.
  await save((r) => ({ cycle: { ...r.cycle, state: "done", reason: "sent", paidCents: (r.cycle.paidCents ?? 0) + amount } }));
  const verified = await workflow.waitVerified(paid.attempt.id, smsMs);
  const a = store.state.attempts.find((x) => x.id === paid.attempt.id);
  if (!verified) return stop("unverified", { amount: money(amount) }, "done");
  const left = a.available ? money(centsOf(a.available.split(" ")[0])) : money(balance.cents - amount);
  return stop("paid", { amount: money(amount), card: card.alias, left }, "done");
}
