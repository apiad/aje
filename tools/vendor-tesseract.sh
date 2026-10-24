#!/usr/bin/env bash
# Fetches the pinned Tesseract.js files the card scanner loads from web/vendor/tesseract/,
# so the app reads card numbers without any network request. Rerun only to change versions.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=web/vendor/tesseract
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fetch() { # package version sha256
  local url
  url=$(npm view "$1@$2" dist.tarball)
  curl -fsSL -o "$TMP/$3.tgz" "$url"
  echo "$4  $TMP/$3.tgz" | sha256sum -c --quiet -
  mkdir -p "$TMP/$3" && tar -xzf "$TMP/$3.tgz" -C "$TMP/$3"
}

fetch tesseract.js 7.0.0 lib 9a93bf51c3387f945d10a24bf8b3a4bf2e45c7c7161b8242aafbaf9d3c4b606a
fetch tesseract.js-core 7.0.0 core ba584355515eaff877552022853c0e71f2cb70466e759d1d6940484929718ee0
fetch @tesseract.js-data/eng 1.0.0 eng c9bddf2e2f0a214ac7918f3f4a3caf45e09ce8674fe26662ae7787ac8927f7bb

mkdir -p "$OUT"
cp "$TMP/lib/package/dist/tesseract.min.js" "$TMP/lib/package/dist/worker.min.js" "$OUT/"
# The SIMD build only: every Android WebView that runs Ajé supports WebAssembly SIMD.
cp "$TMP/core/package/tesseract-core-simd-lstm.wasm.js" "$OUT/"
# Uncompressed: Android packaging gunzips assets named .gz and drops the suffix, so the
# file would not be found under that name; the APK compresses it anyway.
gunzip -c "$TMP/eng/package/4.0.0_best_int/eng.traineddata.gz" > "$OUT/eng.traineddata"
cp "$TMP/lib/package/LICENSE.md" "$OUT/LICENSE-tesseract.js.md" 2>/dev/null || cp "$TMP/lib/package/LICENSE" "$OUT/LICENSE-tesseract.js"
ls -la "$OUT"
