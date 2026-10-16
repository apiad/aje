# Ajé

A native Android app for managing personal money in Cuba: bank cards, phone lines,
transfers and their history. Talking to the banks and ETECSA over USSD, SMS and QR
is one module, built on the public *444 USSD service. It never impersonates anyone or uses the banks' online API.

The repo is private until a working 1.0 and then public, so it is written to be
public now: no real names, numbers, balances, machines or accounts, in code, tests,
fixtures or commits. Test fixtures copy the layout of real texts with made-up values.

## Done means

`make test` is green (the JVM tests of `:core`), and for app changes `make apk`
builds a signed APK. The build host has no radio: anything about telephony or SMS
is verified on a phone, and a report says which of the two a claim came from.

## Where things live

- `core/`: pure Kotlin, no Android imports. The USSD encoder (pinned to
  test vectors), the operation catalog, the money model, the SMS parser.
- `app/`: the Android app. `Telemetry.ALLOWED` is the allowlist of telemetry fields.
- `telemetry/collector.py`: the dev telemetry endpoint; its `ALLOWED` mirrors the app's.
- The design spec and plans live in the maintainer's notes, not here.

## Rules

- A bank PIN or a transfer key is a `Field(secret = true)`. Only `UssdCode.dial`
  returns it; nothing persists or logs a dialed string that carries one.
- Telemetry carries the text of bank USSD replies and bank SMS only through
  `Telemetry.mask`, which turns every digit into `#`. No other field carries a phone or
  card number, an amount or a balance. Adding a field means adding it to both allowlists.
- Signing material and the telemetry token live in `keystore.properties`, which is
  gitignored and points outside the repo.
