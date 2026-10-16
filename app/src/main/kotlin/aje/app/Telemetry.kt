package aje.app

import android.content.Context
import android.os.Build
import androidx.compose.runtime.mutableStateListOf
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** One event as the person sees it in the app's telemetry history. */
data class SentEvent(val json: String, val sent: Boolean)

/**
 * Opt-in development telemetry. Every event carries the app version, Android version,
 * device model and a random install id, plus only the fields in [ALLOWED]. Message
 * texts (USSD replies, bank SMS) go through [mask] first, so every digit leaves the
 * phone as `#`: the words arrive, numbers, amounts and balances do not.
 */
object Telemetry {
    val ALLOWED = setOf(
        "op", "ok", "failure_code", "latency_ms", "kind", "sender", "length", "lines",
        "error", "stack", "bank", "via", "default_sub", "text",
    )

    /** Every digit becomes `#`. */
    fun mask(text: String): String = text.map { if (it.isDigit()) '#' else it }.joinToString("")

    private const val LOG_SIZE = 200
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var queue: File
    private lateinit var log: File

    /** The last events, newest first, with whether each one has reached the server. */
    val history = mutableStateListOf<SentEvent>()

    fun init(context: Context) {
        queue = File(context.filesDir, "telemetry.jsonl")
        log = File(context.filesDir, "telemetry-log.jsonl")
        reloadHistory()
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
            o.putOpt(k, if (k == "text" && v is String) mask(v) else v)
        }
        io.execute {
            queue.appendText(o.toString() + "\n")
            appendLog(o, sent = false)
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
            if (conn.responseCode in 200..299) {
                queue.writeText("")
                markLogSent()
            }
            conn.disconnect()
        } catch (_: Exception) {
            // Offline: the queue keeps the events for the next try.
        }
    }

    private fun appendLog(o: JSONObject, sent: Boolean) {
        val lines = (if (log.exists()) log.readLines() else emptyList()).filter { it.isNotBlank() } +
            JSONObject().put("sent", sent).put("e", o).toString()
        log.writeText(lines.takeLast(LOG_SIZE).joinToString("\n") + "\n")
        reloadHistory()
    }

    private fun markLogSent() {
        if (!log.exists()) return
        val lines = log.readLines().filter { it.isNotBlank() }.map { JSONObject(it).put("sent", true).toString() }
        log.writeText(lines.joinToString("\n") + "\n")
        reloadHistory()
    }

    private fun reloadHistory() {
        val items = (if (log.exists()) log.readLines() else emptyList()).filter { it.isNotBlank() }.map {
            val o = JSONObject(it)
            SentEvent(o.getJSONObject("e").toString(2), o.getBoolean("sent"))
        }.reversed()
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            history.clear()
            history.addAll(items)
        }
    }
}
