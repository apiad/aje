import { randomSeed, segments } from "./encoder.js";

/** The access code and client version the service expects, with their current defaults. */
export const DEFAULT_CONFIG = { accessCode: "444", version: "1260416" };

export const MASK = "••••";

/** One parameter. A secret one (a PIN or a transfer key) is masked wherever the code is shown. */
export const field = (value, secret = false) => ({ value, secret });

/** `*444*op#`: an operation with no parameters. */
export const bare = (op) => ({ kind: "bare", op });

/** `*444*op*code(params)*version#`. */
export const encoded = (op, fields) => ({ kind: "encoded", op, fields });

/** A public ETECSA code sent as typed, such as `*222*328#`. */
export const plain = (parts) => ({ kind: "plain", parts });

export function hasSecret(code) {
  return (code.fields ?? code.parts ?? []).some((f) => f.secret);
}

/** The string handed to the telephony layer. The only output that may contain a secret. */
export function dial(code, config = DEFAULT_CONFIG, seed = randomSeed()) {
  return render(code, config, seed, false);
}

/** The string safe to show and to persist: secret fields replaced by a mask. */
export function display(code, config = DEFAULT_CONFIG, seed = randomSeed()) {
  return render(code, config, seed, true);
}

function render(code, config, seed, masked) {
  switch (code.kind) {
    case "bare":
      return `*${config.accessCode}*${code.op}#`;
    case "encoded": {
      const segs = segments(code.fields.map((f) => f.value), seed)
        .map((s, i) => (masked && code.fields[i].secret ? MASK : s));
      return `*${config.accessCode}*${code.op}*${String(seed).padStart(2, "0")}${segs.join("*")}*${config.version}#`;
    }
    case "plain":
      return "*" + code.parts.map((p) => (masked && p.secret ? MASK : p.value)).join("*") + "#";
  }
  throw new TypeError(`unknown code kind: ${code.kind}`);
}
