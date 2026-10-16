package aje.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.net.Uri
import android.telephony.SubscriptionManager
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

private val PERMISSIONS = arrayOf(
    Manifest.permission.CALL_PHONE,
    Manifest.permission.READ_PHONE_STATE,
    Manifest.permission.RECEIVE_SMS,
)

/** A one-shot USSD code: digits, `*` and `#`, starting with `*` and ending with `#`. */
private val USSD = Regex("""^\*[0-9*#]+#$""")

/**
 * The five native primitives, over the message channel the page sees as `ajeNative`
 * (protocol in web/bridge.js). None of them encodes, parses or decides anything.
 * Nothing here logs a code: a login code carries the bank key.
 */
class NativeBridge(private val activity: MainActivity) : WebViewCompat.WebMessageListener {
    private var pushProxy: JavaScriptReplyProxy? = null
    private var permissionReply: Pair<JavaScriptReplyProxy, Int>? = null

    override fun onPostMessage(
        view: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy,
    ) {
        if (!isMainFrame) return
        val msg = try {
            JSONObject(message.data ?: return)
        } catch (_: JSONException) {
            return
        }
        val id = msg.optInt("id")
        val args = msg.optJSONObject("args") ?: JSONObject()
        try {
            when (msg.optString("method")) {
                "sendUssd" -> Ussd.send(
                    activity, args.optInt("subId", -1), code(args),
                    onReply = { reply(replyProxy, id, JSONObject().put("ok", true).put("reply", it)) },
                    onFailure = { failure, error ->
                        reply(replyProxy, id, JSONObject().put("ok", false).put("failureCode", failure).put("error", error ?: JSONObject.NULL))
                    },
                )
                "dial" -> {
                    Ussd.dial(activity, code(args))
                    reply(replyProxy, id, JSONObject.NULL)
                }
                "listSims" -> reply(replyProxy, id, sims())
                "requestPermissions" -> {
                    permissionReply = replyProxy to id
                    activity.permissions.launch(PERMISSIONS)
                }
                "ready" -> {
                    pushProxy = replyProxy
                    live = this
                    SmsQueue.drain(activity).forEach { push(it) }
                    reply(replyProxy, id, JSONObject.NULL)
                }
                else -> fail(replyProxy, id, "unknown method")
            }
        } catch (e: Exception) {
            // The class name only: a message could quote the code, and a login code carries the key.
            fail(replyProxy, id, e.javaClass.simpleName)
        }
    }

    /** Hands an incoming SMS to the page. False when no page is listening, so the caller queues it. */
    fun push(sms: JSONObject): Boolean {
        val proxy = pushProxy ?: return false
        return try {
            proxy.postMessage(JSONObject(sms.toString()).put("event", "sms").toString())
            true
        } catch (_: Exception) {
            false
        }
    }

    fun onPermissionsResult() {
        val (proxy, id) = permissionReply ?: return
        permissionReply = null
        fun granted(p: String) = activity.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
        reply(
            proxy, id,
            JSONObject()
                .put("callPhone", granted(Manifest.permission.CALL_PHONE))
                .put("readPhoneState", granted(Manifest.permission.READ_PHONE_STATE))
                .put("receiveSms", granted(Manifest.permission.RECEIVE_SMS)),
        )
    }

    fun detach() {
        pushProxy = null
        if (live === this) live = null
    }

    private fun code(args: JSONObject): String {
        val code = args.optString("code")
        require(USSD.matches(code)) { "malformed USSD code" }
        return code
    }

    @SuppressLint("MissingPermission")
    private fun sims(): JSONArray = try {
        JSONArray().apply {
            activity.getSystemService(SubscriptionManager::class.java).activeSubscriptionInfoList.orEmpty().forEach {
                put(JSONObject().put("subId", it.subscriptionId).put("slot", it.simSlotIndex).put("carrier", it.carrierName?.toString() ?: ""))
            }
        }
    } catch (_: SecurityException) {
        JSONArray()
    }

    private fun reply(proxy: JavaScriptReplyProxy, id: Int, result: Any) {
        proxy.postMessage(JSONObject().put("id", id).put("result", result).toString())
    }

    private fun fail(proxy: JavaScriptReplyProxy, id: Int, error: String) {
        proxy.postMessage(JSONObject().put("id", id).put("error", error).toString())
    }

    companion object {
        /** The bridge of the page that is alive now, if any; the SMS receiver pushes through it. */
        var live: NativeBridge? = null
    }
}
