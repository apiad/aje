package aje.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.work.CoroutineWorker
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Phase 0 of the background-work spec, a throwaway: can a Worker load the page without a window,
 * read the app's IndexedDB and send a USSD with the screen off and the app closed, and how late do
 * the wake-ups come. Each run appends one line to a local log that Settings shows, and posts a
 * notification. Nothing leaves the phone.
 */
object Spike {
    private const val TAG = "spike"

    private fun file(context: Context) = File(context.noBackupFilesDir, "spike-log.jsonl")

    /** One wake-up per delay, in minutes from now, each knowing the time it was asked for. */
    fun schedule(context: Context, delaysMin: JSONArray) {
        val wm = WorkManager.getInstance(context)
        val now = System.currentTimeMillis()
        for (i in 0 until delaysMin.length()) {
            val min = delaysMin.getLong(i)
            wm.enqueue(
                OneTimeWorkRequestBuilder<SpikeWorker>()
                    .setInitialDelay(min, TimeUnit.MINUTES)
                    .setInputData(workDataOf("askedAt" to now + min * 60_000, "n" to i + 1, "of" to delaysMin.length()))
                    .addTag(TAG)
                    .build(),
            )
        }
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelAllWorkByTag(TAG)
    }

    @Synchronized
    fun append(context: Context, entry: JSONObject) {
        file(context).appendText(entry.toString() + "\n")
    }

    @Synchronized
    fun log(context: Context): JSONArray {
        val f = file(context)
        val out = JSONArray()
        if (f.exists()) f.readLines().filter { it.isNotBlank() }.forEach { runCatching { out.put(JSONObject(it)) } }
        return out
    }

    @Synchronized
    fun clear(context: Context) {
        file(context).delete()
    }

    @SuppressLint("MissingPermission")
    fun notify(context: Context, id: Int, text: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(TAG) == null) {
            manager.createNotificationChannel(NotificationChannel(TAG, "Prueba de segundo plano", NotificationManager.IMPORTANCE_LOW))
        }
        NotificationManagerCompat.from(context).notify(
            TAG, id,
            NotificationCompat.Builder(context, TAG).setSmallIcon(R.drawable.ic_aje)
                .setContentTitle("Ajé · prueba de segundo plano").setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text)).build(),
        )
    }
}

/** One wake-up of the spike: the device's state, then the page without a window, then the log. */
class SpikeWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        val startedAt = System.currentTimeMillis()
        val askedAt = inputData.getLong("askedAt", startedAt)
        val power = ctx.getSystemService(PowerManager::class.java)
        val entry = JSONObject()
            .put("n", inputData.getInt("n", 0)).put("of", inputData.getInt("of", 0))
            .put("askedAt", askedAt).put("startedAt", startedAt)
            .put("lateMin", (startedAt - askedAt) / 60_000.0)
            .put("screenOn", power.isInteractive)
            .put("dozing", power.isDeviceIdleMode)
            .put("batteryExempt", power.isIgnoringBatteryOptimizations(ctx.packageName))
            .put("appInFront", MainActivity.foreground)
            .put("maker", Build.MANUFACTURER).put("android", Build.VERSION.SDK_INT)
        val page = withTimeoutOrNull(4 * 60_000L) { withContext(Dispatchers.Main) { runPage(ctx) } }
        entry.put("page", page ?: JSONObject().put("error", "timeout"))
        entry.put("tookMs", System.currentTimeMillis() - startedAt)
        Spike.append(ctx, entry)
        Spike.notify(ctx, entry.optInt("n"), summary(entry))
        return Result.success()
    }

    private fun summary(e: JSONObject): String {
        val p = e.optJSONObject("page") ?: JSONObject()
        val ussd = p.optJSONObject("ussd")
        val u = when {
            ussd == null -> "USSD no probado"
            ussd.optBoolean("ok") -> "USSD ok"
            else -> "USSD falló (${ussd.opt("failureCode")})"
        }
        val idb = if (p.has("cards")) "IndexedDB ok (${p.optInt("cards")} tarjetas)" else "IndexedDB: ${p.optString("error", "?")}"
        return "${e.optInt("n")}/${e.optInt("of")} · ${"%.0f".format(e.optDouble("lateMin"))} min tarde · " +
            "pantalla ${if (e.optBoolean("screenOn")) "encendida" else "apagada"} · $idb · $u"
    }

    /** Loads spike.html in a WebView that no window holds, and waits for the result it posts. */
    @SuppressLint("SetJavaScriptEnabled")
    private suspend fun runPage(ctx: Context): JSONObject {
        val result = CompletableDeferred<JSONObject>()
        val loadStart = System.currentTimeMillis()
        val assets = WebViewAssetLoader.Builder()
            .setDomain(MainActivity.DOMAIN)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(ctx))
            .build()
        val webView = try {
            WebView(ctx)
        } catch (e: Exception) {
            return JSONObject().put("error", "WebView: ${e.javaClass.simpleName}")
        }
        try {
            webView.settings.javaScriptEnabled = true
            webView.settings.domStorageEnabled = true
            webView.webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assets.shouldInterceptRequest(request.url)
            }
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                return JSONObject().put("error", "no WebMessageListener")
            }
            WebViewCompat.addWebMessageListener(webView, "ajeSpike", setOf(MainActivity.ORIGIN), object : WebViewCompat.WebMessageListener {
                override fun onPostMessage(view: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy) {
                    val msg = runCatching { JSONObject(message.data ?: "") }.getOrNull() ?: return
                    when (msg.optString("method")) {
                        "sendUssd" -> {
                            val code = msg.optString("code")
                            if (!Regex("""^\*[0-9*#]+#$""").matches(code)) {
                                replyProxy.postMessage(JSONObject().put("ok", false).put("error", "malformed").toString())
                                return
                            }
                            Ussd.send(ctx, msg.optInt("subId", -1), code,
                                onReply = { runCatching { replyProxy.postMessage(JSONObject().put("ok", true).put("reply", it).toString()) } },
                                onFailure = { code, error ->
                                    runCatching { replyProxy.postMessage(JSONObject().put("ok", false).put("failureCode", code).put("error", error ?: "").toString()) }
                                })
                        }
                        "result" -> result.complete((msg.optJSONObject("result") ?: JSONObject()).put("loadMs", System.currentTimeMillis() - loadStart))
                    }
                }
            })
            webView.loadUrl("${MainActivity.ORIGIN}/assets/web/spike.html")
            return withTimeoutOrNull(3 * 60_000L) { result.await() } ?: JSONObject().put("error", "the page never answered")
        } finally {
            webView.destroy()
        }
    }
}
