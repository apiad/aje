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

After a new capture, rebuild the app's plan catalog from it and commit both outputs:

    python3 tools/plan-catalog.py   # writes web/core/plancatalog.js and site/plans.json

`confirm.json` holds the confirmation menus of a card transfer (op 45) and a balance
transfer (`*234*1`) as the dialer showed them on the `captured` date, one screen per
operation with its op and its redacted text. They were read with a throwaway build whose
accessibility service, in capture mode, logs each USSD dialog and only cancels it, so
nothing was sent. Both were dialed for 1 CUP, so the amounts are the real ones; the card
number keeps its layout (16 digits, no spaces) as 12 `X` and a made-up last 4, and the
line becomes `5XXXXXXX`.
