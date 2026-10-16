package aje.core.ussd

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class EncoderTest {
    @Test
    fun reproducesTheTwoDeviceCaptures() {
        assertEquals("61012*046615", Encoder.code("1*0000", seed = 61))
        assertEquals("640111*047936", Encoder.code("3*0000", seed = 64))
    }

    @Test
    fun matchesTheReferenceOnEveryVector() {
        val lines = javaClass.getResource("/encoder-vectors.tsv")!!.readText().trim().lines()
        assertEquals(1600, lines.size)
        for (line in lines) {
            val (params, seed, expected) = line.split("\t")
            assertEquals(expected, Encoder.code(params, seed.toInt()), "params=$params seed=$seed")
        }
    }

    @Test
    fun theKeystreamHasOneHundredEntries() {
        assertEquals(100, Encoder.keystreamSize)
    }

    @Test
    fun refusesNonDigitSegments() {
        assertFailsWith<IllegalArgumentException> { Encoder.code("150.50", seed = 1) }
        assertFailsWith<IllegalArgumentException> { Encoder.code("CUP*1", seed = 1) }
    }

    @Test
    fun refusesASegmentTheApksLongWouldOverflow() {
        assertFailsWith<IllegalArgumentException> { Encoder.code("1234567890123456789", seed = 1) }
    }

    @Test
    fun refusesASeedOutsideTwoDigits() {
        assertFailsWith<IllegalArgumentException> { Encoder.code("1", seed = 100) }
    }
}
