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

    private fun encoded(op: String, values: List<String>) = UssdCode.Encoded(op, values.map { Field(it) })
}
