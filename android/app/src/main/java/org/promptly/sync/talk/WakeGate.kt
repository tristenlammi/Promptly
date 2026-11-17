package org.promptly.sync.talk

import org.promptly.sync.assistant.WakeRules
import java.util.concurrent.LinkedBlockingDeque
import kotlin.concurrent.thread
import kotlin.math.sqrt

/** After "Hey Promptly": wait, on the phone only, to hear whether you go on to say
 *  something. Until you do, nothing is sent to your server, the music isn't paused
 *  and the phone's audio isn't touched; if you don't, it closes without a sound.
 *
 *  What you said while it waited isn't lost: the last half second before you spoke,
 *  and everything since, is kept and handed to Talk first ([then]), so "Hey
 *  Promptly, turn off the kitchen lights" in one breath arrives whole.
 *
 *  It reads from any [MicSource] and has no Android in it, so it's tested as it is. */
class WakeGate(
    private val source: MicSource,
    private val follow: WakeRules.Follow,
    /** However slowly the microphone delivers, never wait longer than this by the clock. */
    private val mostMs: Long = WakeRules.Follow.WAIT_MS + 2_000,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val kept = LinkedBlockingDeque<ShortArray>()
    @Volatile private var pumping = false
    @Volatile private var closed = false
    private var pump: Thread? = null

    /** Blocks until speech (true), or quiet for long enough, or [alive] says stop (false). */
    fun waitForSpeech(alive: () -> Boolean): Boolean {
        val frame = ShortArray(FRAME)
        val ring = ArrayDeque<ShortArray>()
        val giveUpAt = clock() + mostMs
        while (alive() && !closed) {
            if (clock() >= giveUpAt) return false
            val n = runCatching { source.read(frame) }.getOrDefault(-1)
            if (n <= 0) return false
            ring.addLast(frame.copyOf(n))
            while (ring.size > PREROLL_FRAMES) ring.removeFirst()
            when (follow.feed(rms(frame, n))) {
                WakeRules.Follow.Verdict.SPEECH -> {
                    kept.addAll(ring)
                    keepListening()
                    return true
                }
                WakeRules.Follow.Verdict.QUIET -> return false
                WakeRules.Follow.Verdict.WAITING -> Unit
            }
        }
        return false
    }

    /** Keep what you're saying while Talk gets ready (a few hundred milliseconds). */
    private fun keepListening() {
        pumping = true
        pump = thread(name = "wake-gate") {
            val frame = ShortArray(FRAME)
            while (pumping && !closed) {
                val n = runCatching { source.read(frame) }.getOrDefault(-1)
                if (n <= 0) break
                kept.addLast(frame.copyOf(n))
                // Never more than twenty seconds of it, whatever happens.
                while (kept.size > MOST_FRAMES) kept.pollFirst()
            }
        }
    }

    /** Talk's microphone from here: what was kept first, then [inner] (the phone's
     *  own Talk microphone, already open). With [inner] null this carries on with
     *  the same source (a debug build's test file). */
    fun then(inner: MicSource?): MicSource {
        // The other microphone is open: this one has heard enough.
        pumping = false
        runCatching { pump?.join(200) }
        if (inner != null) runCatching { source.close() }
        return object : MicSource {
            override fun read(into: ShortArray): Int {
                val next = kept.pollFirst()
                if (next != null) {
                    val n = minOf(next.size, into.size)
                    next.copyInto(into, 0, 0, n)
                    return n
                }
                return (inner ?: source).read(into)
            }

            override fun close() {
                closed = true
                runCatching { inner?.close() }
                runCatching { source.close() }
            }
        }
    }

    fun close() {
        closed = true
        pumping = false
        runCatching { source.close() }
    }

    companion object {
        /** 20 ms at 16 kHz, the same as Talk's own frames. */
        const val FRAME = 320
        /** Half a second before you were heard to speak. */
        const val PREROLL_FRAMES = 25
        const val MOST_FRAMES = 1000

        fun rms(frame: ShortArray, n: Int): Double {
            if (n <= 0) return 0.0
            var sum = 0.0
            for (i in 0 until n) sum += frame[i].toDouble() * frame[i]
            return sqrt(sum / n)
        }
    }
}
