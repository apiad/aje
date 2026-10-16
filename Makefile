# Every mechanical check and build entry point.
.PHONY: test test-web test-core apk

test: test-web test-core

test-web:
	cd web && node --test

test-core:
	./gradlew :core:test

# A signed dev APK. The version code is the commit count, so each build installs over the last.
apk:
	./gradlew :app:assembleRelease -PversionCode=$$(git rev-list --count HEAD)
	@ls -la app/build/outputs/apk/release/*.apk
