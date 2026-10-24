package aje.app

import android.annotation.SuppressLint
import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.TimeUnit

/**
 * Ajé's alarm clock: the page asks for one time (wakeAt), kept as the unique WorkManager request
 * "aje-wake", which outlives a reboot. At that time [AjeWorker] wakes the page. Which jobs run and
 * when is web/core/jobs.js's to decide; the shell keeps the time and nothing else.
 */
object Wake {
    private const val NAME = "aje-wake"

    /** How long a wake-up may run before the shell closes its page; Android stops a Worker at 10 minutes. */
    const val LIMIT_MS = 9 * 60_000L

    private var running = false
    // A time asked for while a wake-up runs waits for its end: REPLACE would cancel the running one.
    private var asked: Long? = null
    private var hasAsked = false
    private var finished: CompletableDeferred<Unit>? = null

    /** Wakes Ajé at [ms] (now if it is past), instead of any time asked before; null wakes it never. */
    @Synchronized
    fun at(context: Context, ms: Long?) {
        if (!running) return apply(context, ms)
        asked = ms
        hasAsked = true
    }

    /** The page's done: the wake-up that runs now is over. */
    @Synchronized
    fun finish() {
        finished?.complete(Unit)
    }

    @Synchronized
    fun begin(): CompletableDeferred<Unit> {
        running = true
        return CompletableDeferred<Unit>().also { finished = it }
    }

    @Synchronized
    fun end(context: Context) {
        running = false
        finished = null
        if (hasAsked) {
            hasAsked = false
            apply(context, asked)
        }
    }

    private fun apply(context: Context, ms: Long?) {
        val wm = WorkManager.getInstance(context)
        if (ms == null) {
            wm.cancelUniqueWork(NAME)
            return
        }
        val request = OneTimeWorkRequestBuilder<AjeWorker>()
            .setInitialDelay(maxOf(ms - System.currentTimeMillis(), 0), TimeUnit.MILLISECONDS)
            .setInputData(workDataOf("at" to ms))
            .build()
        wm.enqueueUniqueWork(NAME, ExistingWorkPolicy.REPLACE, request)
    }
}

/**
 * One wake-up. An open page gets a wake event and runs its jobs itself, since two pages writing the
 * same IndexedDB would undo each other. Otherwise background.html runs in a WebView no window holds,
 * on the same origin, assets and bridge as the app. Either way the wake-up ends on the page's done,
 * or after [Wake.LIMIT_MS].
 */
class AjeWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val at = inputData.getLong("at", System.currentTimeMillis())
        val finished = Wake.begin()
        try {
            withContext(Dispatchers.Main) {
                val live = NativeBridge.live
                if (live != null && live.wake(at)) withTimeoutOrNull(Wake.LIMIT_MS) { finished.await() } else headless(at, finished)
            }
        } finally {
            Wake.end(applicationContext)
        }
        return Result.success()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private suspend fun headless(at: Long, finished: CompletableDeferred<Unit>) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        val ctx = applicationContext
        val webView = WebView(ctx)
        val bridge = NativeBridge(ctx, null)
        try {
            val assets = MainActivity.prepare(webView)
            webView.webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assets.shouldInterceptRequest(request.url)

                // A page with no window never navigates.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            }
            WebViewCompat.addWebMessageListener(webView, "ajeNative", setOf(MainActivity.ORIGIN), bridge)
            webView.loadUrl("${MainActivity.ORIGIN}/assets/web/background.html?at=$at")
            withTimeoutOrNull(Wake.LIMIT_MS) { finished.await() }
        } finally {
            bridge.detach()
            webView.destroy()
        }
    }
}
