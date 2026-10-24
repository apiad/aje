// The parameter encoding the *444 USSD service expects.
//
// Each "*"-separated digit segment is mapped through a fixed 100-entry keystream and
// XORed with a window of it that starts at a random two-digit seed. The output is the
// seed, then each segment as its two-digit length followed by its encoded value. This
// is a wire format, not encryption: anyone with the keystream can reverse it.

const CODE_VERSION = "372653282298718711";
const CRUDE_CODE =
  "10000110101100011000100100100000110010001100000011100010100110010001010010100010111110001100010000011000010101100000000110001100101010100100011000000101110001100001100010001011110001100010100001000110000001101000101001001101001000001000010001100100011010010111001000110011110010001001100001000100000010000111001000110000101110100001111110011000001000110010000111110001100001111111000110011000101001100101000110001000111100011000101011101011111100111010100010111101000110000110011000110011100011000100111000101000011100010100111000011101100011000010101010000010101000100010100011001010101101000110001011101100011001001101101001111100011000000100010001100100010110101000110110000110000101000100011000000010100000010010001101011011100010110001110001001011100000110110001100001000011001011010100101100010001100100011110100011000011000110001100101010110101011110001100010000101000110001001101010010001001110001000010110110001100100111010001101101000110010010110001000110101000011110110000011101000110001001001100100010010000001111000110010011101110001100000001011000110000100011001111101000110000010010100011000110111100101100101011001100000010011000110000000001000100111100011000101101000100100000100010010101000100011100011000001101110001110011000101001";

// Text parameters (names, a matrix coordinate) are not XORed: each character becomes the two
// digits of this table, and the segment's length is written as 00.
const TEXT_CODES = new Map(Object.entries({".": "15", "-": "85", "_": "58", "0": "37", "/": "11", ",": "29", "%": "67", "&": "20", "a": "59", "b": "00", "c": "82", "1": "89", "A": "05", "B": "54", "C": "60", "á": "88", "@": "64", "d": "51", "e": "93", "h": "50", "2": "41", "D": "57", "E": "65", "F": "61", "é": "91", "#": "08", "g": "30", "f": "46", "i": "97", "3": "80", "G": "83", "H": "13", "I": "55", "í": "53", ";": "56", "j": "76", "k": "25", "l": "42", "4": "66", "J": "73", "K": "17", "L": "38", "ó": "32", "m": "27", "n": "92", "o": "12", "ñ": "03", "5": "01", "M": "06", "N": "49", "O": "18", "Ñ": "33", "p": "98", "q": "23", "r": "31", "6": "94", "P": "44", "Q": "35", "R": "34", "ú": "87", "s": "19", "t": "45", "u": "81", "7": "62", "S": "22", "T": "40", "U": "10", "v": "96", "w": "69", "x": "75", "8": "24", "V": "14", "W": "70", "X": "74", "y": "09", "z": "90", " ": "78", "9": "72", "Y": "71", "Z": "07", "Á": "99", "É": "86", "Í": "47", "Ó": "36", "Ú": "39", "ü": "77", "Ü": "95"}));

const keystream = buildKeystream();
const digitTable = keystream.filter((v) => v < 10).slice(0, 10);

export const KEYSTREAM_SIZE = keystream.length;

export function randomSeed() {
  return Math.floor(Math.random() * 100);
}

/** Encodes a "*"-joined digit parameter list before dialing. */
export function code(params, seed = randomSeed()) {
  return pad2(seed) + segments(params.split("*"), seed).join("*");
}

/** Each segment encoded and prefixed with its length, without the leading seed. */
export function segments(parts, seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 99) throw new RangeError(`seed must be 0..99, got ${seed}`);
  return parts.map((p) => (/^[0-9]+$/.test(p) ? pad2(p.length) + encryptToken(seed, p) : "00" + encodeText(p)));
}

function encryptToken(seed, token) {
  if (!/^[0-9]+$/.test(token)) throw new RangeError(`only digit segments are supported, got "${token}"`);
  const msg = transform(token);
  // The service XORs in a 64-bit integer; past 18 digits it would overflow, so refuse.
  if (msg.length > 18) throw new RangeError(`segment of ${token.length} digits is too long for the wire format`);
  const key = window(seed, token.length).join("").slice(0, msg.length);
  // 18 digits do not fit in a Number, so the XOR runs on BigInt.
  return (BigInt(key) ^ BigInt(msg)).toString();
}

function encodeText(token) {
  return [...token].map((c) => {
    const v = TEXT_CODES.get(c);
    if (v === undefined) throw new RangeError(`the character "${c}" cannot be sent`);
    return v;
  }).join("");
}

function transform(token) {
  let out = "";
  const even = token.length % 2 === 0;
  const body = even ? token : token.slice(0, -1);
  for (let j = 0; j < body.length; j += 2) out += pad2(keystream[Number(body.slice(j, j + 2))]);
  if (!even) out += digitTable[Number(token.at(-1))];
  return out;
}

function window(seed, length) {
  const win = [];
  let pos = seed;
  for (let i = 0; i < length; i++) {
    if (pos === keystream.length - 1) {
      win.push(keystream[0]);
      pos = 1;
    } else if (pos >= 0 && pos < keystream.length) {
      win.push(keystream[pos]);
      pos += 1;
    }
  }
  return win;
}

function buildKeystream() {
  const out = [];
  let bits = CRUDE_CODE;
  let i = 0;
  while (bits.length > 0) {
    const skip = Number(CODE_VERSION[i]);
    bits = skip >= bits.length ? "" : bits.slice(skip);
    if (bits.length < 8) break;
    out.push(parseInt(bits.slice(0, 8), 2));
    bits = bits.slice(8);
    i = (i + 1) % CODE_VERSION.length;
  }
  return out;
}

function pad2(v) {
  return String(v).padStart(2, "0");
}
