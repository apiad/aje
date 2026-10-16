import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { code, KEYSTREAM_SIZE } from "../core/encoder.js";

test("reproduces the two device captures", () => {
  assert.equal(code("1*0000", 61), "61012*046615");
  assert.equal(code("3*0000", 64), "640111*047936");
});

test("matches the reference on every vector", () => {
  const text = readFileSync(new URL("./fixtures/encoder-vectors.tsv", import.meta.url), "utf8");
  const lines = text.trim().split("\n");
  assert.equal(lines.length, 1600);
  for (const line of lines) {
    const [params, seed, expected] = line.split("\t");
    assert.equal(code(params, Number(seed)), expected, `params=${params} seed=${seed}`);
  }
});

test("the keystream has one hundred entries", () => {
  assert.equal(KEYSTREAM_SIZE, 100);
});

test("refuses non-digit segments", () => {
  assert.throws(() => code("150.50", 1), RangeError);
  assert.throws(() => code("CUP*1", 1), RangeError);
});

test("refuses a segment that would overflow 64 bits", () => {
  assert.throws(() => code("1234567890123456789", 1), RangeError);
});

test("refuses a seed outside two digits", () => {
  assert.throws(() => code("1", 100), RangeError);
});
