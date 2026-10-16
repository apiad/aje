// The five native primitives, fake, for designing in a browser. Not shipped in the APK.
// The texts follow the layout of real bank and ETECSA texts; every number in them is made up.

const SAMPLES = {
  BALANCE: "Banco Metropolitano:  La consulta de saldo fue completada. \n" +
    " Saldo Contable: CR 1234.56 CUP \n" +
    " Saldo Disponible: CR 1200.06 CUP",
  TRANSFER: "Banco Metropolitano:  La Transferencia fue completada. \n" +
    " Fecha: 1/2/2026 \n" +
    " Beneficiario: 9200XXXXXXXX0001 \n" +
    " Ordenante: CUP \n" +
    " Monto: 100.00 CUP \n" +
    " Nro. Transaccion: AB0000XYZ0001 \n" +
    " Saldo restante: CR 1134.56 CUP ",
  AUTH: "Usted se ha autenticado en la plataforma de pagos moviles, en el Banco Metropolitano, " +
    "puede comenzar a utilizar nuestros servicios de pagos a traves del movil",
};
const PREPAID = "Saldo: 185.00 CUP. Datos: 3.20 GB. Voz: 01:20:00. SMS: 100. Linea activa hasta 01-01-26 vence 02-02-26.";
const POSTPAID = "Voz: Saldo disponible 180.00 CUP. SMS: Saldo disponible 20.00 CUP. Datos: 5000 MB. Roaming:";
const BANK = "PAGOxMOVIL";

const SIMS = [{ subId: 3, slot: 0, carrier: "Cubacel" }, { subId: 4, slot: 1, carrier: "Cubacel" }];

export function createMock({ delayMs = 800, sims = SIMS } = {}) {
  let session = false;
  let handler = null;
  const buffered = [];
  const calls = [];

  const emit = (sender, body) => {
    const at = Date.now();
    const sms = { sender, body, sentAt: at, receivedAt: at };
    if (handler) handler(sms);
    else buffered.push(sms);
  };
  const later = (fn) => setTimeout(fn, delayMs);
  const wait = () => new Promise((r) => setTimeout(r, delayMs / 2));

  // The bank answers card operations with "debe autenticarse" until op 40 opens a session.
  function reply(code) {
    if (code.startsWith("*444*40*")) {
      session = true;
      later(() => emit(BANK, SAMPLES.AUTH));
      return "Usted esta siendo autenticado";
    }
    if (code.startsWith("*444*46")) {
      if (!session) return "Debe autenticarse primero";
      later(() => emit(BANK, SAMPLES.BALANCE));
      return "Su solicitud esta siendo procesada, espere un SMS";
    }
    if (code === "*222#") return PREPAID;
    if (code === "*111#") return POSTPAID;
    return "Opcion no valida";
  }

  const mock = {
    kind: "mock",
    calls,
    async sendUssd(subId, code) {
      calls.push({ method: "sendUssd", args: { subId, code } });
      await wait();
      return { ok: true, reply: reply(code) };
    },
    async dial(code) {
      calls.push({ method: "dial", args: { code } });
    },
    listSims: async () => sims.map((s) => ({ ...s })),
    requestPermissions: async () => ({ callPhone: true, readPhoneState: true, receiveSms: true }),
    onSms(fn) {
      handler = fn;
      for (const sms of buffered.splice(0)) fn(sms);
    },
    injectSms: (sender, body) => emit(sender, body),
  };
  if (typeof document !== "undefined") panel(mock);
  return mock;
}

/** A folding panel to inject a bank SMS by hand, since a dialed transfer gets no automatic reply. */
function panel(mock) {
  const box = document.createElement("details");
  box.id = "mock-panel";
  box.style.cssText = "position:fixed;right:8px;top:8px;z-index:1000;width:min(280px,calc(100vw - 16px));" +
    "background:#211710;color:#f1e8d8;border:1px solid #3a2a1b;border-radius:10px;padding:6px 10px;font:12px sans-serif";
  box.innerHTML = '<summary style="cursor:pointer">mock · SMS</summary>' +
    '<div style="display:flex;gap:6px;margin:6px 0"><button data-sms="balance">Saldo</button>' +
    '<button data-sms="transfer">Transferencia</button><button data-sms="auth">Autenticado</button></div>' +
    '<textarea id="mock-sms" rows="6" style="width:100%;box-sizing:border-box"></textarea>' +
    '<button id="mock-send" style="margin-top:6px">Inyectar SMS</button>';
  const text = box.querySelector("#mock-sms");
  for (const b of box.querySelectorAll("[data-sms]")) b.onclick = () => (text.value = SAMPLES[b.dataset.sms.toUpperCase()]);
  box.querySelector("#mock-send").onclick = () => mock.injectSms(BANK, text.value);
  if (document.body) document.body.append(box);
  else document.addEventListener("DOMContentLoaded", () => document.body.append(box));
}
