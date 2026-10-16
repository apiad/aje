package aje.core.ops

import aje.core.money.Bank
import aje.core.money.Card
import aje.core.money.Currency
import aje.core.money.Pan
import aje.core.ussd.UssdCode
import aje.core.ussd.UssdConfig
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

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
    fun transferFromTheRegisteredCard() {
        val from = Card("Principal", Bank.METROPOLITANO, Currency.CUP, pan = null)
        val code = BankOps.transfer(from, Pan.parse("9200950000000001"), 1000) as UssdCode.Encoded
        assertEquals("45", code.op)
        assertEquals(
            listOf("9200950000000001", "1000", "1", "1", "0000", "0000", "0", "0000", "0"),
            code.fields.map { it.value },
        )
    }

    @Test
    fun transferFromAnExplicitCard() {
        val from = Card("Ahorro", Bank.METROPOLITANO, Currency.USD, Pan.parse("9200950000000002"))
        val code = BankOps.transfer(from, Pan.parse("9200950000000001"), 25) as UssdCode.Encoded
        assertEquals(listOf("3", "0", "9200950000000002"), code.fields.map { it.value }.subList(2, 5))
    }

    @Test
    fun transferAmountIsAPositiveWholeNumber() {
        val from = Card("Principal", Bank.METROPOLITANO, Currency.CUP, pan = null)
        assertFailsWith<IllegalArgumentException> { BankOps.transfer(from, Pan.parse("9200950000000001"), 0) }
    }

    @Test
    fun replyThatAsksForLogin() {
        assertTrue(BankOps.needsLogin("Respuesta del banco: Debe autenticarse primero"))
        assertFalse(BankOps.needsLogin("Su solicitud esta siendo procesada, espere un SMS"))
    }

    @Test
    fun bandecBalanceIsBare() {
        assertEquals(UssdCode.Bare("46"), BankOps.balance(Card("Nómina", Bank.BANDEC, Currency.CUP, null)))
    }
}
