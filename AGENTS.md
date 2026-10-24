# Ajé

An Android app for managing personal money in Cuba: bank cards, phone lines,
transfers and their history. Talking to the banks and ETECSA over USSD, SMS and QR
is one module, built on the public *444 USSD service. It never impersonates anyone or uses the banks' online API.

The app is a web frontend in a WebView. All logic lives in JavaScript; Android keeps
only what JavaScript cannot do: send a USSD, dial, receive an SMS, list the SIMs,
ask for permissions and keep the bank PIN in a store locked by the device.

The repo is private until a working 1.0 and then public, so it is written to be
public now: no real names, numbers, balances, machines or accounts, in code, tests,
fixtures or commits. Test fixtures copy the layout of real texts with made-up values.

## Done means

`make test` is green: the Node tests of `web/`, including the 1600 encoder vectors. A change to the card
scanner also passes `make ocr` (synthetic cards read by the vendored Tesseract), which a
release runs too.
A change to the interface also passes `make smoke`, and a change to the app builds
with `make apk`.

The interface is iterated on in the browser, never on the phone. Moving the logic to
JavaScript exists so that a screen can change many times an hour and the APK is
almost certain to work. Build `make preview` (one HTML page with the mock) and show
that page to the maintainer; an aegis session sends it as a live artifact with
`node tools/build-preview.mjs <artifact path> --aegis`. Do not send an APK for a
change to `web/`. An APK goes out only when `app/` changed or a release is cut, and
then with a short list of what only a phone can check. The build host has no radio: anything about telephony or SMS is
verified on a phone, and a report says which of the two a claim came from.

## Releases

`make release VERSION=1.0.0` publishes a signed APK from the pushed HEAD as a GitHub release;
a version with a suffix (`1.1.0-beta.1`) is a pre-release, which only the app's beta channel
installs. The assets are `aje-<version>-<versionCode>.apk` and its `.sha256`, the names the
updater (`web/core/update.js`) reads. A release build carries the public telemetry endpoint,
off until the person turns it on; the script checks it is there.

## Where things live

- `web/core/`: the logic as plain ES modules with no DOM, imported by Node and the
  WebView alike. The USSD encoder (pinned to the vectors in `web/test/fixtures/`),
  the operation catalog, the money model, the SMS parser, the store, telemetry and
  the workflows. `web/core/idb.js` is the only browser-only module.
- `web/ui/`: the screens, hand-written JS over the design mockup's CSS.
- `web/vendor/tesseract/`: Tesseract.js for the card scanner, fetched by
  `tools/vendor-tesseract.sh` from pinned npm tarballs; never edited by hand.
- `web/bridge.js`: the client of the message protocol with the native shell;
  `web/mock.js` fakes the native primitives in a browser and is not shipped.
- `app/`: the native shell. `MainActivity` hosts the WebView on
  `https://appassets.androidplatform.net` and serves file inputs with the system picker, `NativeBridge` holds the native primitives (`readSms` reads back 72 hours of service SMS, for settle), `SecretStore` the Keystore-backed PIN store,
  `SmsQueue` keeps SMS that arrive while no page is alive.
- `tools/smoke-web.py`: drives the frontend against the mock with Playwright.
- `telemetry/collector.py`: the public telemetry endpoint behind `https://aje.apiad.net/t`;
  it publishes the redacted rows at `https://aje.apiad.net/data/`.
- The design spec and plans live in the maintainer's notes, not here.

## Rules

- A bank PIN or a transfer key is a `field(value, true)` in `web/core/ussd.js`. Only
  `dial` returns it; nothing stores, logs or reports a dialed string that carries one.
  The one exception is the PIN the person asks to remember: it goes only to the shell's
  secret store (`secretSave`), encrypted under a Keystore key that needs the fingerprint
  or the screen lock on each use, and it lapses after `PIN_DAYS` in `web/core/workflow.js`.
- Telemetry is opt-in and unlinkable: one event per request, no install id, no time (the
  collector stamps the hour). Texts and error messages go through `redact` in
  `web/core/redact.js` before they are queued: digits become `#`, and any word outside the
  vocabulary in `web/core/vocab.js` becomes `‹w›`. Stacks keep only `function@file:line:col`.
  No field carries a phone or card number, a name, an amount or a balance. The one text that keeps
  its digits is a `*133` menu in `menu`, through `redactMenu`, sent by builds before the plan catalog. The allowlist is
  `ALLOWED` in `web/core/telemetry.js`; `telemetry/collector.py` mirrors it and redacts again.
  The collector publishes every row, so the vocabulary never takes a name. See `docs/telemetry.md`.
- The native shell gains no logic and no new primitive without a change to the spec.
- The shell reads incoming-money SMS with `SmsNotice.kt`, a port of `web/core/notice.js`; both are held
  to `web/test/fixtures/notice-vectors.json`, so a change to one reader changes the other and passes
  `./gradlew :app:testDebugUnitTest` too.
- Signing material and the telemetry token live in `keystore.properties`, which is
  gitignored and points outside the repo.
