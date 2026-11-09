package org.promptly.sync.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/** Calls WP-D5: starting calls from the page, the camera, picture-in-picture,
 *  weak connections, tones and hold. */
class CallMediaTest {
    private val call = "0b6f1d2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b"
    private val other = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
    private val user = "11111111-2222-3333-4444-555555555555"
    private val now = 1_800_000_000_000L
    private val server = "https://promptly.example.com"

    /** A call session shaped like `dm.py::_session_token`'s (the signature isn't checked here). */
    private fun session(
        callId: String = call,
        dev: String = "android",
        typ: String = "call",
        sub: String = user,
        exp: Long = now + 12 * 3600_000,
    ): String {
        val enc = Base64.getUrlEncoder().withoutPadding()
        val head = enc.encodeToString("""{"alg":"HS256","typ":"JWT"}""".toByteArray())
        val body = enc.encodeToString("""{"typ":"$typ","sub":"$sub","call":"$callId","sid":"abc","dev":"$dev","iat":1,"exp":${exp / 1000}}""".toByteArray())
        return "$head.$body." + enc.encodeToString(ByteArray(32) { 3 })
    }

    private fun params(
        s: String = session(),
        srv: String? = server,
        callId: String? = call,
        video: String? = "1",
        title: String? = "Ann",
    ): Map<String, String?> = mapOf("server" to srv, "session" to s, "call" to callId, "video" to video, "title" to title)

    // ---------------------------------------------------------------- the hand-off

    @Test
    fun takesAHandOffForThisAppsServer() {
        val h = CallHandoffs.parse(params(), "https://Promptly.example.com:443/", now)!!
        assertEquals(server, h.server)
        assertEquals(call, h.callId)
        assertEquals(user, h.user)
        assertTrue(h.video)
        assertEquals("Ann", h.title)
        assertFalse(CallHandoffs.parse(params(video = "0"), server, now)!!.video)
        assertEquals("Call", CallHandoffs.parse(params(title = "  "), server, now)!!.title)
        assertEquals(80, CallHandoffs.parse(params(title = "x".repeat(300)), server, now)!!.title.length)
    }

    @Test
    fun refusesAnotherServerOrNoServerSetUp() {
        assertNull(CallHandoffs.parse(params(srv = "https://evil.example.com"), server, now))
        assertNull(CallHandoffs.parse(params(srv = "http://promptly.example.com"), server, now))
        assertNull(CallHandoffs.parse(params(srv = "https://promptly.example.com:8443"), server, now))
        assertNull(CallHandoffs.parse(params(), null, now))
        assertNull(CallHandoffs.parse(params(srv = "javascript:alert(1)"), server, now))
    }

    @Test
    fun refusesAnythingButAnAndroidSessionForThatCall() {
        assertNull("another call", CallHandoffs.parse(params(s = session(callId = other)), server, now))
        assertNull("a web session", CallHandoffs.parse(params(s = session(dev = "web")), server, now))
        assertNull("a voice session", CallHandoffs.parse(params(s = session(typ = "voice")), server, now))
        assertNull("expired", CallHandoffs.parse(params(s = session(exp = now - 1000)), server, now))
        assertNull("not a uuid", CallHandoffs.parse(params(callId = "../x"), server, now))
        assertNull("no call", CallHandoffs.parse(params(callId = null), server, now))
        assertNull("junk", CallHandoffs.parse(params(s = "not.a-token.at-all"), server, now))
        assertNull("too short", CallHandoffs.parse(params(s = "a.b"), server, now))
        // The call id is matched however it's cased.
        assertNotNull(CallHandoffs.parse(params(callId = call.uppercase()), server, now))
    }

    @Test
    fun readsTheSessionsClaims() {
        val c = CallHandoffs.claims(session())!!
        assertEquals(user, c.user)
        assertEquals(call, c.callId)
        assertEquals("android", c.device)
        assertNull(CallHandoffs.claims("x.y"))
    }

    // ---------------------------------------------------------------- the machine: calls you start

    private fun handoff(id: String = call, video: Boolean = false) = CallHandoff(server, session(id), id, user, video, "Ann")

    private fun ring(callId: String = other): Ring {
        val enc = Base64.getUrlEncoder().withoutPadding()
        val t = enc.encodeToString("""{"a":"call_answer","e":${(now + 120_000) / 1000},"t":"$callId","u":"$user","v":0}""".toByteArray()) + "." + enc.encodeToString(ByteArray(32) { 7 })
        return Ring.of(CallTag(callId, CallTag.Kind.RING, token = t), "Ben", "Incoming call", now)!!
    }

    @Test
    fun aCallYouStartDialsUntilAnswered() {
        val m = CallMachine()
        val out = m.on(CallEvent.Outgoing(handoff(video = true)))
        assertEquals(listOf(CallEffect.TelecomOutgoing(call, true, "Ann"), CallEffect.Start(handoff(video = true))), out)
        assertEquals(CallState.Active(call, true, "Ann", connected = false, outgoing = true, answered = false), m.state)
        // Connected to LiveKit, but still ringing them: Telecom stays "dialling".
        assertEquals(emptyList<CallEffect>(), m.on(CallEvent.Connected(call)))
        assertEquals(listOf(CallEffect.TelecomActive(call)), m.on(CallEvent.Answered(call)))
        assertEquals(emptyList<CallEffect>(), m.on(CallEvent.Answered(call)))
        // The same hand-off again changes nothing.
        assertEquals(emptyList<CallEffect>(), m.on(CallEvent.Outgoing(handoff(video = true))))
    }

    @Test
    fun saysHowAnUnansweredCallEnded() {
        for ((why, tell, cause) in listOf(
            Triple("ended:declined", "Call declined.", EndCause.REJECTED),
            Triple("ended:missed", "No answer.", EndCause.REMOTE),
            Triple("ended:cancelled", null, EndCause.REMOTE),
            Triple("failed", "Couldn't start the call.", EndCause.MISSED),
        )) {
            val m = CallMachine()
            m.on(CallEvent.Outgoing(handoff()))
            val out = m.on(CallEvent.Ended(call, why))
            assertEquals(why, CallEffect.TelecomEnd(call, cause), out.first())
            assertEquals(why, tell, (out.firstOrNull { it is CallEffect.Tell } as CallEffect.Tell?)?.text)
            assertEquals(CallState.Idle, m.state)
        }
        // Once answered, a decline-like end says nothing.
        val m = CallMachine()
        m.on(CallEvent.Outgoing(handoff()))
        m.on(CallEvent.Answered(call))
        assertEquals(listOf(CallEffect.TelecomEnd(call, EndCause.REMOTE)), m.on(CallEvent.Ended(call, "ended:completed")))
    }

    @Test
    fun startingACallReplacesWhatsHere() {
        // A call ringing here is left to ring out.
        val m = CallMachine()
        m.on(CallEvent.Rang(ring(), now))
        val out = m.on(CallEvent.Outgoing(handoff()))
        assertEquals(CallEffect.CancelRing(other), out[0])
        assertEquals(CallEffect.TelecomEnd(other, EndCause.MISSED), out[1])
        assertTrue(out.contains(CallEffect.Start(handoff())))

        // A call you're in is hung up first.
        val m2 = CallMachine()
        m2.on(CallEvent.Rang(ring(), now))
        m2.on(CallEvent.Answer(other, now))
        val out2 = m2.on(CallEvent.Outgoing(handoff()))
        assertEquals(listOf(CallEffect.Leave(other), CallEffect.TelecomEnd(other, EndCause.LOCAL)), out2.take(2))
        assertEquals(call, (m2.state as CallState.Active).callId)
        // Hanging up the new one before it's answered: leave (the server cancels it).
        assertEquals(listOf(CallEffect.Leave(call), CallEffect.TelecomEnd(call, EndCause.LOCAL)), m2.on(CallEvent.HangUp(call)))
    }

    @Test
    fun anAnsweredCallIsActiveForTelecomOnConnect() {
        val m = CallMachine()
        m.on(CallEvent.Rang(ring(call), now))
        m.on(CallEvent.Answer(call, now))
        assertEquals(listOf(CallEffect.TelecomActive(call)), m.on(CallEvent.Connected(call)))
    }

    // ---------------------------------------------------------------- the server's words

    @Test
    fun readsHowTheServerSaysTheCallEnded() {
        assertEquals(CallRefresh.Ended("declined"), CallRefresh.gone("ended:declined"))
        assertEquals(CallRefresh.Gone, CallRefresh.gone("Not found"))
        assertEquals(CallRefresh.Gone, CallRefresh.gone(null))
        assertEquals(CallRefresh.Gone, CallRefresh.gone("ended:<script>"))
        assertEquals(CallRejoin.Step.Stop("ended:missed"), CallRejoin(now).next(CallRefresh.Ended("missed"), now))
        assertEquals("ended:declined", CallApi.detailOf("""{"detail":"ended:declined"}"""))
        assertNull(CallApi.detailOf("<html>"))
    }

    @Test
    fun readsTheTitleAndTheCameraControls() {
        val body = """{"call":{"id":"$call","media":"video","group":false,"answered_at":null},"url":"/livekit","token":"t","room_id":"$other","lk_room":"c_x","session":"s","session_id":"i","title":"Ann"}"""
        assertEquals("Ann", CallProtocol.parseJoin(body).title)
        assertNull(CallProtocol.parseJoin(body.replace(""","title":"Ann"""", "")).title)
        assertEquals(CallProtocol.Control.CAMERA_ON, CallProtocol.parseControl("""{"action":"camera_on"}""".toByteArray(), "call.control", fromServer = true))
        assertEquals(CallProtocol.Control.FLIP, CallProtocol.parseControl("""{"action":"flip"}""".toByteArray(), "call.control", fromServer = true))
        // Only from the server.
        assertNull(CallProtocol.parseControl("""{"action":"camera_on"}""".toByteArray(), "call.control", fromServer = false))
    }

    @Test
    fun theWordsForCallingHoldAndReconnecting() {
        fun text(status: CallNote.Status, calling: Boolean = false, held: Boolean = false, peerHeld: Boolean = false, group: Boolean = false) =
            CallNote.of("Ann", false, status, muted = false, speaker = false, seconds = 65, others = 2, group = group, calling = calling, held = held, peerHeld = peerHeld).text
        assertEquals("Calling…", text(CallNote.Status.CONNECTING, calling = true))
        assertEquals("Calling…", text(CallNote.Status.CONNECTED, calling = true))
        assertEquals("Ringing everyone…", text(CallNote.Status.CONNECTED, calling = true, group = true))
        assertEquals("Reconnecting…", text(CallNote.Status.RECONNECTING, calling = true))
        assertEquals("On hold · you're on another call", text(CallNote.Status.CONNECTED, held = true))
        assertEquals("On hold", text(CallNote.Status.CONNECTED, peerHeld = true))
        assertEquals("1:05 · 2 others · someone put the call on hold", text(CallNote.Status.CONNECTED, peerHeld = true, group = true))
        assertEquals("1:05", text(CallNote.Status.CONNECTED))
    }

    // ---------------------------------------------------------------- the camera

    @Test
    fun aVideoCallsCameraGoesLiveOnceConnected() {
        val m = CameraMachine(CameraState(wanted = true, permitted = true))
        assertFalse(m.state.live)
        assertEquals(listOf(CameraEffect.Publish(true, true)), m.on(CameraEvent.Connection(true)))
        assertTrue(m.state.live)
        assertEquals(listOf(CameraEffect.Switch(false)), m.on(CameraEvent.Flip))
        assertEquals(listOf(CameraEffect.Switch(true)), m.on(CameraEvent.Flip))
        assertEquals(listOf(CameraEffect.Publish(false, true)), m.on(CameraEvent.Toggle))
        assertFalse(m.state.buttonOn)
        // Flipping while it's off only remembers the side for next time.
        assertEquals(emptyList<CameraEffect>(), m.on(CameraEvent.Flip))
        assertEquals(listOf(CameraEffect.Publish(true, false)), m.on(CameraEvent.Toggle))
    }

    @Test
    fun theScreenGoingOffOrHoldPausesTheCamera() {
        val m = CameraMachine(CameraState(wanted = true, permitted = true, connected = true))
        assertEquals(listOf(CameraEffect.Publish(false, true)), m.on(CameraEvent.Screen(false)))
        assertTrue(m.state.paused)
        assertTrue(m.state.buttonOn)
        assertEquals(listOf(CameraEffect.Publish(true, true)), m.on(CameraEvent.Screen(true)))
        assertEquals(listOf(CameraEffect.Publish(false, true)), m.on(CameraEvent.Hold(true)))
        // Screen back on while still on hold: stays paused.
        assertEquals(emptyList<CameraEffect>(), m.on(CameraEvent.Screen(true)))
        assertEquals(listOf(CameraEffect.Publish(true, true)), m.on(CameraEvent.Hold(false)))
        // A dropped connection takes it; the next one brings it back.
        assertEquals(listOf(CameraEffect.Publish(false, true)), m.on(CameraEvent.Connection(false)))
        assertEquals(listOf(CameraEffect.Publish(true, true)), m.on(CameraEvent.Connection(true)))
    }

    @Test
    fun withoutPermissionItAsksFirst() {
        val m = CameraMachine(CameraState(connected = true))
        assertEquals(listOf(CameraEffect.AskPermission), m.on(CameraEvent.Toggle))
        assertFalse(m.state.live)
        assertEquals(listOf(CameraEffect.Publish(true, true)), m.on(CameraEvent.Permission(true)))
        // Refused: nothing sends, and asking again asks again.
        val n = CameraMachine(CameraState(connected = true))
        n.on(CameraEvent.Set(true))
        assertEquals(emptyList<CameraEffect>(), n.on(CameraEvent.Permission(false)))
        assertEquals(listOf(CameraEffect.AskPermission), n.on(CameraEvent.Toggle))
        // No camera at all: never asks.
        val p = CameraMachine(CameraState(hasCamera = false, connected = true))
        assertEquals(emptyList<CameraEffect>(), p.on(CameraEvent.Toggle))
    }

    @Test
    fun resetStartsANewCallOver() {
        val m = CameraMachine(CameraState(wanted = true, permitted = true, connected = true, front = false))
        m.reset(CameraState(wanted = false, permitted = true))
        assertFalse(m.state.connected)
        assertTrue(m.state.front)
        assertFalse(m.state.wanted)
    }

    // ---------------------------------------------------------------- picture-in-picture

    @Test
    fun pictureInPictureOnlyWithSomethingToWatch() {
        assertTrue(PipPlan.wanted(inCall = true, ringing = false, connected = true, videoCall = true, pictures = false))
        assertTrue(PipPlan.wanted(inCall = true, ringing = false, connected = true, videoCall = false, pictures = true))
        assertFalse("a voice call with no cameras", PipPlan.wanted(inCall = true, ringing = false, connected = true, videoCall = false, pictures = false))
        assertFalse("ringing", PipPlan.wanted(inCall = true, ringing = true, connected = true, videoCall = true, pictures = true))
        assertFalse("not connected", PipPlan.wanted(inCall = true, ringing = false, connected = false, videoCall = true, pictures = true))
        assertFalse("no call", PipPlan.wanted(inCall = false, ringing = false, connected = false, videoCall = true, pictures = true))
        assertTrue(PipPlan.autoEnter(31, true))
        assertFalse(PipPlan.autoEnter(30, true))
        assertTrue(PipPlan.enterOnLeave(29, true))
        assertFalse(PipPlan.enterOnLeave(31, true))
        assertFalse(PipPlan.enterOnLeave(29, false))
    }

    @Test
    fun pictureInPictureShapeStaysWithinWhatAndroidTakes() {
        assertEquals(9 to 16, PipPlan.aspect(0, 0))
        assertEquals(1280 to 720, PipPlan.aspect(1280, 720))
        assertEquals(239 to 100, PipPlan.aspect(3000, 500))
        assertEquals(100 to 239, PipPlan.aspect(500, 3000))
    }

    // ---------------------------------------------------------------- weak connections

    @Test
    fun aWeakLinkLowersVideoWithoutFlapping() {
        val w = WeakLink()
        assertFalse(w.input(LinkQuality.POOR, 0))
        assertFalse(w.tick(3_999))
        assertTrue(w.tick(4_000))
        assertTrue(w.input(LinkQuality.GOOD, 5_000))
        assertTrue(w.tick(14_999))
        assertFalse(w.tick(15_000))
        assertTrue(w.input(LinkQuality.LOST, 16_000))
        assertTrue(w.input(LinkQuality.UNKNOWN, 17_000))
    }

    @Test
    fun videoLevelsAndWords() {
        assertEquals(VideoLevel.HIGH, VideoPlan.level(weak = false, dataSaver = false, metered = false))
        assertEquals(VideoLevel.MEDIUM, VideoPlan.level(weak = false, dataSaver = false, metered = true))
        assertEquals(VideoLevel.LOW, VideoPlan.level(weak = false, dataSaver = true, metered = true))
        assertEquals(VideoLevel.LOW, VideoPlan.level(weak = true, dataSaver = false, metered = false))
        assertEquals(Triple(640, 360, 15), VideoPlan.capture(VideoLevel.LOW))
        assertEquals("Weak connection: video lowered", VideoPlan.words(weak = true, dataSaver = true))
        assertEquals("Data Saver is on: video lowered", VideoPlan.words(weak = false, dataSaver = true))
        assertNull(VideoPlan.words(weak = false, dataSaver = false))
    }

    // ---------------------------------------------------------------- tones

    private val calling = ToneState(inCall = true, status = CallNote.Status.CONNECTED, calling = true)
    private val through = ToneState(inCall = true, status = CallNote.Status.CONNECTED)

    @Test
    fun ringbackUntilTheyAnswerThenTheThroughTone() {
        val connecting = ToneState(inCall = true, status = CallNote.Status.CONNECTING, calling = true)
        assertEquals(emptyList<ToneFx>(), CallTones.diff(ToneState(), connecting))
        assertEquals(listOf(ToneFx.Start(CallTone.RINGBACK)), CallTones.diff(connecting, calling))
        assertEquals(listOf(ToneFx.Stop(CallTone.RINGBACK), ToneFx.Play(CallTone.CONNECTED)), CallTones.diff(calling, through))
        // Nobody answered: the ringback stops and the end tone plays.
        assertEquals(listOf(ToneFx.Stop(CallTone.RINGBACK), ToneFx.Play(CallTone.ENDED)), CallTones.diff(calling, ToneState()))
    }

    @Test
    fun answeringPlaysTheThroughToneOnce() {
        val connecting = ToneState(inCall = true)
        assertEquals(listOf(ToneFx.Play(CallTone.CONNECTED)), CallTones.diff(connecting, through))
        assertEquals(emptyList<ToneFx>(), CallTones.diff(through, through.copy()))
    }

    @Test
    fun reconnectingAndBack() {
        val dropped = through.copy(status = CallNote.Status.RECONNECTING)
        assertEquals(listOf(ToneFx.Play(CallTone.RECONNECTING)), CallTones.diff(through, dropped))
        assertEquals(listOf(ToneFx.Play(CallTone.RECONNECTED)), CallTones.diff(dropped, through))
        // A call ringing them that drops: the ringback stops while it's away.
        val callingDropped = calling.copy(status = CallNote.Status.RECONNECTING)
        assertEquals(listOf(ToneFx.Stop(CallTone.RINGBACK), ToneFx.Play(CallTone.RECONNECTING)), CallTones.diff(calling, callingDropped))
        assertEquals(listOf(ToneFx.Start(CallTone.RINGBACK)), CallTones.diff(callingDropped, calling).filterNot { it is ToneFx.Play })
    }

    @Test
    fun theHoldToneWhileTheyHoldYou() {
        val held = through.copy(peerHeld = true)
        assertEquals(listOf(ToneFx.Start(CallTone.HOLD)), CallTones.diff(through, held))
        assertEquals(listOf(ToneFx.Stop(CallTone.HOLD)), CallTones.diff(held, through))
        // You're on hold yourself (a phone call has the sound): no hold tone.
        assertEquals(emptyList<ToneFx>(), CallTones.diff(through.copy(held = true), held.copy(held = true)))
        assertEquals(listOf(ToneFx.Stop(CallTone.HOLD), ToneFx.Play(CallTone.ENDED)), CallTones.diff(held, ToneState()))
    }

    // ---------------------------------------------------------------- hold

    @Test
    fun holdSignalFromPeopleOnly() {
        assertEquals(true, HoldSignal.decode(HoldSignal.encode(true), "call.hold", fromPerson = true))
        assertEquals(false, HoldSignal.decode(HoldSignal.encode(false), "call.hold", fromPerson = true))
        assertNull(HoldSignal.decode(HoldSignal.encode(true), "call.control", fromPerson = true))
        assertNull(HoldSignal.decode(HoldSignal.encode(true), "call.hold", fromPerson = false))
        assertNull(HoldSignal.decode("junk".toByteArray(), "call.hold", fromPerson = true))
    }
}
