package org.promptly.sync.assistant

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.promptly.sync.assistant.WakeRules.Follow.Verdict
import org.promptly.sync.assistant.WakeRules.Hold
import java.io.File

class WakeRulesTest {
    private val free = WakeRules.AppFacts(micAllowed = true, assistant = true, trip = false, carScreen = false, promptlyCall = false, talk = false)
    private val clear = WakeRules.OwnFacts(car = false, call = false, otherRecording = false)

    // ------------------------------------------------------------ when it listens
    @Test
    fun `it listens only when nothing is in the way`() {
        assertNull(WakeRules.appHold(free))
        assertNull(WakeRules.hold(null, clear))
    }

    @Test
    fun `a trip, a car, a call or a conversation each make it let go`() {
        assertEquals(Hold.DRIVING, WakeRules.appHold(free.copy(trip = true)))
        assertEquals(Hold.CAR, WakeRules.appHold(free.copy(carScreen = true)))
        assertEquals(Hold.CALL, WakeRules.appHold(free.copy(promptlyCall = true)))
        assertEquals(Hold.TALKING, WakeRules.appHold(free.copy(talk = true)))
    }

    @Test
    fun `no microphone or no assistant role comes before everything else`() {
        assertEquals(Hold.NO_MIC, WakeRules.appHold(free.copy(micAllowed = false, trip = true)))
        assertEquals(Hold.NOT_ASSISTANT, WakeRules.appHold(free.copy(assistant = false, talk = true)))
    }

    @Test
    fun `driving on the car screen says driving`() {
        assertEquals(Hold.DRIVING, WakeRules.appHold(free.copy(trip = true, carScreen = true)))
    }

    @Test
    fun `the listening process backs off by itself for a car, a call and another recorder`() {
        assertEquals(Hold.CAR, WakeRules.ownHold(clear.copy(car = true)))
        assertEquals(Hold.CALL, WakeRules.ownHold(clear.copy(call = true)))
        assertEquals(Hold.MIC_BUSY, WakeRules.ownHold(clear.copy(otherRecording = true)))
        // A car wins over the rest: it's the reason you'd want to read.
        assertEquals(Hold.CAR, WakeRules.ownHold(WakeRules.OwnFacts(car = true, call = true, otherRecording = true)))
    }

    @Test
    fun `the reason from the app is the one shown, but either is enough`() {
        assertEquals(Hold.DRIVING, WakeRules.hold(Hold.DRIVING, clear.copy(otherRecording = true)))
        assertEquals(Hold.MIC_BUSY, WakeRules.hold(null, clear.copy(otherRecording = true)))
    }

    @Test
    fun `every kind of call counts, normal sound does not`() {
        assertFalse(WakeRules.callMode(0))   // MODE_NORMAL
        assertTrue(WakeRules.callMode(1))    // ringing
        assertTrue(WakeRules.callMode(2))    // a phone call
        assertTrue(WakeRules.callMode(3))    // a voice chat in any app
        assertTrue(WakeRules.callMode(4))    // call screening
        assertFalse(WakeRules.callMode(-1))  // MODE_INVALID
        assertFalse(WakeRules.callMode(-2))  // MODE_CURRENT
    }

    @Test
    fun `every reason has words a person can read`() {
        Hold.entries.forEach { assertTrue(it.name, it.says.length > 10 && !it.says.contains('_')) }
    }

    // ------------------------------------------------------------ after the phrase
    private fun feed(follow: WakeRules.Follow, rms: Double, ms: Int): Verdict {
        var last = Verdict.WAITING
        repeat(ms / 20) { last = follow.feed(rms) }
        return last
    }

    @Test
    fun `speech after the phrase is heard within a fraction of a second`() {
        val follow = WakeRules.Follow(floor = 200.0)
        assertEquals(Verdict.WAITING, feed(follow, 150.0, 400))
        assertEquals(Verdict.WAITING, feed(follow, 3000.0, 100))
        assertEquals(Verdict.SPEECH, feed(follow, 3000.0, 20))
    }

    @Test
    fun `a quiet room closes it after six seconds, and it stays closed`() {
        val follow = WakeRules.Follow(floor = 200.0)
        assertEquals(Verdict.WAITING, feed(follow, 180.0, 5980))
        assertEquals(Verdict.QUIET, feed(follow, 180.0, 20))
        assertEquals(Verdict.QUIET, feed(follow, 9000.0, 500))
    }

    @Test
    fun `the chime at the start is not you`() {
        val follow = WakeRules.Follow(floor = 200.0)
        assertEquals(Verdict.WAITING, feed(follow, 8000.0, 260))
        assertEquals(Verdict.WAITING, feed(follow, 100.0, 1000))
    }

    @Test
    fun `music that was already playing does not count as speech`() {
        // The room was at 2000 before the phrase: music carrying on at that level is not you.
        val follow = WakeRules.Follow(floor = 2000.0)
        assertEquals(Verdict.WAITING, feed(follow, 2600.0, 3000))
        // A voice well over it is.
        assertEquals(Verdict.SPEECH, feed(follow, 6000.0, 200))
    }

    @Test
    fun `a click or a bump is not speech`() {
        val follow = WakeRules.Follow(floor = 200.0)
        feed(follow, 100.0, 400)
        repeat(20) {
            assertEquals(Verdict.WAITING, feed(follow, 5000.0, 40))
            assertEquals(Verdict.WAITING, feed(follow, 100.0, 200))
        }
    }

    @Test
    fun `in a silent room quiet talking still counts, a hum does not`() {
        assertEquals(Verdict.SPEECH, feed(WakeRules.Follow(floor = 20.0), 700.0, 600))
        assertEquals(Verdict.QUIET, feed(WakeRules.Follow(floor = 20.0), 300.0, 6000))
    }

    // ------------------------------------------------------------ when it goes wrong
    @Test
    fun `three faults in ten minutes switch it off, spread out they do not`() {
        val close = WakeRules.Faults()
        assertFalse(close.note(0))
        assertFalse(close.note(60_000))
        assertTrue(close.note(120_000))

        val apart = WakeRules.Faults()
        assertFalse(apart.note(0))
        assertFalse(apart.note(6 * 60_000L))
        assertFalse(apart.note(12 * 60_000L))
        assertFalse(apart.note(30 * 60_000L))
    }

    @Test
    fun `faults are remembered across a restart of the app`() {
        val before = WakeRules.Faults()
        before.note(1_000)
        before.note(2_000)
        val after = WakeRules.Faults().apply { restore(before.saved()) }
        assertTrue(after.note(3_000))
    }

    @Test
    fun `each try waits longer than the last, up to a limit`() {
        val f = WakeRules.Faults()
        assertEquals(5_000L, f.backoffMs(1))
        assertEquals(10_000L, f.backoffMs(2))
        assertEquals(80_000L, f.backoffMs(5))
        assertEquals(80_000L, f.backoffMs(50))
    }

    // ------------------------------------------------------------ the phrase
    private fun asset(name: String): File =
        listOf("src/main/assets/kws/$name", "app/src/main/assets/kws/$name").map(::File).first { it.exists() }

    @Test
    fun `the phrase file holds only Hey Promptly, as the rules spell it`() {
        val lines = asset("keywords.txt").readLines().filter { it.isNotBlank() }
        assertEquals(listOf(WakeRules.keywordLine()), lines)
        assertTrue(lines.single().startsWith("▁HE Y "))
    }

    @Test
    fun `every piece of the phrase is one the model knows`() {
        val tokens = asset("tokens.txt").readLines().map { it.substringBeforeLast(' ') }.toSet()
        assertTrue(WakeRules.keywordFits(tokens))
        assertFalse(WakeRules.keywordFits(tokens - "LY"))
    }
}
