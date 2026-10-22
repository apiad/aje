# Every mechanical check and build entry point.
.PHONY: test smoke ocr preview apk release

# The logic, including the 1600 encoder vectors, in Node.
test:
	cd web && node --test "test/*.test.js"

# The frontend against the mock in a phone-sized browser.
smoke:
	uv run --with playwright --with pillow python tools/smoke-web.py

# The card scanner on synthetic cards, with the vendored Tesseract. Slow: run before a release.
ocr:
	uv run --with playwright --with pillow python tools/ocr-check.py

# The frontend and the mock as one HTML page, for iterating on the interface without an APK.
preview:
	node tools/build-preview.mjs build/preview.html

# A signed dev APK. The version code is the commit count plus 200, so each build installs over the last;
# the offset clears dev builds made before squash merges shortened the history.
apk:
	./gradlew :app:assembleRelease -PversionCode=$$(( $$(git rev-list --count HEAD) + 200 ))
	@ls -la app/build/outputs/apk/release/*.apk

# A signed release on GitHub, from the pushed HEAD: VERSION=1.0.0 is stable, VERSION=1.1.0-beta.1
# (anything with a "-") is a pre-release, which only the beta channel installs.
release:
	tools/release.sh $(VERSION)
