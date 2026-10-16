package aje.app

import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Opt-in development telemetry. Every event carries the app version, Android version,
 * device model and a random install id, plus only the fields in [ALLOWED]. It never
 * carries SMS bodies, phone or card numbers, amounts, balances or USSD replies.
 */
object Telemetry {
    val ALLOWED = setOf("op", "ok", "failure_code", "latency_ms", "kind", "sender", "length", "lines", "error", "stack", "bank", "via", "default_sub")

    private val io = Executors.newSingleThreadExecutor()
    private lateinit var queue: File

    fun init(context: Context) {
        queue = File(context.filesDir, "telemetry.jsonl")
    }

    fun event(name: String, vararg fields: Pair<String, Any?>) {
        if (!Store.telemetry || BuildConfig.TELEMETRY_URL.isEmpty()) return
        val o = JSONObject()
            .put("event", name)
            .put("t", System.currentTimeMillis())
            .put("app", BuildConfig.VERSION_NAME)
            .put("sdk", Build.VERSION.SDK_INT)
            .put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("install", Store.installId)
        for ((k, v) in fields) {
            require(k in ALLOWED) { "telemetry field not allowed: $k" }
            o.putOpt(k, v)
        }
        io.execute {
            queue.appendText(o.toString() + "\n")
            flush()
        }
    }

    private fun flush() {
        val lines = queue.takeIf { it.exists() }?.readLines()?.filter { it.isNotBlank() } ?: return
        if (lines.isEmpty()) return
        val body = JSONArray(lines.map { JSONObject(it) }).toString().toByteArray()
        try {
            val conn = URL(BuildConfig.TELEMETRY_URL).openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("X-Aje-Token", BuildConfig.TELEMETRY_TOKEN)
            conn.outputStream.use { it.write(body) }
            if (conn.responseCode in 200..299) queue.writeText("")
            conn.disconnect()
        } catch (_: Exception) {
            // Offline: the queue keeps the events for the next try.
        }
    }
}
