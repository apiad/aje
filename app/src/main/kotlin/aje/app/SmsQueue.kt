package aje.app

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * SMS that arrived while no page was alive, such as a bank's transfer confirmation landing
 * while Ajé sat behind the dialer and its process died. The page drains them on `ready`,
 * and draining deletes the file.
 */
object SmsQueue {
    private const val MAX = 20

    private fun file(context: Context) = File(context.noBackupFilesDir, "pending-sms.jsonl")

    @Synchronized
    fun append(context: Context, sms: JSONObject) {
        val f = file(context)
        val lines = (if (f.exists()) f.readLines() else emptyList()).filter { it.isNotBlank() } + sms.toString()
        f.writeText(lines.takeLast(MAX).joinToString("\n") + "\n")
    }

    @Synchronized
    fun drain(context: Context): List<JSONObject> {
        val f = file(context)
        if (!f.exists()) return emptyList()
        val out = f.readLines().filter { it.isNotBlank() }.mapNotNull { runCatching { JSONObject(it) }.getOrNull() }
        f.delete()
        return out
    }
}
