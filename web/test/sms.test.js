import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBankSms, parseLineSms, parsePlanSms, formatMoney, transferMatches, senderTag, BANKISH } from "../core/sms.js";
import { SMS, PLAN_BOUGHT } from "./helpers.js";

test("balance report", () => {
  assert.deepEqual(parseBankSms(SMS.BALANCE), {
    kind: "balance", bank: "METROPOLITANO",
    accounting: { cents: 123456, currency: "CUP" }, available: { cents: 120006, currency: "CUP" },
  });
});

test("transfer done", () => {
  assert.deepEqual(parseBankSms(SMS.TRANSFER), {
    kind: "transfer", bank: "METROPOLITANO", date: "1/2/2026", beneficiary: "9200XXXXXXXX0001",
    amount: { cents: 10000, currency: "CUP" }, transactionId: "AB0000XYZ0001",
    remaining: { cents: 113456, currency: "CUP" },
  });
});

test("transfer matches the masked beneficiary and the amount", () => {
  const done = parseBankSms(SMS.TRANSFER);
  assert.ok(transferMatches(done, "9200950000000001", 10000));
  assert.ok(!transferMatches(done, "9200950000000002", 10000));
  assert.ok(!transferMatches(done, "9200950000000001", 10100));
});

test("authenticated", () => {
  assert.deepEqual(parseBankSms(SMS.AUTH), { kind: "auth", bank: "METROPOLITANO" });
});

test("debit is negative", () => {
  const r = parseBankSms(SMS.BALANCE.replace("CR 1234.56", "DB 5.00"));
  assert.deepEqual(r.accounting, { cents: -500, currency: "CUP" });
  assert.equal(formatMoney(r.accounting), "-5.00 CUP");
});

test("thousands separator and decimal comma", () => {
  assert.equal(parseBankSms(SMS.BALANCE.replace("CR 1234.56", "CR 1,234.56")).accounting.cents, 123456);
  assert.equal(parseBankSms(SMS.BALANCE.replace("CR 1234.56", "CR 1234,56")).accounting.cents, 123456);
});

test("CRLF line breaks as the bank sends them", () => {
  const r = parseBankSms(SMS.BALANCE.replaceAll("\n", "\r\n"));
  assert.deepEqual(r.accounting, { cents: 123456, currency: "CUP" });
  assert.deepEqual(r.available, { cents: 120006, currency: "CUP" });
});

test("a no-break space reads as a space", () => {
  assert.equal(parseBankSms(SMS.BALANCE.replace("Saldo Contable:", "Saldo Contable:")).accounting.cents, 123456);
});

test("unknown texts", () => {
  assert.equal(parseBankSms("Hola, nos vemos mañana"), null);
  assert.equal(parseBankSms("Banco Metropolitano: un aviso que no conocemos"), null);
});

test("a long number is a person and is never reported", () => {
  assert.equal(senderTag("PAGOxMOVIL"), "PAGOxMOVIL");
  assert.equal(senderTag("2266"), "2266");
  assert.equal(senderTag("55555555"), "number");
  assert.ok(BANKISH.test("Banco Metropolitano: un aviso"));
  assert.ok(!BANKISH.test("Hola, nos vemos mañana"));
});

test("Cubacel balance transfer texts", () => {
  assert.deepEqual(parseLineSms(SMS.LINE_SENT), { kind: "line-sent", number: "55555555", amount: { cents: 2500, currency: "CUP" } });
  assert.deepEqual(parseLineSms(SMS.LINE_RECEIVED), { kind: "line-received", number: "56666666", amount: { cents: 2500, currency: "CUP" } });
  for (const k of ["BALANCE", "TRANSFER", "AUTH"]) assert.equal(parseLineSms(SMS[k]), null, k);
  assert.equal(parseBankSms(SMS.LINE_SENT), null);
  assert.ok(BANKISH.test("Usted ha recibido 10.00 CUP"));
});

test("parsePlanSms reads the plan, its price and the balance left", () => {
  assert.deepEqual(parsePlanSms(PLAN_BOUGHT),
    { kind: "plan", name: "4GB+35min+40SMS", days: 30, price: { cents: 24000, currency: "CUP" }, balance: "1234.56 CUP" });
  // The words telemetry hid may be others; the figures still read.
  const other = "ETECSA Plan Nacional: Se ha activado el Plan 4 GB + 35 min valido por 30 dias, se activa con el primer uso. Se cobraron 120.00 CUP. Saldo principal 980.50 CUP";
  assert.deepEqual(parsePlanSms(other), { kind: "plan", name: "4 GB + 35 min", days: 30, price: { cents: 12000, currency: "CUP" }, balance: "980.50 CUP" });
  assert.equal(parsePlanSms(PLAN_BOUGHT.replace(/\. Saldo.*$/, "")).balance, null);
});

test("parsePlanSms ignores other texts", () => {
  for (const body of [SMS.LINE_SENT, SMS.LINE_RECEIVED, SMS.BALANCE, SMS.TRANSFER, "Su plan de datos vence manana", ""]) {
    assert.equal(parsePlanSms(body), null, body);
  }
});
