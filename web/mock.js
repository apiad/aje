// The six native primitives, fake, for designing in a browser. Not shipped in the APK.
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
const prepaid = (cup) => `Saldo: ${cup.toFixed(2)} CUP. Datos: 3.20 GB. Voz: 01:20:00. SMS: 100. Linea activa hasta 01-01-26 vence 02-02-26.`;
// The *133 plan menu has no captured replies yet: the categories follow the web's guides, the
// plans and prices are made up, and the texts are guesses with the layout the parser expects.
const PLANS = [
  ["Datos", [["1 GB", 25], ["2.5 GB", 50], ["4 GB", 80]]],
  ["SMS", [["20 SMS", 10], ["50 SMS", 20], ["120 SMS", 40]]],
  ["Voz", [["5 min", 15], ["10 min", 25], ["25 min", 50]]],
  ["Plan Amigos", [["3 numeros", 20], ["5 numeros", 30], ["10 numeros", 50]]],
];

function planReply(path, buy) {
  if (!path.length) return `Compra de planes:\n${PLANS.map(([name], i) => `${i + 1}. ${name}`).join("\n")}`;
  const [name, plans] = PLANS[Number(path[0]) - 1] ?? [];
  if (!plans || path.length > 2) return null;
  if (path.length === 1) return `${name}:\n${plans.map(([p, cup], i) => `${i + 1}-${p} por ${cup} CUP`).join("\n")}\n0-Atras`;
  const plan = plans[Number(path[1]) - 1];
  if (!plan) return null;
  return buy ? plan : `Usted va a comprar ${plan[0]} por ${plan[1].toFixed(2)} CUP.\n1. Aceptar\n2. Cancelar`;
}
const POSTPAID = "Voz: Saldo disponible 180.00 CUP. SMS: Saldo disponible 20.00 CUP. Datos: 5000 MB. Roaming:";
const BANK = "PAGOxMOVIL";

const SIMS = [{ subId: 3, slot: 0, carrier: "Cubacel" }, { subId: 4, slot: 1, carrier: "Cubacel" }];

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
    if (code.startsWith("*444*48*")) return "Ultimas operaciones:\n 22/10 Pago 150,00 CUP\n 21/10 Recarga 500,00 CUP";
    if (code.startsWith("*444*49*")) return "Su solicitud de registro esta siendo procesada, espere un SMS";
    if (code.startsWith("*444*60*")) return session ? "Su cuenta ha sido asociada satisfactoriamente" : "Debe autenticarse primero";
    if (code.startsWith("*234*2*")) return "Su clave ha sido cambiada satisfactoriamente.";
    if (code === "*222#") return prepaid(balance);
    if (code.startsWith("*133")) {
      const path = code.slice(1, -1).split("*").slice(1);
      const buy = path.length === 3 && path[2] === "1";
      const r = planReply(buy ? path.slice(0, 2) : path, buy);
      if (!r) return "Opcion no valida";
      if (!buy) return r;
      balance -= r[1];
      return "Su compra se ha realizado con exito.";
    }
    if (code === "*111#") return POSTPAID;
    return "Opcion no valida";
  }

  const mock = {
    kind: "mock",
    calls,
    async sendUssd(subId, code) {
      calls.push({ method: "sendUssd", args: { subId, code } });
      await wait();
      // ?mock=ussd-menu: the *133 levels answer with a network menu the API cannot follow.
      if (mode === "ussd-menu" && code.startsWith("*133")) return { ok: false, failureCode: -1 };
      return { ok: true, reply: reply(code) };
    },
    async dial(code) {
      calls.push({ method: "dial", args: { code } });
      // A balance transfer ends in the dialer; the panel's "Saldo pasado" SMS then confirms it.
      if (code.startsWith("*234*1*")) {
        const [, , , to, , amount] = code.slice(0, -1).split("*");
        lastTransfer = { to, amount: Number(amount) };
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
    async installUpdate(url, sha256) {
      calls.push({ method: "installUpdate", args: { url, sha256 } });
      await wait();
      return { ok: true };
    },
    injectSms: (sender, body) => emit(sender, body),
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
  box.style.cssText = "position:fixed;right:8px;top:8px;z-index:1000;max-width:calc(100vw - 16px);" +
    "background:#211710;color:#f1e8d8;border:1px solid #3a2a1b;border-radius:10px;padding:4px 9px;font:11px sans-serif;opacity:.85";
  box.innerHTML = '<summary style="cursor:pointer">SMS</summary>' +
    '<div style="display:flex;gap:6px;margin:6px 0"><button data-sms="balance">Saldo</button>' +
    '<button data-sms="transfer">Transferencia</button><button data-sms="auth">Autenticado</button></div>' +
    '<div style="display:flex;gap:6px;margin:6px 0"><button id="mock-line-sent">Saldo pasado</button>' +
    '<button id="mock-line-received">Saldo recibido</button></div>' +
    '<button id="mock-logout">Cerrar la sesión del banco</button>' +
    '<textarea id="mock-sms" rows="6" style="width:100%;box-sizing:border-box"></textarea>' +
    '<button id="mock-send" style="margin-top:6px">Inyectar SMS</button>';
  box.addEventListener("toggle", () => (box.style.width = box.open ? "280px" : ""));
  const text = box.querySelector("#mock-sms");
  for (const b of box.querySelectorAll("[data-sms]")) b.onclick = () => (text.value = SAMPLES[b.dataset.sms.toUpperCase()]);
  box.querySelector("#mock-line-sent").onclick = () => { mock.lineSent(); box.open = false; };
  box.querySelector("#mock-line-received").onclick = () => { mock.lineReceived(); box.open = false; };
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
