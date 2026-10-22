import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { code, KEYSTREAM_SIZE, segments } from "../core/encoder.js";

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

test("a non-digit segment goes as text; characters outside the table are refused", () => {
  assert.equal(code("CUP*1", 1).split("*")[0], "01" + "00" + segments(["CUP"], 1)[0].slice(2));
  assert.throws(() => code("1*\u{1F600}", 1), RangeError);
});

test("refuses a segment that would overflow 64 bits", () => {
  assert.throws(() => code("1234567890123456789", 1), RangeError);
});

test("refuses a seed outside two digits", () => {
  assert.throws(() => code("1", 100), RangeError);
});

test("a text segment is 00 then two digits per character, from the text table", () => {
  assert.deepEqual(segments(["D7"], 5), ["005762"]);
  assert.deepEqual(segments(["Ana"], 5), ["00" + "05" + segments(["n"], 5)[0].slice(2) + "59"]);
  assert.throws(() => segments(["D7\u{1F600}"], 5), RangeError);
});

test("digit and text segments mix in one list", () => {
  const [num, txt] = segments(["1234", "Gil"], 9);
  assert.equal(num, segments(["1234"], 9)[0]);
  assert.match(txt, /^00\d{6}$/);
});
