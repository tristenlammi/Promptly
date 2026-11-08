package org.promptly.sync.maps

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaDataSource
import android.media.MediaPlayer
import android.util.Log
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/** The assistant's answers, in the voice you chose in your Promptly account. A
 *  sentence at a time, so it starts talking quickly. If your server can't say it,
 *  the phone's own voice takes over: a robotic answer beats none. Directions on a
 *  trip stay with the phone's voice, because they have to work without signal. */
object SpokenAnswer {
    private const val TAG = "PromptlyVoice"
    private const val LONGEST_S = 180L

    private val turn = AtomicInteger()
    private val whenDone = AtomicReference<(() -> Unit)?>(null)
    private val lock = Any()
    private var player: MediaPlayer? = null
    private var finished: CountDownLatch? = null

    /** An answer is being said right now (for the crash breadcrumb). */
    @Volatile var speaking = false
        private set

    fun say(context: Context, words: String, done: (() -> Unit)? = null) {
        stop()
        val mine = turn.get()
        whenDone.set(done)
        val app = context.applicationContext
        thread(name = "spoken-answer") {
            val release = Voice.holdFocus(app)
            val fetching = Executors.newSingleThreadExecutor()
            speaking = true
            Voice.setState(Voice.state.value)
            try {
                val parts = sentences(words)
                var next = fetching.submit<ByteArray> { Maps.speech(app, parts[0]) }
                for (i in parts.indices) {
                    val clip = runCatching { next.get() }.onFailure { Log.w(TAG, "No voice from the server: ${it.cause?.javaClass?.simpleName}") }.getOrNull()
                    if (turn.get() != mine) return@thread
                    // The next one is on its way while this one plays.
                    if (i + 1 < parts.size) next = fetching.submit<ByteArray> { Maps.speech(app, parts[i + 1]) }
                    if (clip == null || !play(clip, mine)) {
                        if (turn.get() == mine) Nav.say(parts.drop(i).joinToString(" "), whenDone.getAndSet(null))
                        return@thread
                    }
                    if (turn.get() != mine) return@thread
                }
                whenDone.getAndSet(null)?.invoke()
            } finally {
                fetching.shutdownNow()
                release()
                if (turn.get() == mine) {
                    speaking = false
                    Voice.quiet()
                }
            }
        }
    }

    /** You've moved on: stop now, rather than when the next sentence turns up. */
    fun stop() {
        turn.incrementAndGet()
        if (speaking) {
            speaking = false
            Voice.quiet()
        }
        synchronized(lock) {
            runCatching { player?.stop() }
            player?.release()
            player = null
            finished?.countDown()
            finished = null
        }
        whenDone.getAndSet(null)?.invoke()
    }

    /** Blocks until it's been said. False if this phone couldn't play it. */
    private fun play(clip: ByteArray, mine: Int): Boolean {
        val latch = CountDownLatch(1)
        val media = MediaPlayer()
        try {
            media.setAudioAttributes(
                AudioAttributes.Builder().setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).setUsage(AudioAttributes.USAGE_ASSISTANT).build(),
            )
            // From memory: what was said to you is never written to the phone's storage.
            media.setDataSource(Bytes(clip))
            media.setOnCompletionListener { latch.countDown() }
            media.setOnErrorListener { _, _, _ -> latch.countDown(); true }
            media.prepare()
            synchronized(lock) {
                if (turn.get() != mine) {
                    media.release()
                    return true
                }
                player = media
                finished = latch
                media.start()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Couldn't play the server's voice", e)
            synchronized(lock) {
                if (player === media) player = null
            }
            media.release()
            return false
        }
        latch.await(LONGEST_S, TimeUnit.SECONDS)
        synchronized(lock) {
            if (player === media) {
                media.release()
                player = null
                finished = null
            }
        }
        return true
    }

    /** Whole sentences, with very short ones kept with the next so it doesn't sound choppy. */
    internal fun sentences(words: String): List<String> {
        val out = mutableListOf<String>()
        var building = ""
        for (piece in words.trim().split(Regex("(?<=[.!?])\\s+"))) {
            building = if (building.isEmpty()) piece else "$building $piece"
            if (building.length >= 40) {
                out += building
                building = ""
            }
        }
        if (building.isNotEmpty()) out += building
        return out.flatMap { it.chunked(1500) }.ifEmpty { listOf(words) }
    }

    private class Bytes(private val data: ByteArray) : MediaDataSource() {
        override fun getSize(): Long = data.size.toLong()

        override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
            if (position >= data.size) return -1
            val count = minOf(size.toLong(), data.size - position).toInt()
            System.arraycopy(data, position.toInt(), buffer, offset, count)
            return count
        }

        override fun close() = Unit
    }
}
