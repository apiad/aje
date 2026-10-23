import test from "node:test";
import assert from "node:assert/strict";
import { BUNDLED } from "../core/plancatalog.js";
import { PLANS_URL, fetchCatalog, findPlan, planCode, validCatalog } from "../core/plans.js";

const catalog = (plans) => ({ v: 1, captured: "2026-10-23", groups: [{ label: "Datos", plans }] });
const PLAN = { path: "1*4*1", name: "4.5GB", price: 240, ask: "¿Desea comprar el plan de 4.5GB x 240.00? Marque 1 para confirmar." };

test("the bundled catalog is valid and holds the captured plans", () => {
  assert.equal(validCatalog(BUNDLED), BUNDLED);
  assert.deepEqual(BUNDLED.groups.map((g) => g.label), ["Datos", "SMS", "Voz"]);
  assert.equal(BUNDLED.groups.flatMap((g) => g.plans).length, 15);
  const plan = findPlan(BUNDLED, "1*4*4");
  assert.equal(plan.name, "6GB +60min +70SMS");
  assert.equal(plan.price, 360);
  assert.equal(findPlan(BUNDLED, "9*9"), null);
});

test("a plan dials the shortcut that lands on Cubacel's confirm", () => {
  assert.equal(planCode(PLAN), "*133*1*4*1#");
  assert.equal(planCode({ path: "2*1" }), "*133*2*1#");
});

test("validCatalog refuses anything that could dial outside *133 or show a made-up price", () => {
  for (const bad of [
    null, "x", { v: 2, groups: [] }, { v: 1, groups: [] }, { v: 1, groups: "x" },
    catalog([]),
    catalog([{ ...PLAN, path: "1*4*1#*222" }]),
    catalog([{ ...PLAN, path: "1**4" }]),
    catalog([{ ...PLAN, path: "" }]),
    catalog([{ ...PLAN, path: "1*2*3*4*5*6*7" }]),
    catalog([{ ...PLAN, price: -1 }]),
    catalog([{ ...PLAN, price: 100000 }]),
    catalog([{ ...PLAN, price: "240" }]),
    catalog([{ ...PLAN, name: "" }]),
    catalog([{ ...PLAN, name: "x".repeat(81) }]),
    catalog([{ ...PLAN, ask: 5 }]),
    { v: 1, captured: "2026-10-23", groups: [{ label: "", plans: [PLAN] }] },
  ]) assert.equal(validCatalog(bad), null, JSON.stringify(bad));
  const ok = catalog([PLAN]);
  assert.equal(validCatalog(ok), ok);
});

test("fetchCatalog takes a valid hosted catalog and nothing else", async () => {
  const hosted = catalog([PLAN]);
  const urls = [];
  const answer = (res) => async (url) => { urls.push(url); return res; };
  assert.deepEqual(await fetchCatalog({ fetch: answer({ ok: true, json: async () => hosted }) }), hosted);
  assert.deepEqual(urls, [PLANS_URL]);
  assert.equal(await fetchCatalog({ fetch: answer({ ok: false, status: 404 }) }), null);
  assert.equal(await fetchCatalog({ fetch: answer({ ok: true, json: async () => ({ v: 1, groups: [] }) }) }), null);
  assert.equal(await fetchCatalog({ fetch: answer({ ok: true, json: async () => { throw new SyntaxError("bad"); } }) }), null);
  assert.equal(await fetchCatalog({ fetch: async () => { throw new TypeError("offline"); } }), null);
});
