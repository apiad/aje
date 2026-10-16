package aje.core.sms

import aje.core.money.Bank
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.assertNull

/** Fixtures follow the layout of real Banco Metropolitano texts; every number in them is made up. */
class BankSmsParserTest {
    private val balance = "Banco Metropolitano:  La consulta de saldo fue completada. \n" +
        " Saldo Contable: CR 1234.56 CUP \n" +
        " Saldo Disponible: CR 1200.06 CUP"

    private val transfer = "Banco Metropolitano:  La Transferencia fue completada. \n" +
        " Fecha: 1/2/2026 \n" +
        " Beneficiario: 9200XXXXXXXX0001 \n" +
        " Ordenante: CUP \n" +
        " Monto: 100.00 CUP \n" +
        " Nro. Transaccion: AB0000XYZ0001 \n" +
        " Saldo restante: CR 1134.56 CUP "

    private val auth = "Usted se ha autenticado en la plataforma de pagos moviles, en el Banco Metropolitano, " +
        "puede comenzar a utilizar nuestros servicios de pagos a traves del movil"

    @Test
    fun balanceReport() {
        assertEquals(
            BankSms.BalanceReport(Bank.METROPOLITANO, Money(123456, "CUP"), Money(120006, "CUP")),
            BankSmsParser.parse(balance),
        )
    }

    @Test
    fun transferDone() {
        assertEquals(
            BankSms.TransferDone(
                Bank.METROPOLITANO, "1/2/2026", "9200XXXXXXXX0001", Money(10000, "CUP"), "AB0000XYZ0001", Money(113456, "CUP"),
            ),
            BankSmsParser.parse(transfer),
        )
    }

    @Test
    fun transferMatchesTheMaskedBeneficiaryAndTheAmount() {
        val done = BankSmsParser.parse(transfer) as BankSms.TransferDone
        assertTrue(done.matches("9200950000000001", 10000))
        assertFalse(done.matches("9200950000000002", 10000))
        assertFalse(done.matches("9200950000000001", 10100))
    }

    @Test
    fun authenticated() {
        assertEquals(BankSms.Authenticated(Bank.METROPOLITANO), BankSmsParser.parse(auth))
    }

    @Test
    fun debitIsNegative() {
        val r = BankSmsParser.parse(balance.replace("CR 1234.56", "DB 5.00")) as BankSms.BalanceReport
        assertEquals(Money(-500, "CUP"), r.accounting)
        assertEquals("-5.00 CUP", r.accounting.toString())
    }

    @Test
    fun thousandsSeparatorAndDecimalComma() {
        val a = BankSmsParser.parse(balance.replace("CR 1234.56", "CR 1,234.56")) as BankSms.BalanceReport
        assertEquals(123456, a.accounting.cents)
        val b = BankSmsParser.parse(balance.replace("CR 1234.56", "CR 1234,56")) as BankSms.BalanceReport
        assertEquals(123456, b.accounting.cents)
    }

    @Test
    fun crlfLineBreaksAsTheBankSendsThem() {
        val r = BankSmsParser.parse(balance.replace("\n", "\r\n")) as BankSms.BalanceReport
        assertEquals(Money(123456, "CUP"), r.accounting)
        assertEquals(Money(120006, "CUP"), r.available)
    }

    @Test
    fun unknownTexts() {
        assertNull(BankSmsParser.parse("Hola, nos vemos mañana"))
        assertNull(BankSmsParser.parse("Banco Metropolitano: un aviso que no conocemos"))
    }
}
