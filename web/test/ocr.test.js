import { test } from "node:test";
import assert from "node:assert/strict";
import { createVote, panFromText } from "../core/ocr.js";

test("panFromText finds 16 digits in groups of four and checks the bank", () => {
  assert.equal(panFromText("BANCO\n9227 9599 0000 0001\nVALID 10/29"), "9227959900000001");
  assert.equal(panFromText("9227959900000001"), "9227959900000001");
  assert.equal(panFromText("9227 7799 0000 0001"), null);
  assert.equal(panFromText("0000"), null);
  assert.equal(panFromText(""), null);
});

test("createVote needs two equal reads in a row and resets on a different one", () => {
  const vote = createVote();
  assert.equal(vote("9227959900000001"), null);
  assert.equal(vote("9227959900000002"), null);
  assert.equal(vote(null), null);
  assert.equal(vote("9227959900000002"), null);
  assert.equal(vote("9227959900000002"), "9227959900000002");
});

import { openScanner } from "../ui/scanner.js";

const fakeBox = () => ({ isConnected: true, replaceChildren() {}, append() {}, set textContent(v) { this.text = v; } });

test("scanner without camera", async () => {
  for (const media of [undefined, { getUserMedia: () => Promise.reject(new Error("NotAllowedError")) }]) {
    const called = await new Promise((resolve, reject) => {
      const stop = openScanner(fakeBox(), { media, onPan: () => reject(new Error("no pan expected")), onFallback: (best) => resolve(best ?? "none") });
      assert.equal(typeof stop, "function");
    });
    assert.equal(called, "none");
  }
});
