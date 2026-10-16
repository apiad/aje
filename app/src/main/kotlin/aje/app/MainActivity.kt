package aje.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.FragmentActivity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Hosts the web frontend bundled in the APK's assets. Everything Ajé does beyond the six
 * primitives in [NativeBridge] runs there. The page loads only from the bundled assets.
 */
class MainActivity : FragmentActivity() {
    private lateinit var webView: WebView
    private lateinit var bridge: NativeBridge

    val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        bridge.onPermissionsResult()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val assets = WebViewAssetLoader.Builder()
            .setDomain(DOMAIN)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        webView = WebView(this)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
        }
        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)

            // The page never navigates away from the bundled frontend.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
        }
        bridge = NativeBridge(this)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "ajeNative", setOf(ORIGIN), bridge)
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
        setContentView(webView)
        webView.loadUrl("$ORIGIN/assets/web/index.html")
    }

    override fun onDestroy() {
        bridge.detach()
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val DOMAIN = "appassets.androidplatform.net"
        const val ORIGIN = "https://$DOMAIN"
    }
}
