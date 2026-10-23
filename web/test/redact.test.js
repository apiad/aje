import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VOCAB, fold, redact, reduceStack } from "../core/redact.js";
import { SMS, PLAN, PREPAID_REPLY, POSTPAID_REPLY } from "./helpers.js";

const read = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const VECTORS = JSON.parse(read("redact-vectors.json"));

test("each shared vector redacts to its expected text", () => {
  for (const { in: text, out } of VECTORS) assert.equal(redact(text, VOCAB), out);
});

test("the known templates leave no digit and no word outside the vocabulary", () => {
  for (const text of [...Object.values(SMS), ...Object.values(PLAN), PREPAID_REPLY, POSTPAID_REPLY]) {
    const out = redact(text, VOCAB);
    assert.doesNotMatch(out, /\p{Nd}/u);
    assert.doesNotMatch(out, /‹w›/u, `a template word is missing from the vocabulary: ${out}`);
  }
});

test("no vocabulary word is a common given name or surname", () => {
  const names = new Set(read("common-names.txt").split("\n").filter((l) => l && !l.startsWith("#")));
  assert.deepEqual([...VOCAB].filter((w) => names.has(w)), []);
});

test("vocabulary words match without case or accents", () => {
  assert.equal(fold("TRANSACCIÓN"), "transaccion");
  assert.equal(redact("Operación MÓVIL", VOCAB), "Operación MÓVIL");
});

test("a stack keeps function, file, line and column, without the app's origin", () => {
  const stack = "TypeError: x is 5\n" +
    "    at parseBalance (https://appassets.androidplatform.net/assets/web/core/ops.js:88:14)\n" +
    "    at https://appassets.androidplatform.net/assets/web/app.js:10:3\n" +
    "    at new Promise (<anonymous>)";
  assert.equal(reduceStack(stack), "parseBalance@core/ops.js:88:14\n<anonymous>@app.js:10:3\nnew Promise@<anonymous>");
});

test("a stack is cut to 20 frames", () => {
  const stack = Array.from({ length: 30 }, (_, i) => `    at f${i} (https://appassets.androidplatform.net/assets/web/a.js:${i}:1)`).join("\n");
  assert.equal(reduceStack(stack).split("\n").length, 20);
});
