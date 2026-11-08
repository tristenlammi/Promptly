package org.promptly.sync.calls

import android.app.Notification
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.promptly.app.CallRings
import java.io.IOException

/**
 * DM calls on this phone (Calls WP-D3), one per app process.
 *
 * Chrome hands every notification from the site to the app's `Delegation`
 * (`:suite`), which passes call pushes here ([CallRings]). A ring becomes a
 * real incoming call: a CallStyle notification with the phone's ringtone and
 * a full-screen ring over the lock screen ([RingNotes]), a Telecom call
 * ([CallTelecom]) so a headset or the car can answer it, and a check with the
 * server every few seconds so it stops when you answer on another device.
 * Answer starts [CallService], which holds the call's audio.
 *
 * [CallMachine] decides; this does what it says. Everything runs on the main
 * thread.
 */
object CallCenter : CallRings.Handler, CallTelecom.Events {
    private const val TAG = "PromptlyCalls"
    private const val POLL_MS = 4_000L

    /** What the call screen and the service read. */
    data class Media(
        val callId: String? = null,
        val roomId: String? = null,
        val connectedAt: Long = 0L,
        val status: CallNote.Status = CallNote.Status.CONNECTING,
        val muted: Boolean = false,
        val speaker: Boolean = false,
        val others: Int = 0,
        val group: Boolean = false,
        /** You started it and nobody's answered yet (Calls WP-D5). */
        val calling: Boolean = false,
        /** Android put the call on hold (you're on a phone call). */
        val held: Boolean = false,
        /** Someone in it put the call on hold. */
        val peerHeld: Boolean = false,
        val camera: CameraState = CameraState(),
        /** "Weak connection: video lowered", or null. */
        val videoNote: String? = null,
    )

    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var machine = CallMachine()
    private lateinit var app: Context
    private lateinit var telecom: CallTelecom
    private var ringTimer: Job? = null
    private var pollJob: Job? = null
    private val pictures = mutableMapOf<String, Icon>()

    private val _state = MutableStateFlow<CallState>(CallState.Idle)
    val state: StateFlow<CallState> = _state
    private val _media = MutableStateFlow(Media())
    val media: StateFlow<Media> = _media

    val audio get() = telecom.audio

    fun init(context: Context) {
        // Once per app (a test's new Application starts it over).
        if (::app.isInitialized && app === context.applicationContext) return
        app = context.applicationContext
        machine = CallMachine()
        _state.value = CallState.Idle
        telecom = CallTelecom(app, scope, this)
        RingNotes.channels(app)
        CallRings.set(this)
    }

    /** The server this app is set up with (`:suite`'s Server). */
    fun server(context: Context): String? =
        context.getSharedPreferences("promptly", Context.MODE_PRIVATE).getString("server", null)

    fun picture(callId: String): Icon? = pictures[callId]

    // ================================================================ from Chrome (binder thread)

    override fun onNotify(context: Context, platformTag: String, notification: Notification): Boolean {
        init(context)
        val tag = CallTag.parse(platformTag) ?: return false
        if (server(context) == null) return false
        return when (tag.kind) {
            CallTag.Kind.RING -> {
                val extras = notification.extras
                val ring = Ring.of(
                    tag,
                    extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString(),
                    extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
                    System.currentTimeMillis(),
                ) ?: return false
                val picture = notification.getLargeIcon()
                main.post {
                    if (picture != null) pictures[ring.callId] = picture
                    dispatch(CallEvent.Rang(ring, System.currentTimeMillis()))
                }
                true
            }
            // Stopped elsewhere: nothing to show (Chrome's would only flash).
            CallTag.Kind.STOP -> {
                main.post { dispatch(CallEvent.Stopped(tag.callId)) }
                true
            }
            // Missed: stop ringing, and Chrome shows "Missed call" (tap → the conversation).
            CallTag.Kind.MISSED -> {
                main.post { dispatch(CallEvent.Missed(tag.callId)) }
                false
            }
            CallTag.Kind.OTHER -> false
        }
    }

    override fun onCancel(context: Context, platformTag: String) {
        val tag = CallTag.parse(platformTag) ?: return
        if (tag.kind == CallTag.Kind.RING) main.post { dispatch(CallEvent.Stopped(tag.callId)) }
    }

    // ================================================================ from Telecom

    override fun systemAnswer(callId: String) {
        main.post {
            // A headset or the car answered: the service starts from here (the
            // app may be in the background; Telecom's call lets it).
            dispatch(CallEvent.Answer(callId, System.currentTimeMillis()))
        }
    }

    override fun systemHold(callId: String, on: Boolean) {
        main.post { CallService.current?.setHeld(callId, on) }
    }

    override fun systemDisconnect(callId: String) {
        main.post {
            when (val s = machine.state) {
                is CallState.Ringing -> if (s.ring.callId == callId) dispatch(CallEvent.Decline(callId))
                is CallState.Active -> when (callId) {
                    s.callId -> dispatch(CallEvent.HangUp(callId))
                    s.waiting?.callId -> dispatch(CallEvent.Decline(callId))
                }
                CallState.Idle -> Unit
            }
        }
    }

    // ================================================================ from the screen, the notifications, the service

    fun answer(callId: String) = dispatch(CallEvent.Answer(callId, System.currentTimeMillis()))
    fun decline(callId: String) = dispatch(CallEvent.Decline(callId))
    fun hangUp(callId: String) = dispatch(CallEvent.HangUp(callId))
    fun connected(callId: String) = dispatch(CallEvent.Connected(callId))
    fun ended(callId: String, why: String) = dispatch(CallEvent.Ended(callId, why))
    fun answeredByThem(callId: String) = dispatch(CallEvent.Answered(callId))

    /** The page started a call and handed it to this app (CallStartActivity). */
    fun startOutgoing(context: Context, h: CallHandoff) {
        init(context)
        dispatch(CallEvent.Outgoing(h))
    }

    fun setMedia(m: Media) {
        _media.value = m
    }

    /** Speaker on or off. False when Telecom doesn't hold the call (the service routes it). */
    fun telecomSpeaker(callId: String, on: Boolean): Boolean = telecom.setSpeaker(callId, on)

    fun telecomHolds(callId: String): Boolean = telecom.holds(callId)

    // ================================================================ doing

    fun dispatch(e: CallEvent) {
        if (!::app.isInitialized) return
        val effects = machine.on(e)
        if (effects.isNotEmpty()) Log.i(TAG, "${e::class.simpleName} → ${effects.joinToString { it::class.simpleName ?: "?" }}")
        _state.value = machine.state
        for (fx in effects) run(fx)
        if (machine.state == CallState.Idle) {
            stopRingWatch()
            pictures.clear()
        }
    }

    private fun run(fx: CallEffect) {
        when (fx) {
            is CallEffect.ShowRing -> {
                RingNotes.show(app, fx.ring, pictures[fx.ring.callId])
                watchRing(fx.ring)
            }
            is CallEffect.CancelRing -> {
                RingNotes.cancel(app, fx.callId)
                stopRingWatch()
            }
            is CallEffect.Answer -> {
                val server = server(app) ?: return ended(fx.ring.callId, "failed")
                _media.value = Media(callId = fx.ring.callId, group = fx.ring.group, speaker = Routing.startsOnSpeaker(fx.ring.video))
                try {
                    CallService.answer(app, server, fx.ring)
                } catch (e: RuntimeException) {
                    // Android wouldn't start the call from the background
                    // (a headset answering with the app asleep): open the call
                    // screen, which answers from the front.
                    Log.w(TAG, "can't start the call service here", e)
                    try {
                        app.startActivity(CallActivity.intent(app, fx.ring.callId, answer = true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    } catch (e2: RuntimeException) {
                        Log.w(TAG, "can't open the call screen either", e2)
                        ended(fx.ring.callId, "failed")
                    }
                }
            }
            is CallEffect.Decline -> {
                val server = server(app) ?: return
                scope.launch(Dispatchers.IO) {
                    try {
                        CallApi(server).decline(fx.ring.token)
                    } catch (e: IOException) {
                        Log.i(TAG, "decline not sent: ${e.message}")
                    }
                }
            }
            is CallEffect.Leave -> CallService.leave(app, fx.callId)
            is CallEffect.Start -> {
                _media.value = Media(callId = fx.handoff.callId, calling = true, speaker = Routing.startsOnSpeaker(fx.handoff.video))
                try {
                    CallService.start(app, fx.handoff)
                } catch (e: RuntimeException) {
                    Log.w(TAG, "can't start the call service", e)
                    ended(fx.handoff.callId, "failed")
                }
            }
            is CallEffect.TelecomOutgoing -> telecom.outgoing(fx.callId, fx.title, fx.video)
            is CallEffect.TelecomIncoming -> telecom.incoming(fx.ring)
            is CallEffect.TelecomAnswer -> telecom.answer(fx.callId, fx.video)
            is CallEffect.TelecomActive -> telecom.active(fx.callId)
            is CallEffect.TelecomEnd -> telecom.end(fx.callId, fx.cause)
            is CallEffect.Tell -> Toast.makeText(app, fx.text, Toast.LENGTH_LONG).show()
        }
    }

    /** While it rings: stop at its time, and ask the server whether it still rings. */
    private fun watchRing(ring: Ring) {
        stopRingWatch()
        val server = server(app) ?: return
        ringTimer = scope.launch {
            delay((ring.until - System.currentTimeMillis()).coerceAtLeast(0))
            dispatch(CallEvent.TimedOut(ring.callId, System.currentTimeMillis()))
        }
        pollJob = scope.launch {
            val api = CallApi(server)
            delay(POLL_MS)
            while (isActive) {
                try {
                    val s = api.ringState(ring.token)
                    if (!s.ringing) {
                        dispatch(CallEvent.NotRinging(ring.callId))
                        return@launch
                    }
                } catch (_: CallApi.Over) {
                    dispatch(CallEvent.NotRinging(ring.callId))
                    return@launch
                } catch (e: IOException) {
                    // Offline for a moment: the ring's own time still ends it.
                } catch (e: IllegalArgumentException) {
                    Log.w(TAG, "ring state", e)
                }
                delay(POLL_MS)
            }
        }
    }

    private fun stopRingWatch() {
        ringTimer?.cancel()
        ringTimer = null
        pollJob?.cancel()
        pollJob = null
    }

    /** Start the in-call service with [ContextCompat] (kept here for the activity). */
    internal fun startService(context: Context, i: Intent) = ContextCompat.startForegroundService(context, i)
}
