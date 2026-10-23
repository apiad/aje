package aje.app

/** What an incoming SMS says came in; the fields of `noticeOf` in web/core/notice.js. */
data class Notice(val kind: String, val amount: String?, val number: String?, val account: String?, val plan: String?)

/**
 * Reads the SMS that tell of money or balance coming in, so the shell can notify with the app closed.
 * A port of web/core/notice.js, held to the same web/test/fixtures/notice-vectors.json by SmsNoticeTest:
 * a change to one reader changes the other. No Android imports, so it runs on the JVM.
 */
object SmsNotice {
    // (?iu): JavaScript's "i" folds case beyond ASCII too, as in [oó].
    private const val AMOUNT = """([0-9][0-9.,]*)\s*"""
    private val CARD = Regex("""(?iu)El titular del tel[eé]fono\s+(\d+)\s+le ha realizado una transferencia a la cuenta\s+(\S+)\s+de\s+${AMOUNT}(CUP|USD|MLC|CUC|EUR)""")
    private val LINE = Regex("""(?iu)(transferido|recibido)\s+([0-9][0-9.,]*)\s*CUP\s+(?:al|del)\s+(?:n[uú]mero\s+)?(?:\+?53)?([56]\d{7})""")
    private val INTL = Regex("""(?iu)Recarga Internacional""")
    private val INTL_AMOUNT = Regex("""(?iu)(?:recibi[oó]|recibido|recargada con)\s+${AMOUNT}CUP""")
    private val INTL_PLAN = Regex("""(?iu)recibi[oó]\s+(.+?)\s+v[aá]lidos?\s""")
    private val RECHARGE = Regex("""(?iu)recarga de saldo m[oó]vil por un monto de\s+${AMOUNT}CUP""")
    private val GIFT = Regex("""(?iu)Ha recibido un plan de\s+(.+?)\s+v[aá]lido""")
    private val EXPIRY = Regex("""(?iu)Su\s+(plan|bonificaci[oó]n)\s+de\s+(.+?)\s+vence el\s+(\d{2}-\d{2}-\d{2,4})""")
    private val LETTER = Regex("""\p{L}""")

    /** The notice an incoming SMS gives, or null; a person's number never gives one. */
    fun of(sender: String, body: String): Notice? {
        // senderTag in web/core/sms.js: short or alphanumeric senders are services.
        if (!(LETTER.containsMatchIn(sender) || sender.length <= 6)) return null
        val text = body.replace(' ', ' ')
        fun n(kind: String, amount: String? = null, number: String? = null, account: String? = null, plan: String? = null) =
            Notice(kind, amount, number, account, plan)
        fun money(figure: String, currency: String = "CUP") = centsOf(figure)?.let { formatMoney(it, currency.uppercase()) }

        CARD.find(text)?.let { m ->
            val amount = money(m.groupValues[3], m.groupValues[4]) ?: return null
            return n("card-received", amount = amount, number = m.groupValues[1], account = m.groupValues[2])
        }
        LINE.find(text)?.let { m ->
            if (m.groupValues[1].startsWith("r", ignoreCase = true)) {
                val cents = centsOf(m.groupValues[2])
                if (cents != null) return n("line-received", amount = formatMoney(cents, "CUP"), number = m.groupValues[3])
            }
        }
        if (INTL.containsMatchIn(text)) {
            INTL_AMOUNT.find(text)?.let { m -> return money(m.groupValues[1])?.let { n("recharge-intl", amount = it) } }
            INTL_PLAN.find(text)?.let { m -> return n("recharge-intl", plan = m.groupValues[1]) }
            return null
        }
        RECHARGE.find(text)?.let { m -> return money(m.groupValues[1])?.let { n("recharge", amount = it) } }
        GIFT.find(text)?.let { m -> return n("plan-gift", plan = m.groupValues[1]) }
        EXPIRY.find(text)?.let { m ->
            val what = if (m.groupValues[1].startsWith("p", ignoreCase = true)) "plan" else "bonificación"
            return n("plan-expiry", plan = "$what de ${m.groupValues[2].lowercase()} vence el ${m.groupValues[3]}")
        }
        return null
    }

    /** The notice's title, which is also its channel's name, and its sentence; `name` is the contact's, or null. */
    fun text(n: Notice, name: String?): Pair<String, String> {
        val from = "de ${name ?: "${n.number} (desconocido)"}"
        return when (n.kind) {
            "card-received" -> "Dinero recibido" to "Recibiste ${n.amount} $from"
            "line-received" -> "Saldo recibido" to "Recibiste ${n.amount} $from"
            "recharge-intl" -> if (n.amount != null) "Saldo recibido" to "Recibiste una recarga internacional de ${n.amount}"
                else "Recargas y planes" to "Recibiste una recarga internacional: ${n.plan}"
            "recharge" -> "Saldo recibido" to "Recibiste una recarga de ${n.amount}"
            "plan-gift" -> "Recargas y planes" to "Recibiste un plan de ${n.plan}"
            else -> "Recargas y planes" to "Tu ${n.plan}"
        }
    }

    /** The SMS's id, as the web's seen list and inbox key it: send time and the hash of the text. */
    fun id(sentAt: Long, body: String): String = "$sentAt:${fnv1a(body)}"

    /** 32-bit FNV-1a over code points, in lowercase hex without padding, as fnv1a in notice.js. */
    fun fnv1a(text: String): String {
        var h = 0x811c9dc5.toInt()
        text.codePoints().forEach { c ->
            h = h xor c
            h *= 0x01000193
        }
        return Integer.toHexString(h)
    }

    /** `25904.29` or `25,904.29` to cents; a lone comma with two digits after it is a decimal comma. */
    private fun centsOf(number: String): Long? {
        val n = if (Regex("""^\d+,\d{2}$""").matches(number)) number.replace(",", ".") else number.replace(",", "")
        val parts = n.split(".")
        fun int(s: String) = if (Regex("""^\d+$""").matches(s)) s.toLong() else null
        return when (parts.size) {
            1 -> int(parts[0])?.times(100)
            2 -> {
                val whole = int(parts[0])
                val frac = int(parts[1].padEnd(2, '0').take(2))
                if (whole == null || frac == null) null else whole * 100 + frac
            }
            else -> null
        }
    }

    private fun formatMoney(cents: Long, currency: String): String {
        val abs = Math.abs(cents)
        return "${if (cents < 0) "-" else ""}${abs / 100}.${(abs % 100).toString().padStart(2, '0')} $currency"
    }
}
