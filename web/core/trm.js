// Reading a Transfermóvil backup (.trm), the file its "Respaldo" option writes. The backup carries
// its own key: 128 ASCII characters, then the lowercase hex SHA-512 of the JSON, then the JSON as
// base64 of AES-256-ECB under the SHA-256 of those 128 characters. Card and account numbers inside
// are encrypted again the same way, under the SHA-256 of FIELD_KEY.

export const FIELD_KEY = "708091521823824654864548452244";

const KEY_LENGTH = 128;
const HASH_END = 256;
const BLOCK = 16;

export class BackupError extends Error {
  /** `code` is "format" (not a backup), "hash" (damaged) or "empty" (nothing to import). */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const ascii = (text) => new TextEncoder().encode(text);
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", ascii(text)));
}

export function fromBase64(text) {
  let bin;
  try { bin = atob(text); } catch { throw new BackupError("format"); }
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** AES-256-ECB decryption with PKCS#7 removed, on WebCrypto, which has no ECB mode. */
export async function aesEcbDecrypt(key, data) {
  if (data.length === 0 || data.length % BLOCK) throw new BackupError("format");
  // Through AES-CBC: with IV 0, CBC yields X_i = D(C_i) xor C_(i-1), so D(C_i) = X_i xor C_(i-1).
  // CBC checks the padding of its last block, so append the CBC encryption of nothing under IV C_n:
  // it decrypts to a full block of 0x10, which CBC strips. Then strip the ECB plaintext's own PKCS#7.
  const k = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["encrypt", "decrypt"]);
  const pad = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: data.slice(-BLOCK) }, k, new Uint8Array(0)));
  const joined = new Uint8Array(data.length + pad.length);
  joined.set(data);
  joined.set(pad, data.length);
  const x = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: new Uint8Array(BLOCK) }, k, joined));
  for (let i = BLOCK; i < x.length; i++) x[i] ^= data[i - BLOCK];
  const n = x[x.length - 1];
  if (n < 1 || n > BLOCK || x.subarray(x.length - n).some((b) => b !== n)) throw new BackupError("format");
  return x.subarray(0, x.length - n);
}

/** The backup's JSON, checked against its hash. Throws BackupError "format" or "hash". */
export async function openEnvelope(text) {
  const t = text.replace(/^﻿/, "").replace(/\s+/g, "");
  const key = t.slice(0, KEY_LENGTH);
  const hash = t.slice(KEY_LENGTH, HASH_END);
  if (t.length <= HASH_END || !/^[\x21-\x7e]+$/.test(key) || !/^[0-9a-f]{128}$/.test(hash)) throw new BackupError("format");
  const plain = await aesEcbDecrypt(await sha256(key), fromBase64(t.slice(HASH_END)));
  let json;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    throw new BackupError("format");
  }
  if (hex(new Uint8Array(await crypto.subtle.digest("SHA-512", ascii(json)))) !== hash) throw new BackupError("hash");
  try {
    return JSON.parse(json);
  } catch {
    throw new BackupError("format");
  }
}
