package org.promptly.sync.talk

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.service.quicksettings.TileService
import android.util.Log
import android.view.KeyEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import org.promptly.sync.R
import org.promptly.sync.assistant.AssistantActivity

/** Keeps a Talk conversation going when the screen locks or you switch apps: a
 *  microphone foreground service with an ongoing notification. On the lock screen
 *  it shows only that Promptly is listening, with Mute and End: no words. A tap on
 *  it opens the sheet (after you unlock). A headset's button stops it talking, or
 *  mutes and unmutes. It goes when the conversation ends. */
class TalkService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var media: MediaSession? = null
    private var foreground = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        channel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action != null && !foreground) {
            // A button on a notification left over from a conversation that's gone.
            stopSelf()
            return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_MUTE -> Talk.toggleMute()
            ACTION_END -> Talk.end()
        }
        if (!foreground) {
            try {
                val note = notification(Talk.ui.value)
                if (Build.VERSION.SDK_INT >= 30) startForeground(ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
                else startForeground(ID, note)
                foreground = true
            } catch (e: Exception) {
                // Not allowed from here (it wasn't started from the screen): the
                // conversation still works while the sheet is open.
                Log.w("PromptlyTalk", "Couldn't keep Talk going in the background", e)
                stopSelf()
                return START_NOT_STICKY
            }
            headset()
            watch()
        }
        return START_NOT_STICKY
    }

    private fun watch() {
        scope.launch {
            Talk.ui.map { Triple(it.phase, it.muted || it.paused, it.state) }.distinctUntilChanged().collect { (phase, _, _) ->
                if (phase == Phase.ENDED || phase == Phase.OFF) {
                    stopSelf()
                    return@collect
                }
                getSystemService(NotificationManager::class.java)?.notify(ID, notification(Talk.ui.value))
            }
        }
        TileService.requestListeningState(this, android.content.ComponentName(this, TalkTile::class.java))
    }

    /** A headset's button press comes here while Talk is on (the last active media
     *  session gets it). A long press still goes to the phone's assistant. */
    private fun headset() {
        val session = MediaSession(this, "PromptlyTalk")
        session.setCallback(object : MediaSession.Callback() {
            override fun onMediaButtonEvent(intent: Intent): Boolean {
                val key = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
                else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
                if (key == null) return false
                return when (key.keyCode) {
                    KeyEvent.KEYCODE_HEADSETHOOK, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                        if (key.action == KeyEvent.ACTION_UP && key.repeatCount == 0 && !key.isLongPress) Talk.headset()
                        true
                    }
                    else -> false
                }
            }
        })
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE)
                .setState(PlaybackState.STATE_PLAYING, 0, 1f)
                .build(),
        )
        session.isActive = true
        media = session
    }

    private fun notification(ui: TalkUi): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, AssistantActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val quiet = ui.muted || ui.paused
        val mute = PendingIntent.getService(this, 1, Intent(this, TalkService::class.java).setAction(ACTION_MUTE), PendingIntent.FLAG_IMMUTABLE)
        val end = PendingIntent.getService(this, 2, Intent(this, TalkService::class.java).setAction(ACTION_END), PendingIntent.FLAG_IMMUTABLE)
        val icon = Icon.createWithResource(this, R.drawable.ic_map_mic)
        val status = when {
            ui.phase == Phase.STARTING -> "Starting…"
            ui.phase == Phase.RECONNECTING -> "Reconnecting…"
            ui.paused -> "Waiting while another app uses the audio"
            ui.muted -> "Muted"
            ui.state == "speaking" -> "Speaking"
            ui.state == "thinking" -> "Thinking"
            else -> "Listening"
        }
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_map_mic)
            .setContentTitle("Talking to Promptly")
            .setContentText(status)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_CALL)
            // On the lock screen: that it's on and the two buttons, never what was said.
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(Notification.Action.Builder(icon, if (quiet) "Unmute" else "Mute", mute).build())
            .addAction(Notification.Action.Builder(icon, "End", end).build())
            .apply { if (Build.VERSION.SDK_INT >= 31) setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE) }
            .build()
    }

    override fun onDestroy() {
        scope.cancel()
        media?.let {
            it.isActive = false
            it.release()
        }
        media = null
        if (foreground) stopForeground(STOP_FOREGROUND_REMOVE)
        TileService.requestListeningState(this, android.content.ComponentName(this, TalkTile::class.java))
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "talk_session"
        private const val ID = 4207
        private const val ACTION_MUTE = "org.promptly.talk.MUTE"
        private const val ACTION_END = "org.promptly.talk.END"

        fun channel(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            if (manager.getNotificationChannel(CHANNEL) != null) return
            manager.createNotificationChannel(
                // Default importance, but silent: a "silent" (low) notification is hidden
                // from the lock screen on most phones, and Mute / End must be there.
                NotificationChannel(CHANNEL, "Talking to Promptly", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Shown while you're in a spoken conversation, with Mute and End."
                    setSound(null, null)
                    enableVibration(false)
                    setShowBadge(false)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                },
            )
        }

        fun start(context: Context) {
            runCatching { context.startForegroundService(Intent(context, TalkService::class.java)) }
                .onFailure { Log.w("PromptlyTalk", "Couldn't start the Talk notification", it) }
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, TalkService::class.java)) }
        }
    }
}
