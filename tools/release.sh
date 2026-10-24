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
# A release carries the public, opt-in collector, off by default; a build without it would never report.
python3 -I -c 'import json, sys, zipfile; c = json.loads(zipfile.ZipFile(sys.argv[1]).read("assets/web/config.json")); sys.exit(0 if c.get("telemetryUrl") == "https://aje.apiad.net/t" and c.get("telemetryToken") and c.get("commit") else "the release lacks the telemetry endpoint, token or commit")' "build/release/$APK"
(cd build/release && sha256sum "$APK" > "$APK.sha256")
PRE=()
[[ $VERSION == *-* ]] && PRE=(--prerelease)
gh release create "v$VERSION" "build/release/$APK" "build/release/$APK.sha256" --target "$HEAD" \
  --title "Ajé $VERSION" "${PRE[@]}" --notes "Ajé $VERSION (versionCode $CODE). Instala el APK o actualiza desde Ajé: Ajustes → Buscar actualización. Qué es Ajé y cómo instalarla: https://aje.apiad.net/"
# Only the newest beta stays a release; every stable one stays. Tags stay too, so each beta can be rebuilt.
# The updater reads one page of 30 releases, which old betas would otherwise fill.
if [[ $VERSION == *-* ]]; then
  gh release list --limit 1000 --json tagName,isPrerelease --jq ".[] | select(.isPrerelease and .tagName != \"v$VERSION\") | .tagName" |
    while read -r tag; do gh release delete "$tag" --yes; echo "deleted the release $tag (its tag stays)"; done
fi
echo "released v$VERSION as $APK"
