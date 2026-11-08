package org.promptly.sync.calls

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import org.promptly.sync.voice.VoiceProtocol
import java.util.Base64

/*
 * DM calls on Android, Calls WP-D5: the rules for starting a call from the
 * page (the hand-off), the phone's camera, picture-in-picture, video on a
 * weak connection, the call's tones and hold. Free of Android and LiveKit so
 * the JVM tests run them; CallStartActivity, CallService and CallActivity do
 * the doing.
 */

// ==================================================================== the hand-off

/**
 * `promptly://call/start?server=…&session=…&call=…&video=0|1&title=…`, opened
 * by Call / Video call on the page on a phone with this app: the page has
 * started the call on the server for this phone (`POST /api/calls` with
 * `device: "android"`), and the app holds it from here, as it does a call it
 * answers. [session] is the call session the server signed (one person, one
 * call, this device); [user] is whose it is, read unverified only to notice
 * a different account handing over (the server checks the signature).
 */
data class CallHandoff(
    val server: String,
    val session: String,
    val callId: String,
    val user: String,
    val video: Boolean,
    val title: String,
)

object CallHandoffs {
    private val json = Json { ignoreUnknownKeys = true }
    private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    /** What a call session says about itself (`dm.py::_session_token`). */
    data class Claims(val user: String, val callId: String, val device: String, val expiresAt: Long)

    /**
     * The page's hand-off, or null when it mustn't be taken: another server
     * than this app's (a web page elsewhere can't point the app, and your
     * microphone, at its own server), not a call session, a session for
     * another call or device, expired, or junk.
     */
    fun parse(params: Map<String, String?>, savedServer: String?, now: Long): CallHandoff? {
        val server = VoiceProtocol.origin(params["server"]) ?: return null
        val saved = VoiceProtocol.origin(savedServer) ?: return null
        if (server != saved) return null
        val session = params["session"]?.takeIf { it.length in 10..2000 } ?: return null
        val callId = params["call"]?.takeIf { UUID.matches(it) }?.lowercase() ?: return null
        val claims = claims(session) ?: return null
        if (claims.callId != callId || claims.device != "android" || claims.expiresAt <= now) return null
        return CallHandoff(
            server = server,
            session = session,
            callId = callId,
            user = claims.user,
            video = params["video"] == "1",
            title = params["title"]?.trim()?.take(80)?.ifBlank { null } ?: "Call",
        )
    }

    /** A call session's claims (a JWT, `typ: "call"`), unverified; null for anything else. */
    fun claims(token: String): Claims? {
        val parts = token.split('.')
        if (parts.size != 3) return null
        val raw = parts[1]
        val payload = runCatching { String(Base64.getUrlDecoder().decode(raw + "=".repeat((4 - raw.length % 4) % 4))) }.getOrNull() ?: return null
        val o = runCatching { json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: return null
        if (o.str("typ") != "call") return null
        val user = o.str("sub") ?: return null
        val call = o.str("call")?.lowercase() ?: return null
        val exp = (o["exp"] as? JsonPrimitive)?.longOrNull ?: return null
        return Claims(user, call, o.str("dev") ?: "", exp * 1000)
    }

    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
}

// ==================================================================== the camera

/**
 * The phone's camera in a call. [wanted] is what you asked for (video calls
 * start with it on, like Messenger); it's [live] only when Android lets the
 * app use the camera, the phone has one, the call's connected, the screen's
 * on and the call isn't on hold. Locking the phone or a phone call taking
 * over pauses it, and it comes back by itself.
 */
data class CameraState(
    val wanted: Boolean = false,
    val front: Boolean = true,
    val permitted: Boolean = false,
    val hasCamera: Boolean = true,
    val connected: Boolean = false,
    val screenOn: Boolean = true,
    val held: Boolean = false,
) {
    val live: Boolean get() = wanted && permitted && hasCamera && connected && screenOn && !held
    /** Wanted and allowed, but paused for now (screen off, on hold). */
    val paused: Boolean get() = wanted && permitted && hasCamera && connected && (!screenOn || held)
    /** The on-screen button: "Turn camera off" while you want it, even paused. */
    val buttonOn: Boolean get() = wanted && permitted && hasCamera
}

sealed class CameraEvent {
    data object Toggle : CameraEvent()
    data class Set(val on: Boolean) : CameraEvent()
    data object Flip : CameraEvent()
    data class Permission(val granted: Boolean) : CameraEvent()
    data class Connection(val connected: Boolean) : CameraEvent()
    data class Screen(val on: Boolean) : CameraEvent()
    data class Hold(val on: Boolean) : CameraEvent()
}

sealed class CameraEffect {
    /** Start or stop sending the camera. */
    data class Publish(val on: Boolean, val front: Boolean) : CameraEffect()
    /** Swap front and back while it's sending. */
    data class Switch(val front: Boolean) : CameraEffect()
    /** Ask Android for the camera (only from the call screen: it's in front). */
    data object AskPermission : CameraEffect()
}

class CameraMachine(initial: CameraState = CameraState()) {
    var state: CameraState = initial
        private set

    /** A new call: start over (nothing's sending). */
    fun reset(s: CameraState) {
        state = s.copy(connected = false)
    }

    fun on(e: CameraEvent): List<CameraEffect> {
        val before = state
        state = when (e) {
            CameraEvent.Toggle -> before.copy(wanted = !before.buttonOn)
            is CameraEvent.Set -> before.copy(wanted = e.on)
            CameraEvent.Flip -> before.copy(front = !before.front)
            is CameraEvent.Permission -> before.copy(permitted = e.granted)
            is CameraEvent.Connection -> before.copy(connected = e.connected)
            is CameraEvent.Screen -> before.copy(screenOn = e.on)
            is CameraEvent.Hold -> before.copy(held = e.on)
        }
        val out = mutableListOf<CameraEffect>()
        val wantsNow = (e == CameraEvent.Toggle || (e is CameraEvent.Set && e.on)) && state.wanted
        if (wantsNow && !state.permitted && state.hasCamera) out += CameraEffect.AskPermission
        when {
            before.live != state.live -> out += CameraEffect.Publish(state.live, state.front)
            state.live && before.front != state.front -> out += CameraEffect.Switch(state.front)
        }
        return out
    }
}

// ==================================================================== picture-in-picture

/**
 * The call screen shrinks into a picture-in-picture window when you leave
 * it (Home, another app) while there's a picture to keep watching: a video
 * call, or anyone's camera or screen on. Never while it rings (the ring is
 * a full-screen choice) or before the call's connected.
 */
object PipPlan {
    fun wanted(inCall: Boolean, ringing: Boolean, connected: Boolean, videoCall: Boolean, pictures: Boolean): Boolean =
        inCall && !ringing && connected && (videoCall || pictures)

    /** Android 12+: Android enters it by itself when you leave. */
    fun autoEnter(sdk: Int, wanted: Boolean): Boolean = wanted && sdk >= 31

    /** Older Android: enter it ourselves when you press Home. */
    fun enterOnLeave(sdk: Int, wanted: Boolean): Boolean = wanted && sdk < 31

    /** The window's shape from the video's size, within what Android takes
     *  (between 1:2.39 and 2.39:1); a portrait phone camera when unknown. */
    fun aspect(width: Int, height: Int): Pair<Int, Int> {
        if (width <= 0 || height <= 0) return 9 to 16
        val r = width.toDouble() / height
        return when {
            r > 2.39 -> 239 to 100
            r < 1 / 2.39 -> 100 to 239
            else -> width to height
        }
    }
}

// ==================================================================== video on a weak connection

/** LiveKit's connection quality, as the rules see it. */
enum class LinkQuality { EXCELLENT, GOOD, POOR, LOST, UNKNOWN }

/** How much video to take and send. */
enum class VideoLevel { HIGH, MEDIUM, LOW }

/**
 * Data saver for calls (the plan's "lower video on weak connections"):
 * cameras come in at the lowest layer and yours goes out small when the
 * connection's weak or Android's Data Saver is on; on mobile data, the
 * middle layer.
 */
object VideoPlan {
    fun level(weak: Boolean, dataSaver: Boolean, metered: Boolean): VideoLevel = when {
        weak || dataSaver -> VideoLevel.LOW
        metered -> VideoLevel.MEDIUM
        else -> VideoLevel.HIGH
    }

    /** Your camera's capture: width, height, frames per second. */
    fun capture(level: VideoLevel): Triple<Int, Int, Int> = when (level) {
        VideoLevel.HIGH -> Triple(1280, 720, 30)
        VideoLevel.MEDIUM -> Triple(960, 540, 24)
        VideoLevel.LOW -> Triple(640, 360, 15)
    }

    /** The line on the call screen, or null when video is as good as it gets. */
    fun words(weak: Boolean, dataSaver: Boolean): String? = when {
        weak -> "Weak connection: video lowered"
        dataSaver -> "Data Saver is on: video lowered"
        else -> null
    }
}

/**
 * Whether the connection counts as weak, without flapping: weak after 4 s
 * of poor (at once when lost), strong again after 10 s of good.
 */
class WeakLink(private val weakAfterMs: Long = 4_000, private val strongAfterMs: Long = 10_000) {
    var weak = false
        private set
    private var since = 0L
    private var bad: Boolean? = null

    /** The latest quality; returns whether it's weak now. */
    fun input(q: LinkQuality, now: Long): Boolean {
        if (q == LinkQuality.UNKNOWN) return weak
        val isBad = q == LinkQuality.POOR || q == LinkQuality.LOST
        if (isBad != bad) {
            bad = isBad
            since = now
        }
        if (q == LinkQuality.LOST) weak = true
        return tick(now)
    }

    /** Time passing (call every second or so). */
    fun tick(now: Long): Boolean {
        val b = bad ?: return weak
        if (b && !weak && now - since >= weakAfterMs) weak = true
        if (!b && weak && now - since >= strongAfterMs) weak = false
        return weak
    }
}

// ==================================================================== tones

enum class CallTone {
    /** Your call ringing them: the long low tone, on and off. */
    RINGBACK,
    /** Someone answered / you're through. */
    CONNECTED,
    RECONNECTING,
    RECONNECTED,
    /** A soft beep every few seconds while the other person has you on hold. */
    HOLD,
    /** The call's over. */
    ENDED,
}

sealed class ToneFx {
    /** Loop until stopped (ringback, hold). */
    data class Start(val tone: CallTone) : ToneFx()
    data class Stop(val tone: CallTone) : ToneFx()
    /** Once. */
    data class Play(val tone: CallTone) : ToneFx()
}

/** What the tones follow. */
data class ToneState(
    val inCall: Boolean = false,
    val status: CallNote.Status = CallNote.Status.CONNECTING,
    /** You started it and nobody's answered. */
    val calling: Boolean = false,
    /** Android put this call on hold (you're on a phone call). */
    val held: Boolean = false,
    /** The other side put you on hold. */
    val peerHeld: Boolean = false,
)

object CallTones {
    private fun ringback(s: ToneState) = s.inCall && s.calling && s.status == CallNote.Status.CONNECTED && !s.held
    private fun hold(s: ToneState) = s.inCall && s.peerHeld && !s.held && s.status == CallNote.Status.CONNECTED

    /** The tones to start, stop and play going from [a] to [b]. */
    fun diff(a: ToneState, b: ToneState): List<ToneFx> {
        val out = mutableListOf<ToneFx>()
        if (ringback(a) && !ringback(b)) out += ToneFx.Stop(CallTone.RINGBACK)
        if (hold(a) && !hold(b)) out += ToneFx.Stop(CallTone.HOLD)
        if (a.inCall && !b.inCall) {
            out += ToneFx.Play(CallTone.ENDED)
            return out
        }
        if (!b.inCall) return out
        val through = b.status == CallNote.Status.CONNECTED && !b.calling
        val wasThrough = a.inCall && a.status == CallNote.Status.CONNECTED && !a.calling
        when {
            a.status == CallNote.Status.CONNECTED && b.status == CallNote.Status.RECONNECTING -> out += ToneFx.Play(CallTone.RECONNECTING)
            a.status == CallNote.Status.RECONNECTING && b.status == CallNote.Status.CONNECTED -> out += ToneFx.Play(CallTone.RECONNECTED)
            through && !wasThrough -> out += ToneFx.Play(CallTone.CONNECTED)
        }
        if (!ringback(a) && ringback(b)) out += ToneFx.Start(CallTone.RINGBACK)
        if (!hold(a) && hold(b)) out += ToneFx.Start(CallTone.HOLD)
        return out
    }
}

// ==================================================================== hold

/**
 * "This call is on hold" between the people in it, as LiveKit data on
 * `call.hold` from the phone that's holding (Android holds a Promptly call
 * when you take a phone call). Sent again to anyone who joins while it holds.
 */
object HoldSignal {
    const val TOPIC = "call.hold"
    private val json = Json { ignoreUnknownKeys = true }

    fun encode(on: Boolean): ByteArray = buildJsonObject { put("hold", on) }.toString().toByteArray()

    /** On or off, or null for anything else (another topic, junk, the server). */
    fun decode(data: ByteArray, topic: String?, fromPerson: Boolean): Boolean? {
        if (topic != TOPIC || !fromPerson) return null
        val o = runCatching { json.parseToJsonElement(data.decodeToString()).jsonObject }.getOrNull() ?: return null
        return (o["hold"] as? JsonPrimitive)?.booleanOrNull
    }
}
