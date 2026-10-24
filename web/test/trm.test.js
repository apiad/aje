import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { aesEcbDecrypt, openEnvelope } from "../core/trm.js";
import { ecbEncrypt, makeBackup } from "./trm-fixture.js";

test("the envelope opens with its own key", async () => {
  const json = { version_apk: "x", cantidad_tablas: 1, scheme: [], datos: [{ tabla: "Nauta", dataJSON: [{ cuenta: "ana.perez", tipo_cuenta: 1 }] }] };
  assert.deepEqual(await openEnvelope(makeBackup(json)), json);
});

test("a BOM, CRLF and a trailing newline are ignored", async () => {
  const t = makeBackup({ datos: [] });
  assert.deepEqual(await openEnvelope("﻿" + t + "\r\n"), { datos: [] });
});

test("text outside ASCII survives the round trip", async () => {
  const json = { datos: [{ tabla: "MCBank", dataJSON: [{ alias: "Nómina ñ" }] }] };
  assert.deepEqual(await openEnvelope(makeBackup(json)), json);
});

test("a wrong hash is 'hash'", async () => {
  await assert.rejects(openEnvelope(makeBackup({ datos: [] }, { tamper: true })), { code: "hash" });
});

test("any other text is 'format'", async () => {
  const t = makeBackup({ datos: [] });
  for (const bad of ["", "hola", "x".repeat(300), "a".repeat(256) + "!!!", t.slice(0, 200) + "Z" + t.slice(201), t.slice(0, -4)])
    await assert.rejects(openEnvelope(bad), { code: "format" }, JSON.stringify(bad.slice(0, 20)));
});

test("aesEcbDecrypt matches node's aes-256-ecb on 1, 2 and 7 blocks", async () => {
  const key = createHash("sha256").update("k").digest();
  for (const n of [0, 5, 16, 17, 100]) {
    const plain = randomBytes(n);
    const out = await aesEcbDecrypt(new Uint8Array(key), new Uint8Array(ecbEncrypt(key, plain)));
    assert.deepEqual(Buffer.from(out), plain, `length ${n}`);
  }
});

test("aesEcbDecrypt refuses a length that is not whole blocks", async () => {
  await assert.rejects(aesEcbDecrypt(new Uint8Array(32), new Uint8Array(15)), { code: "format" });
  await assert.rejects(aesEcbDecrypt(new Uint8Array(32), new Uint8Array(0)), { code: "format" });
});
