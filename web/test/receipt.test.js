import { test } from "node:test";
import assert from "node:assert/strict";
import { maskSms, money, receipt, receiptText, visibleFields } from "../core/receipt.js";
import { memoryBackend, openStore } from "../core/store.js";
import { parseBankSms, parseLineSms } from "../core/sms.js";
import { BILL_ELECTRICITY, PLAN_BOUGHT, SMS } from "./helpers.js";

const AT = new Date(2026, 9, 24, 14, 32).getTime();
const CARDS = [{ id: "c1", alias: "Sueldo", pan: "9227959900000002", currency: "CUP" }];
const NAUTA = "Banco Metropolitano:  La cuenta :ana.perez@nauta.com.cu ha sido recargada con 100.00 CUP. Id Transaccion: AB000CD0001. \n" +
  " Importe Pagado: 100.00 \n Saldo Restante: DB 1100.06 CUP.";
const transfer = { id: 1, op: "45", state: "verified", startedAt: AT - 60_000, verifiedAt: AT, cardId: "c1", to: "9200123412340001",
  amount: 100, transactionId: "AB0000XYZ0001", available: "1134.56 CUP", sms: SMS.TRANSFER };

test("money as a receipt writes it", () => {
  assert.equal(money(1500), "1 500,00");
  assert.equal(money(85.4), "85,40");
  assert.equal(money(1234567.5), "1 234 567,50");
});

test("a transfer: what the bank says, and discreet mode leaves out the card and the balance", () => {
  const r = receipt(transfer, { cards: CARDS });
  assert.equal(r.what, "Transferencia completada");
  assert.deepEqual(r.fields.map((f) => [f.label, f.value]), [
    ["Beneficiario", "9200 •••• •••• 0001"], ["Fecha", "24/10/2026 · 14:32"], ["Nro. transacción", "AB0000XYZ0001"],
    ["Desde tu tarjeta", "Sueldo ···· 0002"], ["Saldo restante", "1 134,56 CUP"],
  ]);
  assert.deepEqual(r.show, [["A la tarjeta", "···· 0001"], ["Nro. transacción", "AB0000XYZ0001"], ["Fecha", "24/10 · 14:32"]]);
  const discreet = receiptText(r, true);
  assert.equal(discreet, "✅ Transferencia completada\nBanco Metropolitano\n\nMonto: 100,00 CUP\n" +
    "Beneficiario: 9200 •••• •••• 0001\nFecha: 24/10/2026 · 14:32\nNro. transacción: AB0000XYZ0001");
  assert.match(receiptText(r, false), /Saldo restante: 1 134,56 CUP/);
});

test("nothing discreet mode hides reaches the shared text or the masked SMS", () => {
  const cases = [
    [receipt(transfer, { cards: CARDS }), SMS.TRANSFER, ["1134", "Sueldo", "0002"]],
    [receipt({ id: 2, kind: "nauta", billId: "b1", state: "verified", startedAt: AT, verifiedAt: AT, cardId: "c1", to: "ana.perez",
      amount: 100, transactionId: "AB000CD0001", available: "1100.06 CUP", sms: NAUTA }, { cards: CARDS }), NAUTA, ["1100", "ana.perez", "Sueldo"]],
    [receipt({ id: 3, op: "234", state: "verified", startedAt: AT, verifiedAt: AT, subId: 3, to: "55555555", amount: 25, sms: SMS.LINE_SENT }),
      SMS.LINE_SENT, ["1234.56", "2027-01-01", "2027-02-01"]],
    [receipt({ id: 4, op: "133", state: "verified", startedAt: AT, verifiedAt: AT, subId: 3, plan: { name: "4GB+35min+40SMS", price: 240 },
      balance: "1234.56 CUP", sms: PLAN_BOUGHT }), PLAN_BOUGHT, ["1234.56"]],
  ];
  for (const [r, sms, secrets] of cases) {
    const shared = receiptText(r, true);
    const masked = maskSms(sms);
    for (const s of secrets) {
      assert.ok(!shared.includes(s), `${r.what}: "${s}" in the shared text`);
      assert.ok(!masked.includes(s), `${r.what}: "${s}" in the masked SMS:\n${masked}`);
      assert.ok(!visibleFields(r, true).some((f) => f.value.includes(s)));
    }
  }
});

test("Nauta: the account keeps its first letter in discreet mode, and in full on the show screen", () => {
  const r = receipt({ id: 2, kind: "nauta", billId: "b1", state: "verified", startedAt: AT, verifiedAt: AT, to: "ana.perez", amount: 100, sms: NAUTA });
  assert.equal(visibleFields(r, true)[0].value, "a•••@nauta.com.cu");
  assert.equal(visibleFields(r, false)[0].value, "ana.perez@nauta.com.cu");
  assert.deepEqual(r.show[0], ["Cuenta", "ana.perez@nauta.com.cu"]);
});

test("no receipt for a balance query, an operation not yet verified, or a debt query", () => {
  assert.equal(receipt({ id: 5, op: "46", state: "verified", startedAt: AT, available: "1.00 CUP" }), null);
  assert.equal(receipt({ ...transfer, state: "dialer" }), null);
  assert.equal(receipt({ id: 6, op: "47", billId: "b1", kind: "electricity", state: "verified", startedAt: AT }), null);
});

test("an operation verified before Ajé kept the SMS still has a receipt, without the original text", () => {
  const { sms, ...old } = transfer;
  const r = receipt(old, { cards: CARDS });
  assert.equal(r.sms, null);
  assert.equal(r.fields[0].value, "···· 0001");
});

test("verifying a transfer or a line transfer keeps the SMS's text", async () => {
  const store = await openStore(memoryBackend(), { now: () => AT });
  await store.add({ id: null, startedAt: AT - 60_000, state: "dialer", op: "45", cardId: "c1", to: "9200123412340001", amount: 100 });
  await store.verifyTransfer({ ...parseBankSms(SMS.TRANSFER), body: SMS.TRANSFER }, AT);
  assert.equal(store.state.attempts[0].sms, SMS.TRANSFER);
  await store.add({ id: null, startedAt: AT - 60_000, state: "dialer", op: "234", subId: 3, to: "55555555", amount: 25 });
  await store.verifyLineTransfer({ ...parseLineSms(SMS.LINE_SENT), body: SMS.LINE_SENT }, AT);
  assert.equal(store.state.attempts[0].sms, SMS.LINE_SENT);
});

test("an electricity payment: the bank's SMS verifies it, and its receipt hides the owner and the balance", async () => {
  const store = await openStore(memoryBackend(), { now: () => AT });
  const bill = await store.saveBill({ kind: "electricity", alias: "Luz de casa", number: "1234567890123", cardId: "c1" });
  const a = await store.add({ id: null, startedAt: AT - 60_000, state: "replied", op: "41", cardId: "c1", billId: bill.id, kind: "electricity", amount: null, debt: false });
  await store.markBill(bill.id, { paid: { at: a.startedAt, cents: 8540, verified: false } });
  const sms = parseBankSms(BILL_ELECTRICITY);
  assert.equal(await store.verifyBill({ ...sms, body: BILL_ELECTRICITY }, AT), 60_000);
  const row = store.state.attempts[0];
  assert.equal(row.state, "verified");
  assert.equal(row.amount, 80.1);
  assert.deepEqual(store.state.bills[0].paid, { at: a.startedAt, cents: 8010, verified: true });

  const r = receipt(row, { cards: CARDS });
  assert.equal(r.what, "Pago de la luz completado");
  assert.deepEqual(visibleFields(r, true).map((f) => [f.label, f.value]), [
    ["Nro. factura", "1234567890123"], ["Período", "10/2026"], ["Importe de la factura", "85,40 CUP"], ["Consumo", "120 KW"],
    ["Fecha", "24/10/2026 · 14:32"], ["Nro. transacción", "MM000A000X001"],
  ]);
  assert.deepEqual(r.show, [["Nro. factura", "1234567890123"], ["Nro. transacción", "MM000A000X001"], ["Período", "10/2026"]]);
  for (const secret of ["ANA", "PEREZ", "1120"]) {
    assert.ok(!receiptText(r, true).includes(secret), secret);
    assert.ok(!maskSms(BILL_ELECTRICITY).includes(secret), secret);
  }
  assert.match(receiptText(r, false), /Titular: ANA PEREZ GARCIA/);
});

test("a bill SMS verifies no payment of another saved bill", async () => {
  const store = await openStore(memoryBackend(), { now: () => AT });
  const other = await store.saveBill({ kind: "electricity", alias: "Luz de mamá", number: "9999999999999", cardId: "c1" });
  await store.saveBill({ kind: "electricity", alias: "Luz", number: "1234567890123", cardId: "c1" });
  await store.add({ id: null, startedAt: AT - 60_000, state: "replied", op: "41", cardId: "c1", billId: other.id, kind: "electricity", debt: false });
  assert.equal(await store.verifyBill(parseBankSms(BILL_ELECTRICITY), AT), null);
});
