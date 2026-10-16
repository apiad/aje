package aje.core.ussd

import kotlin.random.Random

/**
 * The parameter encoding the *444 USSD service expects.
 *
 * Each `*`-separated digit segment is mapped through a fixed 100-entry keystream and
 * XORed with a window of it that starts at a random two-digit seed. The output is the
 * seed, then each segment as its two-digit length followed by its encoded value. This
 * is a wire format, not encryption: anyone with the keystream can reverse it.
 */
object Encoder {
    private const val CODE_VERSION = "372653282298718711"
    private const val CRUDE_CODE =
        "10000110101100011000100100100000110010001100000011100010100110010001010010100010111110001100010000011000010101100000000110001100101010100100011000000101110001100001100010001011110001100010100001000110000001101000101001001101001000001000010001100100011010010111001000110011110010001001100001000100000010000111001000110000101110100001111110011000001000110010000111110001100001111111000110011000101001100101000110001000111100011000101011101011111100111010100010111101000110000110011000110011100011000100111000101000011100010100111000011101100011000010101010000010101000100010100011001010101101000110001011101100011001001101101001111100011000000100010001100100010110101000110110000110000101000100011000000010100000010010001101011011100010110001110001001011100000110110001100001000011001011010100101100010001100100011110100011000011000110001100101010110101011110001100010000101000110001001101010010001001110001000010110110001100100111010001101101000110010010110001000110101000011110110000011101000110001001001100100010010000001111000110010011101110001100000001011000110000100011001111101000110000010010100011000110111100101100101011001100000010011000110000000001000100111100011000101101000100100000100010010101000100011100011000001101110001110011000101001"

    private val keystream: IntArray = buildKeystream()
    private val digitTable: IntArray = keystream.filter { it < 10 }.take(10).toIntArray()

    val keystreamSize: Int get() = keystream.size

    fun randomSeed(): Int = Random.nextInt(100)

    /** Encodes a `*`-joined digit parameter list before dialing. */
    fun code(params: String, seed: Int = randomSeed()): String =
        pad2(seed) + segments(params.split("*"), seed).joinToString("*")

    /** Each segment encoded and prefixed with its length, without the leading seed. */
    fun segments(parts: List<String>, seed: Int): List<String> {
        require(seed in 0..99) { "seed must be 0..99, got $seed" }
        return parts.map { pad2(it.length) + encryptToken(seed, it) }
    }

    private fun encryptToken(seed: Int, token: String): String {
        require(token.isNotEmpty() && token.all { it in '0'..'9' }) {
            "only digit segments are supported, got \"$token\""
        }
        val msg = transform(token)
        // The service XORs in a 64-bit integer; past 18 digits it would overflow, so refuse.
        require(msg.length <= 18) { "segment of ${token.length} digits is too long for the wire format" }
        val key = window(seed, token.length).joinToString("").take(msg.length)
        return (key.toLong() xor msg.toLong()).toString()
    }

    private fun transform(token: String): String {
        val out = StringBuilder()
        val even = token.length % 2 == 0
        val body = if (even) token else token.dropLast(1)
        for (j in body.indices step 2) out.append(pad2(keystream[body.substring(j, j + 2).toInt()]))
        if (!even) out.append(digitTable[token.last().digitToInt()])
        return out.toString()
    }

    private fun window(seed: Int, length: Int): List<Int> {
        val win = ArrayList<Int>(length)
        var pos = seed
        repeat(length) {
            if (pos == keystream.size - 1) {
                win += keystream[0]
                pos = 1
            } else if (pos in keystream.indices) {
                win += keystream[pos]
                pos += 1
            }
        }
        return win
    }

    private fun buildKeystream(): IntArray {
        val out = ArrayList<Int>()
        var bits = CRUDE_CODE
        var i = 0
        while (bits.isNotEmpty()) {
            val skip = CODE_VERSION[i].digitToInt()
            bits = if (skip >= bits.length) "" else bits.substring(skip)
            if (bits.length < 8) break
            out += bits.substring(0, 8).toInt(2)
            bits = bits.substring(8)
            i = (i + 1) % CODE_VERSION.length
        }
        return out.toIntArray()
    }

    private fun pad2(v: Int): String = v.toString().padStart(2, '0')
}
