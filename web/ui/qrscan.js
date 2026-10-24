// The QR tab: a camera viewfinder whose frames go to jsQR. An Ajé charge opens Enviar saldo filled in
// with its number, name and amount; the person still taps Enviar and gives the key.
import { parseCharge } from "../core/qr.js";
import { h } from "./dom.js";

const MESSAGES = {
  "not-aje": "Este QR no es de Ajé para recibir saldo",
  newer: "Actualiza Ajé para leer este QR",
  bad: "Este QR de Ajé está incompleto",
};
const EVERY_MS = 250;

/** jsQR is a classic script, loaded once on first use. */
let reader = null;
function loadReader() {
  reader ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = new URL("../vendor/qr/jsQR.js", import.meta.url).href;
    s.onload = () => resolve(globalThis.jsQR);
    s.onerror = () => { reader = null; reject(new Error("jsQR did not load")); };
    document.head.append(s);
  });
  return reader;
}

export function renderQrScan(ctx) {
  const msg = h("div", { id: "qr-msg", class: "hint" }, "Apunta al QR de Ajé de quien te pide saldo.");
  const video = h("video", { class: "qrcam", playsinline: true, muted: true });
  let stream = null;
  let done = false;

  const stop = () => {
    done = true;
    stream?.getTracks().forEach((t) => t.stop());
    removeEventListener("aje-qr", onTest);
    removeEventListener("hashchange", stop);
  };
  // Leaving the tab by any route (back, the nav, a scan) closes the camera and the listeners.
  addEventListener("hashchange", stop);

  function handle(text) {
    if (done) return;
    const c = parseCharge(text);
    if (!c.ok) {
      msg.textContent = MESSAGES[c.reason];
      return;
    }
    stop();
    const q = new URLSearchParams({ sub: String(ctx.sims[0]?.subId ?? ""), to: c.number });
    if (c.amount) q.set("m", String(c.amount));
    if (c.name) q.set("a", c.name);
    ctx.go(`line-transfer?${q}`);
  }

  // Under the mock, the panel and the smoke test hand over a scanned text: headless Chromium has no camera.
  const onTest = (e) => handle(e.detail);
  if (ctx.bridge.kind === "mock") addEventListener("aje-qr", onTest);

  async function scan() {
    // The reader first: without it the camera is never opened.
    const jsQR = await loadReader().catch(() => null);
    if (done) return;
    if (!jsQR) {
      msg.textContent = "Ajé no pudo cargar el lector de QR.";
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    } catch {
      msg.textContent = "Ajé no puede usar la cámara. Puedes escribir el número en Enviar saldo.";
      return;
    }
    if (done) return stop();
    video.srcObject = stream;
    await video.play().catch(() => null);
    const canvas = document.createElement("canvas");
    const g = canvas.getContext("2d", { willReadFrequently: true });
    const tick = () => {
      if (done) return;
      if (!root.isConnected) return stop();
      if (video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        g.drawImage(video, 0, 0);
        const code = jsQR(g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: "dontInvert" });
        if (code?.data) handle(code.data);
      }
      setTimeout(tick, EVERY_MS);
    };
    tick();
  }

  const root = h("div", { id: "qr-scan" },
    h("div", { class: "topbar" }, h("div", { class: "t" }, "Enviar saldo con QR")),
    h("div", { class: "qrview" }, video),
    msg,
    h("button", { id: "qr-number", class: "btn ghost", onclick: () => { stop(); ctx.go(`line-transfer?sub=${ctx.sims[0]?.subId ?? ""}`); } },
      "Escribir el número"));
  scan();
  return root;
}
