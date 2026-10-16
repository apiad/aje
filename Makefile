# Every mechanical check and build entry point.
.PHONY: test test-web test-core apk

test: test-web test-core

test-web:
	cd web && node --test "test/*.test.js"

test-core:
	./gradlew :core:test

# A signed dev APK. The version code is the commit count plus 100, so each build installs over the last;
# the offset clears dev builds made before squash merges shortened the history.
apk:
	./gradlew :app:assembleRelease -PversionCode=$$(( $$(git rev-list --count HEAD) + 100 ))
	@ls -la app/build/outputs/apk/release/*.apk
