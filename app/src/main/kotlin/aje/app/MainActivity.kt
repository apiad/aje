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
import android.webkit.ValueCallback
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

    // A contact lookup that asked for the contacts permission waits here for the person's answer.
    private var contactsAsk: (() -> Unit)? = null
    private val contactsPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        contactsAsk?.invoke()
        contactsAsk = null
    }

    /** Asks for the contacts permission, then calls [then] whatever the answer. */
    fun askContacts(then: () -> Unit) {
        contactsAsk?.invoke()
        contactsAsk = then
        contactsPermission.launch(Manifest.permission.READ_CONTACTS)
    }

    // An inbox read that asked for the SMS permission waits here for the person's answer.
    private var smsAsk: (() -> Unit)? = null
    private val smsPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        smsAsk?.invoke()
        smsAsk = null
    }

    /** Asks for the permission to read the SMS inbox, then calls [then] whatever the answer. */
    fun askSms(then: () -> Unit) {
        smsAsk?.invoke()
        smsAsk = then
        smsPermission.launch(Manifest.permission.READ_SMS)
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

    // A file input waits here while the system picker is open. The picker grants read access to the
    // one file the person picks, so the app needs no storage permission.
    private var fileReply: ValueCallback<Array<Uri>>? = null
    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uri = result.data?.data
        fileReply?.onReceiveValue(if (result.resultCode == RESULT_OK && uri != null) arrayOf(uri) else null)
        fileReply = null
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
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileReply?.onReceiveValue(null)
                fileReply = callback
                try {
                    filePicker.launch(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"))
                } catch (_: ActivityNotFoundException) {
                    fileReply?.onReceiveValue(null)
                    fileReply = null
                }
                return true
            }

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
        // A recreated activity, or one reopened from Recents, gets the old intent back: its notice was already opened.
        val replayed = savedInstanceState != null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        if (!replayed) openRoute(intent)
    }

    // A tapped notification while Ajé is open (launchMode singleTask) lands here instead of onCreate.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        openRoute(intent)
    }

    /** Hands the page the notice a tapped notification names; only an inbox route is taken. */
    private fun openRoute(intent: Intent?) {
        val route = intent?.getStringExtra(ROUTE) ?: return
        intent.removeExtra(ROUTE)
        if (INBOX_ROUTE.matches(route)) bridge.open(route)
    }

    override fun onResume() {
        super.onResume()
        foreground = true
    }

    override fun onPause() {
        foreground = false
        super.onPause()
    }

    override fun onDestroy() {
        bridge.detach()
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val DOMAIN = "appassets.androidplatform.net"
        const val ORIGIN = "https://$DOMAIN"
        const val ROUTE = "route"
        private val INBOX_ROUTE = Regex("""^inbox/\d+:[0-9a-f]+$""")

        /** Whether the page is in front; the SMS receiver then leaves the notice to the page. */
        @Volatile
        var foreground = false
    }
}
