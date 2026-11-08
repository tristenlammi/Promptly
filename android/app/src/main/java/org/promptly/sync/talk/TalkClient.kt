package org.promptly.sync.talk

import org.json.JSONObject

/** One open WebSocket, as the client sees it. */
interface TalkSocket {
    fun sendText(text: String): Boolean
    fun sendBytes(bytes: ByteArray): Boolean
    fun close(code: Int)
}

/** What a socket reports. Called on any thread: the client hops onto its own. */
interface TalkSocketListener {
    fun onOpen()
    fun onText(text: String)
    fun onBytes(bytes: ByteArray)
    /** Closed by the server (or by us), with its close code. */
    fun onClosed(code: Int)
    /** The connection broke without a close code. */
    fun onFailure()
}

/** Opens `/api/talk/ws` with these query parameters (`resume`). */
fun interface SocketOpener {
    fun open(query: Map<String, String>, listener: TalkSocketListener): TalkSocket
}

/** Time and timers, so tests can run the clock by hand. Everything the client
 *  does happens on [run]: one thread, in order. */
interface Ticker {
    fun now(): Long
    fun run(job: () -> Unit)
    fun after(ms: Long, job: () -> Unit): () -> Unit
}

/** Why a conversation couldn't go on. [fallback]: use the one-question-at-a-time
 *  assistant instead (`/api/assistant`), which may still work. */
data class TalkProblem(val code: String, val show: String, val fallback: Boolean)

/** The connection: hello, the early microphone, pings, and picking a dropped
 *  conversation up again within the server's 30 s. It knows nothing about audio
 *  devices or screens; [TalkCore] does. */
class TalkClient(
    private val opener: SocketOpener,
    private val ticker: Ticker,
    private val hello: () -> JSONObject,
    private val listener: Listener,
) {
    interface Listener {
        fun onEvent(event: TalkEvent)
        fun onSpeech(pcm: ByteArray)
        fun onLink(link: Link)
        fun onEnded(problem: TalkProblem?)
        fun onWeak()
    }

    enum class Link { CONNECTING, LIVE, RECONNECTING }

    private var socket: TalkSocket? = null
    private var generation = 0
    var sessionId: String? = null
        private set
    private var ready = false
    private var ending = false
    private var ended = false
    private var everReady = false
    private var seq = 0
    private val early = ArrayDeque<ByteArray>()
    private var resumeS = 30
    private var dropAt: Long? = null
    private val drops = ArrayList<Long>()
    private val rtts = ArrayList<Long>()
    private val pings = HashMap<Long, Long>()
    private var cancelPing: (() -> Unit)? = null
    private var cancelRetry: (() -> Unit)? = null
    private var lastError: TalkEvent.Error? = null
    private var weak = false
    var handsFree = true

    val live: Boolean get() = !ended

    fun start() = ticker.run { connect() }

    private fun connect() {
        if (ended || ending) return
        val mine = ++generation
        ready = false
        listener.onLink(if (dropAt == null) Link.CONNECTING else Link.RECONNECTING)
        // Past the server's window, the old conversation is gone: start afresh.
        dropAt?.let { if (ticker.now() - it > resumeS * 1000L) sessionId = null }
        val query = HashMap<String, String>()
        sessionId?.let { query["resume"] = it }
        val l = object : TalkSocketListener {
            private var gone = false
            override fun onOpen() = ticker.run { if (mine == generation) opened() }
            override fun onText(text: String) = ticker.run { if (mine == generation) text(text) }
            // Speech, in the same queue as the events so a stop_audio can't overtake it.
            override fun onBytes(bytes: ByteArray) = ticker.run {
                if (mine == generation && !ended) TalkProtocol.withoutSeq(bytes)?.let { listener.onSpeech(it.second) }
            }
            // A socket reports its end once: a failure after a close says nothing new.
            override fun onClosed(code: Int) = ticker.run { if (mine == generation && !gone) { gone = true; closed(code) } }
            override fun onFailure() = ticker.run { if (mine == generation && !gone) { gone = true; closed(null) } }
        }
        socket = try {
            opener.open(query, l)
        } catch (e: Exception) {
            null
        }
        if (socket == null) dropped()
    }

    private fun opened() {
        socket?.sendText(hello().toString())
    }

    private fun text(text: String) {
        val event = TalkProtocol.parse(text)
        when (event) {
            is TalkEvent.Ready -> {
                val fromDrop = dropAt != null
                dropAt = null
                sessionId = event.sessionId
                resumeS = event.resumeS
                ready = true
                everReady = true
                lastError = null
                // The event first: it can still tell a reconnection from the first start.
                listener.onEvent(event)
                listener.onLink(Link.LIVE)
                // What you said while it connected (not after a drop: that's stale).
                if (!fromDrop && handsFree) early.forEach { sendFrame(it) }
                early.clear()
                startPings()
            }
            is TalkEvent.Pong -> pings.remove(event.t)?.let { rtt(ticker.now() - it) }
            is TalkEvent.Error -> {
                lastError = event
                listener.onEvent(event)
            }
            is TalkEvent.Bye -> {
                finish()
                listener.onEvent(event)
                listener.onEnded(null)
            }
            else -> listener.onEvent(event)
        }
    }

    private fun closed(code: Int?) {
        socket = null
        ready = false
        stopPings()
        if (ended) return
        if (ending) {
            finish()
            listener.onEnded(null)
            return
        }
        val shown = lastError?.show ?: lastError?.say
        val problem = when (code) {
            TalkProtocol.CLOSE_UNAUTHORIZED -> TalkProblem("not_signed_in", "This phone needs linking to your Promptly again.", false)
            TalkProtocol.CLOSE_FORBIDDEN -> TalkProblem("talk_off", shown ?: "Talk isn't turned on for your account.", true)
            TalkProtocol.CLOSE_BUSY -> TalkProblem("busy", shown ?: "Too many people are talking right now.", true)
            TalkProtocol.CLOSE_UNAVAILABLE -> TalkProblem(
                lastError?.code ?: "speech_unavailable",
                shown ?: "Voice isn't available on this server right now.",
                lastError?.code != "no_model",
            )
            TalkProtocol.CLOSE_BAD_HELLO -> TalkProblem("bad_hello", "Talk couldn't start on this phone.", true)
            TalkProtocol.CLOSE_NOT_FOUND -> TalkProblem("not_found", "That conversation has gone.", true)
            else -> null
        }
        if (problem != null) {
            finish()
            listener.onEnded(problem)
            return
        }
        if (code == 1000 && !everReady) {
            finish()
            listener.onEnded(null)
            return
        }
        dropped()
    }

    /** The connection went: try to pick the conversation up again. */
    private fun dropped() {
        if (ended || ending) return
        val now = ticker.now()
        if (dropAt == null) {
            dropAt = now
            drops.removeAll { now - it > DROP_WINDOW_MS }
            drops += now
            if (drops.size >= WEAK_DROPS) markWeak()
        }
        val down = now - (dropAt ?: now)
        if (down > (resumeS + 30) * 1000L || (!everReady && down > FIRST_CONNECT_MS)) {
            finish()
            listener.onEnded(
                if (everReady) TalkProblem("offline", "Lost the connection to your server.", false)
                else TalkProblem("offline", "Couldn't reach your server.", true),
            )
            return
        }
        // Too late to resume: start afresh (the phone's conversation is gone with it).
        if (down > resumeS * 1000L) sessionId = null
        listener.onLink(if (everReady) Link.RECONNECTING else Link.CONNECTING)
        val tries = (down / 1000).toInt()
        val wait = minOf(4000L, 500L shl minOf(3, tries))
        cancelRetry?.invoke()
        cancelRetry = ticker.after(wait) { connect() }
    }

    private fun startPings() {
        stopPings()
        fun tick() {
            val s = socket ?: return
            if (!ready) return
            val now = ticker.now()
            // An unanswered ping counts as a slow one.
            pings.entries.removeAll { (_, sent) -> (now - sent > WEAK_RTT_MS * 4).also { late -> if (late) rtt(WEAK_RTT_MS * 4) } }
            pings[now] = now
            s.sendText(JSONObject().put("type", "ping").put("t", now).toString())
            cancelPing = ticker.after(PING_MS) { tick() }
        }
        tick()
    }

    private fun stopPings() {
        cancelPing?.invoke()
        cancelPing = null
        pings.clear()
    }

    private fun rtt(ms: Long) {
        rtts += ms
        while (rtts.size > 3) rtts.removeAt(0)
        if (rtts.size >= 3 && rtts.count { it > WEAK_RTT_MS } >= 2) markWeak()
    }

    private fun markWeak() {
        if (weak) return
        weak = true
        listener.onWeak()
    }

    private fun sendFrame(pcm: ByteArray) {
        val s = socket ?: return
        if (s.sendBytes(TalkProtocol.withSeq(seq, pcm))) seq += 1
    }

    /** 20 ms of microphone. Kept for a moment while the first connection opens,
     *  so you can start talking straight away. Called from the microphone's thread. */
    fun audio(pcm: ByteArray) = ticker.run {
        when {
            ended || ending -> Unit
            ready -> sendFrame(pcm)
            !everReady -> {
                early.addLast(pcm)
                while (early.size > EARLY_FRAMES) early.removeFirst()
            }
        }
    }

    fun send(message: JSONObject) = ticker.run {
        if (ready) socket?.sendText(message.toString())
    }

    /** End it: say bye, and give the server a moment to say it back. */
    fun end() = ticker.run {
        if (ended || ending) return@run
        val s = socket
        if (s != null && ready) {
            ending = true
            s.sendText(JSONObject().put("type", "bye").toString())
            cancelRetry?.invoke()
            ticker.after(BYE_WAIT_MS) {
                if (!ended) {
                    finish()
                    listener.onEnded(null)
                }
            }
        } else {
            finish()
            listener.onEnded(null)
        }
    }

    private fun finish() {
        if (ended) return
        ended = true
        stopPings()
        cancelRetry?.invoke()
        cancelRetry = null
        early.clear()
        val s = socket
        socket = null
        generation++
        runCatching { s?.close(1000) }
    }

    companion object {
        const val PING_MS = 4000L
        const val WEAK_RTT_MS = 800L
        const val WEAK_DROPS = 2
        const val DROP_WINDOW_MS = 120_000L
        /** 3 s of microphone while the socket opens. */
        const val EARLY_FRAMES = 150
        const val BYE_WAIT_MS = 800L
        /** The first connection gets this long before it's given up on. */
        const val FIRST_CONNECT_MS = 8000L
    }
}
