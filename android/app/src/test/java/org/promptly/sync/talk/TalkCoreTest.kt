package org.promptly.sync.talk

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A conversation on the phone, minus the hardware: the yes card, device actions,
 *  interrupts, the instant duck, yielding to a call, the headset, the breadcrumb. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TalkCoreTest {
    private lateinit var ticker: FakeTicker
    private lateinit var opener: FakeOpener
    private lateinit var speaker: FakeSpeaker
    private lateinit var core: TalkCore
    private val carried = ArrayList<JSONObject>()
    private var actionProblem: String? = null
    private val trail = ArrayList<String>()
    private var finished = 0

    private val socket: FakeSocket get() = opener.last
    private val ui: TalkUi get() = core.ui.value

    @Before
    fun setUp() {
        ticker = FakeTicker()
        opener = FakeOpener()
        speaker = FakeSpeaker()
        core = TalkCore(
            ticker, speaker,
            actions = { carried += it; actionProblem },
            trail = { state, _ -> trail += state },
            opener = opener,
            hello = { TalkProtocol.hello(TalkProtocol.PHONE_CAPS, null, null) },
        )
        core.onFinished = { finished++ }
        core.start()
        socket.listener.onOpen()
        socket.ready()
    }

    private fun state(s: String, muted: Boolean = false) = socket.say("type" to "state", "state" to s, "muted" to muted)

    @Test
    fun starts_live_and_leaves_a_breadcrumb_at_each_step() {
        assertEquals(Phase.LIVE, ui.phase)
        state("thinking")
        state("speaking")
        state("listening")
        val steps = trail.filterIndexed { i, s -> i == 0 || trail[i - 1] != s }
        assertEquals(listOf("starting", "listening", "thinking", "speaking", "listening"), steps)
    }

    @Test
    fun captions_follow_partials_heard_reply_and_spoken() {
        socket.say("type" to "partial", "text" to "what's on")
        assertEquals("what's on", ui.exchanges.single().you)
        assertFalse(ui.exchanges.single().youFinal)
        socket.say("type" to "heard", "text" to "What's on today?", "message_id" to null)
        assertTrue(ui.exchanges.single().youFinal)
        assertEquals(1, speaker.replies)
        socket.say("type" to "reply", "text" to "You've got three things.")
        socket.say("type" to "spoken", "chars" to 10)
        assertEquals("You've got three things.", ui.exchanges.single().reply)
        assertEquals(10, ui.exchanges.single().spoken)
    }

    @Test
    fun speech_frames_reach_the_speaker() {
        socket.listener.onBytes(TalkProtocol.withSeq(0, ByteArray(960)))
        assertEquals(1, speaker.pushed.size)
    }

    @Test
    fun the_yes_card_by_button() {
        socket.say("type" to "ask", "question" to "Set an alarm for 6:30 tomorrow?", "approval_id" to "ap1", "expires_in" to 20)
        val ask = ui.ask!!
        assertEquals("Set an alarm for 6:30 tomorrow?", ask.question)
        core.confirm(true)
        val sent = socket.sent("confirm").single()
        assertEquals("yes", sent.getString("answer"))
        assertNull(ui.ask)
        assertEquals("Yes", ui.exchanges.last().you)
        // Answered: the timer that would have hidden it does nothing now.
        ticker.advance(30_000)
        assertNull(ui.ask)
        // A second tap has nothing to answer.
        core.confirm(false)
        assertEquals(1, socket.sent("confirm").size)
    }

    @Test
    fun the_yes_card_said_out_loud_goes_when_the_server_says_it_was_decided() {
        socket.say("type" to "ask", "question" to "Add lunch with Sam on Friday?", "approval_id" to "ap2", "expires_in" to 20)
        // The spoken yes is just talking: the server hears it.
        core.mic(pcm(4000), 0.12)
        assertEquals(1, socket.frames.size)
        socket.say("type" to "ask_done", "approval_id" to "ap2", "outcome" to "approved")
        assertNull(ui.ask)
        assertTrue(socket.sent("confirm").isEmpty())
    }

    @Test
    fun the_yes_card_runs_out() {
        socket.say("type" to "ask", "question" to "Text Sam?", "approval_id" to "ap3", "expires_in" to 20)
        ticker.advance(22_000)
        assertNotNull(ui.ask)
        ticker.advance(1_500)
        assertNull(ui.ask)
    }

    @Test
    fun device_actions_go_to_the_phone() {
        socket.say("type" to "action", "action" to JSONObject().put("type", "set_timer").put("seconds", 600))
        assertEquals("set_timer", carried.single().getString("type"))
        assertEquals(600, carried.single().getInt("seconds"))
        assertNull(ui.notice)
        actionProblem = "There's no clock app on this phone that can set a timer."
        socket.say("type" to "action", "action" to JSONObject().put("type", "set_timer").put("seconds", 60))
        assertEquals(actionProblem, ui.notice)
    }

    @Test
    fun stop_audio_stops_the_speaker_and_marks_the_reply_cut() {
        socket.say("type" to "heard", "text" to "Tell me a story")
        socket.say("type" to "reply", "text" to "Once upon a time")
        socket.say("type" to "stop_audio")
        assertEquals(1, speaker.stops)
        assertTrue(ui.exchanges.last().interrupted)
    }

    @Test
    fun interrupt_says_how_much_was_heard() {
        speaker.playing = true
        speaker.played = 1234
        core.interrupt()
        assertEquals(1234, socket.sent("interrupt").single().getLong("played_ms"))
        assertEquals(1, speaker.stops)
    }

    @Test
    fun stop_interrupts_while_speaking_and_ends_otherwise() {
        state("speaking")
        speaker.playing = true
        core.stop()
        assertEquals(1, socket.sent("interrupt").size)
        state("listening")
        core.stop()
        assertEquals(1, socket.sent("bye").size)
    }

    @Test
    fun talking_over_it_ducks_at_once_and_unducks_when_you_stop() {
        state("speaking")
        speaker.playing = true
        core.mic(pcm(), 0.1)
        core.mic(pcm(), 0.1)
        assertFalse(speaker.ducked)
        core.mic(pcm(), 0.1)
        assertTrue(speaker.ducked)
        ticker.advance(TalkCore.UNDUCK_MS + 20)
        core.mic(pcm(), 0.0)
        assertFalse(speaker.ducked)
    }

    @Test
    fun tap_to_interrupt_does_not_duck() {
        socket.listener.onText(
            JSONObject().put("type", "ready").put("session_id", "s1").put("turn_mode", "hands_free").put("interrupt_mode", "tap").toString(),
        )
        speaker.playing = true
        repeat(5) { core.mic(pcm(), 0.1) }
        assertFalse(speaker.ducked)
    }

    @Test
    fun mute_stops_sending_the_microphone() {
        core.mute()
        assertEquals(1, socket.sent("mute").size)
        core.mic(pcm(), 0.1)
        assertTrue(socket.frames.isEmpty())
        core.toggleMute()
        assertEquals(1, socket.sent("unmute").size)
        core.mic(pcm(), 0.1)
        assertEquals(1, socket.frames.size)
    }

    @Test
    fun a_call_takes_the_audio_and_it_waits_quietly() {
        state("speaking")
        speaker.playing = true
        core.yieldAudio()
        assertTrue(ui.paused)
        assertEquals(1, socket.sent("interrupt").size)
        assertEquals(1, socket.sent("mute").size)
        assertTrue(trail.last() == "paused")
        core.mic(pcm(), 0.2)
        assertTrue(socket.frames.isEmpty())
        // The server's muted state doesn't turn the pause into a mute.
        state("muted", muted = true)
        assertFalse(ui.muted)
        core.resume()
        assertFalse(ui.paused)
        assertEquals(1, socket.sent("unmute").size)
        core.mic(pcm(), 0.2)
        assertEquals(1, socket.frames.size)
    }

    @Test
    fun already_muted_stays_muted_after_a_call() {
        core.mute()
        core.yieldAudio()
        core.resume()
        assertTrue(socket.sent("unmute").isEmpty())
        assertTrue(ui.muted)
    }

    @Test
    fun headset_press_interrupts_or_mutes() {
        state("speaking")
        speaker.playing = true
        core.headset()
        assertEquals(1, socket.sent("interrupt").size)
        state("listening")
        core.headset()
        assertEquals(1, socket.sent("mute").size)
        core.headset()
        assertEquals(1, socket.sent("unmute").size)
    }

    @Test
    fun type_instead_and_the_example_chips() {
        core.text("Add milk to my shopping list")
        assertEquals("Add milk to my shopping list", socket.sent("text").single().getString("words"))
        assertTrue(ui.exchanges.last().typed)
        // The server says it back as heard: still one exchange.
        socket.say("type" to "heard", "text" to "Add milk to my shopping list", "message_id" to null)
        assertEquals(1, ui.exchanges.size)
        socket.say("type" to "reply", "text" to "Added.")
        assertEquals("Added.", ui.exchanges.single().reply)
    }

    @Test
    fun goodbye_plays_the_end_tone_and_finishes() {
        socket.say("type" to "bye", "reason" to "goodbye")
        assertEquals(Phase.ENDED, ui.phase)
        assertEquals("goodbye", ui.endReason)
        assertEquals(1, speaker.tones)
        assertEquals(1, finished)
        assertEquals("ended", trail.last())
        // The microphone goes nowhere now.
        core.mic(pcm(), 0.2)
        assertTrue(socket.frames.isEmpty())
    }

    @Test
    fun a_drop_says_reconnecting_and_the_breadcrumb_says_so() {
        socket.listener.onFailure()
        assertEquals(Phase.RECONNECTING, ui.phase)
        assertEquals("reconnecting", trail.last())
        ticker.advance(500)
        socket.listener.onOpen()
        socket.ready(resumed = true)
        assertEquals(Phase.LIVE, ui.phase)
        assertNull(ui.notice)
        // Picked up too late: a fresh start in the same screen, and it says so.
        socket.listener.onFailure()
        ticker.advance(500)
        socket.listener.onOpen()
        socket.ready(session = "s2", resumed = false)
        assertEquals("Reconnected. Say that again?", ui.notice)
    }

    @Test
    fun talk_turned_off_on_the_server_ends_with_a_fallback() {
        socket.say("type" to "error", "code" to "talk_off", "say" to "Talk isn't turned on for your account.", "show" to "Talk isn't turned on for your account.")
        socket.listener.onClosed(TalkProtocol.CLOSE_FORBIDDEN)
        assertEquals(Phase.ENDED, ui.phase)
        assertTrue(ui.problem!!.fallback)
        assertEquals(1, finished)
    }
}
