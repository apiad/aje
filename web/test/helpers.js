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
};

export const PREPAID_REPLY =
  "Saldo: 250.50 CUP. Datos: 3.20 GB. Voz: 01:20:00. SMS: 100. Linea activa hasta 01-01-26 vence 02-02-26.";

export const POSTPAID_REPLY =
  "Voz: Saldo disponible 180.00 CUP. SMS: Saldo disponible 20.00 CUP. Datos: 5000 MB. Roaming:";

/**
 * A bridge whose sendUssd answers from `replies` in order. Each reply is a result, or a function
 * returning a promise of one, for tests that control when the reply lands. Calls are recorded.
 */
export function fakeBridge(replies = []) {
  const calls = [];
  const queue = [...replies];
  return {
    calls,
    async sendUssd(subId, code) {
      calls.push({ method: "sendUssd", args: { subId, code } });
      const next = queue.shift() ?? { ok: true, reply: "" };
      return typeof next === "function" ? next() : next;
    },
    async dial(code) {
      calls.push({ method: "dial", args: { code } });
    },
  };
}
