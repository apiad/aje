// Writes a sample Transfermóvil backup for the smoke test and the preview: node web/test/write-trm.mjs <path>.
// Every name and number in it is made up.
import { writeFileSync } from "node:fs";
import { encField, makeBackup, tables } from "./trm-fixture.js";

const card = (pan, alias, tipo_moneda = "CUP") => ({ id: 1, cuenta: encField(pan), alias, tipo_moneda, agencia: "" });

writeFileSync(process.argv[2], makeBackup(tables({
  MCBank: [
    card("9227959900000011", "Nómina"),
    card("9760030000000012", "Clásica-0012", "USD"),
    card("9227069900000013", "Ahorro"),
    card("9760040000000014", "Empresa"),
    card("9227959900000001", "Metro CUP"),
    { id: 6, cuenta: "AAAA", alias: "Ilegible" },
  ],
  CuentaBanco: [
    { id: 1, cuenta: encField("9227959900000021"), descripcion: "Ana", movil: "51234567" },
    { id: 2, cuenta: encField("9227069900000022"), descripcion: "Ben", movil: "52345678" },
  ],
  Factura: [{ id: 1, tipo_factura: 1, factura: "1000001", cod_factura: "E1" }],
  Nauta: [{ id: 1, cuenta: "ana.perez", tipo_cuenta: 1 }],
  Pin: [{ id: 1, pin: "0000" }],
  RecordSMS: [{ id: 1, fecha: "01/01/2026", tipo_servicio: "Agentes" }],
})));
