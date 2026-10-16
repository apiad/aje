package aje.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import aje.core.sms.BankSms
import aje.core.sms.BankSmsParser

/** Reads each incoming SMS; bank confirmations verify the pending operation. */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        messages.groupBy { it.originatingAddress ?: "" }.forEach { (sender, parts) ->
            handle(sender, parts.joinToString("") { it.messageBody ?: "" })
        }
    }

    private fun handle(sender: String, body: String) {
        // Short or alphanumeric senders are services; a long number is a person and is never reported.
        val senderTag = if (sender.any { it.isLetter() } || sender.length <= 6) sender else "number"
        when (val sms = BankSmsParser.parse(body)) {
            is BankSms.BalanceReport -> {
                val latency = Store.verifyBalance(sms)
                Telemetry.event("sms", "kind" to "balance", "sender" to senderTag, "bank" to sms.bank.name, "latency_ms" to latency)
            }
            is BankSms.TransferDone -> Telemetry.event("sms", "kind" to "transfer", "sender" to senderTag, "bank" to sms.bank.name)
            is BankSms.Authenticated -> Telemetry.event("sms", "kind" to "auth", "sender" to senderTag, "bank" to sms.bank.name)
            null -> if (BANKISH in body) {
                Telemetry.event("sms", "kind" to "unparsed_bank", "sender" to senderTag, "length" to body.length, "lines" to body.lines().size)
            }
        }
    }

    private companion object {
        val BANKISH = Regex("banco|bpa|bandec|metropolitano|transferm|saldo", RegexOption.IGNORE_CASE)
    }
}
