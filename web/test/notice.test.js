import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fnv1a, noticeOf, noticeText } from "../core/notice.js";

// The same file holds the shell's Kotlin reader (SmsNoticeTest) to the same answers.
const VECTORS = JSON.parse(readFileSync(new URL("./fixtures/notice-vectors.json", import.meta.url), "utf8"));

test("every vector reads as the shell must read it", () => {
  for (const v of VECTORS) assert.deepEqual(noticeOf(v.sender, v.body), v.out, v.body);
});

test("every vector's id is its send time and the hash of its text", () => {
  for (const v of VECTORS) assert.equal(v.id, `${v.sentAt}:${fnv1a(v.body)}`);
});

test("a notice from a person's number is never read", () => {
  const card = VECTORS.find((v) => v.out?.kind === "card-received");
  assert.equal(noticeOf("+5355555555", card.body), null);
  assert.equal(noticeOf("55555555", card.body), null);
});

test("a no-break space reads as a space", () => {
  const card = VECTORS.find((v) => v.out?.kind === "card-received");
  assert.deepEqual(noticeOf(card.sender, card.body.replace("de 1500.00", "de 1500.00")), card.out);
});

test("the copy of each kind", () => {
  const n = (kind, o) => ({ kind, amount: null, number: null, account: null, plan: null, ...o });
  const card = n("card-received", { amount: "1500.00 CUP", number: "51234567", account: "9200XXXXXXXX0001" });
  assert.deepEqual(noticeText(card, "Mamá"), { title: "Dinero recibido", text: "Recibiste 1500.00 CUP de Mamá" });
  assert.deepEqual(noticeText(card, null), { title: "Dinero recibido", text: "Recibiste 1500.00 CUP de 51234567 (desconocido)" });
  assert.deepEqual(noticeText(n("line-received", { amount: "250.00 CUP", number: "51234567" }), null),
    { title: "Saldo recibido", text: "Recibiste 250.00 CUP de 51234567 (desconocido)" });
  assert.deepEqual(noticeText(n("recharge-intl", { amount: "500.00 CUP" }), null),
    { title: "Saldo recibido", text: "Recibiste una recarga internacional de 500.00 CUP" });
  assert.deepEqual(noticeText(n("recharge-intl", { plan: "10GB +100MIN +100SMS" }), null),
    { title: "Recargas y planes", text: "Recibiste una recarga internacional: 10GB +100MIN +100SMS" });
  assert.deepEqual(noticeText(n("recharge", { amount: "500.00 CUP" }), null),
    { title: "Saldo recibido", text: "Recibiste una recarga de 500.00 CUP" });
  assert.deepEqual(noticeText(n("plan-gift", { plan: "3GB" }), null), { title: "Recargas y planes", text: "Recibiste un plan de 3GB" });
  assert.deepEqual(noticeText(n("plan-expiry", { plan: "plan de datos vence el 25-10-26" }), null),
    { title: "Recargas y planes", text: "Tu plan de datos vence el 25-10-26" });
});
