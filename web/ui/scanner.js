// The card scanner: a camera viewfinder whose frames go through Tesseract.js, vendored under
// web/vendor/tesseract/ so nothing is fetched from the network. A number is accepted once two
// consecutive frames read the same one; frames stay in memory and are dropped as they are read.
import { createVote, panFromText } from "../core/ocr.js";
import { h } from "./dom.js";

const VENDOR = new URL("../vendor/tesseract/", import.meta.url).href;
const EVERY_MS = 400;

let worker = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}

/** One Tesseract worker for the app's life, reading digits and spaces only. */
export function ocrWorker() {
  worker ??= (async () => {
    if (!globalThis.Tesseract) await loadScript(`${VENDOR}tesseract.min.js`);
    const w = await globalThis.Tesseract.createWorker("eng", 1, {
      workerPath: `${VENDOR}worker.min.js`, corePath: `${VENDOR}tesseract-core-simd-lstm.wasm.js`,
      langPath: VENDOR.replace(/\/$/, ""), gzip: false, workerBlobURL: false,
    });
    await w.setParameters({ tessedit_char_whitelist: "0123456789 ", tessedit_pageseg_mode: "6" });
    return w;
  })();
  return worker;
}

/**
 * The band of a card image where the number is printed, in grey: the lower middle of the card,
 * from 45% to 80% of its height. `card` is the card's rectangle within the source.
 */
export function numberBand(source, card) {
  const y = card.y + card.h * 0.45;
  const bh = card.h * 0.35;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(card.w);
  canvas.height = Math.round(bh);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.filter = "grayscale(1)";
  g.drawImage(source, card.x, y, card.w, bh, 0, 0, canvas.width, canvas.height);
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  binarize(img.data, canvas.width, canvas.height);
  g.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Adaptive threshold: a pixel brighter than the mean of its neighbourhood by a margin is ink.
 * Card digits are light on a dark card; the output is dark ink on white, as Tesseract prefers,
 * and a glare band raises the local mean with the digits under it, so they survive it.
 */
function binarize(px, w, h) {
  const r = Math.max(8, Math.round(h / 4));
  const sum = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += px[(y * w + x) * 4];
      sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const area = (y1 - y0) * (x1 - x0);
      const mean = (sum[y1 * (w + 1) + x1] - sum[y0 * (w + 1) + x1] - sum[y1 * (w + 1) + x0] + sum[y0 * (w + 1) + x0]) / area;
      out[y * w + x] = px[(y * w + x) * 4] > mean + 18 ? 0 : 255;
    }
  }
  for (let i = 0; i < w * h; i++) px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = out[i];
}

/** The frame's rectangle in grey, as it is: a paper bill is dark ink on white, which Tesseract reads well. */
export function paperFrame(source, rect) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(rect.w);
  canvas.height = Math.round(rect.h);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.filter = "grayscale(1)";
  g.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** The text Tesseract reads in a canvas or image. */
export async function readText(image) {
  const { data } = await (await ocrWorker()).recognize(image);
  return data.text;
}

/**
 * Opens the camera in `box` and reads frames until a number is accepted (`onPan`), the
 * person gives up after `timeoutMs` without one, or there is no camera (`onFallback`, with the
 * best number read so far or null). Returns a function that stops the camera. A card number by
 * default; `parse` and `crop` read another kind of number, such as a bill's.
 */
export function openScanner(box, { onPan, onFallback, timeoutMs = 8000, media = globalThis.navigator?.mediaDevices, parse = panFromText, crop = numberBand } = {}) {
  let stopped = false;
  let stream = null;
  let timer = null;
  let best = null;
  const vote = createVote(2);
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    for (const t of stream?.getTracks() ?? []) t.stop();
  };
  const fallback = () => {
    if (stopped) return;
    stop();
    onFallback?.(best);
  };

  if (!media?.getUserMedia) {
    queueMicrotask(fallback);
    return stop;
  }
  box.textContent = "Abriendo la cámara…";
  media.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false }).then(async (s) => {
    stream = s;
    if (stopped) return stop();
    const video = h("video", { playsinline: true, muted: true });
    const read = h("div", { class: "read", id: "scan-read" });
    video.srcObject = s;
    box.replaceChildren(video, h("div", { class: "frame" }), read);
    await video.play();
    timer = setTimeout(fallback, timeoutMs);
    while (!stopped && box.isConnected) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      // The frame on screen is inset 14% by 7%; the card fills it.
      const card = { x: vw * 0.07, y: vh * 0.14, w: vw * 0.86, h: vh * 0.72 };
      const text = vw ? await readText(crop(video, card)).catch(() => "") : "";
      const pan = parse(text);
      if (pan) best = pan;
      read.textContent = pan ? pan.replace(/(\d{4})(?=\d)/g, "$1 ") : "";
      const accepted = vote(pan);
      if (accepted && !stopped) {
        stop();
        return onPan?.(accepted);
      }
      await new Promise((r) => setTimeout(r, EVERY_MS));
    }
    stop();
  }).catch(fallback);
  return stop;
}
