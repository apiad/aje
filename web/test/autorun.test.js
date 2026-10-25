import { test } from "node:test";
import assert from "node:assert/strict";
import { nextAt } from "../core/automations.js";
import { runRule } from "../core/autorun.js";
import { automationJob } from "../core/jobs.js";
import { memoryBackend, openStore } from "../core/store.js";
import { createWorkflow, PIN_DAYS } from "../core/workflow.js";
import { BILL_ELECTRICITY, fakeBridge, SMS } from "./helpers.js";

// Local times, as the phone keeps them: October 2026.
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m).getTime();
const HOUR = 3_600_000;
const DEBT = (figure) => `Consulta de servicio completada. \r\n La Factura: 1234567890123 tiene una deuda de ${figure} CUP`;
const balanceSms = (available) => SMS.BALANCE.replace("1200.06", available);
const telemetry = { event() {}, flush: async () => {}, idle: async () => {} };

/**
 * A store with one card, one electricity bill, a rule and the mode on; a bridge whose sendUssd answers
 * by op from `script`, each entry an SMS the bank sends back (or null for none), and records notify.
 */
async function world({ script = {}, on = true, rule = {}, pin = true, card = {} } = {}) {
  const clock = { t: at(6, 9) };
  const now = () => clock.t;
  let ids = 0;
  const store = await openStore(memoryBackend(), { now, newId: () => `id-${++ids}` });
  await store.update({ subId: 3, automation: { on, capCents: 1_000_000 } });
  const c = await store.addCard({ alias: "Ahorro", pan: "9227959900000001", bank: "METROPOLITANO", currency: "CUP" });
  await store.updateCard(c.id, { state: "linked", ...card });
  const bill = await store.saveBill({ kind: "electricity", alias: "Casa", number: "1234567890123", cardId: c.id });
  const r = await store.saveAutomation({ id: null, type: "bill", billId: bill.id, window: { from: 5, to: 10 }, maxCents: 80000, minLeftCents: 50000, on: true, cycle: null, last: null, ...rule });
  const bridge = fakeBridge();
  if (pin) await bridge.secretSave("pin:METROPOLITANO", "1234", PIN_DAYS, { unattended: true });
  bridge.calls.length = 0;
  const notices = [];
  bridge.notify = async (n) => { notices.push(n); };
  const sent = [];
  const queues = Object.fromEntries(Object.entries(script).map(([op, list]) => [op, [...list]]));
  bridge.sendUssd = async (subId, code) => {
    const op = code.split("*")[2];
    sent.push(op);
    const next = queues[op]?.shift();
    if (next && typeof next === "object") return next;
    if (next) setTimeout(() => workflow.handleSms({ sender: "PAGOxMOVIL", body: next, receivedAt: clock.t }), 1);
    return { ok: true, reply: "Su solicitud esta siendo procesada, espere un SMS" };
  };
  const workflow = createWorkflow({ bridge, store, telemetry, now, seed: () => 61 });
  const ctx = { store, bridge, workflow, smsMs: 50 };
  const rule0 = () => store.state.automations[0];
  return { clock, store, bridge, workflow, ctx, notices, sent, rule: rule0, run: () => runRule(ctx, rule0(), clock.t) };
}

const HAPPY = { 47: [DEBT("85.40")], 46: [SMS.BALANCE], 41: [BILL_ELECTRICITY] };

test("the happy path checks the debt and the balance, pays once and notifies it", async () => {
  const w = await world({ script: HAPPY });
  assert.equal(await w.run(), "paid");
  assert.deepEqual(w.sent, ["47", "46", "41"]);
  assert.equal(w.notices.length, 1);
  assert.deepEqual(w.notices[0], {
    id: "auto:id-3:2026-10:paid", channel: "automations", route: "auto",
    title: "Pagaste Luz · Casa: 85.40 CUP", text: "De la tarjeta Ahorro. Quedan 1120.50 CUP.",
  });
  assert.deepEqual(w.rule().cycle, { month: "2026-10", state: "done", reason: "paid", paidCents: 8540, currency: "CUP" });
  assert.equal(w.rule().last.outcome, "paid");
  assert.equal(w.store.state.attempts.find((a) => a.op === "41").ruleId, "id-3");
});

test("no balance SMS: no payment, a failure, retried hourly, and the third one notifies", async () => {
  const w = await world({ script: { 47: [DEBT("85.40"), DEBT("85.40"), DEBT("85.40")] } });
  for (let i = 1; i <= 3; i++) {
    assert.equal(await w.run(), "failed");
    assert.equal(w.rule().last.failsToday, i);
    assert.equal(w.notices.length, i === 3 ? 1 : 0);
    if (i < 3) assert.equal(nextAt(w.rule(), w.clock.t), w.clock.t + HOUR);
    w.clock.t += HOUR;
  }
  assert.ok(!w.sent.includes("41"));
  assert.deepEqual([w.notices[0].title, w.notices[0].text], ["No pude pagar Luz · Casa hoy", "El banco no respondió. Lo intento mañana."]);
  assert.equal(nextAt(w.rule(), w.clock.t), at(7, 9));
});

test("a payment whose SMS never comes closes the month as unverified and is never sent again", async () => {
  const w = await world({ script: { 47: [DEBT("85.40")], 46: [SMS.BALANCE] } });
  assert.equal(await w.run(), "unverified");
  assert.equal(w.notices[0].title, "Pagué Luz · Casa: 85.40 CUP, sin confirmar");
  assert.equal(w.rule().cycle.state, "done");
  assert.equal(nextAt(w.rule(), at(7, 9)), new Date(2026, 10, 5, 9).getTime());
  w.clock.t = at(7, 9);
  await automationJob.run({ ...w.ctx, now: w.clock.t });
  assert.equal(w.sent.filter((op) => op === "41").length, 1);
});

test("a debt with no figure pays nothing and sends the person to Servicios", async () => {
  const w = await world({ script: { 47: ["Consulta de servicio completada. \r\n La Factura: 1234567890123 debe algo"] } });
  assert.equal(await w.run(), "unknown");
  assert.deepEqual(w.sent, ["47"]);
  assert.equal(w.notices[0].text, "El banco dice que hay deuda pero no cuánto. Págala desde Servicios.");
  assert.equal(w.rule().cycle.state, "stopped");
});

test("a lapsed unattended PIN sends no USSD, notifies once and turns the mode off", async () => {
  const w = await world({ pin: false, script: HAPPY });
  assert.equal(await w.run(), "stopped");
  assert.deepEqual(w.sent, []);
  assert.equal(w.notices.length, 1);
  assert.equal(w.notices[0].title, "Las automatizaciones están detenidas");
  assert.equal(w.store.state.settings.automation.on, false);
  assert.equal(automationJob.nextAt(w.store.state, w.clock.t), Infinity);
});

test("a closed session logs in with the unattended PIN, then asks again", async () => {
  const w = await world({ script: { 47: [{ ok: true, reply: "Debe autenticarse" }, DEBT("85.40")], 40: [SMS.AUTH], 46: [SMS.BALANCE], 41: [BILL_ELECTRICITY] } });
  assert.equal(await w.run(), "paid");
  assert.deepEqual(w.sent, ["47", "40", "47", "46", "41"]);
});

test("two rules on one card run one after the other, and the second reads the balance again", async () => {
  const w = await world({ script: { 47: [DEBT("85.40"), DEBT("300.00")], 46: [SMS.BALANCE, balanceSms("1120.50").replace("1234.56", "1150.00")], 41: [BILL_ELECTRICITY] } });
  await w.store.saveAutomation({ ...w.rule(), id: null, minLeftCents: 100000 });
  await automationJob.run({ ...w.ctx, now: w.clock.t });
  assert.deepEqual(w.sent, ["47", "46", "41", "47", "46"]);
  assert.deepEqual(w.notices.map((n) => n.title), ["Pagaste Luz · Casa: 85.40 CUP", "No pagué Luz · Casa"]);
  assert.match(w.notices[1].text, /dejaría 820.50 CUP en la tarjeta, menos del mínimo de 1000.00 CUP/);
});

test("a debt above the maximum sends no payment", async () => {
  const w = await world({ script: { 47: [DEBT("900.00")], 46: [SMS.BALANCE] } });
  assert.equal(await w.run(), "max");
  assert.ok(!w.sent.includes("41"));
  assert.equal(w.notices[0].text, "La factura es de 900.00 CUP y tu límite es 800.00 CUP. No vuelvo a intentarlo este mes.");
  assert.equal(nextAt(w.rule(), w.clock.t), new Date(2026, 10, 5, 9).getTime());
});

test("a balance read before the run is never used", async () => {
  const w = await world({ script: { 47: [DEBT("85.40")], 46: [balanceSms("100.00")] }, card: { balance: { available: "99999.00 CUP", at: at(6, 8), op: "46", attemptId: 99 } } });
  assert.equal(await w.run(), "min");
  assert.ok(!w.sent.includes("41"));
  assert.equal(w.notices[0].text, "Pagar 85.40 CUP dejaría 14.60 CUP en la tarjeta, menos del mínimo de 500.00 CUP. No vuelvo a intentarlo este mes.");
});

test("the monthly cap counts what the rules already paid", async () => {
  const w = await world({ script: { 47: [DEBT("85.40")], 46: [SMS.BALANCE] } });
  await w.store.update({ automation: { on: true, capCents: 10000 } });
  await w.store.saveAutomation({ ...w.rule(), id: null, on: false, cycle: { month: "2026-10", state: "done", reason: "paid", paidCents: 5000, currency: "CUP" } });
  assert.equal(await w.run(), "cap");
  assert.equal(w.notices[0].text, "Las automatizaciones ya movieron 50.00 CUP este mes y el tope es 100.00 CUP.");
});

test("no debt: nothing is paid, no notice, due again tomorrow", async () => {
  const w = await world({ script: { 47: ["Consulta de servicio completada. \r\n La Factura: 1234567890123 no tiene deudas "] } });
  assert.equal(await w.run(), "no-debt");
  assert.deepEqual([w.sent, w.notices], [["47"], []]);
  assert.equal(nextAt(w.rule(), w.clock.t), at(7, 9));
});

test("a menu is left alone and notified", async () => {
  const w = await world({ script: { 47: [DEBT("85.40")], 46: [SMS.BALANCE], 41: [{ ok: false, failureCode: -1 }] } });
  assert.equal(await w.run(), "menu");
  assert.equal(w.notices[0].title, "Toca para pagar Luz · Casa");
  assert.equal(w.bridge.calls.filter((c) => c.method === "dial").length, 0);
});

test("a window that closed unpaid is notified once and the cycle stops", async () => {
  const w = await world({ rule: { cycle: { month: "2026-10", state: "open", reason: null, paidCents: 0, currency: "CUP" }, last: { at: at(10, 11), outcome: "failed", failsToday: 3 } } });
  w.clock.t = at(11, 7);
  assert.equal(await w.run(), "missed");
  assert.deepEqual(w.sent, []);
  assert.equal(w.notices[0].title, "No pagué Luz · Casa este mes");
  assert.equal(w.rule().cycle.state, "stopped");
  assert.equal(nextAt(w.rule(), w.clock.t), new Date(2026, 10, 5, 9).getTime());
});

test("mode off sends nothing", async () => {
  const w = await world({ on: false, script: HAPPY });
  assert.equal(await w.run(), null);
  assert.deepEqual([w.sent, w.notices], [[], []]);
  assert.equal(automationJob.nextAt(w.store.state, w.clock.t), Infinity);
});

test("a run cut short while it waits for the payment's SMS never pays again", async () => {
  const w = await world({ script: { 47: [DEBT("85.40"), DEBT("85.40")], 46: [SMS.BALANCE, SMS.BALANCE] } });
  w.workflow.waitVerified = () => Promise.reject(new Error("the shell closed the page"));
  await assert.rejects(w.run());
  w.clock.t = at(7, 9);
  await automationJob.run({ ...w.ctx, now: w.clock.t });
  assert.equal(w.sent.filter((op) => op === "41").length, 1);
});

test("a rule that throws counts as a failure, so the job is not due again at once", async () => {
  const w = await world({ script: HAPPY });
  w.workflow.freshDebt = () => Promise.reject(new Error("boom"));
  await automationJob.run({ ...w.ctx, now: w.clock.t });
  assert.deepEqual([w.rule().last.outcome, w.rule().last.failsToday], ["failed", 1]);
  assert.equal(automationJob.nextAt(w.store.state, w.clock.t), w.clock.t + HOUR);
});
