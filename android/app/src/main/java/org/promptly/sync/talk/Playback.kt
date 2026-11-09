package org.promptly.sync.talk

/** The bit of an `AudioTrack` playback needs, so the logic runs in a plain test. */
interface Track {
    /** Non-blocking: how many bytes it took (0 when its buffer is full). */
    fun write(bytes: ByteArray, offset: Int, size: Int): Int
    /** Frames (samples) played since the track started or was last flushed. */
    fun head(): Long
    /** Throw away what it holds, now. */
    fun drop()
    fun volume(gain: Float)
}

/** Speech from the server, played as it arrives. The server sends it at playing
 *  pace, a little ahead; this keeps the queue, feeds the track without blocking,
 *  knows how much of the current reply has actually been heard (for an interrupt's
 *  `played_ms`), and stops within a frame: what's queued and what the track holds
 *  are both dropped. Thread-safe: the socket pushes, a writer thread [pump]s, the
 *  screen and the microphone stop and duck. */
class Playback(private val track: Track, private val sampleRate: Int = TalkProtocol.SPEECH_RATE) {
    private val lock = Any()
    private val queue = ArrayDeque<ByteArray>()
    private var current: ByteArray? = null
    private var offset = 0
    /** Samples handed to the track since it was last emptied. */
    private var written = 0L
    /** The track's head when the current reply's first sound went in. */
    private var replyStart: Long? = null
    private var newReply = true
    private var playingNow = false
    var ducked = false
        private set

    /** Told when sound starts and when it runs out. Called on the writer thread. */
    var onPlaying: ((Boolean) -> Unit)? = null

    fun push(pcm: ByteArray) {
        if (pcm.isEmpty()) return
        synchronized(lock) { queue.addLast(pcm) }
    }

    /** The next frames pushed are a new reply (for [playedMs]). */
    fun startReply() = synchronized(lock) {
        newReply = true
        replyStart = null
    }

    /** Feed the track what it has room for. Returns true when there was anything
     *  to feed, so the writer can sleep when it's idle. */
    fun pump(): Boolean {
        var changed: Boolean? = null
        val busy: Boolean
        synchronized(lock) {
            while (true) {
                val frame = current ?: queue.removeFirstOrNull()?.also {
                    current = it
                    offset = 0
                    if (newReply) {
                        newReply = false
                        replyStart = track.head()
                    }
                } ?: break
                val took = track.write(frame, offset, frame.size - offset)
                if (took <= 0) break
                offset += took
                written += took / 2
                if (offset >= frame.size) current = null
            }
            val pending = written - track.head()
            val playing = pending > 0 || current != null
            if (playing != playingNow) {
                playingNow = playing
                changed = playing
            }
            busy = current != null || queue.isNotEmpty() || pending > 0
        }
        changed?.let { onPlaying?.invoke(it) }
        return busy
    }

    val playing: Boolean get() = synchronized(lock) { playingNow || current != null || queue.isNotEmpty() }

    /** How much of the current reply has been heard, in ms (null before any of it). */
    fun playedMs(): Long? = synchronized(lock) {
        val start = replyStart ?: return null
        maxOf(0L, track.head() - start) * 1000 / sampleRate
    }

    /** What's queued or in the track and not heard yet, in ms. */
    fun bufferedMs(): Long = synchronized(lock) {
        val queued = queue.sumOf { it.size.toLong() } + ((current?.size ?: 0) - offset)
        (queued / 2 + maxOf(0L, written - track.head())) * 1000 / sampleRate
    }

    /** Stop now: everything not yet heard is gone. Returns how much of the reply
     *  was heard, in ms. */
    fun stop(): Long? {
        val heard: Long?
        var wasPlaying = false
        synchronized(lock) {
            heard = playedMs()
            queue.clear()
            current = null
            offset = 0
            track.drop()
            written = track.head()
            replyStart = null
            newReply = true
            wasPlaying = playingNow
            playingNow = false
        }
        if (ducked) unduck()
        if (wasPlaying) onPlaying?.invoke(false)
        return heard
    }

    /** You started talking over it: quieter at once, while the server decides. */
    fun duck() {
        ducked = true
        track.volume(DUCK_GAIN)
    }

    fun unduck() {
        ducked = false
        track.volume(1f)
    }

    companion object {
        const val DUCK_GAIN = 0.3f
    }
}
