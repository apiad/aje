package aje.core.ops

import aje.core.money.Bank
import aje.core.money.Card
import aje.core.money.Currency
import aje.core.money.Pan
import aje.core.ussd.UssdCode
import aje.core.ussd.UssdConfig
import kotlin.test.Test
import kotlin.test.assertEquals

class BankOpsTest {
    @Test
    fun balanceByRegisteredCurrency() {
        val card = Card("Principal", Bank.METROPOLITANO, Currency.CUP, pan = null)
        assertEquals("*444*46*61012*046615*1260416#", BankOps.balance(card).dial(UssdConfig(), seed = 61))
    }

    @Test
    fun balanceByExplicitCard() {
        val card = Card("Ahorro", Bank.METROPOLITANO, Currency.USD, Pan.parse("9200950000000000"))
        assertEquals(listOf("0", "9200950000000000"), (BankOps.balance(card) as UssdCode.Encoded).fields.map { it.value })
    }

    @Test
    fun loginSendsAgencyAndAMaskedKey() {
        val code = BankOps.login(Bank.METROPOLITANO, "1234") as UssdCode.Encoded
        assertEquals("40", code.op)
        assertEquals(listOf("03", "1234"), code.fields.map { it.value })
        assertEquals(listOf(false, true), code.fields.map { it.secret })
        assertEquals(false, "1234" in code.display(UssdConfig(), seed = 5))
    }

    @Test
    fun bandecBalanceIsBare() {
        assertEquals(UssdCode.Bare("46"), BankOps.balance(Card("Nómina", Bank.BANDEC, Currency.CUP, null)))
    }
}
