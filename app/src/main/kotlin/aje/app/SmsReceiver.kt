package aje.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.telephony.SubscriptionManager
import org.json.JSONObject

/**
 * Hands each incoming SMS, raw, to the page, or queues it when no page is alive. Money or balance
 * that came in is also notified, unless the page is in front and shows it itself.
 */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        val now = System.currentTimeMillis()
        // The SIM the SMS came in on; older builds of Android name the extra "subscription".
        val subId = intent.getIntExtra(SubscriptionManager.EXTRA_SUBSCRIPTION_INDEX, intent.getIntExtra("subscription", -1))
        messages.groupBy { it.originatingAddress ?: "" }.forEach { (sender, parts) ->
            val sms = JSONObject()
                .put("sender", sender)
                .put("body", parts.joinToString("") { it.messageBody ?: "" })
                .put("sentAt", parts.first().timestampMillis)
                .put("receivedAt", now)
            if (subId >= 0) sms.put("subId", subId)
            if (NativeBridge.live?.push(sms) != true) SmsQueue.append(context.applicationContext, sms)
            if (!MainActivity.foreground) {
                val body = sms.getString("body")
                SmsNotice.of(sender, body)?.let { Notices.post(context.applicationContext, it, SmsNotice.id(sms.getLong("sentAt"), body)) }
            }
        }
    }
}
