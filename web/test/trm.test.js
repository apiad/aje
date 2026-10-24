import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { aesEcbDecrypt, openEnvelope, readBackup } from "../core/trm.js";
import { ecbEncrypt, encField, makeBackup, tables } from "./trm-fixture.js";

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

const read = (map) => readBackup(makeBackup(tables(map)));
const mc = (pan, over = {}) => ({ id: 1, cuenta: encField(pan), alias: "", tipo_moneda: "CUP", agencia: "", ...over });

test("own cards: bank from the number, currency from the backup, alias kept or made", async () => {
  const b = await read({ MCBank: [
    mc("9227959900000001", { alias: "Nómina", agencia: "Metropolitano" }),
    mc("9760030000000002", { alias: "  ", tipo_moneda: "USD", agencia: "MiTransfer" })] });
  assert.equal(b.exportedAt, "23/10/2026 18:44:20");
  assert.deepEqual(b.cards, [
    { pan: "9227959900000001", alias: "Nómina", bank: "METROPOLITANO", currency: "CUP", reason: null },
    { pan: "9760030000000002", alias: "Tarjeta Clásica ····0002", bank: "CLASICA", currency: "USD", reason: null }]);
});

test("MLC counts as USD; an unknown currency falls back to the number's", async () => {
  const b = await read({ MCBank: [mc("9227959900000001", { tipo_moneda: "MLC" }), mc("9227069900000003", { tipo_moneda: "EUR" })] });
  assert.deepEqual(b.cards.map((c) => c.currency), ["USD", "CUP"]);
});

test("cards Ajé cannot operate carry the reason", async () => {
  const b = await read({ MCBank: [mc("9760040000000004"), mc("0500000000000010"), mc("9227009900000005")] });
  assert.deepEqual(b.cards.map((c) => c.reason), ["Clásica empresarial", "Número de cuenta, no de tarjeta", "Banco desconocido"]);
  assert.deepEqual(b.cards.map((c) => c.pan), ["9760040000000004", "0500000000000010", "9227009900000005"]);
});

test("a card in MCBank and TarjetaPropia is one row", async () => {
  const b = await read({
    MCBank: [mc("9227959900000001", { alias: "Nómina" })],
    TarjetaPropia: [{ id: 1, serie: "9227959900000001", descripcion: "Otra", tipo_moneda: "CUP" }, { id: 2, serie: "9227069900000003", descripcion: "Ahorro", tipo_moneda: "CUP" }] });
  assert.deepEqual(b.cards.map((c) => [c.pan, c.alias]), [["9227959900000001", "Nómina"], ["9227069900000003", "Ahorro"]]);
});

test("recipients, bills, ONAT, phones, landlines and Nauta map their columns", async () => {
  const b = await read({
    CuentaBanco: [{ id: 1, cuenta: encField("9227959900000009"), descripcion: "Ana", movil: "51234567" }],
    Factura: [0, 1, 2, 3, 7].map((t, i) => ({ id: i, tipo_factura: t, factura: `10000${i}`, cod_factura: `C${i}` })),
    ServicioPublico: [{ id: 1, tipo_servicio: 0, cod_servicio: "RC05", valor: "12345678901" }],
    TeflMovil: [{ id: 1, number: "51234567" }], TelfFijo: [{ id: 1, number: "71234567" }],
    Nauta: [{ id: 1, cuenta: "ana.perez", tipo_cuenta: 1 }] });
  assert.deepEqual(b.recipients, [{ name: "Ana", account: "9227959900000009", phone: "51234567" }]);
  assert.deepEqual(b.bills.map((x) => x.kind), ["phone", "electricity", "water", "gas", null]);
  assert.deepEqual(b.bills[1], { kind: "electricity", type: 1, contract: "100001", code: "C1" });
  assert.deepEqual(b.onat, [{ nit: "12345678901" }]);
  assert.deepEqual(b.phones, [{ number: "51234567" }]);
  assert.deepEqual(b.landlines, [{ number: "71234567" }]);
  assert.deepEqual(b.nauta, [{ user: "ana.perez", type: 1 }]);
  assert.equal(b.unreadable, 0);
});

test("Pin and AOperKey never reach the result", async () => {
  const b = await read({ Pin: [{ pin: "1234" }], AOperKey: [{ k: "s3cret" }], TeflMovil: [{ number: "51234567" }] });
  const out = JSON.stringify(b);
  assert.equal(out.includes("1234"), true, "the phone number is there");
  assert.equal(out.includes('"1234"'), false);
  assert.equal(out.includes("s3cret"), false);
});

test("a row that does not decrypt is unreadable, the rest reads", async () => {
  const b = await read({
    MCBank: [mc("9227959900000001"), { id: 2, cuenta: "not base64!", alias: "x" }, { id: 3, cuenta: "AAAA", alias: "y" }, { id: 4, alias: "no number" }],
    TarjetaPropia: [{ id: 1, serie: "1234", descripcion: "corta" }],
    TeflMovil: [{ id: 1 }] });
  assert.equal(b.cards.length, 1);
  assert.equal(b.unreadable, 5);
});

test("a backup with only RecordSMS is 'empty'", async () => {
  await assert.rejects(read({ RecordSMS: [{ id: 1, fecha: "x", tipo_servicio: "Agentes" }] }), { code: "empty" });
  await assert.rejects(readBackup(makeBackup({ datos: [] })), { code: "empty" });
});

test("an unknown table is skipped", async () => {
  const b = await read({ Futura: [{ a: 1 }], TeflMovil: [{ number: "51234567" }] });
  assert.equal(b.phones.length, 1);
  assert.equal(b.unreadable, 0);
});

test("a JSON that is not a backup is 'format'", async () => {
  await assert.rejects(readBackup(makeBackup([1, 2])), { code: "format" });
  await assert.rejects(readBackup(makeBackup({ datos: "x" })), { code: "format" });
});
