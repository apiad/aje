# Telemetry

Ajé's telemetry is opt-in, redacted on the phone and unlinkable, and everything it collects is
public. The page for users is <https://aje.apiad.net/privacidad>; this is the same mechanism for
developers.

## On the phone

- Off by default in every build. The app asks once on first launch (`web/ui/consent.js`), and
  Settings → Privacidad turns it on or off. Turning it off drops the unsent queue.
- `telemetry.event(name, fields)` in `web/core/telemetry.js` accepts only the fields in `ALLOWED`
  and throws on any other. Each event is sent alone, one `POST https://aje.apiad.net/t` per event,
  with the header `X-Aje-Token`. The token ships in the APK; it only keeps noise out.
- Every event carries `event`, `app` (version), `commit`, `android` (major version) and `maker`
  (from `AjeMaker/<maker>`, which `MainActivity` appends to the WebView's user agent). There is
  no install id and no time.
- `text` and `error` go through `redact`, and `stack` through `reduceStack`
  (`web/core/redact.js`), before the event is queued. Latencies are rounded to 100 ms.
- Settings shows the last events exactly as they left the phone.

## Redaction

`redact(text)` splits the text into words and keeps everything between them as is.

- A word with a digit keeps its shape: each digit becomes `#`, each capital `A`, each other
  letter `a`. `AB0000XYZ0001` becomes `AA####AAA####`.
- A word of letters only is kept if its folded form (lowercase, no accents) is in
  `web/core/vocab.js`. Any other word becomes `‹w›`.

The vocabulary holds the fixed words of the message templates the app knows and Spanish function
words. It has no general dictionary, because many names are also common words. When a new bank
text shows up in the data with `‹w›` where its fixed words are, add those words to
`web/core/vocab.js`. `web/test/redact.test.js` fails if a vocabulary word is in
`web/test/fixtures/common-names.txt`, and if a known template still has a `‹w›`.

`reduceStack` keeps each frame as `function@file:line:col`, relative to `web/`, at most 20.

`telemetry/collector.py` implements the same `redact` in Python; both run the vectors in
`web/test/fixtures/redact-vectors.json`.

A `*133` plan menu is the network's public catalog, and its option numbers and prices are what
there is to learn. The `plan_menu` event carries it in `menu`, through `redactMenu`: the same
rules, except that digits stay. A run of 7 or more digits, which could be a phone number, a date,
and the figure after "saldo" still become `#`. The collector has `redact_menu`; both run `web/test/fixtures/menu-vectors.json`.

Builds since the plan catalog (`docs/ussd/133.json`) no longer send `plan_menu`, since the app no
longer reads `*133` over the API; the collector still accepts it from older builds. Cubacel's SMS
after a plan purchase goes out as an `sms` event of kind `plan`, with its redacted text, whether it
confirmed a purchase (`ok`) and how long after the dial it came.

A notice of money or balance that came in (`web/core/notice.js`) sends a `notice` event when it
enters the inbox, with `ok: false`, and again when the person opens it, with `ok: true`. It
carries only `kind` (`card-received`, `line-received`, `recharge-intl`, `recharge`, `plan-gift`,
`plan-expiry`): never the amount, the number, the account or the text.

Picking a Transfermóvil backup to import (`web/ui/import.js`) sends one `import` event. It carries
`ok`, and on a failure `failure_code` (`format`, `hash`, `empty`, `read` when the file could not be
read, or `cancel` when the picker was closed); on success `cards` (cards found), `added` (cards added) and `kept` (rows saved for later):
only counts, never a number, a name, an alias or anything else from the file.

## The collector

`telemetry/collector.py`, standard library only, behind Caddy at `https://aje.apiad.net/t`.

- Accepts one JSON object up to 16 KB with a string `event`; answers 204, or 400, 403, 413.
- Keeps only the allowlisted fields, redacts `text` and `error` again, and `menu` with `redact_menu`, keeps only frame lines in
  `stack`, and adds `hour`, the UTC hour the event arrived (`2026-10-23T10:00Z`).
- Writes no request log, and the Caddy site has no access log, so no IP is ever written.
- Rows wait in `pending/<hour>.jsonl`. Once the hour is over, they are shuffled and appended to
  `data/<day>.jsonl`.

## The data

<https://aje.apiad.net/data/> lists one JSON Lines file per UTC day, CC0. Each line is one event:

```json
{"event": "sms", "app": "1.0.0-beta.6", "commit": "0615a16", "android": "14", "maker": "samsung", "kind": "unparsed_bank", "sender": "PAGOxMOVIL", "length": 212, "lines": 7, "text": "Banco Metropolitano: ‹w› ‹w› ###.## CUP", "hour": "2026-10-23T10:00Z"}
```

## Running it

```bash
AJE_TOKEN=... python3 telemetry/collector.py --port 8767 --root /var/lib/aje-collector
cd telemetry && python3 -m unittest test_collector   # part of make test
```
