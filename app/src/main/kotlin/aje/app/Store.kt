package aje.app

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import aje.core.money.Bank
import aje.core.money.Currency
import aje.core.sms.BankSms
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

enum class AttemptState { SENT, REPLIED, FAILED, DIALER, VERIFIED }

/** One balance query: logged on send, verified when the bank's SMS arrives. */
data class Attempt(
    val id: Long,
    val startedAt: Long,
    val code: String,
    val state: AttemptState,
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
    var telemetry by mutableStateOf(false)
    lateinit var installId: String
        private set

    fun init(context: Context) {
        prefs = context.getSharedPreferences("aje", Context.MODE_PRIVATE)
        subId = prefs.getInt("subId", -1)
        bank = Bank.valueOf(prefs.getString("bank", Bank.METROPOLITANO.name)!!)
        currency = Currency.valueOf(prefs.getString("currency", Currency.CUP.name)!!)
        telemetry = prefs.getBoolean("telemetry", false)
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
            .putBoolean("telemetry", telemetry)
            .apply()
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
        val pending = attempts.firstOrNull { it.state != AttemptState.VERIFIED && now - it.startedAt < WINDOW_MS }
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
        .put("id", a.id).put("startedAt", a.startedAt).put("code", a.code).put("state", a.state.name)
        .putOpt("reply", a.reply).putOpt("failureCode", a.failureCode)
        .putOpt("accounting", a.accounting).putOpt("available", a.available).putOpt("verifiedAt", a.verifiedAt)

    private fun fromJson(o: JSONObject) = Attempt(
        id = o.getLong("id"),
        startedAt = o.getLong("startedAt"),
        code = o.optString("code"),
        state = AttemptState.valueOf(o.getString("state")),
        reply = o.optString("reply").ifEmpty { null },
        failureCode = if (o.has("failureCode")) o.getInt("failureCode") else null,
        accounting = o.optString("accounting").ifEmpty { null },
        available = o.optString("available").ifEmpty { null },
        verifiedAt = if (o.has("verifiedAt")) o.getLong("verifiedAt") else null,
    )
}
