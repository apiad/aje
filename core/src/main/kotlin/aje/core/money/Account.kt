package aje.core.money

import aje.core.ops.BankOps
import aje.core.ussd.UssdCode

/** A Cubacel line's balance code: prepaid dials *222#, postpaid (enterprise) dials *111#. */
enum class MobilePlan(val balanceCode: String) { PREPAGO("*222#"), POSPAGO("*111#") }

/**
 * The line balance shown on a phone card. Both replies carry a `N.NN CUP` figure — prepaid after
 * "Saldo:", postpaid after "Voz: Saldo disponible" — so the first one is the balance. Null when the
 * reply has no CUP amount (an error or an outage).
 */
object MobileBalance {
    private val amount = Regex("""(\d+[.,]\d{2})\s*CUP""")

    fun parse(reply: String): String? = amount.find(reply)?.let { "${it.groupValues[1]} CUP" }
}

/** One account in the home deck: a bank card in a currency, or a phone line on a SIM. */
sealed interface Account {
    val kind: String
}

/** The card registered with [bank] in [currency]; its balance is op 46 with that currency selector. */
data class BankCard(val bank: Bank, val currency: Currency) : Account {
    override val kind get() = "card"

    fun balance(): UssdCode = BankOps.balance(Card("", bank, currency, pan = null))
}

/** A phone line on SIM [slot] (subscription [subId]), labelled by the person, with its [plan]. */
data class MobileLine(val subId: Int, val slot: Int, val label: String, val plan: MobilePlan) : Account {
    override val kind get() = "phone"

    val balanceCode: String get() = plan.balanceCode
}
