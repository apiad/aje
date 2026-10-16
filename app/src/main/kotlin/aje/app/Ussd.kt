package aje.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.telephony.TelephonyManager

/** Sends one-shot USSD codes on a chosen SIM, or hands them to the dialer. */
object Ussd {
    fun send(context: Context, subId: Int, code: String, onReply: (String) -> Unit, onFailure: (Int, String?) -> Unit) {
        try {
            val base = context.getSystemService(TelephonyManager::class.java)
            val tm = if (subId >= 0) base.createForSubscriptionId(subId) else base
            tm.sendUssdRequest(code, object : TelephonyManager.UssdResponseCallback() {
                override fun onReceiveUssdResponse(t: TelephonyManager, request: String, response: CharSequence) =
                    onReply(response.toString())

                override fun onReceiveUssdResponseFailed(t: TelephonyManager, request: String, failureCode: Int) =
                    onFailure(failureCode, null)
            }, Handler(Looper.getMainLooper()))
        } catch (e: Exception) {
            onFailure(-100, e.javaClass.simpleName)
        }
    }

    /** Opens the system dialer's call with the code; the reply then shows in the system's USSD window. */
    fun dial(context: Context, code: String) {
        context.startActivity(Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(code))))
    }
}
