import java.util.Properties

plugins {
    id("com.android.application")
}

// The signing key and the telemetry endpoint live outside the repo; keystore.properties points at them.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "aje.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.aje.app"
        minSdk = 26
        targetSdk = 34
        versionCode = (project.findProperty("versionCode") as String?)?.toInt() ?: 1
        // A release passes its version (make release); any other build is a dev build.
        versionName = (project.findProperty("versionName") as String?) ?: "0.1.0-dev.$versionCode"
    }

    signingConfigs {
        create("dev") {
            if (keystoreProps.containsKey("storeFile")) {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("dev")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

/** Copies web/ into the APK's assets, without tests or the mock, and writes the build's config.json. */
abstract class WebAssets : DefaultTask() {
    @get:InputDirectory abstract val source: DirectoryProperty
    @get:Input abstract val config: MapProperty<String, String>
    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun run() {
        val out = outputDir.get().asFile.resolve("web")
        out.deleteRecursively()
        source.get().asFile.copyRecursively(out)
        listOf("test", "mock.js", "package.json", "config.json").forEach { out.resolve(it).deleteRecursively() }
        val json = config.get().entries.joinToString(",", "{", "}") { (k, v) ->
            "\"$k\":\"" + v.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
        }
        out.resolve("config.json").writeText(json)
    }
}

val webAssets = tasks.register<WebAssets>("webAssets") {
    source.set(rootProject.layout.projectDirectory.dir("web"))
    config.put("app", android.defaultConfig.versionName!!)
    config.put("versionCode", android.defaultConfig.versionCode!!.toString())
    config.put("commit", providers.exec { commandLine("git", "rev-parse", "--short", "HEAD") }.standardOutput.asText.get().trim())
    // The public, opt-in collector: every build carries it, off until the person turns it on. The
    // token ships in the APK and only keeps noise out.
    config.put("telemetryUrl", keystoreProps.getProperty("telemetryUrl", ""))
    config.put("telemetryToken", keystoreProps.getProperty("telemetryToken", ""))
}

androidComponents {
    onVariants { variant -> variant.sources.assets?.addGeneratedSourceDirectory(webAssets, WebAssets::outputDir) }
}

dependencies {
    implementation("androidx.activity:activity:1.13.0")
    implementation("androidx.webkit:webkit:1.17.1")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.fragment:fragment:1.8.5")
    // Phase 0 of the background-work spec: wake-ups that survive a reboot.
    implementation("androidx.work:work-runtime-ktx:2.11.2")
    // SmsNoticeTest runs on the JVM, where Android's org.json is a stub.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
