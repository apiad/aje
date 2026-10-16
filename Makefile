# Every mechanical check and build entry point.
.PHONY: test smoke preview apk

# The logic, including the 1600 encoder vectors, in Node.
test:
	cd web && node --test "test/*.test.js"

# The frontend against the mock in a phone-sized browser.
smoke:
	uv run --with playwright python tools/smoke-web.py

# The frontend and the mock as one HTML page, for iterating on the interface without an APK.
preview:
	node tools/build-preview.mjs build/preview.html

# A signed dev APK. The version code is the commit count plus 200, so each build installs over the last;
# the offset clears dev builds made before squash merges shortened the history.
apk:
	./gradlew :app:assembleRelease -PversionCode=$$(( $$(git rev-list --count HEAD) + 200 ))
	@ls -la app/build/outputs/apk/release/*.apk
