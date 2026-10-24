import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDebtSms, parseBankSms, parseLineSms, parsePlanSms, formatMoney, transferMatches, senderTag, BANKISH } from "../core/sms.js";
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
  assert.deepEqual(parseBankSms(SMS.MITRANSFER_AUTH), { kind: "auth", bank: "MITRANSFER" });
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
  // Review: a line break, two hidden words, and a balance with a comma read too; the balance is normalized.
  assert.equal(parsePlanSms(PLAN_BOUGHT.replace("Se ha comprado", "Se ha\ncomprado")).price.cents, 24000);
  assert.equal(parsePlanSms(PLAN_BOUGHT.replace("comprado", "activado correctamente").replace("Se debitaron", "Se le debitaron")).price.cents, 24000);
  assert.equal(parsePlanSms(PLAN_BOUGHT.replace("1234.56", "12,234.56")).balance, "12234.56 CUP");
  assert.equal(parsePlanSms(PLAN_BOUGHT.replace("1234.56", "1234,56")).balance, "1234.56 CUP");
});

// Review: the price is the sentence right after the plan's, never a later figure.
test("parsePlanSms takes no price from a later sentence", () => {
  const body = "ETECSA Plan Nacional: Se ha comprado Plan 1GB valido por 7 dias, se activa con el primer uso. Gracias. Se recargaron 500.00 CUP";
  assert.equal(parsePlanSms(body), null);
});

test("parsePlanSms ignores other texts", () => {
  for (const body of [SMS.LINE_SENT, SMS.LINE_RECEIVED, SMS.BALANCE, SMS.TRANSFER, "Su plan de datos vence manana", ""]) {
    assert.equal(parsePlanSms(body), null, body);
  }
});

test("parsePlanSms reads Cubacel's 2025 format", () => {
  const body = "Ha comprado un plan de 3GB +15MIN +20SMS valido por 30 dias, se activara con el primer uso. Se desconto 120.00 CUP. Saldo actual 880.00 CUP";
  assert.deepEqual(parsePlanSms(body), { kind: "plan", name: "3GB +15MIN +20SMS", days: 30, price: { cents: 12000, currency: "CUP" }, balance: "880.00 CUP" });
  // As a phone received it: no currency, "de su cuenta principal", two spaces before the balance.
  const seen = "Ha comprado un plan de 1.5GB valido por 7 dias, se activara con el primer uso. Se desconto 125.00 de su cuenta principal. Saldo actual  880.00";
  assert.deepEqual(parsePlanSms(seen), { kind: "plan", name: "1.5GB", days: 7, price: { cents: 12500, currency: "CUP" }, balance: "880.00 CUP" });
  const older = "Ha comprado 2.5GB +3.5GB LTE +25MIN +40SMS valido por 30 dias, se activara con el primer uso. Se desconto 360.00 de su cuenta principal. Saldo actual  12.00";
  assert.equal(parsePlanSms(older).name, "2.5GB +3.5GB LTE +25MIN +40SMS");
  // Without the price there is nothing to confirm a purchase by.
  assert.equal(parsePlanSms("Ha comprado un plan de 3GB +15MIN +20SMS valido por 30 dias, se activara con el primer uso."), null);
  assert.equal(parsePlanSms("Ha recibido un plan de 3GB valido por 30 dias, se activara con el primer uso."), null);
});

test("a refused balance query is 'balance-failed'", () => {
  assert.deepEqual(parseBankSms(SMS.BALANCE_FAILED), { kind: "balance-failed", bank: "METROPOLITANO" });
});

test("a Nauta recharge and a Nauta Hogar payment", () => {
  assert.deepEqual(parseBankSms("Banco Metropolitano:  La cuenta :ana.perez@nauta.com.cu ha sido recargada con 100.00 CUP. Id Transaccion: AB123CD4567. Saldo Restante: DB 1000.00 CUP."),
    { kind: "nauta", bank: "METROPOLITANO", user: "ana.perez", hogar: false, amount: { cents: 10000, currency: "CUP" }, transactionId: "AB123CD4567",
      remaining: { cents: 100000, currency: "CUP" } });
  const hogar = parseBankSms("Banco Metropolitano:  La cuenta Nauta Hogar: ana@nauta.com.cu ha sido pagada con 300.00 CUP. Monto Pagado: 300 CUP. \n Id Transaccion: AB123CD4569. \n Saldo Restante: DB 1000.00 CUP.");
  assert.deepEqual([hogar.kind, hogar.user, hogar.hogar, hogar.amount.cents, hogar.transactionId], ["nauta", "ana", true, 30000, "AB123CD4569"]);
});

test("parseDebtSms reads the service query's answer", () => {
  assert.deepEqual(parseDebtSms("Consulta de servicio completada. \r\n La Factura: 01234567890 no tiene deudas "), { kind: "debt", number: "01234567890", cents: 0 });
  assert.deepEqual(parseDebtSms("Consulta de servicio completada. \r\n La Factura: 1234567890123 tiene una deuda de 85.40 CUP"), { kind: "debt", number: "1234567890123", cents: 8540 });
  assert.deepEqual(parseDebtSms("Consulta de servicio completada. \r\n La Factura: 1234567890123 debe algo"), { kind: "debt", number: "1234567890123", cents: null });
  assert.equal(parseDebtSms("Banco Metropolitano:  La consulta de saldo fue completada."), null);
});
