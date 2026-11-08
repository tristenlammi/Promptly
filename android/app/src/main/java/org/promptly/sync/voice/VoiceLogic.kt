package org.promptly.sync.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.Base64

/*
 * The voice service's rules, kept free of Android and LiveKit so the JVM
 * tests can run them: what the server's commands mean, mute and deafen,
 * what the phone reports, what the notification says, and what to do when
 * the connection goes or the session ends. VoiceService does the doing.
 */

/** A command from the server on the `voice.control` data topic
 *  (backend `app/calls/voice.py::_send_control`). */
sealed class VoiceCommand {
    data object Mute : VoiceCommand()
    data object Unmute : VoiceCommand()
    data object Deafen : VoiceCommand()
    data object Undeafen : VoiceCommand()
    /** The server took you out ("admin", "alone", "moved", "access"…). */
    data class Leave(val reason: String) : VoiceCommand()
    /** Alone too long: answer within [seconds] or you're disconnected. */
    data class StillThere(val seconds: Int) : VoiceCommand()
    /** An admin moved you: the server already joined you to [roomId]. */
    data class Move(val roomId: String, val lkRoom: String, val token: String, val session: String) : VoiceCommand()
}

/** What the server hands back from join / refresh (`voice.py::join_out`). */
data class VoiceJoin(
    val url: String,
    val token: String,
    val roomId: String,
    val spaceId: String,
    val lkRoom: String,
    val session: String,
    val sessionId: String,
    val channelName: String,
    val spaceName: String,
    val bitrateKbps: Int,
    val quality: String,
    val canTalk: Boolean,
    val serverMuted: Boolean,
    val serverDeafened: Boolean,
)

/** What the web page's Join hands to the app (`promptly://voice/join?…`). */
data class VoiceHandoff(
    val server: String,
    val session: String,
    val roomId: String,
    val channel: String,
    val space: String,
)

object VoiceProtocol {
    const val CONTROL_TOPIC = "voice.control"
    private val json = Json { ignoreUnknownKeys = true }

    /** A server command, or null for anything else (another topic, a
     *  message from a participant rather than the server, junk). */
    fun parseCommand(data: ByteArray, topic: String?, fromServer: Boolean): VoiceCommand? {
        if (topic != CONTROL_TOPIC || !fromServer) return null
        val o = runCatching { json.parseToJsonElement(data.decodeToString()).jsonObject }.getOrNull() ?: return null
        return when (o.str("action")) {
            "mute" -> VoiceCommand.Mute
            "unmute" -> VoiceCommand.Unmute
            "deafen" -> VoiceCommand.Deafen
            "undeafen" -> VoiceCommand.Undeafen
            "leave" -> VoiceCommand.Leave(o.str("reason") ?: "left")
            "still_there" -> VoiceCommand.StillThere((o["seconds"]?.jsonPrimitive?.intOrNull ?: 120).coerceIn(10, 600))
            "move" -> {
                val room = o.str("room_id") ?: return null
                val lk = o.str("lk_room") ?: return null
                val token = o.str("token") ?: return null
                val session = o.str("session") ?: return null
                VoiceCommand.Move(room, lk, token, session)
            }
            else -> null
        }
    }

    fun parseJoin(body: String): VoiceJoin {
        val o = json.parseToJsonElement(body).jsonObject
        fun req(k: String) = o.str(k) ?: throw IllegalArgumentException("join has no $k")
        return VoiceJoin(
            url = o.str("url") ?: "/livekit",
            token = req("token"),
            roomId = req("room_id"),
            spaceId = o.str("space_id") ?: "",
            lkRoom = req("lk_room"),
            session = req("session"),
            sessionId = req("session_id"),
            channelName = o.str("channel_name") ?: "Voice",
            spaceName = o.str("space_name") ?: "",
            bitrateKbps = o["bitrate"]?.jsonPrimitive?.intOrNull ?: 64,
            quality = o.str("quality") ?: "good",
            canTalk = o.bool("can_talk") ?: true,
            serverMuted = o.bool("server_muted") ?: false,
            serverDeafened = o.bool("server_deafened") ?: false,
        )
    }

    /** `POST /api/rooms/voice/session/state`. */
    fun stateBody(session: String, mic: MicState): String = buildJsonObject {
        put("voice_session", session)
        put("muted", mic.muted || mic.deafened)
        put("deafened", mic.deafened)
    }.toString()

    /** `POST /api/rooms/voice/session/speaking`. */
    fun speakingBody(session: String, on: Boolean): String = buildJsonObject {
        put("voice_session", session)
        put("on", on)
    }.toString()

    /** `session/still-here` and `session/leave`. */
    fun sessionBody(session: String): String = buildJsonObject { put("voice_session", session) }.toString()

    /** `POST /api/rooms/voice/refresh`. */
    fun refreshBody(session: String): String = buildJsonObject { put("session", session) }.toString()

    /** The LiveKit signalling address: the join's path ("/livekit") on the
     *  server, as a WebSocket. A full ws(s) URL is used as is. */
    fun signalUrl(server: String, path: String): String {
        if (path.startsWith("ws://") || path.startsWith("wss://")) return path
        val base = server.trimEnd('/')
        val ws = when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
            else -> base
        }
        return ws + "/" + path.trimStart('/')
    }

    /** "https://Host:443/x" -> "https://host"; null when it isn't an http(s) origin. */
    fun origin(raw: String?): String? {
        if (raw.isNullOrBlank()) return null
        val u = runCatching { java.net.URI(raw.trim()) }.getOrNull() ?: return null
        val scheme = u.scheme?.lowercase() ?: return null
        val host = u.host?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val port = when {
            u.port < 0 -> ""
            scheme == "https" && u.port == 443 -> ""
            scheme == "http" && u.port == 80 -> ""
            else -> ":${u.port}"
        }
        return "$scheme://$host$port"
    }

    /**
     * Reads the page's hand-off. Only a session for the server this phone's
     * Promptly app is set up with is taken: a web page elsewhere can't point
     * the app (and your microphone) at another server.
     */
    fun parseHandoff(params: Map<String, String?>, savedServer: String?): VoiceHandoff? {
        val server = origin(params["server"]) ?: return null
        val saved = origin(savedServer) ?: return null
        if (server != saved) return null
        val session = params["session"]?.takeIf { it.length in 10..2000 } ?: return null
        val room = params["room"]?.takeIf { it.matches(Regex("[0-9a-fA-F-]{32,36}")) } ?: return null
        return VoiceHandoff(
            server = server,
            session = session,
            roomId = room.lowercase(),
            channel = params["channel"]?.take(80)?.ifBlank { null } ?: "Voice",
            space = params["space"]?.take(80) ?: "",
        )
    }

    /** Whose session this is (the JWT's `sub`), unverified: only to notice
     *  a different account handing off than last time. */
    fun sessionUser(token: String): String? {
        val parts = token.split('.')
        if (parts.size != 3) return null
        val payload = runCatching { String(Base64.getUrlDecoder().decode(parts[1].padBase64())) }.getOrNull() ?: return null
        val o = runCatching { json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: return null
        if (o.str("typ") != "voice") return null
        return o.str("sub")
    }

    private fun String.padBase64(): String = this + "=".repeat((4 - length % 4) % 4)
    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.bool(k: String): Boolean? = (this[k] as? JsonPrimitive)?.booleanOrNull
}

/**
 * Mute and deafen, as on the web (`frontend/src/rtc/voice/engine.ts`):
 * deafen mutes you too, and undeafen puts back the mute you had; unmuting
 * while deafened undeafens. An admin's server-mute / -deafen sits on top
 * and can't be undone here.
 */
data class MicState(
    val muted: Boolean = false,
    val deafened: Boolean = false,
    val mutedBeforeDeafen: Boolean = false,
    /** The channel lets you talk ("Who can talk"). */
    val canTalk: Boolean = true,
    val serverMuted: Boolean = false,
    val serverDeafened: Boolean = false,
    /** LiveKit's grant includes the microphone (false while server-muted). */
    val micGranted: Boolean = true,
    /** Android lets the app use the microphone. */
    val hasMicPermission: Boolean = true,
) {
    /** The microphone is sending. */
    val micOn: Boolean get() = mayTalk && !muted && !deafened
    /** You may talk at all right now (whether or not you're muted). */
    val mayTalk: Boolean get() = canTalk && hasMicPermission && micGranted && !serverMuted && !serverDeafened
    /** You hear the channel. */
    val hearing: Boolean get() = !deafened && !serverDeafened
    /** Unmute is on offer (an admin's mute isn't yours to lift). */
    val canUnmute: Boolean get() = mayTalk

    fun mute(): MicState = if (muted) this else copy(muted = true)

    fun unmute(): MicState = when {
        deafened -> undeafen().copy(muted = false)
        !mayTalk -> this
        else -> copy(muted = false)
    }

    fun deafen(): MicState = if (deafened) this else copy(deafened = true, mutedBeforeDeafen = muted, muted = true)

    fun undeafen(): MicState = if (!deafened) this else copy(deafened = false, muted = mutedBeforeDeafen)

    fun toggleMute(): MicState = if (muted || deafened) unmute() else mute()

    fun toggleDeafen(): MicState = if (deafened) undeafen() else deafen()

    fun apply(cmd: VoiceCommand): MicState = when (cmd) {
        VoiceCommand.Mute -> mute()
        VoiceCommand.Unmute -> unmute()
        VoiceCommand.Deafen -> deafen()
        VoiceCommand.Undeafen -> undeafen()
        else -> this
    }
}

/** Speaking edges for the rings everyone else sees: on after 150 ms of
 *  talking, off after 400 ms of quiet (the web client's debounce). */
class SpeakingDebouncer(private val onMs: Long = 150, private val offMs: Long = 400) {
    private var raw = false
    private var since = 0L
    var reported = false
        private set

    /** The latest reading. Returns when to call [tick] next, or null. */
    fun input(talking: Boolean, now: Long): Long? {
        if (talking != raw) {
            raw = talking
            since = now
        }
        return due()
    }

    /** An edge to report now (true / false), or null. */
    fun tick(now: Long): Boolean? {
        if (raw == reported) return null
        if (now - since < if (raw) onMs else offMs) return null
        reported = raw
        return reported
    }

    /** When the pending edge is due, or null if nothing's pending. */
    fun due(): Long? = if (raw == reported) null else since + if (raw) onMs else offMs

    /** Muted / left: off at once. True when that's an edge to report. */
    fun forceOff(): Boolean {
        raw = false
        if (!reported) return false
        reported = false
        return true
    }
}

/** What a dropped connection means. Names are LiveKit's DisconnectReason. */
enum class DropKind {
    /** We left. */
    OURS,
    /** Joined on another device or channel: that one has the session now. */
    REPLACED,
    /** The server removed us or closed the room: ask whether the session lives. */
    REMOVED,
    /** Network trouble: rejoin with a fresh token. */
    NETWORK;

    companion object {
        fun of(reason: String?): DropKind = when (reason) {
            "CLIENT_INITIATED" -> OURS
            "DUPLICATE_IDENTITY" -> REPLACED
            "PARTICIPANT_REMOVED", "ROOM_DELETED", "ROOM_CLOSED", "USER_REJECTED" -> REMOVED
            else -> NETWORK
        }
    }
}

/** The answer to `POST voice/refresh`. */
sealed class Refresh {
    data class Ok(val join: VoiceJoin) : Refresh()
    /** 404: the session ended (you left, were removed, joined elsewhere). */
    data object Gone : Refresh()
    /** No answer (network, server down): try again. */
    data class Failed(val why: String) : Refresh()
}

/**
 * Getting back into the channel after the connection dropped: fresh token,
 * connect; on failure wait 1, 2, 4, 8, 15, then 30 s between tries. The
 * server's word ends it (the session is gone); so does five minutes with no
 * way through (the reaper will have dropped us anyway).
 */
class Rejoin(private val startedAt: Long, private val giveUpMs: Long = 5 * 60_000) {
    sealed class Step {
        data class Connect(val join: VoiceJoin) : Step()
        data class Retry(val inMs: Long) : Step()
        data class Stop(val why: String) : Step()
    }

    var attempts = 0
        private set

    fun next(result: Refresh, now: Long): Step = when (result) {
        is Refresh.Ok -> Step.Connect(result.join)
        Refresh.Gone -> Step.Stop("ended")
        is Refresh.Failed -> retry(now)
    }

    /** The connect after a good refresh failed too. */
    fun connectFailed(now: Long): Step = retry(now)

    private fun retry(now: Long): Step {
        if (now - startedAt >= giveUpMs) return Step.Stop("lost")
        val d = DELAYS[attempts.coerceAtMost(DELAYS.size - 1)]
        attempts++
        return Step.Retry(d)
    }

    companion object {
        val DELAYS = longArrayOf(1_000, 2_000, 4_000, 8_000, 15_000, 30_000)
    }
}

/** What the ongoing notification says. */
data class VoiceNote(
    val title: String,
    val text: String,
    val muteLabel: String,
    val muteEnabled: Boolean,
    val deafenLabel: String,
) {
    companion object {
        /**
         * @param talking display names of the others talking now
         * @param others how many others are in the channel
         */
        fun of(
            channel: String,
            space: String,
            mic: MicState,
            status: Status,
            talking: List<String>,
            others: Int,
        ): VoiceNote {
            val title = "🔊 $channel" + if (space.isNotBlank()) " · $space" else ""
            val people = when (others) {
                0 -> "Just you here"
                1 -> "You and 1 other"
                else -> "You and $others others"
            }
            val text = when {
                status == Status.CONNECTING -> "Connecting…"
                status == Status.RECONNECTING -> "Reconnecting…"
                mic.serverDeafened -> "An admin deafened you"
                mic.serverMuted -> "An admin muted you"
                !mic.hasMicPermission -> "Listening only: Promptly can't use your microphone"
                // (Deafened, you don't hear them: no "is talking" then.)
                mic.deafened -> "Deafened · $people"
                talking.isNotEmpty() && mic.muted -> talkingLine(talking) + " · you're muted"
                talking.isNotEmpty() -> talkingLine(talking)
                !mic.canTalk -> "Listening · only admins can talk here"
                mic.muted -> "Muted · $people"
                else -> people
            }
            return VoiceNote(
                title = title,
                text = text,
                muteLabel = if (mic.muted || mic.deafened) "Unmute" else "Mute",
                // An admin's mute (or a channel where you can't talk) isn't
                // yours to lift: no Mute button then, unless you're deafened.
                muteEnabled = mic.mayTalk || mic.deafened,
                deafenLabel = if (mic.deafened) "Undeafen" else "Deafen",
            )
        }

        fun talkingLine(names: List<String>): String = when (names.size) {
            0 -> ""
            1 -> "${names[0]} is talking"
            2 -> "${names[0]} and ${names[1]} are talking"
            3 -> "${names[0]}, ${names[1]} and ${names[2]} are talking"
            else -> "${names[0]}, ${names[1]} and ${names.size - 2} others are talking"
        }
    }

    enum class Status { CONNECTING, CONNECTED, RECONNECTING }
}

/** The user id in a LiveKit identity `u:<id>` (not a `:view` second connection). */
fun userOfIdentity(identity: String): String? =
    Regex("^u:([0-9a-fA-F-]{36})$").find(identity)?.groupValues?.get(1)?.lowercase()
