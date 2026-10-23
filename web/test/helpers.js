// Shared fixtures. They follow the layout of real Banco Metropolitano texts; every number in them is made up.

export const SMS = {
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
  // Cubacel balance transfers, from sender ETECSA. LINE_SENT follows a text seen on a phone;
  // LINE_RECEIVED is still a guess.
  LINE_SENT: "Usted ha transferido 25 CUP al numero 55555555. Saldo principal 1234.56 CUP, linea activa hasta 2027-01-01, vence 2027-02-01",
  LINE_RECEIVED: "Usted ha recibido 25.00 CUP del numero 56666666. Su saldo es 300.00 CUP.",
};

// Cubacel's SMS after a plan purchase. Telemetry brought it redacted: its layout and figures are real,
// the words it hid are guesses, so it is not one of the templates the vocabulary must cover.
export const PLAN_BOUGHT = "ETECSA Plan Nacional: Se ha comprado Plan 4GB+35min+40SMS valido por 30 dias, se activa con el primer uso. Se debitaron 240.00 CUP. Saldo actual 1234.56 CUP";

export const PREPAID_REPLY =
  "Saldo: 250.50 CUP. Datos: 3.20 GB. Voz: 01:20:00. SMS: 100. Linea activa hasta 01-01-26 vence 02-02-26.";

export const POSTPAID_REPLY =
  "Voz: Saldo disponible 180.00 CUP. SMS: Saldo disponible 20.00 CUP. Datos: 5000 MB. Roaming:";

/**
 * A bridge whose sendUssd answers from `replies` in order. Each reply is a result, or a function
 * returning a promise of one, for tests that control when the reply lands. Calls are recorded.
 */
export function fakeBridge(replies = [], { dialFails = false, secrets = true, unlock = true } = {}) {
  const calls = [];
  const queue = [...replies];
  const vault = new Map();
  // The device secret store; `unlock: false` is a person who cancels the fingerprint prompt.
  const secretStore = secrets ? {
    vault,
    async secretStatus(name) {
      return { available: true, saved: vault.has(name), expiresAt: vault.get(name)?.expiresAt ?? null };
    },
    async secretSave(name, value, days) {
      calls.push({ method: "secretSave", args: { name, days } });
      if (!unlock) return false;
      vault.set(name, { value, expiresAt: days * 86_400_000 });
      return true;
    },
    async secretLoad(name) {
      calls.push({ method: "secretLoad", args: { name } });
      return unlock ? vault.get(name)?.value ?? null : null;
    },
    async secretForget(name) {
      calls.push({ method: "secretForget", args: { name } });
      vault.delete(name);
    },
  } : {};
  return {
    calls,
    ...secretStore,
    async sendUssd(subId, code) {
      calls.push({ method: "sendUssd", args: { subId, code } });
      const next = queue.shift() ?? { ok: true, reply: "" };
      return typeof next === "function" ? next() : next;
    },
    async dial(code) {
      calls.push({ method: "dial", args: { code } });
      if (dialFails) throw new Error("SecurityException");
    },
  };
}
