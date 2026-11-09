package org.promptly.sync.talk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The car's one press, one turn (WP-T8): press, listen, close; a question reopens
 *  the microphone for its window only; a press while it talks stops it; the car
 *  taking the microphone back or a call ends it; and the answer waits for directions. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CarTurnTest {
    private lateinit var ticker: FakeTicker
    private lateinit var opener: FakeOpener
    private lateinit var speaker: FakeSpeaker
    private lateinit var core: TalkCore
    private lateinit var turn: CarTurn
    private val mic = FakeCarMic()
    private val sounds = FakeSounds()
    private val notices = ArrayList<String>()

    private val socket: FakeSocket get() = opener.last

    class FakeCarMic : CarMicControl {
        var opened = 0
        var closed = 0
        var refuse = false
        var isOpen = false
        override fun open(): Boolean {
            if (refuse) return false
            opened++
            isOpen = true
            return true
        }
        override fun close() {
            closed++
            isOpen = false
        }
    }

    class FakeSounds : CarSounds {
        val played = ArrayList<String>()
        override fun opening() {
            played += "up"
        }
        override fun closing() {
            played += "down"
        }
    }

    @Before
    fun setUp() {
        ticker = FakeTicker()
        opener = FakeOpener()
        speaker = FakeSpeaker()
        core = TalkCore(
            ticker, speaker,
            actions = { null },
            trail = { _, _ -> },
            opener = opener,
            hello = { TalkProtocol.carHello(null, null, null) },
        )
        turn = CarTurn(ticker, core, mic, sounds) { notices += it }
        core.watcher = turn
        core.start(captions = false, tapped = true)
    }

    private fun live() {
        socket.listener.onOpen()
        socket.listener.onText(
            org.json.JSONObject().put("type", "ready").put("session_id", "s1").put("resumed", false)
                .put("turn_mode", "tap").put("interrupt_mode", "tap")
                .put("audio", org.json.JSONObject().put("format", "pcm16").put("sample_rate", 24000).put("frame_ms", 20))
                .put("limits", org.json.JSONObject().put("resume_s", 30).put("idle_s", 120)).toString(),
        )
    }

    private fun state(s: String) = socket.say("type" to "state", "state" to s, "muted" to false)
    private fun speak() = core.mic(pcm(4000), 0.2)

    @Test
    fun the_hello_is_the_cars_no_screen_and_no_talking_over_it() {
        val hello = socket.let { live(); it.sent("hello").single() }
        assertEquals("car", hello.getString("device"))
        assertEquals("tap", hello.getString("turn_mode"))
        assertEquals("tap", hello.getString("interrupt_mode"))
        val caps = hello.getJSONArray("caps").let { a -> (0 until a.length()).map { a.getString(it) } }
        assertFalse("dial" in caps || "message" in caps || "open_app" in caps)
    }

    @Test
    fun press_listens_and_what_you_said_while_it_connected_is_kept() {
        turn.press()
        assertEquals(CarTurn.Mic.LISTENING, turn.mic)
        assertEquals(listOf("up"), sounds.played)
        // Said before the socket was up: kept for this turn.
        repeat(3) { speak() }
        live()
        assertEquals(3, socket.frames.size)
        speak()
        assertEquals(4, socket.frames.size)
    }

    @Test
    fun the_server_ending_the_turn_closes_the_microphone() {
        live()
        turn.press()
        speak()
        socket.say("type" to "partial", "text" to "add milk")
        state("thinking")
        assertEquals(CarTurn.Mic.CLOSED, turn.mic)
        assertEquals(1, mic.closed)
        assertEquals(listOf("up", "down"), sounds.played)
        // Closed: nothing more goes to the server.
        val sent = socket.frames.size
        speak()
        assertEquals(sent, socket.frames.size)
    }

    @Test
    fun saying_nothing_closes_it_again() {
        live()
        turn.press()
        ticker.advance(CarTurn.QUIET_MS + 10)
        assertEquals(CarTurn.Mic.CLOSED, turn.mic)
        // Nothing heard: nothing to flush.
        assertTrue(socket.sent("end_turn").isEmpty())
    }

    @Test
    fun talking_keeps_it_open_until_the_longest_turn() {
        live()
        turn.press()
        socket.say("type" to "partial", "text" to "what's on")
        ticker.advance(CarTurn.QUIET_MS + 10)
        assertEquals(CarTurn.Mic.LISTENING, turn.mic)
        ticker.advance(CarTurn.LONGEST_MS)
        assertEquals(CarTurn.Mic.CLOSED, turn.mic)
        assertEquals(1, socket.sent("end_turn").size)
    }

    @Test
    fun a_question_reopens_it_only_for_its_window_once_said() {
        live()
        turn.press()
        socket.say("type" to "partial", "text" to "tell sam")
        state("thinking")
        state("speaking")
        speaker.playing = true
        core.playing(true)
        socket.say("type" to "ask", "question" to "Message Sam on Promptly: 'I'm ten minutes away.' Send it?", "approval_id" to "m:c", "expires_in" to 20, "listen_s" to 6)
        // Still being said: not yet.
        assertEquals(CarTurn.Mic.CLOSED, turn.mic)
        state("listening")
        assertEquals(CarTurn.Mic.CLOSED, turn.mic)
        speaker.playing = false
        core.playing(false)
        assertEquals(CarTurn.Mic.ANSWERING, turn.mic)
        assertEquals(2, mic.opened)
        // Nothing said in 6 s: it closes, and doesn't open again by itself.
        ticker.advance(6_010)
        assertEquals(CarTurn.Mic.CLOSED, turn.mic)
        state("listening")
        core.playing(false)
        assertEquals(CarTurn.Mic.CLOSED, turn.mic)
        assertEquals(2, mic.opened)
    }

    @Test
    fun without_a_question_it_never_opens_by_itself() {
        live()
        turn.press()
        socket.say("type" to "partial", "text" to "what's on tomorrow")
        state("thinking")
        state("speaking")
        core.playing(true)
        core.playing(false)
        state("listening")
        ticker.advance(60_000)
        assertEquals(CarTurn.Mic.CLOSED, turn.mic)
        assertEquals(1, mic.opened)
    }

    @Test
    fun press_while_it_talks_stops_it_and_the_mic_stays_shut() {
        live()
        turn.press()
        state("thinking")
        state("speaking")
        speaker.playing = true
        core.playing(true)
        turn.press()
        assertEquals(1, socket.sent("interrupt").size)
        assertEquals(CarTurn.Mic.CLOSED, turn.mic)
        assertEquals(1, mic.opened)
    }

    @Test
    fun press_while_it_listens_means_ive_finished() {
        live()
        turn.press()
        socket.say("type" to "partial", "text" to "navigate home")
        turn.press()
        assertEquals(CarTurn.Mic.CLOSED, turn.mic)
        assertEquals(1, socket.sent("end_turn").size)
    }

    @Test
    fun the_car_taking_the_microphone_back_ends_the_turn() {
        live()
        turn.press()
        socket.say("type" to "partial", "text" to "add a stop")
        turn.micGone()
        assertEquals(CarTurn.Mic.CLOSED, turn.mic)
        assertEquals(1, socket.sent("end_turn").size)
    }

    @Test
    fun losing_the_audio_stops_listening_and_talking() {
        live()
        turn.press()
        turn.audioLost()
        assertEquals(CarTurn.Mic.CLOSED, turn.mic)
        state("speaking")
        speaker.playing = true
        core.playing(true)
        socket.say("type" to "ask", "question" to "Send it?", "approval_id" to "m:c", "expires_in" to 20, "listen_s" to 6)
        turn.audioLost()
        assertEquals(1, socket.sent("interrupt").size)
        // The question it was asking doesn't reopen the microphone afterwards.
        speaker.playing = false
        core.playing(false)
        state("listening")
        assertEquals(CarTurn.Mic.CLOSED, turn.mic)
    }

    @Test
    fun a_microphone_it_cant_have_says_so() {
        live()
        mic.refuse = true
        turn.press()
        assertEquals(CarTurn.Mic.CLOSED, turn.mic)
        assertEquals(listOf(CarTurn.NO_MIC), notices)
        assertTrue(sounds.played.isEmpty())
    }

    @Test
    fun the_conversation_lapsing_closes_everything_quietly() {
        live()
        turn.press()
        socket.say("type" to "bye", "reason" to "idle")
        assertEquals(CarTurn.Mic.CLOSED, turn.mic)
        assertEquals(listOf("up"), sounds.played)
        // Over: a press now is CarTalk's to start afresh, not this turn's.
        turn.press()
        assertEquals(1, mic.opened)
    }
}

/** The car's answer waits for a direction being said, and starts once it's done. */
class PlaybackHoldTest {
    private class Track : org.promptly.sync.talk.Track {
        var written = 0
        override fun write(bytes: ByteArray, offset: Int, size: Int): Int {
            written += size
            return size
        }
        override fun head(): Long = 0
        override fun drop() = Unit
        override fun volume(gain: Float) = Unit
    }

    @Test
    fun a_reply_waits_while_held_and_not_forever() {
        var now = 0L
        var prompt = true
        val track = Track()
        val p = Playback(track, clock = { now })
        p.hold = { prompt }
        p.push(ByteArray(960))
        p.pump()
        assertEquals(0, track.written)
        assertTrue(p.playing)
        prompt = false
        p.pump()
        assertEquals(960, track.written)
        // A later reply held too long goes ahead anyway.
        p.stop()
        prompt = true
        p.push(ByteArray(960))
        p.pump()
        assertEquals(960, track.written)
        now += Playback.MAX_HOLD_MS + 1
        p.pump()
        assertEquals(1920, track.written)
    }

    @Test
    fun a_reply_already_playing_isnt_cut() {
        val track = Track()
        var prompt = false
        val p = Playback(track)
        p.hold = { prompt }
        p.push(ByteArray(960))
        p.pump()
        prompt = true
        p.push(ByteArray(960))
        p.pump()
        assertEquals(1920, track.written)
    }
}
