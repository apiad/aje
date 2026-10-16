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
