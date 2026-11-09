package org.promptly.sync.talk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The playback buffer: fed without blocking, knows what was heard, stops at once. */
class PlaybackTest {
    /** A track with room for [capacity] samples, played by [play]. */
    private class FakeTrack(val capacity: Int = 2400) : Track {
        var held = 0
        var head = 0L
        var drops = 0
        var gain = 1f
        val received = ArrayList<Byte>()

        override fun write(bytes: ByteArray, offset: Int, size: Int): Int {
            val room = (capacity - held) * 2
            val n = minOf(room, size) and 1.inv()
            for (i in 0 until n) received += bytes[offset + i]
            held += n / 2
            return n
        }

        override fun head(): Long = head

        override fun drop() {
            drops++
            held = 0
        }

        override fun volume(gain: Float) {
            this.gain = gain
        }

        fun play(samples: Int) {
            val n = minOf(samples, held)
            held -= n
            head += n
        }
    }

    private fun frame(fill: Byte = 1) = ByteArray(TalkProtocol.SPEECH_FRAME_BYTES) { fill }

    @Test
    fun feeds_what_fits_and_keeps_the_rest_queued() {
        val track = FakeTrack(capacity = 960) // two frames
        val p = Playback(track)
        repeat(5) { p.push(frame()) }
        assertTrue(p.pump())
        assertEquals(960, track.held)
        assertEquals(100L, p.bufferedMs())
        track.play(480)
        p.pump()
        assertEquals(960, track.held)
        assertEquals(80L, p.bufferedMs())
    }

    @Test
    fun played_ms_counts_from_the_start_of_the_reply() {
        val track = FakeTrack(capacity = 10_000)
        val p = Playback(track)
        // Something from before this reply.
        p.push(frame())
        p.pump()
        track.play(480)
        p.startReply()
        assertNull(p.playedMs())
        repeat(10) { p.push(frame()) }
        p.pump()
        assertEquals(0L, p.playedMs())
        track.play(24_000 / 1000 * 140) // 140 ms
        assertEquals(140L, p.playedMs())
    }

    @Test
    fun stop_drops_the_queue_and_the_track_and_says_what_was_heard() {
        val track = FakeTrack(capacity = 960)
        val p = Playback(track)
        var playing: Boolean? = null
        p.onPlaying = { playing = it }
        p.startReply()
        repeat(20) { p.push(frame()) }
        p.pump()
        assertEquals(true, playing)
        track.play(24 * 40)
        val heard = p.stop()
        assertEquals(40L, heard)
        assertEquals(1, track.drops)
        assertEquals(false, playing)
        assertFalse(p.playing)
        assertEquals(0L, p.bufferedMs())
        // Nothing left to feed.
        val before = track.received.size
        assertFalse(p.pump())
        assertEquals(before, track.received.size)
    }

    @Test
    fun a_new_reply_after_a_stop_counts_afresh() {
        val track = FakeTrack()
        val p = Playback(track)
        p.startReply()
        repeat(3) { p.push(frame()) }
        p.pump()
        track.play(480)
        p.stop()
        p.push(frame(2))
        p.pump()
        track.play(240)
        assertEquals(10L, p.playedMs())
    }

    @Test
    fun runs_dry_and_says_so() {
        val track = FakeTrack()
        val p = Playback(track)
        val seen = ArrayList<Boolean>()
        p.onPlaying = { seen += it }
        p.push(frame())
        p.pump()
        track.play(480)
        assertFalse(p.pump())
        assertEquals(listOf(true, false), seen)
    }

    @Test
    fun duck_and_unduck() {
        val track = FakeTrack()
        val p = Playback(track)
        p.duck()
        assertEquals(Playback.DUCK_GAIN, track.gain)
        assertTrue(p.ducked)
        p.stop()
        assertEquals(1f, track.gain)
        assertFalse(p.ducked)
    }

    @Test
    fun partial_writes_keep_their_place() {
        val track = FakeTrack(capacity = 300) // not a whole frame
        val p = Playback(track)
        p.push(frame(3))
        p.push(frame(4))
        p.pump()
        assertEquals(600, track.received.size)
        track.play(300)
        p.pump()
        track.play(300)
        p.pump()
        track.play(300)
        p.pump()
        track.play(300)
        p.pump()
        assertEquals(1920, track.received.size)
        assertEquals(960, track.received.count { it == 3.toByte() })
        assertEquals(960, track.received.count { it == 4.toByte() })
    }
}
