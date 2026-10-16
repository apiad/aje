package aje.core.ussd

/** The access code and client version the service expects, with their current defaults. */
data class UssdConfig(val accessCode: String = "444", val version: String = "1260416")

/** One parameter. A secret one (a PIN or a transfer key) is masked wherever the code is shown. */
data class Field(val value: String, val secret: Boolean = false)

private const val MASK = "••••"

sealed interface UssdCode {
    /** The string handed to the telephony layer. The only output that may contain a secret. */
    fun dial(config: UssdConfig, seed: Int = Encoder.randomSeed()): String

    /** The string safe to show and to persist: secret fields replaced by a mask. */
    fun display(config: UssdConfig, seed: Int = Encoder.randomSeed()): String

    val hasSecret: Boolean

    /** `*444*op#`: an operation with no parameters. */
    data class Bare(val op: String) : UssdCode {
        override val hasSecret = false
        override fun dial(config: UssdConfig, seed: Int) = "*${config.accessCode}*$op#"
        override fun display(config: UssdConfig, seed: Int) = dial(config, seed)
    }

    /** `*444*op*code(params)*version#`. */
    data class Encoded(val op: String, val fields: List<Field>) : UssdCode {
        override val hasSecret get() = fields.any { it.secret }

        override fun dial(config: UssdConfig, seed: Int) =
            render(config, seed, Encoder.segments(fields.map { it.value }, seed))

        override fun display(config: UssdConfig, seed: Int) =
            render(
                config, seed,
                Encoder.segments(fields.map { it.value }, seed).mapIndexed { i, s -> if (fields[i].secret) MASK else s },
            )

        private fun render(config: UssdConfig, seed: Int, segments: List<String>) =
            "*${config.accessCode}*$op*${seed.toString().padStart(2, '0')}${segments.joinToString("*")}*${config.version}#"
    }

    /** A public ETECSA code sent as typed, such as `*222*328#`. */
    data class Plain(val parts: List<Field>) : UssdCode {
        override val hasSecret get() = parts.any { it.secret }
        override fun dial(config: UssdConfig, seed: Int) = parts.joinToString("*", "*", "#") { it.value }
        override fun display(config: UssdConfig, seed: Int) =
            parts.joinToString("*", "*", "#") { if (it.secret) MASK else it.value }
    }
}
