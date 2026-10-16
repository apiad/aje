# Ajé

An Android app for managing personal money in Cuba: bank cards, phone lines,
transfers and their history. Talking to the banks and ETECSA over USSD, SMS and QR
is one module, built on the public *444 USSD service. It never impersonates anyone or uses the banks' online API.

The app is a web frontend in a WebView. All logic lives in JavaScript; Android keeps
only what JavaScript cannot do: send a USSD, dial, receive an SMS, list the SIMs and
ask for permissions.

The repo is private until a working 1.0 and then public, so it is written to be
public now: no real names, numbers, balances, machines or accounts, in code, tests,
fixtures or commits. Test fixtures copy the layout of real texts with made-up values.

## Done means

`make test` is green: the Node tests of `web/`, including the 1600 encoder vectors.
A change to the interface also passes `make smoke`, and a change to the app builds
with `make apk`. The build host has no radio: anything about telephony or SMS is
verified on a phone, and a report says which of the two a claim came from.

## Where things live

- `web/core/`: the logic as plain ES modules with no DOM, imported by Node and the
  WebView alike. The USSD encoder (pinned to the vectors in `web/test/fixtures/`),
  the operation catalog, the money model, the SMS parser, the store, telemetry and
  the workflows. `web/core/idb.js` is the only browser-only module.
- `web/ui/`: the screens, hand-written JS over the design mockup's CSS.
- `web/bridge.js`: the client of the message protocol with the native shell;
  `web/mock.js` fakes the five primitives in a browser and is not shipped.
- `app/`: the native shell. `MainActivity` hosts the WebView on
  `https://appassets.androidplatform.net`, `NativeBridge` holds the five primitives,
  `SmsQueue` keeps SMS that arrive while no page is alive.
- `tools/smoke-web.py`: drives the frontend against the mock with Playwright.
- `telemetry/collector.py`: the dev telemetry endpoint.
- The design spec and plans live in the maintainer's notes, not here.

## Rules

- A bank PIN or a transfer key is a `field(value, true)` in `web/core/ussd.js`. Only
  `dial` returns it; nothing stores, logs or reports a dialed string that carries one.
- Telemetry carries the text of bank USSD replies and bank SMS only through `mask`,
  which turns every digit into `#`. No other field carries a phone or card number, an
  amount or a balance. The allowlist is `ALLOWED` in `web/core/telemetry.js`, and a
  test checks that `telemetry/collector.py` mirrors it.
- The native shell gains no logic and no new primitive without a change to the spec.
- Signing material and the telemetry token live in `keystore.properties`, which is
  gitignored and points outside the repo.
