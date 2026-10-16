package aje.app

import android.content.Context
import aje.core.money.Card
import aje.core.money.Currency
import aje.core.money.MobileLine
import aje.core.money.Pan
import aje.core.ops.BankOps
import aje.core.ussd.Encoder
import aje.core.ussd.UssdConfig

/** The bank operations the app runs, outside the UI so the SMS receiver can rerun one. */
object Ops {
    private fun card(currency: Currency) = Card("Principal", Store.bank, currency, pan = null)

    fun balance(context: Context, currency: Currency = Store.currency, viaDialer: Boolean = false) {
        val ussd = BankOps.balance(card(currency))
        val seed = Encoder.randomSeed()
        val config = UssdConfig()
        val now = System.currentTimeMillis()
        val attempt = Attempt(
            now, now, ussd.display(config, seed), if (viaDialer) AttemptState.DIALER else AttemptState.SENT,
            currency = currency.name,
        )
        Store.add(attempt)
        val dialed = ussd.dial(config, seed)
        if (viaDialer) {
            Telemetry.event("ussd_sent", "op" to "46", "bank" to Store.bank.name, "via" to "dialer")
            Ussd.dial(context, dialed)
            return
        }
        Telemetry.event("ussd_sent", "op" to "46", "bank" to Store.bank.name, "via" to "api")
        Ussd.send(
            context, Store.subId, dialed,
            onReply = { reply ->
                Store.update(attempt.id) { if (it.state == AttemptState.VERIFIED) it.copy(reply = reply) else it.copy(state = AttemptState.REPLIED, reply = reply) }
                Telemetry.event("ussd_reply", "op" to "46", "ok" to true, "length" to reply.length, "latency_ms" to System.currentTimeMillis() - now, "text" to reply)
                if (BankOps.needsLogin(reply)) sessionLost("46")
            },
            onFailure = { code, error ->
                Store.update(attempt.id) { if (it.state == AttemptState.VERIFIED) it else it.copy(state = AttemptState.FAILED, failureCode = code) }
                Telemetry.event("ussd_reply", "op" to "46", "ok" to false, "failure_code" to code, "error" to error)
            },
        )
    }

    /** Sends op 40 with the key. The key goes into the dialed string only and is dropped here. */
    fun login(context: Context, pin: String, onStatus: (String) -> Unit) {
        val code = BankOps.login(Store.bank, pin)
        onStatus("Enviando…")
        val start = System.currentTimeMillis()
        Telemetry.event("ussd_sent", "op" to "40", "bank" to Store.bank.name, "via" to "api")
        Ussd.send(
            context, Store.subId, code.dial(UssdConfig()),
            onReply = {
                onStatus("Respuesta del banco: $it")
                Telemetry.event("ussd_reply", "op" to "40", "ok" to true, "latency_ms" to System.currentTimeMillis() - start, "text" to it)
            },
            onFailure = { c, e ->
                onStatus("El teléfono no la envió (código $c).")
                Store.retryBalanceAfterLogin = false
                Telemetry.event("ussd_reply", "op" to "40", "ok" to false, "failure_code" to c, "error" to e)
            },
        )
    }

    /**
     * Dials op 45. The transfer ends in the bank's menu, where the person types 1 to confirm,
     * so it goes through the system dialer; the bank's transfer SMS verifies it.
     */
    fun transfer(context: Context, currency: Currency = Store.currency, to: Pan, amount: Long) {
        val ussd = BankOps.transfer(card(currency), to, amount)
        val seed = Encoder.randomSeed()
        val config = UssdConfig()
        val now = System.currentTimeMillis()
        Store.add(
            Attempt(
                now, now, ussd.display(config, seed), AttemptState.DIALER,
                op = "45", to = to.digits, amount = amount, currency = currency.name,
            ),
        )
        Telemetry.event("ussd_sent", "op" to "45", "bank" to Store.bank.name, "via" to "dialer")
        Ussd.dial(context, ussd.dial(config, seed))
    }

    /**
     * Sends a line's balance code (*222# prepaid, *111# postpaid) on that SIM and reports the
     * reply. The reply is text, not an SMS, so it is shown as-is and not matched to an attempt.
     */
    fun mobileBalance(context: Context, line: MobileLine, onStatus: (String) -> Unit) {
        val op = line.balanceCode.filter { it.isDigit() }
        onStatus("Enviando…")
        val start = System.currentTimeMillis()
        Telemetry.event("ussd_sent", "op" to op, "via" to "api")
        Ussd.send(
            context, line.subId, line.balanceCode,
            onReply = {
                onStatus(it)
                Telemetry.event("ussd_reply", "op" to op, "ok" to true, "length" to it.length, "latency_ms" to System.currentTimeMillis() - start, "text" to it)
            },
            onFailure = { c, e ->
                onStatus("El teléfono no la envió (código $c).")
                Telemetry.event("ussd_reply", "op" to op, "ok" to false, "failure_code" to c, "error" to e)
            },
        )
    }

    /** The bank said the session is closed: report how long ago the last login was confirmed. */
    private fun sessionLost(op: String) {
        val since = Store.authenticatedAt?.let { System.currentTimeMillis() - it }
        Telemetry.event("session_lost", "op" to op, "bank" to Store.bank.name, "age_ms" to since)
    }
}
