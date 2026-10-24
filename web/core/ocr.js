// What the scanner does with each frame's text: find a card number the bank rule accepts,
// and accept it only once consecutive frames agree, since a card number carries no check digit.
import { classifyPan } from "./money.js";

/** The first 16-digit run, allowing spaces between groups of four, that names a known bank; else null. */
export function panFromText(text) {
  for (const m of text.matchAll(/\d{4}[ ]?\d{4}[ ]?\d{4}[ ]?\d{4}/g)) {
    const c = classifyPan(m[0]);
    if (!c.error && c.bank) return c.pan;
  }
  return null;
}

/**
 * The first run of digits, allowing single spaces or dashes between groups, whose length is one
 * of `digits`; else null. A bill number carries no check digit either, so the vote decides.
 */
export function billNumberFromText(text, digits) {
  for (const m of text.matchAll(/\d(?:[ -]?\d)*/g)) {
    const n = m[0].replace(/[ -]/g, "");
    if (digits.includes(n.length)) return n;
  }
  return null;
}

/** A vote over reads: returns the number once it is seen in `n` consecutive reads, else null. */
export function createVote(n = 2) {
  let last = null;
  let count = 0;
  return (pan) => {
    count = pan !== null && pan === last ? count + 1 : pan === null ? 0 : 1;
    last = pan;
    return count >= n ? pan : null;
  };
}
