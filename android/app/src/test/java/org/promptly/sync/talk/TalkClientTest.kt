package org.promptly.sync.talk

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
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

/** The phone's protocol client against a scripted server end. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TalkClientTest {
    private lateinit var ticker: FakeTicker
    private lateinit var opener: FakeOpener
    private lateinit var client: TalkClient
    private val events = ArrayList<TalkEvent>()
    private val speech = ArrayList<ByteArray>()
    private val links = ArrayList<TalkClient.Link>()
    private val ended = ArrayList<TalkProblem?>()
    private var weak = 0

    @Before
    fun setUp() {
        events.clear()
        speech.clear()
        links.clear()
        ended.clear()
        weak = 0
        ticker = FakeTicker()
        opener = FakeOpener()
        client = TalkClient(opener, ticker, { TalkProtocol.hello(TalkProtocol.PHONE_CAPS, "Australia/Brisbane", "en-AU") }, object : TalkClient.Listener {
            override fun onEvent(event: TalkEvent) {
                events += event
            }
            override fun onSpeech(pcm: ByteArray) {
                speech += pcm
            }
            override fun onLink(link: TalkClient.Link) {
                links += link
            }
            override fun onEnded(problem: TalkProblem?) {
                ended += problem
            }
            override fun onWeak() {
                weak++
            }
        })
    }

    private fun connect(): FakeSocket {
        client.start()
        val s = opener.last
        s.listener.onOpen()
        s.ready()
        return s
    }

    @Test
    fun hello_says_android_with_its_caps_and_pcm() {
        client.start()
        opener.last.listener.onOpen()
        val hello = opener.last.sent("hello").single()
        assertEquals("android", hello.getString("device"))
        assertEquals("pcm16", hello.getString("codec"))
        assertEquals("pcm16", hello.getString("play"))
        assertEquals(16000, hello.getInt("sample_rate"))
        val caps = hello.getJSONArray("caps").let { a -> (0 until a.length()).map { a.getString(it) } }
        assertEquals(listOf("timer", "alarm", "dial", "message", "open_app", "navigate"), caps)
        assertEquals("Australia/Brisbane", hello.getString("tz"))
        assertTrue(opener.last.query.isEmpty())
    }

    @Test
    fun speech_before_ready_is_kept_and_sent_in_order_with_sequence_numbers() {
        client.start()
        val s = opener.last
        s.listener.onOpen()
        repeat(3) { client.audio(pcm(it.toShort())) }
        assertTrue(s.frames.isEmpty())
        s.ready()
        assertEquals(3, s.frames.size)
        s.frames.forEachIndexed { i, f ->
            val (seq, body) = TalkProtocol.withoutSeq(f)!!
            assertEquals(i, seq)
            assertArrayEquals(pcm(i.toShort()), body)
        }
        client.audio(pcm())
        assertEquals(3, TalkProtocol.withoutSeq(s.frames.last())!!.first)
        assertEquals(TalkClient.Link.LIVE, links.last())
    }

    @Test
    fun the_early_buffer_holds_three_seconds_at_most() {
        client.start()
        repeat(TalkClient.EARLY_FRAMES + 40) { client.audio(pcm()) }
        opener.last.ready()
        assertEquals(TalkClient.EARLY_FRAMES, opener.last.frames.size)
    }

    @Test
    fun speech_frames_come_through_without_their_sequence_number() {
        val s = connect()
        val frame = ByteArray(TalkProtocol.SPEECH_FRAME_BYTES) { it.toByte() }
        s.listener.onBytes(TalkProtocol.withSeq(7, frame))
        assertArrayEquals(frame, speech.single())
    }

    @Test
    fun the_nested_action_event_is_unwrapped() {
        val s = connect()
        s.say("type" to "action", "action" to JSONObject().put("type", "set_timer").put("seconds", 600).put("label", "Tea"))
        val action = events.filterIsInstance<TalkEvent.Action>().single().action
        assertEquals("set_timer", action.getString("type"))
        assertEquals(600, action.getInt("seconds"))
    }

    @Test
    fun ready_resume_null_conversation_and_ask_parse() {
        val s = connect()
        val ready = events.filterIsInstance<TalkEvent.Ready>().single()
        assertEquals("s1", ready.sessionId)
        assertEquals(24000, ready.sampleRate)
        assertEquals(30, ready.resumeS)
        s.say("type" to "ask", "question" to "Set an alarm for 6:30?", "approval_id" to "a1", "expires_in" to 20)
        val ask = events.filterIsInstance<TalkEvent.Ask>().single()
        assertEquals("a1", ask.approvalId)
        assertEquals(20, ask.expiresIn)
        s.say("type" to "ask_done", "approval_id" to "a1", "outcome" to "approved")
        assertEquals("approved", events.filterIsInstance<TalkEvent.AskDone>().single().outcome)
    }

    @Test
    fun pings_time_the_connection_and_slow_answers_mark_it_weak() {
        val s = connect()
        val first = s.sent("ping").single()
        ticker.advance(50)
        s.say("type" to "pong", "t" to first.getLong("t"))
        assertEquals(0, weak)
        // Two of the next three come back slowly.
        repeat(3) { i ->
            ticker.advance(TalkClient.PING_MS - (if (i == 0) 50 else 900))
            val ping = s.sent("ping").last()
            ticker.advance(if (i == 2) 100 else 900)
            s.say("type" to "pong", "t" to ping.getLong("t"))
        }
        assertEquals(1, weak)
    }

    @Test
    fun a_drop_resumes_the_same_conversation_without_resending_old_speech() {
        val s = connect()
        client.audio(pcm())
        s.listener.onFailure()
        assertEquals(TalkClient.Link.RECONNECTING, links.last())
        // While it's down, the microphone goes nowhere.
        client.audio(pcm())
        assertEquals(1, opener.sockets.size)
        ticker.advance(500)
        assertEquals(2, opener.sockets.size)
        val again = opener.last
        assertEquals("s1", again.query["resume"])
        again.listener.onOpen()
        again.ready(resumed = true)
        assertTrue(again.frames.isEmpty())
        assertTrue(ended.isEmpty())
        // A failure after a close is the same end, told twice.
        s.listener.onClosed(1006)
        assertEquals(2, opener.sockets.size)
    }

    @Test
    fun too_late_to_resume_starts_afresh_then_gives_up() {
        val s = connect()
        opener.refuse = true
        s.listener.onFailure()
        ticker.advance(31_000)
        opener.refuse = false
        ticker.advance(4_000)
        assertNull(opener.last.query["resume"])
        opener.refuse = true
        opener.last.listener.onFailure()
        ticker.advance(40_000)
        assertEquals("offline", ended.single()!!.code)
        assertFalse(ended.single()!!.fallback)
    }

    @Test
    fun close_codes_say_why_and_whether_the_old_assistant_could_help() {
        fun closeWith(code: Int, error: String? = null): TalkProblem? {
            setUp()
            client.start()
            val s = opener.last
            s.listener.onOpen()
            error?.let { s.say("type" to "error", "code" to it, "say" to "Nope.", "show" to "Nope.") }
            s.listener.onClosed(code)
            return ended.singleOrNull()
        }
        assertFalse(closeWith(TalkProtocol.CLOSE_UNAUTHORIZED)!!.fallback)
        assertTrue(closeWith(TalkProtocol.CLOSE_FORBIDDEN, "talk_off")!!.fallback)
        assertEquals("Nope.", closeWith(TalkProtocol.CLOSE_FORBIDDEN, "talk_off")!!.show)
        assertTrue(closeWith(TalkProtocol.CLOSE_BUSY)!!.fallback)
        assertTrue(closeWith(TalkProtocol.CLOSE_UNAVAILABLE, "speech_unavailable")!!.fallback)
        assertFalse(closeWith(TalkProtocol.CLOSE_UNAVAILABLE, "no_model")!!.fallback)
        assertTrue(closeWith(TalkProtocol.CLOSE_BAD_HELLO)!!.fallback)
    }

    @Test
    fun end_says_bye_and_finishes_when_the_server_does() {
        val s = connect()
        client.end()
        assertEquals(1, s.sent("bye").size)
        assertTrue(ended.isEmpty())
        s.say("type" to "bye", "reason" to "bye")
        assertEquals(1, ended.size)
        assertNull(ended.single())
        assertNotNull(s.closedWith)
        // Nothing more goes out.
        client.audio(pcm())
        client.send(JSONObject().put("type", "mute"))
        assertTrue(s.frames.isEmpty())
        assertTrue(s.sent("mute").isEmpty())
    }

    @Test
    fun end_without_an_answer_finishes_anyway() {
        connect()
        client.end()
        ticker.advance(TalkClient.BYE_WAIT_MS + 1)
        assertEquals(1, ended.size)
    }

    @Test
    fun an_unreachable_server_gives_up_after_a_few_seconds_and_offers_the_old_way() {
        opener.refuse = true
        client.start()
        ticker.advance(TalkClient.FIRST_CONNECT_MS + 5_000)
        assertEquals("offline", ended.single()!!.code)
        assertTrue(ended.single()!!.fallback)
    }

    @Test
    fun sequence_numbers_round_trip_big_endian() {
        val framed = TalkProtocol.withSeq(0x01020304, byteArrayOf(9, 8))
        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 9, 8), framed)
        assertEquals(0x01020304, TalkProtocol.withoutSeq(framed)!!.first)
        assertNull(TalkProtocol.withoutSeq(byteArrayOf(1, 2, 3, 4)))
        assertEquals(-1, TalkProtocol.withoutSeq(TalkProtocol.withSeq(-1, byteArrayOf(0)))!!.first)
    }
}
