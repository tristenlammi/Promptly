package org.promptly.sync.talk

import org.json.JSONArray
import org.json.JSONObject

/** The phone's side of `/api/talk/ws` (the server's `app/talk/protocol.py` has the
 *  whole thing). JSON events both ways, and audio as binary messages: a 4-byte
 *  big-endian sequence number, then 20 ms of PCM16 mono (16 kHz up, 24 kHz down). */
object TalkProtocol {
    const val MIC_RATE = 16_000
    const val SPEECH_RATE = 24_000
    const val FRAME_MS = 20
    /** 20 ms of 16 kHz PCM16. */
    const val MIC_FRAME_BYTES = MIC_RATE * FRAME_MS / 1000 * 2
    /** 20 ms of 24 kHz PCM16. */
    const val SPEECH_FRAME_BYTES = SPEECH_RATE * FRAME_MS / 1000 * 2

    // Close codes: the WebSocket stand-ins for HTTP statuses.
    const val CLOSE_BAD_HELLO = 4400
    const val CLOSE_UNAUTHORIZED = 4401
    const val CLOSE_FORBIDDEN = 4403
    const val CLOSE_NOT_FOUND = 4404
    const val CLOSE_BUSY = 4429
    const val CLOSE_UNAVAILABLE = 4503

    /** What this phone can do when asked (the server only offers these). */
    val PHONE_CAPS = listOf("timer", "alarm", "dial", "message", "open_app", "navigate")

    fun withSeq(seq: Int, payload: ByteArray, size: Int = payload.size): ByteArray {
        val out = ByteArray(4 + size)
        out[0] = (seq ushr 24).toByte()
        out[1] = (seq ushr 16).toByte()
        out[2] = (seq ushr 8).toByte()
        out[3] = seq.toByte()
        System.arraycopy(payload, 0, out, 4, size)
        return out
    }

    /** The sequence number and the audio, or null for something too short to be a frame. */
    fun withoutSeq(message: ByteArray): Pair<Int, ByteArray>? {
        if (message.size < 5) return null
        val seq = ((message[0].toInt() and 0xFF) shl 24) or ((message[1].toInt() and 0xFF) shl 16) or
            ((message[2].toInt() and 0xFF) shl 8) or (message[3].toInt() and 0xFF)
        return seq to message.copyOfRange(4, message.size)
    }

    fun hello(caps: List<String>, tz: String?, lang: String?, play: String = "pcm16", codec: String = "pcm16"): JSONObject =
        JSONObject()
            .put("type", "hello")
            .put("codec", codec)
            .put("sample_rate", MIC_RATE)
            .put("play", play)
            .put("device", "android")
            .put("caps", JSONArray(caps))
            .apply {
                tz?.let { put("tz", it) }
                lang?.let { put("lang", it) }
            }

    fun parse(text: String): TalkEvent = runCatching { parse(JSONObject(text)) }.getOrDefault(TalkEvent.Unknown("?"))

    fun parse(o: JSONObject): TalkEvent {
        fun str(key: String): String? = if (o.isNull(key)) null else o.optString(key).takeIf { it.isNotEmpty() }
        return when (val type = o.optString("type")) {
            "ready" -> {
                val audio = o.optJSONObject("audio")
                val limits = o.optJSONObject("limits")
                TalkEvent.Ready(
                    sessionId = o.optString("session_id"),
                    resumed = o.optBoolean("resumed"),
                    turnMode = str("turn_mode") ?: "hands_free",
                    interruptMode = str("interrupt_mode") ?: "talk",
                    format = audio?.optString("format")?.takeIf { it.isNotEmpty() } ?: "pcm16",
                    sampleRate = audio?.optInt("sample_rate", SPEECH_RATE) ?: SPEECH_RATE,
                    resumeS = limits?.optInt("resume_s", 30) ?: 30,
                    idleS = limits?.optInt("idle_s", 120) ?: 120,
                )
            }
            "state" -> TalkEvent.State(o.optString("state", "listening"), o.optBoolean("muted"))
            "partial" -> TalkEvent.Partial(o.optString("text"))
            "heard" -> TalkEvent.Heard(o.optString("text"), str("message_id"))
            "reply" -> TalkEvent.Reply(o.optString("text"), o.optBoolean("done"), str("message_id"))
            "spoken" -> TalkEvent.Spoken(o.optInt("chars"))
            "tool" -> TalkEvent.Tool(o.optString("label"), str("name"))
            "card" -> TalkEvent.Card(o.optString("kind"), o.optJSONObject("meta") ?: JSONObject())
            "ask" -> TalkEvent.Ask(o.optString("question"), o.optString("approval_id"), o.optInt("expires_in", 20))
            "ask_done" -> TalkEvent.AskDone(o.optString("approval_id"), o.optString("outcome"))
            // The server nests the device action: {type: "action", action: {type: "set_timer", ...}}.
            "action" -> o.optJSONObject("action")?.let { TalkEvent.Action(it) } ?: TalkEvent.Unknown(type)
            "stop_audio" -> TalkEvent.StopAudio
            "error" -> TalkEvent.Error(o.optString("code"), str("say"), str("show"))
            "bye" -> TalkEvent.Bye(o.optString("reason", "bye"))
            "pong" -> TalkEvent.Pong(o.optLong("t"))
            else -> TalkEvent.Unknown(type)
        }
    }
}

sealed interface TalkEvent {
    data class Ready(
        val sessionId: String,
        val resumed: Boolean,
        val turnMode: String,
        val interruptMode: String,
        val format: String,
        val sampleRate: Int,
        val resumeS: Int,
        val idleS: Int,
    ) : TalkEvent

    data class State(val state: String, val muted: Boolean) : TalkEvent
    data class Partial(val text: String) : TalkEvent
    data class Heard(val text: String, val messageId: String?) : TalkEvent
    data class Reply(val text: String, val done: Boolean, val messageId: String?) : TalkEvent
    data class Spoken(val chars: Int) : TalkEvent
    data class Tool(val label: String, val name: String?) : TalkEvent
    data class Card(val kind: String, val meta: JSONObject) : TalkEvent
    data class Ask(val question: String, val approvalId: String, val expiresIn: Int) : TalkEvent
    data class AskDone(val approvalId: String, val outcome: String) : TalkEvent
    data class Action(val action: JSONObject) : TalkEvent
    data object StopAudio : TalkEvent
    data class Error(val code: String, val say: String?, val show: String?) : TalkEvent
    data class Bye(val reason: String) : TalkEvent
    data class Pong(val t: Long) : TalkEvent
    data class Unknown(val type: String) : TalkEvent
}
