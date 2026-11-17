package org.promptly.sync.assistant

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.promptly.sync.R
import org.promptly.sync.calls.CallCenter
import org.promptly.sync.calls.CallState
import org.promptly.sync.maps.Nav
import org.promptly.sync.maps.Voice
import org.promptly.sync.talk.CarTalk
import org.promptly.sync.talk.Talk
import org.promptly.sync.voice.VoiceService

/** "Hey Promptly", from the app's side: the switch, starting and stopping the
 *  listening process ([WakeService]), telling it when to let go of the microphone,
 *  and opening the assistant when it hears the phrase.
 *
 *  Off until you turn it on in the assistant's settings, on this phone only. It
 *  needs Promptly to be the phone's assistant: Android only lets the assistant open
 *  the microphone, or a sheet, from the background. */
object WakeWord {
    private const val TAG = "PromptlyWake"
    private const val PREFS = "wake"
    private const val CHANNEL = "wake_off"
    private const val NOTE_OFF = 4142
    private const val TICK_MS = 2_000L

    private val main = Handler(Looper.getMainLooper())
    private val faults = WakeRules.Faults()
    private var app: Context? = null
    private var bound = false
    private var ticking = false
    /** Starts in a row that ended badly, for the wait before the next one. */
    private var streak = 0
    private var lastFaultAt = 0L
    /** After a fault: not before this (the clock since boot). */
    private var holdOffUntil = 0L

    /** What the settings screen shows under the switch: listening, or why not. */
    private val _status = MutableStateFlow<String?>(null)
    val status: StateFlow<String?> = _status.asStateFlow()

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun enabled(context: Context): Boolean = prefs(context).getBoolean("on", false)

    /** Also answer on a locked phone. Private things still wait for an unlock. */
    fun whenLocked(context: Context): Boolean = prefs(context).getBoolean("locked", false)

    fun setWhenLocked(context: Context, on: Boolean) = prefs(context).edit().putBoolean("locked", on).apply()

    /** It can be turned on: the microphone is allowed and Promptly is the assistant. */
    fun possible(context: Context): Boolean = Voice.allowed(context) && Voice.holdsRole(context)

    fun setEnabled(context: Context, on: Boolean) {
        prefs(context).edit().putBoolean("on", on).apply()
        if (on) {
            streak = 0
            faults.restore(emptyList())
            saveFaults(context)
            context.getSystemService(NotificationManager::class.java)?.cancel(NOTE_OFF)
        }
        sync(context)
    }

    /** Once, when the app's own process starts (and when the assistant service does). */
    fun init(context: Context) {
        val c = context.applicationContext
        if (app == null) {
            app = c
            faults.restore(prefs(c).getString("faults", "").orEmpty().split(',').mapNotNull { it.toLongOrNull() })
        }
        sync(c)
    }

    private fun facts(context: Context) = WakeRules.AppFacts(
        micAllowed = Voice.allowed(context),
        assistant = Voice.holdsRole(context),
        trip = runCatching { Nav.onTrip() }.getOrDefault(false),
        carScreen = Voice.inCar,
        promptlyCall = CallCenter.state.value !is CallState.Idle || VoiceService.routes() != null,
        talk = Talk.live || CarTalk.live,
    )

    private val tick = object : Runnable {
        override fun run() {
            val c = app
            if (c == null || !enabled(c)) {
                ticking = false
                return
            }
            push(c, resume = false)
            main.postDelayed(this, TICK_MS)
        }
    }

    /** Bring the listening process in line with the switch and what's going on. */
    fun sync(context: Context) {
        val c = context.applicationContext
        app = c
        if (!enabled(c)) {
            stop(c)
            return
        }
        push(c, resume = false)
        if (!ticking) {
            ticking = true
            main.postDelayed(tick, TICK_MS)
        }
    }

    private var lastSent: String? = "-"

    private fun push(c: Context, resume: Boolean) {
        val hold = WakeRules.appHold(facts(c))
        // Without the microphone or the assistant's place there's nothing to run.
        if (hold == WakeRules.Hold.NO_MIC || hold == WakeRules.Hold.NOT_ASSISTANT) {
            stop(c)
            _status.value = hold.says
            return
        }
        // The conversation it started has just finished: listen again straight away.
        @Suppress("NAME_SHADOWING")
        val resume = resume || (lastSent == WakeRules.Hold.TALKING.name && hold == null)
        // The same as last time, and it's still there: nothing to say.
        if (bound && !resume && lastSent == hold?.name) return
        // It fell over a moment ago: give it the wait it was promised.
        if (!bound && android.os.SystemClock.elapsedRealtime() < holdOffUntil) return
        try {
            ContextCompat.startForegroundService(c, WakeService.intent(c, hold, resume))
            lastSent = hold?.name
            if (!bound) c.bindService(Intent(c, WakeService::class.java), link, 0)
        } catch (e: Exception) {
            // Android said not from here, not now. The next tick asks again.
            Log.i(TAG, "Couldn't start listening: ${e.javaClass.simpleName}")
        }
    }

    private fun stop(c: Context) {
        if (bound) {
            bound = false
            runCatching { c.unbindService(link) }
        }
        runCatching { c.stopService(Intent(c, WakeService::class.java)) }
        lastSent = "-"
        _status.value = null
    }

    /** Watches the listening process: if it goes without being asked to, that's a fault. */
    private val link = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            bound = true
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            val c = app ?: return
            if (!bound || !enabled(c)) return
            // A moment for its own explanation to arrive first (refused, or a caught error).
            main.postDelayed({
                if (bound && enabled(c) && android.os.SystemClock.elapsedRealtime() - refusedAt > 5_000) fault(c, "The listening process stopped")
            }, 1_200)
        }
    }

    /** Android wouldn't let it start just now. Not a fault: try again in a little while. */
    internal fun refused(context: Context) {
        val c = context.applicationContext
        refusedAt = android.os.SystemClock.elapsedRealtime()
        if (bound) {
            bound = false
            runCatching { c.unbindService(link) }
        }
        lastSent = "-"
        holdOffUntil = refusedAt + 10_000
        _status.value = "Waiting for Android to let it start"
    }

    private var refusedAt = -60_000L

    internal fun fault(context: Context, why: String) {
        val c = context.applicationContext
        // The process going and its own last words are one fault, not two.
        val at = android.os.SystemClock.elapsedRealtime()
        if (lastFaultAt != 0L && at - lastFaultAt < 3_000) return
        lastFaultAt = at
        Log.w(TAG, "Wake word fault: $why")
        VoiceTrail.note("wake", "fault", System.currentTimeMillis())
        if (bound) {
            bound = false
            runCatching { c.unbindService(link) }
        }
        lastSent = "-"
        val tooMany = faults.note(System.currentTimeMillis())
        saveFaults(c)
        if (tooMany) {
            prefs(c).edit().putBoolean("on", false).apply()
            stop(c)
            tellOff(c)
            return
        }
        streak++
        val wait = faults.backoffMs(streak)
        holdOffUntil = at + wait
        main.postDelayed({ if (enabled(c)) push(c, resume = true) }, wait + 50)
    }

    private fun saveFaults(c: Context) = prefs(c).edit().putString("faults", faults.saved().joinToString(",")).apply()

    private fun tellOff(c: Context) {
        val manager = c.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Hey Promptly problems", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(c, 2, Intent(c, AssistantSettingsActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        runCatching {
            manager.notify(
                NOTE_OFF,
                NotificationCompat.Builder(c, CHANNEL)
                    .setSmallIcon(R.drawable.ic_promptly_status)
                    .setContentTitle("\"Hey Promptly\" turned itself off")
                    .setContentText("It stopped unexpectedly a few times. You can turn it back on in the assistant's settings.")
                    .setStyle(NotificationCompat.BigTextStyle().bigText("It stopped unexpectedly a few times, so it has turned itself off rather than keep trying. Nothing else was affected. You can turn it back on in the assistant's settings."))
                    .setAutoCancel(true)
                    .setContentIntent(open)
                    .build(),
            )
        }
    }

    // ------------------------------------------------------------ the phrase was heard
    /** The listening process heard it and has let go of the microphone. Nothing is
     *  sent anywhere yet, and nothing is said: the sheet opens and waits for you. */
    internal fun heard(context: Context, floor: Double) {
        val c = context.applicationContext
        streak = 0
        val hold = WakeRules.appHold(facts(c))
        if (!enabled(c) || hold != null) {
            // Something started in the meantime (a trip, a call): not now.
            push(c, resume = true)
            return
        }
        VoiceTrail.note("wake", "heard", System.currentTimeMillis())
        if (!PromptlyAssistantService.showSheet(Bundle().apply { putBoolean(EXTRA_WAKE, true); putDouble(EXTRA_FLOOR, floor) })) {
            Log.i(TAG, "The assistant couldn't open")
            push(c, resume = true)
        }
    }

    /** The sheet has finished with the microphone (or never took it). */
    fun finished(context: Context) {
        val c = context.applicationContext
        if (enabled(c)) main.postDelayed({ if (enabled(c)) push(c, resume = true) }, 600)
    }

    internal fun state(text: String) {
        _status.value = text
    }

    const val EXTRA_WAKE = "wake"
    const val EXTRA_FLOOR = "floor"
}

/** What the listening process says to the app: it's in another process, so it says
 *  it with a broadcast only this app can send or receive. */
class WakeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_HEARD -> WakeWord.heard(context, intent.getDoubleExtra(EXTRA_FLOOR, 200.0))
            ACTION_FAULT -> WakeWord.fault(context, intent.getStringExtra(EXTRA_WHY) ?: "unknown")
            ACTION_REFUSED -> WakeWord.refused(context)
            ACTION_STATE -> WakeWord.state(intent.getStringExtra(EXTRA_WHY) ?: return)
            ACTION_TURNED_OFF -> WakeWord.setEnabled(context, false)
        }
    }

    companion object {
        const val ACTION_HEARD = "org.promptly.wake.HEARD"
        const val ACTION_FAULT = "org.promptly.wake.FAULT"
        const val ACTION_REFUSED = "org.promptly.wake.REFUSED"
        const val ACTION_STATE = "org.promptly.wake.STATE"
        const val ACTION_TURNED_OFF = "org.promptly.wake.TURNED_OFF"
        const val EXTRA_FLOOR = "floor"
        const val EXTRA_WHY = "why"
    }
}
