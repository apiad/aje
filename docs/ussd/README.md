# USSD menu captures

`133.json` is the Cubacel `*133#` plan menu as a phone saw it on the `captured`
date: every screen reached by a chained shortcut (`*133*1*4#`), its kind (`menu`,
`confirm`, `text`, `error`), its redacted text and its options. Android's USSD API
cannot read these menus, so `tools/ussd-explore.py` reads the dialer's dialog with
`uiautomator dump` instead.

Run it again when ETECSA changes the menu, with a phone on USB and adb authorized
(on Xiaomi also "USB debugging (Security settings)"):

    python3 tools/ussd-explore.py --root 133 --out docs/ussd/133.json --sim 2

`--sim N` picks row N when the dialer asks which SIM to use; `--adb`, `--delay`
and `--max-dials` are optional.

Safety rules the script keeps:

- It never types into a USSD dialog and never presses its send button; it only
  cancels it (Cancel or BACK).
- It expands only menus. A screen that asks to confirm is a leaf; nothing longer
  than its path is dialed.
- It never dials back/exit options (Atrás, Volver, Salir, Menu…) or bare action
  options (Habilitar, Deshabilitar, Activar, Desactivar, Adicionar, Eliminar),
  which act at once with no confirm screen.
- At most 80 dials, depth at most 6, at least 4 s between dials.
- Before writing, phone numbers become `5XXXXXXX`, the figure after "saldo" becomes
  `0.00` and any run of 7 or more digits becomes `#######`. Prices stay.
