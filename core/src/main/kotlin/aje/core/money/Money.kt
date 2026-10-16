package aje.core.money

/** The currency index the bank's USSD uses (`monedaTarjeta`). USD also covers MLC cards. */
enum class Currency(val index: Int) { CUP(1), CUC(2), USD(3) }

/** A bank, with the two-digit agency code PIN operations lead with. */
enum class Bank(val agency: String?, val displayName: String) {
    BPA("01", "BPA"), BANDEC("02", "BANDEC"), METROPOLITANO("03", "Banco Metropolitano"), MITRANSFER(null, "MiTransfer")
}

/** A 16-digit card number. */
@JvmInline
value class Pan(val digits: String) {
    init {
        require(digits.length == 16 && digits.all { it in '0'..'9' }) { "a card number has 16 digits" }
    }

    val last4: String get() = digits.takeLast(4)

    /** The bank the number belongs to, or null when the prefix does not say. */
    fun bank(): Bank? = when {
        digits.startsWith("976003") -> Bank.MITRANSFER
        digits.startsWith("92") -> when (digits.substring(4, 6)) {
            "12" -> Bank.BPA
            "06" -> Bank.BANDEC
            "95" -> Bank.METROPOLITANO
            else -> null
        }
        else -> null
    }

    override fun toString() = "Pan(····$last4)"

    companion object {
        fun parse(text: String) = Pan(text.filter { it != '-' && it != ' ' })
    }
}

/** The `monedaTarjeta*cuentaOrigen` pair that ends every card operation. */
sealed interface CardSelector {
    val fields: List<String>

    /** The card registered with the bank for this phone in a currency. */
    data class Registered(val currency: Currency) : CardSelector {
        override val fields get() = listOf(currency.index.toString(), "0000")
    }

    /** An explicit card, by number. */
    data class Explicit(val pan: Pan) : CardSelector {
        override val fields get() = listOf("0", pan.digits)
    }
}

/** A bank card as the person labelled it. */
data class Card(val label: String, val bank: Bank, val currency: Currency, val pan: Pan?) {
    val selector: CardSelector get() = pan?.let { CardSelector.Explicit(it) } ?: CardSelector.Registered(currency)
}
