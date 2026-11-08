package org.promptly.sync.calls

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.Base64

/*
 * DM calls on Android (Calls WP-D3): the rules, free of Android, Telecom and
 * LiveKit so the JVM tests can run them. How a call push's notification from
 * Chrome is read, what ringing, answering, declining and hanging up do (and
 * what Telecom is told), what the server answers, and what the notifications
 * say. CallCenter, CallTelecom and CallService do the doing.
 */

/**
 * The tag of a call push's notification, as the service worker sets it
 * (`frontend/src/sw.ts::callTag`), found inside the tag Chrome gives the app
 * (Chrome wraps the page's tag with its own prefix):
 *
 *     call:<call id>|r|<a|v>|<busy 0|1>|<group 0|1>|<answer token>   a ring
 *     call:<call id>|s                                              stop ringing
 *     call:<call id>|m                                              missed
 *
 * The answer token is only there on a phone with this app (the page tells
 * the worker), and only on a ring.
 */
data class CallTag(
    val callId: String,
    val kind: Kind,
    val video: Boolean = false,
    val busy: Boolean = false,
    val group: Boolean = false,
    val token: String? = null,
) {
    enum class Kind { RING, STOP, MISSED, OTHER }

    companion object {
        private val RE = Regex(
            "call:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})((?:\\|[A-Za-z0-9_.-]*)*)",
        )

        /** The call tag inside Chrome's [platformTag], or null for any other notification. */
        fun parse(platformTag: String?): CallTag? {
            if (platformTag.isNullOrEmpty()) return null
            val m = RE.find(platformTag) ?: return null
            val id = m.groupValues[1].lowercase()
            val f = m.groupValues[2].split('|').drop(1)
            return when (f.getOrNull(0)) {
                "r" -> CallTag(
                    callId = id,
                    kind = Kind.RING,
                    video = f.getOrNull(1) == "v",
                    busy = f.getOrNull(2) == "1",
                    group = f.getOrNull(3) == "1",
                    token = f.getOrNull(4)?.takeIf { it.length in 10..2000 && it.contains('.') },
                )
                "s" -> CallTag(id, Kind.STOP)
                "m" -> CallTag(id, Kind.MISSED)
                else -> CallTag(id, Kind.OTHER)
            }
        }
    }
}

/** The ringing push's answer token (`notifications/actions.py::sign`):
 *  `<base64url json>.<mac>`; only its expiry is read here, unverified. */
object AnswerToken {
    private val json = Json { ignoreUnknownKeys = true }

    /** When it stops working, in epoch milliseconds; null if unreadable. */
    fun expiresAt(token: String): Long? {
        val raw = token.substringBefore('.', "")
        if (raw.isEmpty()) return null
        val body = runCatching { String(Base64.getUrlDecoder().decode(raw + "=".repeat((4 - raw.length % 4) % 4))) }.getOrNull() ?: return null
        val o = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return null
        val e = (o["e"] as? JsonPrimitive)?.longOrNull ?: return null
        return e * 1000
    }

    /** Which call it answers (`t`). */
    fun callOf(token: String): String? {
        val raw = token.substringBefore('.', "")
        val body = runCatching { String(Base64.getUrlDecoder().decode(raw + "=".repeat((4 - raw.length % 4) % 4))) }.getOrNull() ?: return null
        val o = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return null
        return (o["t"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.lowercase()
    }
}

/** A call ringing this phone. */
data class Ring(
    val callId: String,
    val token: String,
    val video: Boolean,
    /** You're in a call or voice channel (here or on another device). */
    val busy: Boolean,
    val group: Boolean,
    /** Who's calling (a group: the conversation's name). */
    val title: String,
    /** "Incoming call", "Ann is starting a video call". */
    val text: String,
    /** Rings until then (epoch ms): the server's 45 s, cut to the token's life. */
    val until: Long,
) {
    companion object {
        /** How long a ring lasts (`backend/app/calls/ring.py::RING_TTL`). */
        const val RING_MS = 45_000L

        /** Margin so an answer isn't sent with a token about to die. */
        const val TOKEN_MARGIN_MS = 5_000L

        /** A ring from Chrome's notification, or null when it can't be one
         *  (no token: the page doesn't know about this app; or stale). */
        fun of(tag: CallTag, title: String?, text: String?, now: Long): Ring? {
            if (tag.kind != CallTag.Kind.RING) return null
            val token = tag.token ?: return null
            if (AnswerToken.callOf(token)?.let { it != tag.callId } == true) return null
            val expires = AnswerToken.expiresAt(token) ?: return null
            val until = minOf(now + RING_MS, expires - TOKEN_MARGIN_MS)
            if (until <= now) return null
            val kind = if (tag.video) "video call" else "call"
            return Ring(
                callId = tag.callId,
                token = token,
                video = tag.video,
                busy = tag.busy,
                group = tag.group,
                title = title?.trim()?.take(120)?.ifBlank { null } ?: "Promptly",
                text = text?.trim()?.take(200)?.ifBlank { null } ?: "Incoming $kind",
                until = until,
            )
        }
    }
}

// ==================================================================== the state machine

/** How a call ended, as Telecom is told (`android.telecom.DisconnectCause`). */
enum class EndCause { LOCAL, REMOTE, REJECTED, MISSED }

sealed class CallEvent {
    /** Chrome handed over a ring. */
    data class Rang(val ring: Ring, val now: Long) : CallEvent()
    /** "Stop ringing": answered or declined on another device, the caller hung up, or Chrome closed the ring. */
    data class Stopped(val callId: String) : CallEvent()
    data class Missed(val callId: String) : CallEvent()
    /** The ring's time is up here. */
    data class TimedOut(val callId: String, val now: Long) : CallEvent()
    /** The server says it isn't ringing you any more ([CallApi.ringState]). */
    data class NotRinging(val callId: String) : CallEvent()
    /** Answer: on the ring screen, the notification, a Bluetooth headset or the car. */
    data class Answer(val callId: String, val now: Long) : CallEvent()
    data class Decline(val callId: String) : CallEvent()
    /** Hang up: the notification, the call screen, a headset or the car. */
    data class HangUp(val callId: String) : CallEvent()
    data class Connected(val callId: String) : CallEvent()
    /** The call's over for this phone: [why] "ended" (the server's word, or
     *  "ended:<reason>" when it said how: declined, missed, cancelled…),
     *  "replaced" (taken on another device), "lost" (no way back), "failed"
     *  (couldn't answer or start). */
    data class Ended(val callId: String, val why: String) : CallEvent()
    /** You started a call on the page and it handed it to this app (Calls WP-D5). */
    data class Outgoing(val handoff: CallHandoff) : CallEvent()
    /** Someone answered the call you started. */
    data class Answered(val callId: String) : CallEvent()
}

sealed class CallEffect {
    /** Show (or show again) the ring: full screen / heads-up, ringtone. */
    data class ShowRing(val ring: Ring) : CallEffect()
    data class CancelRing(val callId: String) : CallEffect()
    /** Redeem the ring's token and start the in-call service. */
    data class Answer(val ring: Ring) : CallEffect()
    data class Decline(val ring: Ring) : CallEffect()
    /** Leave the call on the server and stop the in-call service. */
    data class Leave(val callId: String) : CallEffect()
    /** Telecom: a new incoming call (the car, a headset, the lock screen). */
    data class TelecomIncoming(val ring: Ring) : CallEffect()
    data class TelecomAnswer(val callId: String, val video: Boolean) : CallEffect()
    data class TelecomActive(val callId: String) : CallEffect()
    data class TelecomEnd(val callId: String, val cause: EndCause) : CallEffect()
    /** Say something short ("This call has ended"). */
    data class Tell(val text: String) : CallEffect()
    /** Start the in-call service on a call you started (the page's hand-off). */
    data class Start(val handoff: CallHandoff) : CallEffect()
    /** Telecom: a call you're making (dialling until it's answered). */
    data class TelecomOutgoing(val callId: String, val video: Boolean, val title: String) : CallEffect()
}

/** Where this phone is with DM calls. */
sealed class CallState {
    data object Idle : CallState()
    data class Ringing(val ring: Ring) : CallState()
    /** In a call (connecting or connected), maybe with another ringing on top.
     *  [outgoing]: you started it; [answered]: someone else has picked up
     *  (always true for a call you answered). */
    data class Active(
        val callId: String,
        val video: Boolean,
        val title: String,
        val connected: Boolean,
        val waiting: Ring? = null,
        val outgoing: Boolean = false,
        val answered: Boolean = true,
    ) : CallState()
}

/**
 * The rules: one call at a time, plus one more ringing on top of it ("End and
 * answer"). A ring that's stale or for a call already here is ignored; a
 * second call ringing while one rings is left to ring out on the server (it
 * becomes a missed call). Answering a waiting call hangs up the current one
 * first. Every step says what Telecom is told, so the car, a headset and the
 * lock screen agree with what's on the phone.
 */
class CallMachine {
    var state: CallState = CallState.Idle
        private set

    fun on(e: CallEvent): List<CallEffect> {
        val s = state
        return when (e) {
            is CallEvent.Rang -> rang(s, e)
            is CallEvent.Stopped -> stop(s, e.callId, EndCause.REMOTE)
            is CallEvent.NotRinging -> stop(s, e.callId, EndCause.REMOTE)
            is CallEvent.Missed -> stop(s, e.callId, EndCause.MISSED)
            is CallEvent.TimedOut -> {
                val r = ringOf(s, e.callId)
                if (r != null && e.now >= r.until) stop(s, e.callId, EndCause.MISSED) else emptyList()
            }
            is CallEvent.Answer -> answer(s, e)
            is CallEvent.Decline -> decline(s, e.callId)
            is CallEvent.HangUp -> {
                if (s is CallState.Active && s.callId == e.callId) {
                    state = after(s)
                    listOf(CallEffect.Leave(s.callId), CallEffect.TelecomEnd(s.callId, EndCause.LOCAL)) + promoteWaiting(s)
                } else {
                    emptyList()
                }
            }
            is CallEvent.Connected -> {
                if (s is CallState.Active && s.callId == e.callId && !s.connected) {
                    state = s.copy(connected = true)
                    // A call you're making stays "dialling" for Telecom until it's answered.
                    if (s.answered) listOf(CallEffect.TelecomActive(s.callId)) else emptyList()
                } else {
                    emptyList()
                }
            }
            is CallEvent.Answered -> {
                if (s is CallState.Active && s.callId == e.callId && !s.answered) {
                    state = s.copy(answered = true)
                    listOf(CallEffect.TelecomActive(s.callId))
                } else {
                    emptyList()
                }
            }
            is CallEvent.Ended -> {
                if (s is CallState.Active && s.callId == e.callId) {
                    state = after(s)
                    val reason = e.why.substringAfter("ended:", "")
                    val unanswered = s.outgoing && !s.answered
                    val tell = when {
                        e.why == "failed" && s.outgoing -> listOf(CallEffect.Tell("Couldn't start the call."))
                        e.why == "failed" -> listOf(CallEffect.Tell("Couldn't answer: this call has ended."))
                        e.why == "lost" -> listOf(CallEffect.Tell("Lost the connection to the call."))
                        unanswered && reason == "declined" -> listOf(CallEffect.Tell("Call declined."))
                        unanswered && reason == "missed" -> listOf(CallEffect.Tell("No answer."))
                        else -> emptyList()
                    }
                    val cause = when {
                        e.why == "failed" -> EndCause.MISSED
                        unanswered && reason == "declined" -> EndCause.REJECTED
                        else -> EndCause.REMOTE
                    }
                    listOf(CallEffect.TelecomEnd(s.callId, cause)) + tell + promoteWaiting(s)
                } else {
                    emptyList()
                }
            }
            is CallEvent.Outgoing -> outgoing(s, e.handoff)
        }
    }

    /**
     * A call you started on the page, handed to this app. It replaces
     * whatever's here: the server has already taken you out of any other
     * call; a call ringing here is left to ring out (it becomes missed).
     */
    private fun outgoing(s: CallState, h: CallHandoff): List<CallEffect> {
        if (s is CallState.Active && s.callId == h.callId) return emptyList()
        val out = mutableListOf<CallEffect>()
        when (s) {
            is CallState.Ringing -> {
                out += CallEffect.CancelRing(s.ring.callId)
                out += CallEffect.TelecomEnd(s.ring.callId, EndCause.MISSED)
            }
            is CallState.Active -> {
                s.waiting?.let {
                    out += CallEffect.CancelRing(it.callId)
                    out += CallEffect.TelecomEnd(it.callId, EndCause.MISSED)
                }
                out += CallEffect.Leave(s.callId)
                out += CallEffect.TelecomEnd(s.callId, EndCause.LOCAL)
            }
            CallState.Idle -> Unit
        }
        state = CallState.Active(h.callId, h.video, h.title, connected = false, outgoing = true, answered = false)
        out += CallEffect.TelecomOutgoing(h.callId, h.video, h.title)
        out += CallEffect.Start(h)
        return out
    }

    private fun rang(s: CallState, e: CallEvent.Rang): List<CallEffect> {
        val r = e.ring
        if (e.now >= r.until) return emptyList()
        return when (s) {
            CallState.Idle -> {
                state = CallState.Ringing(r)
                listOf(CallEffect.ShowRing(r), CallEffect.TelecomIncoming(r))
            }
            is CallState.Ringing -> {
                if (s.ring.callId != r.callId) return emptyList()
                // Rung again (a group call's Ring): a fresh token and time.
                state = CallState.Ringing(r.copy(busy = r.busy || s.ring.busy))
                listOf(CallEffect.ShowRing((state as CallState.Ringing).ring))
            }
            is CallState.Active -> {
                if (s.callId == r.callId) return emptyList()
                val waiting = r.copy(busy = true)
                val fresh = s.waiting?.callId != r.callId
                if (s.waiting != null && fresh) return emptyList()
                state = s.copy(waiting = waiting)
                listOf(CallEffect.ShowRing(waiting)) + if (fresh) listOf(CallEffect.TelecomIncoming(waiting)) else emptyList()
            }
        }
    }

    private fun stop(s: CallState, callId: String, cause: EndCause): List<CallEffect> = when {
        s is CallState.Ringing && s.ring.callId == callId -> {
            state = CallState.Idle
            listOf(CallEffect.CancelRing(callId), CallEffect.TelecomEnd(callId, cause))
        }
        s is CallState.Active && s.waiting?.callId == callId -> {
            state = s.copy(waiting = null)
            listOf(CallEffect.CancelRing(callId), CallEffect.TelecomEnd(callId, cause))
        }
        // Our own call: "stop ringing" after we answered it here is for the
        // other devices. Anything else isn't ours.
        else -> emptyList()
    }

    private fun answer(s: CallState, e: CallEvent.Answer): List<CallEffect> {
        val r = ringOf(s, e.callId) ?: return emptyList()
        if (e.now >= r.until + Ring.TOKEN_MARGIN_MS) {
            // Too late (the token is about to die, or has): it's a missed call.
            return stop(s, e.callId, EndCause.MISSED) + CallEffect.Tell("This call has ended.")
        }
        val out = mutableListOf<CallEffect>(CallEffect.CancelRing(r.callId))
        if (s is CallState.Active) {
            // End and answer.
            out += CallEffect.Leave(s.callId)
            out += CallEffect.TelecomEnd(s.callId, EndCause.LOCAL)
        }
        state = CallState.Active(r.callId, r.video, r.title, connected = false)
        out += CallEffect.TelecomAnswer(r.callId, r.video)
        out += CallEffect.Answer(r)
        return out
    }

    private fun decline(s: CallState, callId: String): List<CallEffect> {
        val r = ringOf(s, callId) ?: return emptyList()
        state = if (s is CallState.Active) s.copy(waiting = null) else CallState.Idle
        return listOf(CallEffect.CancelRing(callId), CallEffect.Decline(r), CallEffect.TelecomEnd(callId, EndCause.REJECTED))
    }

    private fun ringOf(s: CallState, callId: String): Ring? = when (s) {
        is CallState.Ringing -> s.ring.takeIf { it.callId == callId }
        is CallState.Active -> s.waiting?.takeIf { it.callId == callId }
        CallState.Idle -> null
    }

    /** A call that was waiting rings on its own once the current one's over. */
    private fun after(s: CallState.Active): CallState = s.waiting?.let { CallState.Ringing(it.copy(busy = false)) } ?: CallState.Idle

    private fun promoteWaiting(s: CallState.Active): List<CallEffect> {
        val w = s.waiting ?: return emptyList()
        return listOf(CallEffect.ShowRing(w.copy(busy = false)))
    }
}

// ==================================================================== the server

/** What the server hands back from answer / refresh (`dm.py::join_out`). */
data class CallJoin(
    val url: String,
    val token: String,
    val roomId: String,
    val lkRoom: String,
    val session: String,
    val sessionId: String,
    val callId: String,
    val video: Boolean,
    val group: Boolean,
    val answeredAt: String?,
    /** Who the call's with, as you see it (the server's `title`). */
    val title: String? = null,
)

/** `POST /api/calls/answer/state`. */
data class RingState(val ringing: Boolean, val ended: Boolean)

object CallProtocol {
    private val json = Json { ignoreUnknownKeys = true }

    fun parseJoin(body: String): CallJoin {
        val o = json.parseToJsonElement(body).jsonObject
        fun req(k: String) = o.str(k) ?: throw IllegalArgumentException("join has no $k")
        val call = o["call"] as? JsonObject ?: throw IllegalArgumentException("join has no call")
        return CallJoin(
            url = o.str("url") ?: "/livekit",
            token = req("token"),
            roomId = req("room_id"),
            lkRoom = req("lk_room"),
            session = req("session"),
            sessionId = o.str("session_id") ?: "",
            callId = call.str("id") ?: throw IllegalArgumentException("call has no id"),
            video = call.str("media") == "video",
            group = call.bool("group") ?: false,
            answeredAt = call.str("answered_at"),
            title = o.str("title")?.trim()?.take(120)?.ifBlank { null },
        )
    }

    fun parseRingState(body: String): RingState {
        val o = json.parseToJsonElement(body).jsonObject
        return RingState(ringing = o.bool("ringing") ?: false, ended = o.bool("ended") ?: false)
    }

    /** `POST /api/calls/answer`. */
    fun answerBody(token: String): String = buildJsonObject {
        put("token", token)
        put("device", "android")
    }.toString()

    /** `answer/decline`, `answer/state`. */
    fun tokenBody(token: String): String = buildJsonObject { put("token", token) }.toString()

    /** `session/refresh`, `session/leave`. */
    fun sessionBody(session: String): String = buildJsonObject { put("session", session) }.toString()

    /** The page's remote control (`dm.py::control`), from the server only. */
    enum class Control { MUTE, UNMUTE, SPEAKER_ON, SPEAKER_OFF, CAMERA_ON, CAMERA_OFF, FLIP }

    const val CONTROL_TOPIC = "call.control"

    fun parseControl(data: ByteArray, topic: String?, fromServer: Boolean): Control? {
        if (topic != CONTROL_TOPIC || !fromServer) return null
        val o = runCatching { json.parseToJsonElement(data.decodeToString()).jsonObject }.getOrNull() ?: return null
        return when (o.str("action")) {
            "mute" -> Control.MUTE
            "unmute" -> Control.UNMUTE
            "speaker_on" -> Control.SPEAKER_ON
            "speaker_off" -> Control.SPEAKER_OFF
            "camera_on" -> Control.CAMERA_ON
            "camera_off" -> Control.CAMERA_OFF
            "flip" -> Control.FLIP
            else -> null
        }
    }

    /** The page for a call: the conversation, which shows the call's video. */
    fun pagePath(roomId: String, callId: String): String = "/rooms/r/$roomId?call=$callId"

    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.bool(k: String): Boolean? = (this[k] as? JsonPrimitive)?.booleanOrNull
}

/** The answer to `POST session/refresh`. */
sealed class CallRefresh {
    data class Ok(val join: CallJoin) : CallRefresh()
    /** 404: the session's over (hung up, ended, taken on another device). */
    data object Gone : CallRefresh()
    /** 404 "ended:<reason>": the call itself is over, and the server says how
     *  (declined, missed, cancelled, completed). */
    data class Ended(val reason: String) : CallRefresh()
    data class Failed(val why: String) : CallRefresh()

    companion object {
        /** A 404's detail: "ended:declined" → [Ended], anything else → [Gone]. */
        fun gone(detail: String?): CallRefresh {
            val r = detail?.takeIf { it.startsWith("ended:") }?.substringAfter("ended:")?.takeIf { it.matches(Regex("[a-z_]{1,24}")) }
            return if (r != null) Ended(r) else Gone
        }
    }
}

/**
 * Getting back into the call after the connection dropped (LiveKit's own
 * reconnect gave up): fresh token, connect; waits 1, 2, 4, 8, then 15 s.
 * The server's word ends it; so do two minutes without a way through (the
 * other person will have hung up by then).
 */
class CallRejoin(private val startedAt: Long, private val giveUpMs: Long = 2 * 60_000) {
    sealed class Step {
        data class Connect(val join: CallJoin) : Step()
        data class Retry(val inMs: Long) : Step()
        data class Stop(val why: String) : Step()
    }

    var attempts = 0
        private set

    fun next(result: CallRefresh, now: Long): Step = when (result) {
        is CallRefresh.Ok -> Step.Connect(result.join)
        CallRefresh.Gone -> Step.Stop("ended")
        is CallRefresh.Ended -> Step.Stop("ended:${result.reason}")
        is CallRefresh.Failed -> retry(now)
    }

    fun connectFailed(now: Long): Step = retry(now)

    private fun retry(now: Long): Step {
        if (now - startedAt >= giveUpMs) return Step.Stop("lost")
        val d = DELAYS[attempts.coerceAtMost(DELAYS.size - 1)]
        attempts++
        return Step.Retry(d)
    }

    companion object {
        val DELAYS = longArrayOf(1_000, 2_000, 4_000, 8_000, 15_000)
    }
}

// ==================================================================== what it says

/** The ongoing call notification and the call screen's words. */
data class CallNote(val title: String, val text: String, val muteLabel: String, val speakerLabel: String) {
    enum class Status { CONNECTING, CONNECTED, RECONNECTING }

    companion object {
        /**
         * @param calling you started it and nobody's answered yet
         * @param held Android put this call on hold (you took a phone call)
         * @param peerHeld someone in it put the call on hold
         */
        fun of(
            name: String,
            video: Boolean,
            status: Status,
            muted: Boolean,
            speaker: Boolean,
            seconds: Long,
            others: Int,
            group: Boolean,
            calling: Boolean = false,
            held: Boolean = false,
            peerHeld: Boolean = false,
        ): CallNote {
            val what = if (video) "Video call" else "Call"
            val text = when {
                status == Status.RECONNECTING -> "Reconnecting…"
                calling -> if (group) "Ringing everyone…" else "Calling…"
                status == Status.CONNECTING -> "Connecting…"
                held -> "On hold · you're on another call"
                peerHeld && !group -> "On hold"
                else -> buildString {
                    append(elapsed(seconds))
                    if (group) append(if (others == 1) " · 1 other" else " · $others others")
                    if (peerHeld) append(" · someone put the call on hold")
                    if (muted) append(" · you're muted")
                }
            }
            return CallNote(
                title = "$what with $name",
                text = text,
                muteLabel = if (muted) "Unmute" else "Mute",
                speakerLabel = if (speaker) "Speaker off" else "Speaker",
            )
        }

        /** 0:42, 12:05, 1:02:09. */
        fun elapsed(seconds: Long): String {
            val s = seconds.coerceAtLeast(0)
            val h = s / 3600
            val m = (s % 3600) / 60
            val sec = s % 60
            return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
        }

        /** The ring's words: "Answer", or "End and answer" while you're on a call. */
        fun answerLabel(ring: Ring): String = if (ring.busy) "End and answer" else "Answer"

        fun busyLine(ring: Ring): String? = if (ring.busy) "You're on another call. Answering ends it." else null
    }
}

/** Speaker or not: calls start on the earpiece (a phone call held to your
 *  ear), video calls on the loudspeaker; a headset or the car always wins. */
object Routing {
    enum class Kind { EARPIECE, SPEAKER, WIRED, BLUETOOTH, OTHER }

    /** The route to pick from [available], given whether the speaker is wanted. */
    fun pick(available: List<Kind>, speaker: Boolean): Kind? {
        if (available.isEmpty()) return null
        if (speaker && Kind.SPEAKER in available) return Kind.SPEAKER
        for (k in listOf(Kind.BLUETOOTH, Kind.WIRED, Kind.EARPIECE, Kind.SPEAKER)) if (k in available) return k
        return available.first()
    }

    fun startsOnSpeaker(video: Boolean): Boolean = video
}
