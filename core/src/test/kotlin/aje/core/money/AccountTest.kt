package aje.core.money

import aje.core.ops.BankOps
import aje.core.ussd.UssdCode
import kotlin.test.Test
import kotlin.test.assertEquals

class AccountTest {
    @Test
    fun mobilePlanCodes() {
        assertEquals("*222#", MobilePlan.PREPAGO.balanceCode)
        assertEquals("*111#", MobilePlan.POSPAGO.balanceCode)
    }

    @Test
    fun bankCardBalanceUsesCurrencySelector() {
        val code = BankCard(Bank.METROPOLITANO, Currency.USD).balance() as UssdCode.Encoded
        assertEquals("46", code.op)
        assertEquals(listOf("3", "0000"), code.fields.map { it.value })
    }

    @Test
    fun bankCardBalanceMatchesBankOps() {
        val card = BankCard(Bank.METROPOLITANO, Currency.CUP)
        val direct = BankOps.balance(Card("", Bank.METROPOLITANO, Currency.CUP, null)) as UssdCode.Encoded
        assertEquals(direct.fields.map { it.value }, (card.balance() as UssdCode.Encoded).fields.map { it.value })
    }

    @Test
    fun mobileLineBalanceCodeIsItsPlan() {
        assertEquals("*111#", MobileLine(2, 0, "SIM 1", MobilePlan.POSPAGO).balanceCode)
    }
}
