package aje.core.ussd

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class UssdCodeTest {
    private val config = UssdConfig()

    @Test
    fun bareCodes() {
        assertEquals("*444*85#", UssdCode.Bare("85").dial(config))
    }

    @Test
    fun encodedCodesMatchTheBalanceCapture() {
        val code = UssdCode.Encoded("46", listOf(Field("1"), Field("0000")))
        assertEquals("*444*46*61012*046615*1260416#", code.dial(config, seed = 61))
    }

    @Test
    fun theAccessCodeAndVersionComeFromConfig() {
        val code = UssdCode.Encoded("46", listOf(Field("1"), Field("0000")))
        assertEquals("*555*46*61012*046615*9999999#", code.dial(UssdConfig("555", "9999999"), seed = 61))
    }

    @Test
    fun displayMasksEverySecretSegment() {
        val code = UssdCode.Encoded("30", listOf(Field("01"), Field("4321", secret = true), Field("1500")))
        val dialed = code.dial(config, seed = 7)
        val shown = code.display(config, seed = 7)
        val pinSegment = dialed.removePrefix("*444*30*").split("*")[1]
        assertTrue(pinSegment in dialed)
        assertFalse(pinSegment in shown)
        assertTrue("••••" in shown)
        assertTrue(code.hasSecret)
    }

    @Test
    fun plainDisplayMasksTheTransferKey() {
        val code = UssdCode.Plain(listOf(Field("234"), Field("1"), Field("55555555"), Field("9876", secret = true), Field("25")))
        assertEquals("*234*1*55555555*9876*25#", code.dial(config))
        assertEquals("*234*1*55555555*••••*25#", code.display(config))
    }
}
