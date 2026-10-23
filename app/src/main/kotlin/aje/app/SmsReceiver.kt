package aje.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.telephony.SubscriptionManager
import org.json.JSONObject

/** Hands each incoming SMS, raw, to the page, or queues it when no page is alive. */
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
        }
    }
}
