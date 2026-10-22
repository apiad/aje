package aje.app

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Installs an update from the project's GitHub releases: downloads the APK, and opens Android's
 * installer only when its SHA-256 is the release's, it is this app at a newer version, and it is
 * signed with the same certificate as the installed app. It decides nothing else; the page chose
 * the release.
 */
object Updater {
    private const val RELEASES = "https://github.com/apiad/aje/releases/download/"
    private val HEX64 = Regex("^[0-9a-f]{64}$")

    fun install(activity: MainActivity, url: String, sha256: String, done: (JSONObject) -> Unit) {
        val answer = { ok: Boolean, reason: String? -> activity.runOnUiThread { done(JSONObject().put("ok", ok).put("reason", reason ?: JSONObject.NULL)) } }
        if (!url.startsWith(RELEASES) || !HEX64.matches(sha256)) return answer(false, "release")
        Thread {
            try {
                val file = File(activity.cacheDir, "updates/update.apk").apply { parentFile?.mkdirs() }
                // A download that passed before Android asked for the install permission is reused.
                if (!file.exists() || digest(file) != sha256) download(url, file)
                if (digest(file) != sha256) return@Thread answer(false, "checksum")
                val pm = activity.packageManager
                val flags = PackageManager.GET_SIGNATURES or if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else 0
                val archive = pm.getPackageArchiveInfo(file.path, flags) ?: return@Thread answer(false, "apk")
                val installed = pm.getPackageInfo(activity.packageName, flags)
                if (archive.packageName != activity.packageName) return@Thread answer(false, "apk")
                if (code(archive) <= code(installed)) return@Thread answer(false, "version")
                if (certs(archive).isEmpty() || certs(archive) != certs(installed)) return@Thread answer(false, "signature")
                activity.runOnUiThread {
                    if (Build.VERSION.SDK_INT >= 26 && !pm.canRequestPackageInstalls()) {
                        activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
                        return@runOnUiThread done(JSONObject().put("ok", false).put("reason", "permission"))
                    }
                    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", file)
                    activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                    done(JSONObject().put("ok", true))
                }
            } catch (e: Exception) {
                answer(false, "download")
            }
        }.start()
    }

    private fun download(url: String, file: File) {
        var target = URL(url)
        repeat(5) { // GitHub redirects release assets to its storage host.
            val c = target.openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false
            c.connectTimeout = 20_000
            c.readTimeout = 60_000
            when (c.responseCode) {
                in 300..399 -> target = URL(target, c.getHeaderField("Location")).also { c.disconnect() }
                200 -> return c.inputStream.use { input -> file.outputStream().use { input.copyTo(it) } }
                else -> throw IllegalStateException("HTTP ${c.responseCode}")
            }
        }
        throw IllegalStateException("too many redirects")
    }

    private fun digest(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(1 shl 16)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    @Suppress("DEPRECATION")
    private fun code(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun certs(info: PackageInfo): Set<String> {
        val sigs = if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) info.signingInfo!!.apkContentsSigners else info.signatures
        val md = MessageDigest.getInstance("SHA-256")
        return sigs.orEmpty().map { md.digest(it.toByteArray()).joinToString("") { b -> "%02x".format(b) } }.toSet()
    }
}
