package aje.core.ops

import aje.core.money.Bank
import aje.core.money.Card
import aje.core.ussd.Field
import aje.core.ussd.UssdCode

/** Bank operations and the order of their parameters. */
object BankOps {
    /** Opcode 46. BANDEC takes no parameters; the other banks take the card selector. */
    fun balance(card: Card): UssdCode =
        if (card.bank == Bank.BANDEC) UssdCode.Bare("46") else encoded("46", card.selector.fields)

    /**
     * Opcode 40: opens a mobile-payments session with the bank, `agency*clave`. The bank
     * answers card operations with "debe autenticarse primero" until this has run.
     */
    fun login(bank: Bank, pin: String): UssdCode {
        val agency = requireNotNull(bank.agency) { "${bank.name} has no agency code" }
        require(pin.length == 4 && pin.all { it in '0'..'9' }) { "the bank key has 4 digits" }
        return UssdCode.Encoded("40", listOf(Field(agency), Field(pin, secret = true)))
    }

    private fun encoded(op: String, values: List<String>) = UssdCode.Encoded(op, values.map { Field(it) })
}
