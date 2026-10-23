import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeNumber, transferBalance, changeKey, validKey, planPath, parseMenu, purchaseOutcome } from "../core/lines.js";
import { PLAN } from "./helpers.js";
import { DEFAULT_CONFIG, dial, display } from "../core/ussd.js";

test("normalizeNumber", () => {
  for (const raw of ["55555555", "+53 5555 5555", "0053-5555-5555", "(53) 5555 5555", " 65555555\n"]) {
    assert.match(normalizeNumber(raw), /^[56]\d{7}$/, raw);
  }
  for (const raw of ["7555555", "75555555", "5555555", "555555555", "", "abc"]) assert.equal(normalizeNumber(raw), null, raw);
});

test("transferBalance dials the key and displays it masked", () => {
  const c = transferBalance("55555555", "9876", 25);
  assert.equal(dial(c, DEFAULT_CONFIG, 0), "*234*1*55555555*9876*25#");
  assert.equal(display(c, DEFAULT_CONFIG, 0), "*234*1*55555555*••••*25#");
});

test("changeKey masks both keys", () => {
  assert.equal(display(changeKey("1234", "4321"), DEFAULT_CONFIG, 0), "*234*2*••••*••••#");
});

test("validKey", () => {
  assert.ok(validKey("0000"));
  for (const k of ["123", "12345", "12a4", ""]) assert.ok(!validKey(k));
});

test("normalizeNumber drops the old domestic 0", () => {
  for (const raw of ["(05) 1234567", "(05)1234567", "051234567", "0 5123 4567"]) assert.equal(normalizeNumber(raw), "51234567", raw);
});

test("planPath chains the shortcut", () => {
  assert.equal(dial(planPath([]), DEFAULT_CONFIG, 0), "*133#");
  assert.equal(dial(planPath(["1", "2"]), DEFAULT_CONFIG, 0), "*133*1*2#");
});

test("parseMenu reads numbered options with ., ) or -", () => {
  const m = parseMenu(PLAN.MENU);
  assert.equal(m.kind, "menu");
  assert.equal(m.title, "Compra de planes:");
  assert.deepEqual(m.options.map((o) => o.key), ["1", "2", "3", "4"]);
  assert.equal(m.options[3].label, "Plan Amigos");
  assert.deepEqual(parseMenu(PLAN.SUBMENU).options.map((o) => o.key), ["1", "2", "3", "0"]);
  assert.equal(parseMenu(PLAN.SUBMENU).options[1].label, "2.5 GB por 50 CUP");
  assert.deepEqual(parseMenu("Elija:\n1) Uno\n2) Dos").options.map((o) => o.label), ["Uno", "Dos"]);
});

test("a confirm screen is not a menu", () => {
  assert.deepEqual(parseMenu(PLAN.CONFIRM), { kind: "confirm", text: PLAN.CONFIRM, price: "25.00 CUP" });
});

test("parseMenu returns null for anything else", () => {
  for (const r of [PLAN.BOUGHT, "Opcion no valida", "", "1. Solo una opcion"]) assert.equal(parseMenu(r), null, r);
});

test("purchaseOutcome", () => {
  assert.equal(purchaseOutcome(PLAN.BOUGHT), "bought");
  assert.equal(purchaseOutcome(PLAN.REFUSED), "refused");
  assert.equal(purchaseOutcome("Opcion no valida"), null);
});
