// Redaction for telemetry. A text keeps its layout and the words of a closed vocabulary; any
// other word becomes ‹w›, and a word with a digit keeps only its shape (# for digits, A and a for
// letters). A name never in the vocabulary is redacted without anyone having to recognize it.
// telemetry/collector.py repeats this on the server; web/test/fixtures/redact-vectors.json pins both.

import { WORDS } from "./vocab.js";

export const VOCAB = new Set(WORDS);

const MAX_FRAMES = 20;

/** Lowercase without accents, the form the vocabulary is written in. */
export const fold = (word) => word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function redact(text, vocab = VOCAB) {
  // ‹w› is already redacted: redacting twice (phone, then collector) gives the same text.
  return text.split(/(‹w›|[\p{L}\p{N}\p{M}]+)/u).map((token, i) => {
    if (i % 2 === 0 || token === "‹w›") return token;
    if (/\p{N}/u.test(token)) return token.replace(/\p{N}/gu, "#").replace(/\p{Lu}/gu, "A").replace(/[\p{Ll}\p{Lo}\p{Lm}\p{Lt}]/gu, "a");
    return vocab.has(fold(token)) ? token : "‹w›";
  }).join("");
}

/**
 * A *133 menu, which is the network's public catalog: like redact, but option numbers and prices keep
 * their digits. A run of 8 or more digits, which could be a phone number, still becomes #.
 */
export function redactMenu(text, vocab = VOCAB) {
  const masked = text.replace(/\p{N}(?:[ .-]?\p{N}){7,}/gu, (run) => run.replace(/\p{N}/gu, "#"));
  return masked.split(/(‹w›|[\p{L}\p{N}\p{M}]+)/u).map((token, i) => {
    if (i % 2 === 0 || token === "‹w›") return token;
    if (/\p{N}/u.test(token)) return token.replace(/\p{Lu}/gu, "A").replace(/[\p{Ll}\p{Lo}\p{Lm}\p{Lt}]/gu, "a");
    return vocab.has(fold(token)) ? token : "‹w›";
  }).join("");
}

/** A V8 stack as `function@file:line:col` lines, relative to web/, at most 20. */
export function reduceStack(stack) {
  const frames = [];
  for (const line of String(stack).split("\n")) {
    const m = /^\s*at (?:(.+?) \((.+)\)|(.+))$/.exec(line);
    if (!m) continue;
    const fn = m[1] ?? "<anonymous>";
    const where = (m[2] ?? m[3]).replace(/^.*\/assets\/web\//, "").replace(/^[a-z]+:\/\/.*\//, "");
    frames.push(`${fn}@${where}`);
    if (frames.length === MAX_FRAMES) break;
  }
  return frames.join("\n");
}
