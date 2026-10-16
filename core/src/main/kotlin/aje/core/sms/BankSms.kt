package aje.core.sms

import aje.core.money.Bank

/** A signed money amount as the bank prints it, such as `CR 1234.56 CUP`. */
data class Money(val cents: Long, val currency: String) {
    override fun toString(): String {
        val sign = if (cents < 0) "-" else ""
        val abs = kotlin.math.abs(cents)
        return "$sign${abs / 100}.${(abs % 100).toString().padStart(2, '0')} $currency"
    }
}

/** A confirmation SMS from a bank, parsed. */
sealed interface BankSms {
    val bank: Bank

    data class BalanceReport(override val bank: Bank, val accounting: Money, val available: Money) : BankSms

    data class TransferDone(
        override val bank: Bank,
        val date: String,
        val beneficiary: String,
        val amount: Money,
        val transactionId: String,
        val remaining: Money?,
    ) : BankSms {
        /** Whether this confirms a transfer of [cents] to [card]; the bank masks the middle of the number with X. */
        fun matches(card: String, cents: Long): Boolean =
            amount.cents == cents && beneficiary.length == card.length &&
                beneficiary.zip(card).all { (b, c) -> b == 'X' || b == c }
    }

    /** The bank opened a mobile-payments session for this phone. */
    data class Authenticated(override val bank: Bank) : BankSms
}

/**
 * Reads bank confirmation SMS. Only Banco Metropolitano's texts have been seen so far;
 * a text from another bank, or one this parser does not know, returns null.
 */
object BankSmsParser {
    private const val MONEY = """(CR|DB)?\s*([0-9][0-9.,]*)\s*(CUP|CUC|USD|MLC|EUR)"""

    fun parse(body: String): BankSms? {
        val text = body.replace(' ', ' ')
        val bank = bankOf(text) ?: return null
        return when {
            Regex("consulta de saldo fue completada", RegexOption.IGNORE_CASE) in text -> {
                val accounting = money(text, "Saldo Contable") ?: return null
                val available = money(text, "Saldo Disponible") ?: return null
                BankSms.BalanceReport(bank, accounting, available)
            }
            Regex("transferencia fue completada", RegexOption.IGNORE_CASE) in text -> BankSms.TransferDone(
                bank = bank,
                date = field(text, "Fecha") ?: return null,
                beneficiary = field(text, "Beneficiario") ?: return null,
                amount = money(text, "Monto") ?: return null,
                transactionId = field(text, "Nro\\.? Transacci[oó]n") ?: return null,
                remaining = money(text, "Saldo restante"),
            )
            Regex("se ha autenticado en la plataforma de pagos m[oó]viles", RegexOption.IGNORE_CASE) in text ->
                BankSms.Authenticated(bank)
            else -> null
        }
    }

    private fun bankOf(text: String): Bank? = when {
        Regex("Banco Metropolitano", RegexOption.IGNORE_CASE) in text -> Bank.METROPOLITANO
        else -> null
    }

    private fun field(text: String, label: String): String? =
        Regex("""$label\s*:\s*([^\n]+)""", RegexOption.IGNORE_CASE).find(text)?.groupValues?.get(1)?.trim()

    private fun money(text: String, label: String): Money? {
        val m = Regex("""$label\s*:\s*$MONEY""", RegexOption.IGNORE_CASE).find(text) ?: return null
        val (sign, number, currency) = m.destructured
        val cents = centsOf(number) ?: return null
        return Money(if (sign.equals("DB", ignoreCase = true)) -cents else cents, currency.uppercase())
    }

    /** `25904.29` or `25,904.29` to cents. A lone comma with two digits after it is a decimal comma. */
    private fun centsOf(number: String): Long? {
        val n = if (Regex("""^\d+,\d{2}$""").matches(number)) number.replace(',', '.') else number.replace(",", "")
        val parts = n.split('.')
        return when (parts.size) {
            1 -> parts[0].toLongOrNull()?.times(100)
            2 -> {
                val whole = parts[0].toLongOrNull() ?: return null
                val frac = parts[1].padEnd(2, '0').take(2).toLongOrNull() ?: return null
                whole * 100 + frac
            }
            else -> null
        }
    }
}
