# Ajé

Personal finance for Cuba, as an Android app. Offline first; it talks to the
banks over USSD and SMS from your own SIM. The app is a web frontend in a
WebView, with a small native shell for what only Android can do.

```bash
make test   # the logic in Node, including the encoder's reference vectors
make smoke  # the frontend against a mock, in a phone-sized browser (Playwright)
make apk    # signed APK (needs keystore.properties)
```

To work on the frontend in a browser, serve `web/` (for example
`python3 -m http.server -d web`) and open `index.html`: without the native
shell it runs against `web/mock.js`.

## Privacy

Ajé keeps everything on the phone. The only thing that can leave it is opt-in error reporting:
one redacted event per request, with no identifier, published in full at
<https://aje.apiad.net/data/>. How it works, for users: <https://aje.apiad.net/privacidad>; for
developers: [docs/telemetry.md](docs/telemetry.md).
