package org.promptly.sync.talk

/** The car's microphone as a turn sees it: [CarMic] on the car (Android Auto's
 *  `CarAudioRecord`) or the phone's microphone on the dash. */
interface CarMicControl {
    /** Open it, taking the audio exclusively while you talk. False when it can't be
     *  had (no permission, a call, the car said no). */
    fun open(): Boolean
    fun close()
}

/** The short tones either side of your turn: rising as the microphone opens,
 *  falling as it closes. */
interface CarSounds {
    fun opening()
    fun closing()
}

/** One press, one turn (Talk phase 2, WP-T8). The car never listens on its own:
 *
 *  * **Press** the microphone: a rising tone, the microphone opens, you talk. The
 *    server decides you've finished (Smart Turn) and the microphone **closes**
 *    (falling tone) while it thinks and answers.
 *  * **Only after it asked you something** ("Send it?", "Which one?") does the
 *    microphone open again by itself, once the question has been said, for the
 *    server's `listen_s` (6 s in the car), with the same tone and the car's own
 *    recording indicator. Then it closes.
 *  * **Press while it's talking** (or thinking) stops it; the microphone stays shut.
 *  * Press while it's listening: you've finished.
 *  * Nothing said within [QUIET_MS] of a press closes it again, and no turn is ever
 *    longer than [LONGEST_MS].
 *  * The car taking the microphone back (the driver dismissed the indicator: a read
 *    of −1) ends the turn; losing the audio (a phone call) stops everything.
 *
 *  Everything runs on the conversation's [Ticker] thread, like [TalkCore]. */
class CarTurn(
    private val ticker: Ticker,
    private val core: TalkCore,
    private val microphone: CarMicControl,
    private val sounds: CarSounds,
    /** Something to show and say briefly when the microphone can't open. */
    private val notice: (String) -> Unit = {},
) : TurnWatcher {
    enum class Mic { CLOSED, LISTENING, ANSWERING }

    var mic: Mic = Mic.CLOSED
        private set

    /** Told whenever [mic] changes (the car screen's microphone icon). */
    var onMic: ((Mic) -> Unit)? = null

    private var serverState = "listening"
    private var speaking = false
    private var words = false
    private var listenFor = 0
    private var cancelQuiet: (() -> Unit)? = null
    private var cancelLongest: (() -> Unit)? = null
    private var ended = false

    /** The microphone button on the car's screen (or the driving screen's pill). */
    fun press() = ticker.run {
        if (ended) return@run
        when {
            mic != Mic.CLOSED -> close(flush = words)
            busy() -> {
                // Stop it talking. Whatever it was about to ask is dropped with it.
                listenFor = 0
                core.interrupt()
            }
            else -> open(Mic.LISTENING, QUIET_MS, LONGEST_MS)
        }
    }

    private fun busy(): Boolean = speaking || serverState == "speaking" || serverState == "thinking"

    private fun open(kind: Mic, quietMs: Long, longestMs: Long) {
        if (!microphone.open()) {
            notice(NO_MIC)
            return
        }
        sounds.opening()
        words = false
        set(kind)
        core.listen(true)
        cancelQuiet = ticker.after(quietMs) { if (!words) close(flush = false) }
        cancelLongest = ticker.after(longestMs) { close(flush = true) }
    }

    private fun close(flush: Boolean, tone: Boolean = true) {
        if (mic == Mic.CLOSED) return
        cancelQuiet?.invoke()
        cancelLongest?.invoke()
        cancelQuiet = null
        cancelLongest = null
        runCatching { microphone.close() }
        set(Mic.CLOSED)
        core.listen(false, flush = flush)
        if (tone) sounds.closing()
    }

    private fun set(m: Mic) {
        if (mic == m) return
        mic = m
        onMic?.invoke(m)
    }

    /** It asked, the question has been said, and nothing's playing: open for the answer. */
    private fun maybeReopen() {
        if (listenFor <= 0 || mic != Mic.CLOSED || speaking || serverState != "listening" || ended) return
        val seconds = listenFor
        listenFor = 0
        // The window is for starting your answer; once you're talking it can finish.
        open(Mic.ANSWERING, seconds * 1000L, seconds * 1000L + ANSWER_EXTRA_MS)
    }

    // ------------------------------------------------------------ the car's side
    /** The car's microphone read −1: the driver dismissed the recording indicator. */
    fun micGone() = ticker.run { close(flush = words) }

    /** Something else took the audio (a phone call): stop listening and talking. */
    fun audioLost() = ticker.run {
        listenFor = 0
        close(flush = false, tone = false)
        if (busy()) core.interrupt()
    }

    // ------------------------------------------------------------ TurnWatcher
    override fun state(state: String) {
        serverState = state
        // The server heard the end of your turn: the microphone closes while it works.
        if ((state == "thinking" || state == "speaking") && mic != Mic.CLOSED) close(flush = false)
        if (state == "listening") maybeReopen()
    }

    override fun words() {
        if (mic == Mic.CLOSED) return
        words = true
        cancelQuiet?.invoke()
        cancelQuiet = null
    }

    override fun asked(listenS: Int) {
        listenFor = listenS.coerceIn(0, MAX_LISTEN_S)
        maybeReopen()
    }

    override fun askDone() {
        listenFor = 0
    }

    override fun playing(now: Boolean) {
        speaking = now
        if (!now) maybeReopen()
    }

    override fun finished() {
        ended = true
        listenFor = 0
        close(flush = false, tone = false)
    }

    companion object {
        /** Pressed and said nothing: closed again after this. */
        const val QUIET_MS = 8_000L
        /** No turn is longer than this. */
        const val LONGEST_MS = 30_000L
        /** Answering a question: room to finish once you've started. */
        const val ANSWER_EXTRA_MS = 6_000L
        const val MAX_LISTEN_S = 10
        const val NO_MIC = "Can't use the microphone right now"
    }
}
