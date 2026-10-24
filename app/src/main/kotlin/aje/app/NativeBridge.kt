package aje.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Telephony
import android.telephony.SubscriptionInfo
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
    Manifest.permission.READ_PHONE_NUMBERS,
    Manifest.permission.RECEIVE_SMS,
) + (if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.POST_NOTIFICATIONS) else emptyArray())

/** How far back `readSms` reads the inbox, whatever the page asks: old texts stay on the phone. */
private const val SMS_HISTORY_MS = 72 * 60 * 60 * 1000L

/** A one-shot USSD code: digits, `*` and `#`, starting with `*` and ending with `#`. */
private val USSD = Regex("""^\*[0-9*#]+#$""")

/**
 * The native primitives, over the message channel the page sees as `ajeNative`
 * (protocol in web/bridge.js). None of them encodes, parses or decides anything.
 * Nothing here logs a code or a secret: a login code and a saved secret carry the bank key.
 */
class NativeBridge(private val activity: MainActivity) : WebViewCompat.WebMessageListener {
    private var pushProxy: JavaScriptReplyProxy? = null
    private var permissionReply: Pair<JavaScriptReplyProxy, Int>? = null
    // A notice route that came before the page was listening; pushed on ready.
    private var pendingRoute: String? = null

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
                "secretStatus" -> reply(replyProxy, id, SecretStore.status(activity, name(args)))
                "secretSave" -> SecretStore.save(activity, name(args), args.getString("value"), args.optInt("days", 180)) {
                    reply(replyProxy, id, it)
                }
                "secretLoad" -> SecretStore.load(activity, name(args)) { reply(replyProxy, id, it ?: JSONObject.NULL) }
                "secretForget" -> {
                    SecretStore.forget(activity, name(args))
                    reply(replyProxy, id, JSONObject.NULL)
                }
                "pickContact" -> activity.pickContact { reply(replyProxy, id, it ?: JSONObject.NULL) }
                "contactNames" -> {
                    val numbers = args.optJSONArray("numbers") ?: JSONArray()
                    val lookUp = { contactNames(numbers) { reply(replyProxy, id, it) } }
                    val granted = activity.checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED
                    if (args.optBoolean("ask") && !granted) activity.askContacts(lookUp) else lookUp()
                }
                "readSms" -> {
                    val since = maxOf(args.optLong("since", 0), System.currentTimeMillis() - SMS_HISTORY_MS)
                    val granted = { activity.checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED }
                    val read = { if (granted()) inbox(since) { reply(replyProxy, id, it) } else fail(replyProxy, id, "permission") }
                    if (granted()) read() else activity.askSms(read)
                }
                "installUpdate" -> Updater.install(
                    activity, args.getString("url"), args.getString("sha256"),
                    progress = { received, total ->
                        post(replyProxy, JSONObject().put("id", id).put("progress", JSONObject().put("received", received).put("total", total)))
                    },
                ) { reply(replyProxy, id, it) }
                "ready" -> {
                    pushProxy = replyProxy
                    live = this
                    SmsQueue.drain(activity).forEach { push(it) }
                    pendingRoute?.let { open(it) }
                    pendingRoute = null
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

    /** Tells the page to open a notice's route, now or once it sends ready. */
    fun open(route: String) {
        val proxy = pushProxy
        if (proxy == null) {
            pendingRoute = route
            return
        }
        post(proxy, JSONObject().put("event", "open").put("route", route))
    }

    /** `{number: name}` for the numbers in the contacts; looked up off the main thread. */
    private fun contactNames(numbers: JSONArray, reply: (JSONObject) -> Unit) {
        Thread {
            val names = JSONObject()
            for (i in 0 until numbers.length()) {
                val number = numbers.optString(i)
                if (number.isNotEmpty()) Notices.nameOf(activity, number)?.let { names.put(number, it) }
            }
            activity.runOnUiThread { reply(names) }
        }.start()
    }

    /**
     * The inbox SMS received since `since`, oldest first, from service senders only: a sender with a
     * letter or of six digits or fewer, as senderTag in web/core/sms.js. A person's texts are never
     * read. Read off the main thread.
     */
    private fun inbox(since: Long, reply: (JSONArray) -> Unit) {
        Thread {
            val list = JSONArray()
            try {
                activity.contentResolver.query(
                    Telephony.Sms.Inbox.CONTENT_URI,
                    arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE_SENT, Telephony.Sms.DATE, Telephony.Sms.SUBSCRIPTION_ID),
                    "${Telephony.Sms.DATE} >= ?", arrayOf(since.toString()), "${Telephony.Sms.DATE} ASC",
                )?.use { c ->
                    while (c.moveToNext()) {
                        val sender = c.getString(0) ?: continue
                        if (!sender.any { it.isLetter() } && sender.length > 6) continue
                        val sms = JSONObject().put("sender", sender).put("body", c.getString(1) ?: "")
                            .put("sentAt", c.getLong(2)).put("receivedAt", c.getLong(3))
                        if (!c.isNull(4) && c.getInt(4) >= 0) sms.put("subId", c.getInt(4))
                        list.put(sms)
                    }
                }
            } catch (_: SecurityException) {
            }
            activity.runOnUiThread { reply(list) }
        }.start()
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
                .put("readPhoneNumbers", granted(Manifest.permission.READ_PHONE_NUMBERS))
                .put("receiveSms", granted(Manifest.permission.RECEIVE_SMS))
                .put("postNotifications", Build.VERSION.SDK_INT < 33 || granted(Manifest.permission.POST_NOTIFICATIONS))
                .put("readContacts", granted(Manifest.permission.READ_CONTACTS)),
        )
    }

    fun detach() {
        pushProxy = null
        if (live === this) live = null
    }

    private fun name(args: JSONObject): String {
        val name = args.optString("name")
        require(name.matches(Regex("""^[a-z]+:[A-Za-z0-9_]+$"""))) { "malformed secret name" }
        return name
    }

    private fun code(args: JSONObject): String {
        val code = args.optString("code")
        require(USSD.matches(code)) { "malformed USSD code" }
        return code
    }

    @SuppressLint("MissingPermission")
    private fun sims(): JSONArray = try {
        JSONArray().apply {
            val sm = activity.getSystemService(SubscriptionManager::class.java)
            sm.activeSubscriptionInfoList.orEmpty().forEach {
                put(JSONObject().put("subId", it.subscriptionId).put("slot", it.simSlotIndex).put("carrier", it.carrierName?.toString() ?: "")
                    .put("number", number(sm, it)))
            }
        }
    } catch (_: SecurityException) {
        JSONArray()
    }

    /** The SIM's own number, which many SIMs do not carry: "" when Android does not know it or may not tell. */
    @SuppressLint("MissingPermission")
    @Suppress("DEPRECATION")
    private fun number(sm: SubscriptionManager, info: SubscriptionInfo): String = try {
        if (Build.VERSION.SDK_INT >= 33) sm.getPhoneNumber(info.subscriptionId) else info.number.orEmpty()
    } catch (_: Exception) {
        // Not allowed, a SIM gone since the list was read, or no subscription service: no number.
        ""
    }

    private fun reply(proxy: JavaScriptReplyProxy, id: Int, result: Any) =
        post(proxy, JSONObject().put("id", id).put("result", result))

    private fun fail(proxy: JavaScriptReplyProxy, id: Int, error: String) =
        post(proxy, JSONObject().put("id", id).put("error", error))

    // A USSD callback can land after its page is gone; the answer then has nowhere to go.
    private fun post(proxy: JavaScriptReplyProxy, message: JSONObject) {
        try {
            proxy.postMessage(message.toString())
        } catch (_: Exception) {
        }
    }

    companion object {
        /** The bridge of the page that is alive now, if any; the SMS receiver pushes through it. */
        var live: NativeBridge? = null
    }
}
