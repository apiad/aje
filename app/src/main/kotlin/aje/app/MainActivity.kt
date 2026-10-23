package aje.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.net.Uri
import android.os.Bundle
import android.provider.ContactsContract
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
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
import org.json.JSONObject

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

    // The page's camera request waits here while Android asks the person for the camera.
    private var cameraRequest: PermissionRequest? = null
    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        cameraRequest?.let { if (granted) it.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else it.deny() }
        cameraRequest = null
    }

    // A contact pick waits here while the system picker is open. The picker grants read access to
    // the one row the person picks, so the app needs no contacts permission.
    private var contactReply: ((JSONObject?) -> Unit)? = null
    private val contactPicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uri = result.data?.data
        val contact = if (result.resultCode == RESULT_OK && uri != null) readContact(uri) else null
        contactReply?.invoke(contact)
        contactReply = null
    }

    /** Opens the system picker over phone numbers; [reply] gets {name, number}, or null on cancel. */
    fun pickContact(reply: (JSONObject?) -> Unit) {
        contactReply?.invoke(null)
        contactReply = reply
        try {
            contactPicker.launch(Intent(Intent.ACTION_PICK, ContactsContract.CommonDataKinds.Phone.CONTENT_URI))
        } catch (_: ActivityNotFoundException) {
            contactReply = null
            reply(null)
        }
    }

    private fun readContact(uri: Uri): JSONObject? = try {
        val cols = arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER)
        contentResolver.query(uri, cols, null, null, null)?.use { c ->
            if (c.moveToFirst()) JSONObject().put("name", c.getString(0) ?: "").put("number", c.getString(1) ?: "") else null
        }
    } catch (_: SecurityException) {
        null
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
            // Telemetry reports the maker, not the model; the page reads it from here.
            userAgentString = "$userAgentString AjeMaker/${Build.MANUFACTURER.lowercase().replace(" ", "")}"
        }
        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)

            // The page never navigates away from the bundled frontend; an https link elsewhere
            // (the privacy page) opens in the browser.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.scheme == "https" && url.host != DOMAIN) {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, url))
                    } catch (_: ActivityNotFoundException) {
                    }
                }
                return true
            }
        }
        // The card scanner: video capture for the bundled frontend only, and nothing else.
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val video = PermissionRequest.RESOURCE_VIDEO_CAPTURE
                if (request.origin.toString().trimEnd('/') != ORIGIN || request.resources.toList() != listOf(video)) {
                    request.deny()
                } else if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(arrayOf(video))
                } else {
                    cameraRequest?.deny()
                    cameraRequest = request
                    cameraPermission.launch(Manifest.permission.CAMERA)
                }
            }
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
