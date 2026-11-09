package org.promptly.sync.talk

import org.json.JSONObject

/** A clock run by hand: jobs run at once, timers when [advance] passes them. */
class FakeTicker : Ticker {
    var t = 1_000_000L
    private class Timer(val due: Long, val job: () -> Unit, var cancelled: Boolean = false)
    private val timers = ArrayList<Timer>()

    override fun now(): Long = t
    override fun run(job: () -> Unit) = job()
    override fun after(ms: Long, job: () -> Unit): () -> Unit {
        val timer = Timer(t + ms, job)
        timers += timer
        return { timer.cancelled = true }
    }

    fun advance(ms: Long) {
        val target = t + ms
        while (true) {
            val next = timers.filter { !it.cancelled && it.due <= target }.minByOrNull { it.due } ?: break
            timers.remove(next)
            t = next.due
            next.job()
        }
        t = target
    }
}

/** The server's end of one socket. */
class FakeSocket(val query: Map<String, String>, val listener: TalkSocketListener) : TalkSocket {
    val texts = ArrayList<JSONObject>()
    val frames = ArrayList<ByteArray>()
    var closedWith: Int? = null

    override fun sendText(text: String): Boolean {
        texts += JSONObject(text)
        return closedWith == null
    }

    override fun sendBytes(bytes: ByteArray): Boolean {
        frames += bytes
        return closedWith == null
    }

    override fun close(code: Int) {
        closedWith = code
    }

    fun sent(type: String) = texts.filter { it.optString("type") == type }

    fun say(vararg pairs: Pair<String, Any?>) {
        val o = JSONObject()
        pairs.forEach { (k, v) -> o.put(k, v ?: JSONObject.NULL) }
        listener.onText(o.toString())
    }

    fun ready(session: String = "s1", resumed: Boolean = false) = listener.onText(
        JSONObject().put("type", "ready").put("session_id", session).put("resumed", resumed).put("conversation_id", JSONObject.NULL)
            .put("turn_mode", "hands_free").put("interrupt_mode", "talk")
            .put("audio", JSONObject().put("format", "pcm16").put("sample_rate", 24000).put("frame_ms", 20))
            .put("limits", JSONObject().put("resume_s", 30).put("idle_s", 120)).toString(),
    )
}

class FakeOpener : SocketOpener {
    val sockets = ArrayList<FakeSocket>()
    var refuse = false
    val last: FakeSocket get() = sockets.last()

    override fun open(query: Map<String, String>, listener: TalkSocketListener): TalkSocket {
        if (refuse) throw java.io.IOException("no route")
        return FakeSocket(query, listener).also { sockets += it }
    }
}

class FakeSpeaker : Speaker {
    val pushed = ArrayList<ByteArray>()
    var stops = 0
    var replies = 0
    var tones = 0
    var played: Long? = 640L
    override var playing = false
    override var ducked = false
    override fun push(pcm: ByteArray) {
        pushed += pcm
    }
    override fun startReply() {
        replies++
    }
    override fun stop(): Long? {
        stops++
        playing = false
        ducked = false
        return played
    }
    override fun playedMs(): Long? = played
    override fun duck() {
        ducked = true
    }
    override fun unduck() {
        ducked = false
    }
    override fun endTone() {
        tones++
    }
}

fun pcm(level: Short = 0, samples: Int = 320): ByteArray {
    val out = ByteArray(samples * 2)
    for (i in 0 until samples) {
        out[i * 2] = level.toInt().toByte()
        out[i * 2 + 1] = (level.toInt() shr 8).toByte()
    }
    return out
}
