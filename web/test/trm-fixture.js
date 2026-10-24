// Builds Transfermóvil backups for tests, with node:crypto. Every value put in one is made up.
import { createCipheriv, createHash, randomInt } from "node:crypto";
import { FIELD_KEY } from "../core/trm.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const sha256 = (text) => createHash("sha256").update(text, "ascii").digest();

export function ecbEncrypt(key, data) {
  const c = createCipheriv("aes-256-ecb", key, null);
  return Buffer.concat([c.update(data), c.final()]);
}

/** A backup's text: its own 128-char key, the SHA-512 of the JSON, then the JSON under AES-256-ECB. */
export function makeBackup(json, { tamper = false } = {}) {
  const key = Array.from({ length: 128 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const plain = JSON.stringify(json);
  let hash = createHash("sha512").update(plain, "utf8").digest("hex");
  if (tamper) hash = (hash[0] === "0" ? "1" : "0") + hash.slice(1);
  return key + hash + ecbEncrypt(sha256(key), Buffer.from(plain, "utf8")).toString("base64");
}

/** A card or account number as the backup stores it. */
export const encField = (plain) => ecbEncrypt(sha256(FIELD_KEY), Buffer.from(plain, "utf8")).toString("base64");

/** The JSON of a backup holding these tables. */
export const tables = (map, exportedAt = "23/10/2026 18:44:20") => ({
  version_apk: "test", fecha_exp: exportedAt, cantidad_tablas: Object.keys(map).length, scheme: [],
  datos: Object.entries(map).map(([tabla, dataJSON]) => ({ tabla, dataJSON })),
});
