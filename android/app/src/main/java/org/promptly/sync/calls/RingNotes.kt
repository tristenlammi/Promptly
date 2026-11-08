package org.promptly.sync.calls

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.graphics.drawable.IconCompat
import org.promptly.sync.R

/**
 * The ring: a CallStyle notification with Answer and Decline, the phone's own
 * ringtone (looping until it's answered, declined or over) and a full-screen
 * intent, so a locked phone lights up with [CallActivity]. The ringtone is the
 * notification channel's sound, so the phone's silent and vibrate modes and Do
 * Not Disturb (whose call rules apply to it) decide whether it sounds.
 *
 * Android 14+ only lets calling and alarm apps ring full screen by default;
 * when it says no, the ring shows as a heads-up notification instead and,
 * once, a notification asks to allow it ([askFullScreenOnce]).
 */
object RingNotes {
    private const val TAG = "PromptlyRing"
    const val CHANNEL_RING = "call_ring"
    const val CHANNEL_WAITING = "call_waiting"
    const val CHANNEL_ONGOING = "call_ongoing"
    private const val CHANNEL_TIPS = "call_tips"
    private const val NOTE_RING = 4301
    private const val NOTE_FULL_SCREEN = 4304
    private const val PREFS = "calls"
    private const val KEY_ASKED_FSI = "asked_full_screen"

    /** Full screen was refused for a ring since the app started. */
    @Volatile
    var fullScreenRefused = false
        private set

    fun channels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_RING) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_RING, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Rings when someone calls you in Promptly"
                    setSound(
                        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build(),
                    )
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 800, 600, 800, 600)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                    setShowBadge(false)
                },
            )
        }
        if (nm.getNotificationChannel(CHANNEL_WAITING) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_WAITING, "Calls while you're on a call", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "A second call while you're on one: End and answer, or Decline"
                    setSound(null, null)
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 200, 200, 200)
                    setShowBadge(false)
                },
            )
        }
        if (nm.getNotificationChannel(CHANNEL_ONGOING) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ONGOING, "Calls in progress", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "While you're on a call: Mute, Speaker and Hang up"
                    setSound(null, null)
                    enableVibration(false)
                    setShowBadge(false)
                },
            )
        }
        if (nm.getNotificationChannel(CHANNEL_TIPS) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_TIPS, "Call settings", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Settings calls need to ring properly"
                },
            )
        }
    }

    fun person(ring: Ring, picture: Icon?, context: Context): Person {
        val b = Person.Builder().setName(ring.title).setImportant(true)
        if (picture != null) runCatching { b.setIcon(IconCompat.createFromIcon(context, picture)) }
        return b.build()
    }

    fun show(context: Context, ring: Ring, picture: Icon?) {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 34 && !nm.canUseFullScreenIntent()) fullScreenRefused = true
        val open = PendingIntent.getActivity(
            context, ring.callId.hashCode(),
            CallActivity.intent(context, ring.callId, answer = false),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        // Answer opens the call screen (over the lock screen), which answers
        // from the front: Android lets a call start its microphone from there.
        val answer = PendingIntent.getActivity(
            context, ring.callId.hashCode() + 1,
            CallActivity.intent(context, ring.callId, answer = true),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val decline = CallActions.pending(context, CallActions.DECLINE, ring.callId, 2)
        // "End and answer" needs words of its own: CallStyle's buttons are fixed.
        val n = if (ring.busy) plain(context, ring, open, answer, decline) else try {
            NotificationCompat.Builder(context, if (ring.busy) CHANNEL_WAITING else CHANNEL_RING)
                .setSmallIcon(R.drawable.ic_call_status)
                .setColor(ACCENT)
                .setContentTitle(ring.title)
                .setContentText(CallNote.busyLine(ring) ?: ring.text)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(false)
                .setContentIntent(open)
                .setFullScreenIntent(open, true)
                .setTimeoutAfter((ring.until - System.currentTimeMillis()).coerceAtLeast(1_000))
                .setStyle(NotificationCompat.CallStyle.forIncomingCall(person(ring, picture, context), decline, answer).setIsVideo(ring.video))
                .build()
        } catch (e: RuntimeException) {
            Log.w(TAG, "call style", e)
            plain(context, ring, open, answer, decline)
        }
        // The ringtone loops until the ring's cancelled.
        if (!ring.busy) n.flags = n.flags or Notification.FLAG_INSISTENT
        try {
            nm.notify(TAG_RING, NOTE_RING, n)
        } catch (e: RuntimeException) {
            // A phone that refuses CallStyle here: an ordinary ringing notification.
            Log.w(TAG, "ring refused, plain one instead", e)
            val p = plain(context, ring, open, answer, decline)
            if (!ring.busy) p.flags = p.flags or Notification.FLAG_INSISTENT
            nm.notify(TAG_RING, NOTE_RING, p)
        }
        lastRing = ring.callId
    }

    private fun plain(context: Context, ring: Ring, open: PendingIntent, answer: PendingIntent, decline: PendingIntent): Notification =
        NotificationCompat.Builder(context, if (ring.busy) CHANNEL_WAITING else CHANNEL_RING)
            .setSmallIcon(R.drawable.ic_call_status)
            .setColor(ACCENT)
            .setContentTitle(ring.title)
            .setContentText(CallNote.busyLine(ring) ?: ring.text)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setContentIntent(open)
            .setFullScreenIntent(open, true)
            .addAction(R.drawable.ic_call_decline, "Decline", decline)
            .addAction(R.drawable.ic_call_answer, CallNote.answerLabel(ring), answer)
            .build()

    private var lastRing: String? = null
    private const val TAG_RING = "call-ring"

    fun cancel(context: Context, callId: String) {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (lastRing == null || lastRing == callId) nm.cancel(TAG_RING, NOTE_RING)
        if (lastRing == callId) lastRing = null
        if (fullScreenRefused) askFullScreenOnce(context)
    }

    /** Full screen is allowed (always, before Android 14). */
    fun canRingFullScreen(context: Context): Boolean =
        Build.VERSION.SDK_INT < 34 || context.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()

    /** Android's page for "Allow full-screen notifications" for this app. */
    fun fullScreenSettings(context: Context): Intent =
        if (Build.VERSION.SDK_INT >= 34) {
            Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + context.packageName))
        } else {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        }

    fun askedFullScreen(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ASKED_FSI, false)

    fun markAskedFullScreen(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ASKED_FSI, true).apply()
    }

    /** Once: "Let calls ring on your lock screen", after a ring that couldn't. */
    private fun askFullScreenOnce(context: Context) {
        if (canRingFullScreen(context) || askedFullScreen(context)) return
        markAskedFullScreen(context)
        val go = PendingIntent.getActivity(
            context, 4305, fullScreenSettings(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(context, CHANNEL_TIPS)
            .setSmallIcon(R.drawable.ic_call_status)
            .setColor(ACCENT)
            .setContentTitle("Let calls ring on your lock screen")
            .setContentText("Promptly calls can only show as a notification now. Tap to allow full-screen calls.")
            .setStyle(NotificationCompat.BigTextStyle().bigText("Promptly calls can only show as a notification now, so you may miss them when your phone is locked. Tap, then turn on \"Allow full-screen notifications\"."))
            .setAutoCancel(true)
            .setContentIntent(go)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(NOTE_FULL_SCREEN, n)
    }

    const val ACCENT = 0xFFD97757.toInt()
}
