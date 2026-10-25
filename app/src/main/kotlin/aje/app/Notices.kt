package aje.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.ContactsContract
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/**
 * Android notifications for money or balance that came in while the page was not in front. The text
 * is [SmsNotice.text]'s; the name, the contact's when the person allowed the contacts. Tapping one
 * opens Ajé on the notice, which stays in the inbox until the person opens or dismisses it there.
 */
object Notices {
    /** The channels, by the notice's title. */
    private val CHANNELS = mapOf("Dinero recibido" to "money", "Saldo recibido" to "balance", "Recargas y planes" to "plans")

    fun post(context: Context, notice: Notice, id: String) {
        if (Build.VERSION.SDK_INT >= 33 && !granted(context, Manifest.permission.POST_NOTIFICATIONS)) return
        val manager = context.getSystemService(NotificationManager::class.java)
        CHANNELS.forEach { (name, channel) ->
            if (manager.getNotificationChannel(channel) == null) {
                manager.createNotificationChannel(NotificationChannel(channel, name, NotificationManager.IMPORTANCE_DEFAULT))
            }
        }
        val (title, text) = SmsNotice.text(notice, notice.number?.let { nameOf(context, it) })
        val open = Intent(context, MainActivity::class.java)
            .putExtra(MainActivity.ROUTE, "inbox/$id")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        // The whole id, send time included, tells apart two SMS with the same text, such as two equal recharges,
        // and keeps each one's tap intent its own.
        val tag = id.hashCode()
        val tap = PendingIntent.getActivity(context, tag, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(context, CHANNELS.getValue(title))
            .setSmallIcon(R.drawable.ic_aje)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(tap)
            .setAutoCancel(false)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(tag, notification)
        } catch (_: SecurityException) {
            // The permission was taken back between the check and the post.
        }
    }

    /** The channels a background job (web/core/jobs.js) may post on: id to the name Android's settings show. */
    private val JOB_CHANNELS = mapOf("updates" to "Actualizaciones", "automations" to "Automatizaciones")

    /** A notification a background job asked for, `{id, channel, title, text, route}`; a tap opens Ajé on `route`. */
    fun job(context: Context, n: JSONObject) {
        val id = n.getString("id")
        val channel = n.getString("channel")
        val name = requireNotNull(JOB_CHANNELS[channel]) { "unknown channel" }
        val route = n.getString("route")
        require(MainActivity.ROUTES.matches(route)) { "unknown route" }
        if (Build.VERSION.SDK_INT >= 33 && !granted(context, Manifest.permission.POST_NOTIFICATIONS)) return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(channel) == null) {
            manager.createNotificationChannel(NotificationChannel(channel, name, NotificationManager.IMPORTANCE_DEFAULT))
        }
        val open = Intent(context, MainActivity::class.java)
            .putExtra(MainActivity.ROUTE, route)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        // A job's id names what it notifies (an update's version), so the same id replaces its notification.
        val tag = "job:$id".hashCode()
        val tap = PendingIntent.getActivity(context, tag, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val text = n.getString("text")
        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_aje)
            .setContentTitle(n.getString("title"))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build()
        try {
            NotificationManagerCompat.from(context).notify("job", tag, notification)
        } catch (_: SecurityException) {
            // The permission was taken back between the check and the post.
        }
    }

    /** The contact's name for this number, or null without the contacts permission or a match. */
    fun nameOf(context: Context, number: String): String? {
        if (!granted(context, Manifest.permission.READ_CONTACTS)) return null
        return try {
            val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
            context.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0)?.takeIf { it.isNotBlank() } else null
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun granted(context: Context, permission: String) =
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
}
