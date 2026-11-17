package org.promptly.sync.talk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.promptly.sync.assistant.WakeRules

class WakeGateTest {
    /** A microphone that plays a script: each entry is one 20 ms frame filled with that
     *  value; after the script it carries on with [then] (or is gone, when null). */
    private class Script(private val frames: List<Short>, private val then: Short? = null) : MicSource {
        @Volatile var at = 0
        @Volatile var closed = false

        @Synchronized
        override fun read(into: ShortArray): Int {
            if (closed) return -1
            val v = frames.getOrNull(at) ?: then ?: return -1
            at++
            if (at > frames.size) Thread.sleep(2)
            into.fill(v)
            return into.size
        }

        override fun close() {
            closed = true
        }
    }

    private fun frames(value: Int, ms: Int) = List(ms / 20) { value.toShort() }

    @Test
    fun `nobody speaks, so it gives up and nothing is kept`() {
        val mic = Script(frames(100, 7000))
        val gate = WakeGate(mic, WakeRules.Follow(200.0))
        assertFalse(gate.waitForSpeech { true })
        // It read six seconds and no more.
        assertEquals(300, mic.at)
        gate.close()
        assertTrue(mic.closed)
    }

    @Test
    fun `closing the sheet stops the wait at once`() {
        val mic = Script(frames(100, 7000))
        val gate = WakeGate(mic, WakeRules.Follow(200.0))
        assertFalse(gate.waitForSpeech { mic.at < 10 })
        assertTrue(mic.at < 20)
    }

    @Test
    fun `what you said while it waited reaches Talk first, in order, then the phone microphone`() {
        // Quiet, then you speak (frames numbered so the order shows), then it runs out.
        val quiet = frames(100, 1000)
        val speech = List(40) { (4000 + it).toShort() }
        val mic = Script(quiet + speech)
        val gate = WakeGate(mic, WakeRules.Follow(200.0))
        assertTrue(gate.waitForSpeech { true })
        Thread.sleep(150)
        val phone = Script(emptyList(), then = 7)
        val source = gate.then(phone)
        assertTrue(mic.closed)

        val into = ShortArray(WakeGate.FRAME)
        val got = ArrayList<Short>()
        while (true) {
            source.read(into)
            if (into[0] == 7.toShort()) break
            got += into[0]
        }
        // Half a second of the room before you spoke, then every frame of speech, none missing.
        assertEquals(speech, got.filter { it >= 4000 })
        assertTrue(got.takeWhile { it < 4000 }.size in 15..25)
        // From here it's the phone's microphone.
        assertEquals(WakeGate.FRAME, source.read(into))
        assertEquals(7.toShort(), into[0])
        source.close()
        assertTrue(phone.closed)
    }

    @Test
    fun `a test file carries on as the microphone when there is no other`() {
        val mic = Script(frames(100, 600) + List(10) { 5000.toShort() }, then = 9)
        val gate = WakeGate(mic, WakeRules.Follow(200.0))
        assertTrue(gate.waitForSpeech { true })
        val source = gate.then(null)
        assertFalse(mic.closed)
        val into = ShortArray(WakeGate.FRAME)
        var sawLive = false
        repeat(200) {
            source.read(into)
            if (into[0] == 9.toShort()) sawLive = true
        }
        assertTrue(sawLive)
        source.close()
        assertTrue(mic.closed)
    }

    @Test
    fun `a slow microphone cannot keep it waiting past the clock`() {
        var now = 0L
        val mic = Script(frames(100, 7000))
        val gate = WakeGate(mic, WakeRules.Follow(200.0), mostMs = 1000, clock = { now.also { now += 100 } })
        assertFalse(gate.waitForSpeech { true })
        assertTrue(mic.at <= 11)
    }

    @Test
    fun `the level is the usual root mean square`() {
        assertEquals(0.0, WakeGate.rms(ShortArray(4), 0), 0.0)
        assertEquals(100.0, WakeGate.rms(ShortArray(320) { 100 }, 320), 0.001)
    }
}
