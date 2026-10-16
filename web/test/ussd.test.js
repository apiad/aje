import { test } from "node:test";
import assert from "node:assert/strict";
import { bare, encoded, plain, field, dial, display, hasSecret, DEFAULT_CONFIG } from "../core/ussd.js";

test("bare codes", () => {
  assert.equal(dial(bare("85")), "*444*85#");
});

test("encoded codes match the balance capture", () => {
  assert.equal(dial(encoded("46", [field("1"), field("0000")]), DEFAULT_CONFIG, 61), "*444*46*61012*046615*1260416#");
});

test("the access code and version come from config", () => {
  const c = encoded("46", [field("1"), field("0000")]);
  assert.equal(dial(c, { accessCode: "555", version: "9999999" }, 61), "*555*46*61012*046615*9999999#");
});

test("display masks every secret segment", () => {
  const c = encoded("30", [field("01"), field("4321", true), field("1500")]);
  const dialed = dial(c, DEFAULT_CONFIG, 7);
  const shown = display(c, DEFAULT_CONFIG, 7);
  const pinSegment = dialed.slice("*444*30*".length).split("*")[1];
  assert.ok(dialed.includes(pinSegment));
  assert.ok(!shown.includes(pinSegment));
  assert.ok(shown.includes("••••"));
  assert.ok(hasSecret(c));
});

test("plain display masks the transfer key", () => {
  const c = plain([field("234"), field("1"), field("55555555"), field("9876", true), field("25")]);
  assert.equal(dial(c), "*234*1*55555555*9876*25#");
  assert.equal(display(c), "*234*1*55555555*••••*25#");
});
