package aje.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** Holds the shell's reader to the vectors the web's reader passes (web/test/notice.test.js). */
class SmsNoticeTest {
    // Gradle runs unit tests in the module's directory, app/.
    private val vectors = JSONArray(File(System.getProperty("user.dir"), "../web/test/fixtures/notice-vectors.json").readText())

    private fun JSONObject.str(k: String): String? = if (isNull(k)) null else getString(k)

    private fun notice(o: JSONObject) = Notice(o.getString("kind"), o.str("amount"), o.str("number"), o.str("account"), o.str("plan"))

    @Test
    fun everyVectorReadsAsTheWebReadsIt() {
        for (i in 0 until vectors.length()) {
            val v = vectors.getJSONObject(i)
            val expected = if (v.isNull("out")) null else notice(v.getJSONObject("out"))
            assertEquals(v.getString("body"), expected, SmsNotice.of(v.getString("sender"), v.getString("body")))
        }
    }

    @Test
    fun everyVectorsIdIsTheWebsId() {
        for (i in 0 until vectors.length()) {
            val v = vectors.getJSONObject(i)
            assertEquals(v.getString("id"), SmsNotice.id(v.getLong("sentAt"), v.getString("body")))
        }
    }

    @Test
    fun aHashOverCodePointsBeyondTheBasicPlane() {
        // fnv1a in notice.js over "Mamá 🙂", computed in Node.
        assertEquals("7:ab4a0e1b", SmsNotice.id(7, "Mamá 🙂"))
    }

    @Test
    fun theCopyMatchesTheWeb() {
        val card = Notice("card-received", "1500.00 CUP", "51234567", "9200XXXXXXXX0001", null)
        assertEquals("Dinero recibido" to "Recibiste 1500.00 CUP de Mamá", SmsNotice.text(card, "Mamá"))
        assertEquals("Dinero recibido" to "Recibiste 1500.00 CUP de 51234567 (desconocido)", SmsNotice.text(card, null))
        assertEquals("Saldo recibido" to "Recibiste 250.00 CUP de 51234567 (desconocido)",
            SmsNotice.text(Notice("line-received", "250.00 CUP", "51234567", null, null), null))
        assertEquals("Saldo recibido" to "Recibiste una recarga internacional de 500.00 CUP",
            SmsNotice.text(Notice("recharge-intl", "500.00 CUP", null, null, null), null))
        assertEquals("Recargas y planes" to "Recibiste una recarga internacional: 10GB +100MIN +100SMS",
            SmsNotice.text(Notice("recharge-intl", null, null, null, "10GB +100MIN +100SMS"), null))
        assertEquals("Saldo recibido" to "Recibiste una recarga de 500.00 CUP", SmsNotice.text(Notice("recharge", "500.00 CUP", null, null, null), null))
        assertEquals("Recargas y planes" to "Recibiste un plan de 3GB", SmsNotice.text(Notice("plan-gift", null, null, null, "3GB"), null))
        assertEquals("Recargas y planes" to "Tu plan de datos vence el 25-10-26",
            SmsNotice.text(Notice("plan-expiry", null, null, null, "plan de datos vence el 25-10-26"), null))
    }
}
