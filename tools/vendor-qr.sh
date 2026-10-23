#!/usr/bin/env bash
# Fetches the pinned QR libraries into web/vendor/qr/: qrcode-generator draws a charge's QR and jsQR
# reads camera frames, both on the phone with no network request. Rerun only to change versions.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=web/vendor/qr
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fetch() { # package version name sha256
  local url
  url=$(npm view "$1@$2" dist.tarball)
  curl -fsSL -o "$TMP/$3.tgz" "$url"
  echo "$4  $TMP/$3.tgz" | sha256sum -c --quiet -
  mkdir -p "$TMP/$3" && tar -xzf "$TMP/$3.tgz" -C "$TMP/$3"
}

fetch qrcode-generator 2.0.4 gen 02e2e18a99a90b02dad940851f59b7c3c5fd1ab79cbdece8595cb06328878159
fetch jsqr 1.4.0 reader b5299b37917a1fe7a8cab9dd5cc6b8accf82663add80abe5bf7761a921cc6602

mkdir -p "$OUT"
cp "$TMP/gen/package/dist/qrcode.mjs" "$OUT/qrcode.mjs"
cp "$TMP/reader/package/dist/jsQR.js" "$OUT/jsQR.js"
# qrcode.mjs carries its MIT notice in its header; jsQR ships its Apache-2.0 license apart.
cp "$TMP/reader/package/LICENSE" "$OUT/LICENSE.jsqr"
