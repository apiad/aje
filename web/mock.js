// The six native primitives, fake, for designing in a browser. Not shipped in the APK.
// The texts follow the layout of real bank and ETECSA texts; every number in them is made up.
import { BUNDLED } from "./core/plancatalog.js";
import { findPlan } from "./core/plans.js";

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
  // The mock cannot decode the dialed user and amount: these match the smoke test's Nauta account.
  NAUTA: "Banco Metropolitano:  La cuenta :ana.perez@nauta.com.cu ha sido recargada con 100.00 CUP. Id Transaccion: AB000CD0001. \n" +
    " Importe Pagado: 100.00 \n Saldo Restante: DB 1100.06 CUP. \n Se aplico un descuento del 00% al pago realizado. Gracias por utilizar nuestros servicios, ETECSA.",
  AUTH: "Usted se ha autenticado en la plataforma de pagos moviles, en el Banco Metropolitano, " +
    "puede comenzar a utilizar nuestros servicios de pagos a traves del movil",
};
const prepaid = (cup) => `Saldo: ${cup.toFixed(2)} CUP. Datos: 3.20 GB. Voz: 01:20:00. SMS: 100. Linea activa hasta 01-01-26 vence 02-02-26.`;
const POSTPAID = "Voz: Saldo disponible 180.00 CUP. SMS: Saldo disponible 20.00 CUP. Datos: 5000 MB. Roaming:";
const BANK = "PAGOxMOVIL";
// The phone's contacts, for the inbox's names; any other number is unknown.
const CONTACTS = { 51234567: "Mamá" };

// Android reports the number of the second SIM only, as some phones do.
const SIMS = [{ subId: 3, slot: 0, carrier: "Cubacel", number: "" }, { subId: 4, slot: 1, carrier: "Cubacel", number: "+5351234567" }];

const MODE = typeof location === "undefined" ? "" : new URLSearchParams(location.search).get("mock") ?? "";

export function createMock({ delayMs = 800, sims = SIMS, mode = MODE } = {}) {
  let session = false;
  let clasica = false;
  let handler = null;
  const buffered = [];
  const calls = [];
  const secrets = new Map();
  const CONTACT = { name: "Ben", number: "+53 5100 0001" };
  let nextContact;
  // The last balance transfer, so the panel's SMS can confirm it.
  let lastTransfer = { to: "55555555", amount: 25 };
  let balance = 185; // the prepaid line's CUP, lowered by a plan purchase

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
      if (mode === "refuse-login") return "Clave incorrecta";
      session = true;
      // Seen on a phone: a login while the session is open gets this reply and no SMS.
      if (mode === "already-auth") return "Usted ya se encuentra autenticado en el sistema.";
      later(() => emit(BANK, SAMPLES.AUTH));
      return "Usted esta siendo autenticado";
    }
    if (code.startsWith("*444*46")) {
      // The Clásica (agency 08) carries its balance in the reply, with no session and no SMS.
      if (clasica) return "Saldo de la cuenta MiTransfer: 1 500,00 CUP";
      if (!session) return "Debe autenticarse primero";
      later(() => emit(BANK, SAMPLES.BALANCE));
      return "Su solicitud esta siendo procesada, espere un SMS";
    }
    // Ops 49, 60, 111 and 48 have no captured replies yet: these texts are guesses, to drive the screens.
    // Seen on a phone: 111 without a MiTransfer session.
    if (code.startsWith("*444*111*") && !session) return "No es posible realizar la operacion. Debe autenticarse.";
    if (code.startsWith("*444*111*")) { clasica = true; return "Su solicitud de asociacion esta siendo procesada, espere un SMS"; }
    // Bills and Nauta (41, 42, 67, 19, 51, 21, 59): a session first; Nauta's SMS confirms its recharge.
    const bill = /^\*444\*(41|42|67|19|51|21|59)\*/.exec(code);
    if (bill && !session) return "No es posible realizar la operacion. Debe autenticarse.";
    if (bill?.[1] === "59") later(() => emit(BANK, SAMPLES.NAUTA));
    if (bill) return "Su solicitud esta siendo procesada, espere un sms con los datos de la transaccion.";
    // The debt query's reply has not been captured yet: a guess at its shape.
    if (code.startsWith("*444*47*")) return session ? "La factura tiene una deuda de 85.40 CUP" : "No es posible realizar la operacion. Debe autenticarse.";
    if (code.startsWith("*444*48*")) return "Ultimas operaciones:\n 22/10 Pago 150,00 CUP\n 21/10 Recarga 500,00 CUP";
    if (code.startsWith("*444*49*")) return "Su solicitud de registro esta siendo procesada, espere un SMS";
    if (code.startsWith("*444*60*")) return session ? "Su cuenta ha sido asociada satisfactoriamente" : "Debe autenticarse primero";
    if (code.startsWith("*234*2*")) return "Su clave ha sido cambiada satisfactoriamente.";
    if (code === "*222#") return prepaid(balance);
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
      // A balance transfer ends in the dialer; the panel's "Saldo pasado" SMS then confirms it.
      if (code.startsWith("*234*1*")) {
        const [, , , to, , amount] = code.slice(0, -1).split("*");
        lastTransfer = { to, amount: Number(amount) };
      }
      // A plan's shortcut lands on Cubacel's confirm; here the person always types 1, and its SMS follows.
      const plan = code.startsWith("*133*") && findPlan(BUNDLED, code.slice(5, -1));
      if (plan) {
        balance -= plan.price;
        const left = balance;
        later(() => emit("ETECSA", `ETECSA Plan Nacional: Se ha comprado Plan ${plan.name} valido por 30 dias, se activa con el primer uso. ` +
          `Se debitaron ${plan.price.toFixed(2)} CUP. Saldo actual ${left.toFixed(2)} CUP`));
      }
    },
    listSims: async () => sims.map((s) => ({ ...s })),
    requestPermissions: async () => ({ callPhone: true, readPhoneState: true, receiveSms: true }),
    // The device's fingerprint prompt always succeeds here, except in ?mock=no-unlock.
    async secretStatus(name) {
      return { available: true, saved: secrets.has(name), expiresAt: secrets.get(name)?.expiresAt ?? null };
    },
    async secretSave(name, value, days) {
      await wait();
      if (mode === "no-unlock") return false;
      secrets.set(name, { value, expiresAt: Date.now() + days * 86_400_000 });
      return true;
    },
    async secretLoad(name) {
      await wait();
      return mode === "no-unlock" ? null : secrets.get(name)?.value ?? null;
    },
    async secretForget(name) {
      secrets.delete(name);
    },
    async pickContact() {
      calls.push({ method: "pickContact", args: {} });
      await wait();
      const c = nextContact === undefined ? CONTACT : nextContact;
      nextContact = undefined;
      return c && { ...c };
    },
    /** The next contact the picker answers: one contact, or null for a person who cancels. */
    setNextContact: (c) => { nextContact = c; },
    onSms(fn) {
      handler = fn;
      for (const sms of buffered.splice(0)) fn(sms);
    },
    async installUpdate(url, sha256, onProgress = null) {
      calls.push({ method: "installUpdate", args: { url, sha256 } });
      const total = 7_500_000;
      for (let step = 1; step <= 5; step++) {
        await wait();
        onProgress?.((total * step) / 5, total);
      }
      return { ok: true };
    },
    async contactNames(numbers, ask) {
      calls.push({ method: "contactNames", args: { numbers, ask } });
      return Object.fromEntries(numbers.filter((n) => CONTACTS[n]).map((n) => [n, CONTACTS[n]]));
    },
    // The browser has no notifications to tap.
    onOpen() {},
    injectSms: (sender, body) => emit(sender, body),
    // Incoming money and plans, as PAGOxMOVIL, ETECSA and Cubacel send them.
    cardReceived: () => emit(BANK, `El titular del telefono 51234567 le ha realizado una transferencia a la cuenta 9200XXXXXXXX0001 de 1500.00 CUP. Nro. Transaccion KW${Date.now() % 1e9}`),
    rechargeIntl: () => emit("ETECSA", `ETECSA: Recarga Internacional. Ud. recibio 500 CUP. Transaccion ${Date.now() % 1e9}. Sextuplica Tu Recarga y Datos ilimitados de 12am-7am(validos por 30 dias).Consulte *222#.`),
    planGift: () => emit("Cubacel", "Ha recibido un plan de 3GB valido por 30 dias, se activara con el primer uso."),
    lineSent: () => emit("ETECSA", `Usted ha transferido ${lastTransfer.amount} CUP al numero ${lastTransfer.to}. Saldo principal 1234.56 CUP, linea activa hasta 2027-01-01, vence 2027-02-01`),
    lineReceived: () => emit("ETECSA", "Usted ha recibido 25.00 CUP del numero 56666666. Su saldo es 300.00 CUP."),
    endSession: () => { session = false; },
  };
  if (typeof document !== "undefined") panel(mock);
  return mock;
}

/** A folding panel to inject a bank SMS by hand, since a dialed transfer gets no automatic reply. */
function panel(mock) {
  const box = document.createElement("details");
  box.id = "mock-panel";
  box.style.cssText = "position:fixed;right:8px;bottom:84px;z-index:1000;max-width:calc(100vw - 16px);" +
    "background:#211710;color:#f1e8d8;border:1px solid #3a2a1b;border-radius:10px;padding:4px 9px;font:11px sans-serif;opacity:.85";
  box.innerHTML = '<summary style="cursor:pointer">SMS</summary>' +
    '<div style="display:flex;gap:6px;margin:6px 0"><button data-sms="balance">Saldo</button>' +
    '<button data-sms="transfer">Transferencia</button><button data-sms="auth">Autenticado</button></div>' +
    '<div style="display:flex;gap:6px;margin:6px 0"><button id="mock-line-sent">Saldo pasado</button>' +
    '<button id="mock-line-received">Saldo recibido</button>' +
    '<button id="mock-qr">QR de cobro</button></div>' +
    '<div style="display:flex;gap:6px;margin:6px 0"><button id="mock-card-received">Dinero a tarjeta</button>' +
    '<button id="mock-recharge-intl">Recarga int.</button><button id="mock-plan-gift">Plan regalado</button></div>' +
    '<button id="mock-logout">Cerrar la sesión del banco</button>' +
    '<textarea id="mock-sms" rows="6" style="width:100%;box-sizing:border-box"></textarea>' +
    '<button id="mock-send" style="margin-top:6px">Inyectar SMS</button>';
  box.addEventListener("toggle", () => (box.style.width = box.open ? "280px" : ""));
  const text = box.querySelector("#mock-sms");
  for (const b of box.querySelectorAll("[data-sms]")) b.onclick = () => (text.value = SAMPLES[b.dataset.sms.toUpperCase()]);
  box.querySelector("#mock-line-sent").onclick = () => { mock.lineSent(); box.open = false; };
  box.querySelector("#mock-line-received").onclick = () => { mock.lineReceived(); box.open = false; };
  box.querySelector("#mock-card-received").onclick = () => { mock.cardReceived(); box.open = false; };
  box.querySelector("#mock-recharge-intl").onclick = () => { mock.rechargeIntl(); box.open = false; };
  box.querySelector("#mock-plan-gift").onclick = () => { mock.planGift(); box.open = false; };
  // The QR tab under the mock reads this instead of a camera frame.
  box.querySelector("#mock-qr").onclick = () => {
    box.open = false;
    dispatchEvent(new CustomEvent("aje-qr", { detail: "aje:saldo?v=1&n=56666666&m=150&a=Ana" }));
  };
  box.querySelector("#mock-logout").onclick = () => {
    mock.endSession();
    box.open = false;
  };
  box.querySelector("#mock-send").onclick = () => {
    mock.injectSms(BANK, text.value);
    box.open = false;
  };
  if (document.body) document.body.append(box);
  else document.addEventListener("DOMContentLoaded", () => document.body.append(box));
}
