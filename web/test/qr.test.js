import { test } from "node:test";
import assert from "node:assert/strict";
import { chargeUri, parseCharge } from "../core/qr.js";

test("a charge round-trips through its QR text", () => {
  const text = chargeUri({ number: "55555555", amount: 150, name: "Ana" });
  assert.equal(text, "aje:saldo?v=1&n=55555555&m=150&a=Ana");
  assert.deepEqual(parseCharge(text), { ok: true, number: "55555555", amount: 150, name: "Ana" });
});

test("amount and name are optional", () => {
  const text = chargeUri({ number: "65555555" });
  assert.equal(text, "aje:saldo?v=1&n=65555555");
  assert.deepEqual(parseCharge(text), { ok: true, number: "65555555", amount: null, name: null });
});

test("a name round-trips", () => {
  const name = "Ñico & Cía = 😀";
  assert.equal(parseCharge(chargeUri({ number: "55555555", name })).name, name);
  assert.equal(parseCharge(chargeUri({ number: "55555555", name: "x".repeat(60) })).name.length, 40);
});

test("parseCharge refuses what it cannot pay", () => {
  assert.deepEqual(parseCharge("aje:saldo?v=2&n=55555555"), { ok: false, reason: "newer" });
  for (const t of ["https://example.com/?n=55555555", "TRANSFERMOVIL_ETECSA,9200000000000001", "", "aje:otra?v=1&n=55555555"]) {
    assert.deepEqual(parseCharge(t), { ok: false, reason: "not-aje" }, t);
  }
  for (const t of ["aje:saldo?v=1&n=7555555", "aje:saldo?v=1&n=55555555&m=10.5", "aje:saldo?v=1&n=55555555&m=-5",
    "aje:saldo?v=1&n=55555555&m=0", "aje:saldo?v=1&m=10", "aje:saldo?n=55555555"]) {
    assert.deepEqual(parseCharge(t), { ok: false, reason: "bad" }, t);
  }
});

// The QR on screen is read back by the same decoder the scanner uses.
test("qrSvg draws a QR that jsQR reads back", async () => {
  const { qrMatrix, qrSvg } = await import("../core/qrimage.js");
  // The reader is a UMD script the WebView loads with <script>; here it runs with a CommonJS module.
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(new URL("../vendor/qr/jsQR.js", import.meta.url), "utf8"), { module, exports: module.exports });
  const jsQR = module.exports.default ?? module.exports;
  const text = chargeUri({ number: "55555555", amount: 150, name: "Ñico" });
  assert.match(qrSvg(text), /^<svg[^>]*viewBox="0 0 \d+ \d+"/);
  // Rasterize the module matrix at 4 px per module with a 4-module quiet zone, as RGBA.
  const m = qrMatrix(text);
  const scale = 4, quiet = 4, size = (m.length + 2 * quiet) * scale;
  const px = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) {
    if (!m[y][x]) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }
  assert.equal(jsQR(px, size, size)?.data, text);
});
