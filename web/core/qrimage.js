// A charge's QR as a module matrix and an SVG, drawn by the vendored qrcode-generator.
import qrcode from "../vendor/qr/qrcode.mjs";

/** The QR of `text` as rows of booleans, true for a dark module; error correction M. */
export function qrMatrix(text) {
  const qr = qrcode(0, "M");
  qr.addData(new TextEncoder().encode(text).reduce((s, b) => s + String.fromCharCode(b), ""), "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => qr.isDark(y, x)));
}

/** An SVG of the QR with a 4-module quiet zone, one path for the dark modules, scaled by CSS. */
export function qrSvg(text) {
  const m = qrMatrix(text);
  const size = m.length + 8;
  let d = "";
  m.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
