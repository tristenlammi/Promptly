// Tells a phone with a locked app that something's waiting: a new device, an invitation, an
// emergency request. It polls bare counts with the device token alone. No vault session, no
// names, no vault content: the notification says only what kind of thing it is. This takes
// the place of the push the plan wanted, since the Android app has no Web Push.
package org.promptly.sync.passwords

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.promptly.sync.R
import org.promptly.sync.passwords.core.Alerts
import org.promptly.sync.passwords.core.ApiError
import org.promptly.sync.passwords.core.ExportReminder
import org.promptly.sync.passwords.core.OfflineError
import org.promptly.sync.passwords.core.VaultApi
import org.promptly.sync.passwords.ui.PasswordsActivity
import java.util.concurrent.TimeUnit

/** What's new since last time. Pure, so a count going down and back up isn't missed, and a
 *  count that merely stayed the same doesn't say anything twice. */
object AlertDiff {
    data class News(val devices: Boolean, val invitations: Boolean, val emergency: Boolean, val sentTabs: Boolean = false) {
        val any: Boolean get() = devices || invitations || emergency || sentTabs
    }

    fun news(before: Alerts, now: Alerts) = News(now.deviceRequests > before.deviceRequests, now.invitations > before.invitations, now.emergency > before.emergency, now.sentTabs > before.sentTabs)
}

object AlertsCheck {
    private const val CHANNEL = "passwords"
    private const val NAME = "pw-alerts"

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences("pw_alerts", Context.MODE_PRIVATE)

    fun schedule(context: Context) {
        val work = PeriodicWorkRequestBuilder<AlertsWorker>(30, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, work)
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(NAME)
        prefs(context).edit().clear().apply()
        // This phone's left the account: what was waiting isn't its business any more.
        val nm = context.getSystemService(NotificationManager::class.java)
        for (id in 1..5) nm.cancel("pw-alert", id)
    }

    private fun channel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Passwords", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "A new device, an invitation or an emergency request is waiting, a browser sent a tab here, or it's time for an encrypted export."
            })
        }
    }

    private fun post(context: Context, id: Int, title: String, text: String) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        channel(context)
        val open = PendingIntent.getActivity(
            context, id,
            Intent(context, PasswordsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.pw_key)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
        context.getSystemService(NotificationManager::class.java).notify("pw-alert", id, n)
    }

    /** Needs no vault session and says nothing about the vault, and it's worth saying with the
     *  server down: that's when you'd want the copy. */
    private fun remindAboutExport(context: Context) {
        val p = Pw.prefs
        if (!ExportReminder.shouldNotify(p.exportLast, p.exportSince, p.exportSnoozedUntil, p.exportNotifiedAt)) return
        p.exportNotifiedAt = System.currentTimeMillis()
        post(context, 4, "Time for an encrypted export", "Open Passwords to save a copy of your vault.")
    }

    /** One look. Blocking. True when it can stop; false to try again later. */
    fun run(context: Context): Boolean {
        Pw.init(context)
        val server = Pw.prefs.server ?: return true
        val token = Pw.prefs.alertToken ?: Pw.prefs.deviceToken ?: return true
        remindAboutExport(context)
        val now = try {
            VaultApi(server, { token }).alerts()
        } catch (e: OfflineError) {
            return false
        } catch (e: ApiError) {
            // This device was removed, or the server said no. Nothing to tell anyone about.
            return e.status < 500
        }
        val p = prefs(context)
        val before = Alerts(p.getInt("devices", 0), p.getInt("invitations", 0), p.getInt("emergency", 0), p.getInt("sent", 0))
        val news = AlertDiff.news(before, now)
        // Quiet when you're in the app already: the screens show all this.
        if (news.devices) post(context, 1, "A new device wants your vault", "Approve it from Passwords, if it's yours.")
        if (news.invitations) post(context, 2, "A shared vault is waiting", "Open Passwords to accept or decline it.")
        if (news.emergency) post(context, 3, "Emergency access needs you", "Open Passwords to see it, and refuse it if you want to.")
        // No address or title: the phone can't open it while locked, and a notification can be read
        // from the lock screen. Unlocking opens it (SentTabs).
        if (news.sentTabs) post(context, 5, "A tab was sent to this phone", "Open Passwords and unlock to open it.")
        p.edit().putInt("devices", now.deviceRequests).putInt("invitations", now.invitations).putInt("emergency", now.emergency).putInt("sent", now.sentTabs).apply()
        return true
    }
}

class AlertsWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        if (AlertsCheck.run(applicationContext)) Result.success() else Result.retry()
    }
}
