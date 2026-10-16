package aje.app

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import aje.core.money.Bank
import aje.core.money.Currency
import aje.core.money.MobilePlan
import aje.core.sms.BankSms
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

enum class AttemptState { SENT, REPLIED, FAILED, DIALER, VERIFIED }

/**
 * One bank operation, logged on send and verified when the bank's SMS arrives. A balance
 * query is op 46; a transfer is op 45 and carries the destination card and the amount.
 */
data class Attempt(
    val id: Long,
    val startedAt: Long,
    val code: String,
    val state: AttemptState,
    val op: String = "46",
    val to: String? = null,
    val amount: Long? = null,
    val currency: String? = null,
    val transactionId: String? = null,
    val reply: String? = null,
    val failureCode: Int? = null,
    val accounting: String? = null,
    val available: String? = null,
    val verifiedAt: Long? = null,
)

/** Settings and history, in SharedPreferences. Small enough for this slice; Room comes later. */
object Store {
    private const val WINDOW_MS = 20 * 60 * 1000L
    private lateinit var prefs: SharedPreferences

    val attempts = mutableStateListOf<Attempt>()
    var subId by mutableStateOf(-1)
    var bank by mutableStateOf(Bank.METROPOLITANO)
    var currency by mutableStateOf(Currency.CUP)
    /** The currencies whose bank cards show in the deck. */
    var enabledCurrencies by mutableStateOf(setOf(Currency.CUP, Currency.CUC, Currency.USD))
    /** The balance code each SIM's line dials, by subscription id; absent means prepaid. */
    var mobilePlans by mutableStateOf<Map<Int, MobilePlan>>(emptyMap())
    var telemetry by mutableStateOf(false)
    /** When the bank's "se ha autenticado" SMS last arrived. */
    var authenticatedAt by mutableStateOf<Long?>(null)
        private set
    /** Set when the person logged in from a "debe autenticarse" reply: the auth SMS reruns the balance query. */
    var retryBalanceAfterLogin by mutableStateOf(false)
    lateinit var installId: String
        private set

    fun init(context: Context) {
        prefs = context.getSharedPreferences("aje", Context.MODE_PRIVATE)
        subId = prefs.getInt("subId", -1)
        bank = Bank.valueOf(prefs.getString("bank", Bank.METROPOLITANO.name)!!)
        currency = Currency.valueOf(prefs.getString("currency", Currency.CUP.name)!!)
        enabledCurrencies = prefs.getString("enabledCurrencies", null)
            ?.split(",")?.filter { it.isNotEmpty() }?.map { Currency.valueOf(it) }?.toSet()
            ?.ifEmpty { null }
            ?: setOf(Currency.CUP, Currency.CUC, Currency.USD)
        mobilePlans = JSONObject(prefs.getString("mobilePlans", "{}")!!).let { o ->
            o.keys().asSequence().associate { it.toInt() to MobilePlan.valueOf(o.getString(it)) }
        }
        telemetry = prefs.getBoolean("telemetry", false)
        authenticatedAt = prefs.getLong("authenticatedAt", 0L).takeIf { it > 0 }
        installId = prefs.getString("installId", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("installId", it).apply()
        }
        attempts.clear()
        val arr = JSONArray(prefs.getString("attempts", "[]"))
        for (i in 0 until arr.length()) attempts += fromJson(arr.getJSONObject(i))
    }

    fun saveSettings() {
        prefs.edit()
            .putInt("subId", subId)
            .putString("bank", bank.name)
            .putString("currency", currency.name)
            .putString("enabledCurrencies", enabledCurrencies.joinToString(",") { it.name })
            .putString("mobilePlans", JSONObject().also { o -> mobilePlans.forEach { (k, v) -> o.put(k.toString(), v.name) } }.toString())
            .putBoolean("telemetry", telemetry)
            .apply()
    }

    /** The plan a SIM's line uses for its balance code; prepaid unless the person set it. */
    fun planFor(subId: Int): MobilePlan = mobilePlans[subId] ?: MobilePlan.PREPAGO

    fun setPlan(subId: Int, plan: MobilePlan) {
        mobilePlans = mobilePlans + (subId to plan)
        saveSettings()
    }

    /** The last verified balance shown on a currency's card, or null until one is queried. */
    fun balanceFor(currency: Currency): String? =
        attempts.firstOrNull { it.op == "46" && it.state == AttemptState.VERIFIED && it.currency == currency.name }?.available

    fun authenticated(at: Long) {
        authenticatedAt = at
        prefs.edit().putLong("authenticatedAt", at).apply()
    }

    fun add(attempt: Attempt) {
        attempts.add(0, attempt)
        while (attempts.size > 50) attempts.removeAt(attempts.lastIndex)
        persist()
    }

    fun update(id: Long, change: (Attempt) -> Attempt) {
        val i = attempts.indexOfFirst { it.id == id }
        if (i >= 0) {
            attempts[i] = change(attempts[i])
            persist()
        }
    }

    /** Promotes the latest pending balance query to verified. Returns the latency, or null if none matched. */
    fun verifyBalance(sms: BankSms.BalanceReport, now: Long = System.currentTimeMillis()): Long? {
        val pending = attempts.firstOrNull { it.op == "46" && it.state != AttemptState.VERIFIED && now - it.startedAt < WINDOW_MS }
        val accounting = sms.accounting.toString()
        val available = sms.available.toString()
        if (pending == null) {
            add(Attempt(now, now, "", AttemptState.VERIFIED, accounting = accounting, available = available, verifiedAt = now))
            return null
        }
        update(pending.id) {
            it.copy(state = AttemptState.VERIFIED, accounting = accounting, available = available, verifiedAt = now)
        }
        return now - pending.startedAt
    }

    /**
     * Promotes the pending transfer this SMS confirms, by card and amount, to verified.
     * Returns the latency, or null if no pending transfer matched.
     */
    fun verifyTransfer(sms: BankSms.TransferDone, now: Long = System.currentTimeMillis()): Long? {
        val pending = attempts.firstOrNull {
            it.op == "45" && it.state != AttemptState.VERIFIED && now - it.startedAt < WINDOW_MS &&
                it.to != null && it.amount != null && sms.matches(it.to, it.amount * 100)
        } ?: return null
        update(pending.id) {
            it.copy(
                state = AttemptState.VERIFIED, transactionId = sms.transactionId,
                available = sms.remaining?.toString(), verifiedAt = now,
            )
        }
        return now - pending.startedAt
    }

    fun saveCrash(stack: String) {
        prefs.edit().putString("crash", stack).commit()
    }

    fun takeCrash(): String? = prefs.getString("crash", null)?.also { prefs.edit().remove("crash").apply() }

    private fun persist() {
        val arr = JSONArray()
        attempts.forEach { arr.put(toJson(it)) }
        prefs.edit().putString("attempts", arr.toString()).apply()
    }

    private fun toJson(a: Attempt) = JSONObject()
        .put("id", a.id).put("startedAt", a.startedAt).put("code", a.code).put("state", a.state.name).put("op", a.op)
        .putOpt("to", a.to).putOpt("amount", a.amount).putOpt("currency", a.currency).putOpt("transactionId", a.transactionId)
        .putOpt("reply", a.reply).putOpt("failureCode", a.failureCode)
        .putOpt("accounting", a.accounting).putOpt("available", a.available).putOpt("verifiedAt", a.verifiedAt)

    private fun fromJson(o: JSONObject) = Attempt(
        id = o.getLong("id"),
        startedAt = o.getLong("startedAt"),
        code = o.optString("code"),
        state = AttemptState.valueOf(o.getString("state")),
        op = o.optString("op", "46"),
        to = o.optString("to").ifEmpty { null },
        amount = if (o.has("amount")) o.getLong("amount") else null,
        currency = o.optString("currency").ifEmpty { null },
        transactionId = o.optString("transactionId").ifEmpty { null },
        reply = o.optString("reply").ifEmpty { null },
        failureCode = if (o.has("failureCode")) o.getInt("failureCode") else null,
        accounting = o.optString("accounting").ifEmpty { null },
        available = o.optString("available").ifEmpty { null },
        verifiedAt = if (o.has("verifiedAt")) o.getLong("verifiedAt") else null,
    )
}
