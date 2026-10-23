import { test } from "node:test";
import assert from "node:assert/strict";
import { createMock } from "../mock.js";

const until = async (cond) => { for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 2)); };

test("the mock asks for login, then authenticates and answers the balance by SMS", async () => {
  const m = createMock({ delayMs: 0 });
  const got = [];
  m.onSms((s) => got.push(s.body));
  assert.match((await m.sendUssd(3, "*444*46*61012*046615*1260416#")).reply, /autenticarse/i);
  await m.sendUssd(3, "*444*40*00000*1260416#");
  await until(() => got.length === 1);
  assert.match(got[0], /se ha autenticado/);
  assert.match((await m.sendUssd(3, "*444*46*61012*046615*1260416#")).reply, /procesada/);
  await until(() => got.length === 2);
  assert.match(got[1], /consulta de saldo fue completada/);
});

test("the mock answers both mobile balance codes and lists two SIMs", async () => {
  const m = createMock({ delayMs: 0 });
  assert.match((await m.sendUssd(3, "*222#")).reply, /Saldo: \d+\.\d{2} CUP/);
  assert.match((await m.sendUssd(4, "*111#")).reply, /Saldo disponible/);
  assert.equal((await m.listSims()).length, 2);
});

test("the mock keeps a secret until it is forgotten", async () => {
  const m = createMock({ delayMs: 0 });
  assert.deepEqual(await m.secretStatus("pin:BM"), { available: true, saved: false, expiresAt: null });
  assert.equal(await m.secretSave("pin:BM", "1234", 180), true);
  assert.equal((await m.secretStatus("pin:BM")).saved, true);
  assert.equal(await m.secretLoad("pin:BM"), "1234");
  await m.secretForget("pin:BM");
  assert.equal(await m.secretLoad("pin:BM"), null);
});

test("op 49 starts a registration and op 60 links a card once logged in", async () => {
  const m = createMock({ delayMs: 0 });
  assert.match((await m.sendUssd(3, "*444*49*0100*1260416#")).reply, /registro/i);
  assert.match((await m.sendUssd(3, "*444*60*0100*1260416#")).reply, /autenticarse/i);
  await m.sendUssd(3, "*444*40*0100*1260416#");
  assert.match((await m.sendUssd(3, "*444*60*0100*1260416#")).reply, /asociada/i);
});

test("the mock pretends to install an update", async () => {
  const m = createMock({ delayMs: 0 });
  assert.deepEqual(await m.installUpdate("https://example.test/aje.apk", "ab".repeat(32)), { ok: true });
});

test("the mock contact picker answers a sample contact, or what the test sets", async () => {
  const m = createMock({ delayMs: 0 });
  assert.deepEqual(await m.pickContact(), { name: "Ben", number: "+53 5100 0001" });
  m.setNextContact(null);
  assert.equal(await m.pickContact(), null);
  m.setNextContact({ name: "Oficina", number: "7 800 0000" });
  assert.deepEqual(await m.pickContact(), { name: "Oficina", number: "7 800 0000" });
  assert.deepEqual(await m.pickContact(), { name: "Ben", number: "+53 5100 0001" });
});

test("the mock update download reports progress up to the total", async () => {
  const m = createMock({ delayMs: 0 });
  const seen = [];
  assert.deepEqual(await m.installUpdate("https://x/a.apk", "ab", (r, t) => seen.push([r, t])), { ok: true });
  assert.ok(seen.length >= 2);
  assert.deepEqual(seen.at(-1), [seen.at(-1)[1], seen.at(-1)[1]]);
});
