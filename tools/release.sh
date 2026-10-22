#!/usr/bin/env bash
# Builds a signed APK for VERSION from the pushed HEAD and publishes it as a GitHub release, with
# the asset names the app's updater reads: aje-<version>-<versionCode>.apk and its .sha256.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=${1:?usage: tools/release.sh 1.0.0 | 1.1.0-beta.1}
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?$ ]] || { echo "bad version: $VERSION" >&2; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "the tree has uncommitted changes" >&2; exit 1; }
HEAD=$(git rev-parse HEAD)
git branch -r --contains "$HEAD" | grep -q . || { echo "push $HEAD first" >&2; exit 1; }
CODE=$(( $(git rev-list --count HEAD) + 200 ))
./gradlew -q :app:assembleRelease -PversionCode="$CODE" -PversionName="$VERSION"
APK="aje-$VERSION-$CODE.apk"
mkdir -p build/release
cp app/build/outputs/apk/release/app-release.apk "build/release/$APK"
# A public release must not carry the dev telemetry endpoint or its token.
python3 -I -c 'import json, sys, zipfile; c = json.loads(zipfile.ZipFile(sys.argv[1]).read("assets/web/config.json")); sys.exit("telemetry in a release build" if c.get("telemetryUrl") or c.get("telemetryToken") else 0)' "build/release/$APK"
(cd build/release && sha256sum "$APK" > "$APK.sha256")
PRE=()
[[ $VERSION == *-* ]] && PRE=(--prerelease)
gh release create "v$VERSION" "build/release/$APK" "build/release/$APK.sha256" --target "$HEAD" \
  --title "Ajé $VERSION" "${PRE[@]}" --notes "Ajé $VERSION (versionCode $CODE). Instala el APK o actualiza desde Ajé: Ajustes → Buscar actualización. Qué es Ajé y cómo instalarla: https://apiad.github.io/aje/"
echo "released v$VERSION as $APK"
