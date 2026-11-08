package org.promptly.sync.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class CallLogicTest {
    private val call = "0b6f1d2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b"
    private val other = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
    private val now = 1_800_000_000_000L

    /** A token shaped like `notifications/actions.py::sign`'s (the mac isn't checked here). */
    private fun token(callId: String = call, expiresAt: Long = now + 120_000): String {
        val body = """{"a":"call_answer","e":${expiresAt / 1000},"t":"$callId","u":"11111111-2222-3333-4444-555555555555","v":0}"""
        val enc = Base64.getUrlEncoder().withoutPadding()
        return enc.encodeToString(body.toByteArray()) + "." + enc.encodeToString(ByteArray(32) { 7 })
    }

    private fun ring(callId: String = call, busy: Boolean = false, video: Boolean = false, at: Long = now): Ring {
        val t = token(callId, at + 120_000)
        return Ring.of(CallTag(callId, CallTag.Kind.RING, video = video, busy = busy, token = t), "ann", "Incoming call", at)!!
    }

    // ---------------------------------------------------------------- reading Chrome's tag

    @Test
    fun readsTheRingInsideChromesTag() {
        val t = token()
        val tag = CallTag.parse("p#https://promptly.example.com#0call:$call|r|v|1|0|$t")!!
        assertEquals(call, tag.callId)
        assertEquals(CallTag.Kind.RING, tag.kind)
        assertTrue(tag.video)
        assertTrue(tag.busy)
        assertFalse(tag.group)
        assertEquals(t, tag.token)
    }

    @Test
    fun readsStopMissedAndOldTags() {
        assertEquals(CallTag.Kind.STOP, CallTag.parse("call:$call|s")!!.kind)
        assertEquals(CallTag.Kind.MISSED, CallTag.parse("p#x#1call:${call.uppercase()}|m")!!.kind)
        assertEquals(call, CallTag.parse("p#x#1call:${call.uppercase()}|m")!!.callId)
        // An older page's tag: a call, but nothing to ring with.
        val old = CallTag.parse("p#https://h#0call:$call")!!
        assertEquals(CallTag.Kind.OTHER, old.kind)
        assertNull(Ring.of(old, "ann", "Incoming call", now))
    }

    @Test
    fun otherNotificationsAreNotCalls() {
        assertNull(CallTag.parse(null))
        assertNull(CallTag.parse(""))
        assertNull(CallTag.parse("p#https://h#0room:$call"))
        assertNull(CallTag.parse("p#https://h#0call:not-a-uuid|r|a|0|0|x.y"))
        assertNull(CallTag.parse("p#https://h#0task:42"))
    }

    @Test
    fun aRingWithoutATokenDoesntRingHere() {
        // A phone the page doesn't know has the app: Chrome shows its own notification.
        val tag = CallTag.parse("call:$call|r|a|0|0|")!!
        assertNull(tag.token)
        assertNull(Ring.of(tag, "ann", "Incoming call", now))
    }

    @Test
    fun aTokenForAnotherCallIsRefused() {
        val tag = CallTag(call, CallTag.Kind.RING, token = token(other))
        assertNull(Ring.of(tag, "ann", "Incoming call", now))
    }

    // ---------------------------------------------------------------- the token's life

    @Test
    fun theRingLastsFortyFiveSecondsOrTheTokensLife() {
        assertEquals(now + 45_000, ring().until)
        val short = Ring.of(CallTag(call, CallTag.Kind.RING, token = token(expiresAt = now + 20_000)), "ann", null, now)!!
        assertEquals(now + 15_000, short.until)
        assertEquals("Incoming call", short.text)
        // A push that arrives with its token (nearly) dead doesn't ring at all.
        assertNull(Ring.of(CallTag(call, CallTag.Kind.RING, token = token(expiresAt = now + 4_000)), "ann", null, now))
        assertNull(Ring.of(CallTag(call, CallTag.Kind.RING, token = "junk.junk"), "ann", null, now))
    }

    @Test
    fun readsTheTokensExpiryAndCall() {
        assertEquals((now + 120_000) / 1000 * 1000, AnswerToken.expiresAt(token()))
        assertEquals(call, AnswerToken.callOf(token()))
        assertNull(AnswerToken.expiresAt("nodot"))
        assertNull(AnswerToken.expiresAt("%%%.x"))
    }

    @Test
    fun answeringAfterTheTokenDiedIsAMissedCall() {
        val m = CallMachine()
        val r = ring()
        m.on(CallEvent.Rang(r, now))
        val out = m.on(CallEvent.Answer(call, r.until + Ring.TOKEN_MARGIN_MS))
        assertEquals(CallState.Idle, m.state)
        assertTrue(out.contains(CallEffect.TelecomEnd(call, EndCause.MISSED)))
        assertTrue(out.any { it is CallEffect.Tell })
        assertFalse(out.any { it is CallEffect.Answer })
    }

    // ---------------------------------------------------------------- answer and decline

    @Test
    fun ringAnswerConnectHangUp() {
        val m = CallMachine()
        val r = ring()
        assertEquals(listOf(CallEffect.ShowRing(r), CallEffect.TelecomIncoming(r)), m.on(CallEvent.Rang(r, now)))
        assertEquals(CallState.Ringing(r), m.state)

        val answered = m.on(CallEvent.Answer(call, now + 3_000))
        assertEquals(
            listOf(CallEffect.CancelRing(call), CallEffect.TelecomAnswer(call, false), CallEffect.Answer(r)),
            answered,
        )
        assertEquals(CallState.Active(call, false, "ann", connected = false), m.state)

        // "Answered on another device" reaches this phone too: it's ours, ignore it.
        assertEquals(emptyList<CallEffect>(), m.on(CallEvent.Stopped(call)))
        assertEquals(listOf(CallEffect.TelecomActive(call)), m.on(CallEvent.Connected(call)))
        assertEquals(emptyList<CallEffect>(), m.on(CallEvent.Connected(call)))

        assertEquals(listOf(CallEffect.Leave(call), CallEffect.TelecomEnd(call, EndCause.LOCAL)), m.on(CallEvent.HangUp(call)))
        assertEquals(CallState.Idle, m.state)
    }

    @Test
    fun declineTellsTheServerAndTelecom() {
        val m = CallMachine()
        val r = ring()
        m.on(CallEvent.Rang(r, now))
        assertEquals(
            listOf(CallEffect.CancelRing(call), CallEffect.Decline(r), CallEffect.TelecomEnd(call, EndCause.REJECTED)),
            m.on(CallEvent.Decline(call)),
        )
        assertEquals(CallState.Idle, m.state)
        // A second tap (or the car's button too): nothing more.
        assertEquals(emptyList<CallEffect>(), m.on(CallEvent.Decline(call)))
        assertEquals(emptyList<CallEffect>(), m.on(CallEvent.Answer(call, now)))
    }

    @Test
    fun answeredElsewhereOrCallerGaveUpStopsTheRing() {
        for (ev in listOf(CallEvent.Stopped(call), CallEvent.NotRinging(call))) {
            val m = CallMachine()
            m.on(CallEvent.Rang(ring(), now))
            assertEquals(listOf(CallEffect.CancelRing(call), CallEffect.TelecomEnd(call, EndCause.REMOTE)), m.on(ev))
            assertEquals(CallState.Idle, m.state)
        }
    }

    @Test
    fun missedAndTimedOut() {
        val m = CallMachine()
        val r = ring()
        m.on(CallEvent.Rang(r, now))
        assertEquals(emptyList<CallEffect>(), m.on(CallEvent.TimedOut(call, now + 10_000)))
        assertEquals(listOf(CallEffect.CancelRing(call), CallEffect.TelecomEnd(call, EndCause.MISSED)), m.on(CallEvent.TimedOut(call, r.until)))
        assertEquals(CallState.Idle, m.state)
        // The missed push after that: nothing left to stop.
        assertEquals(emptyList<CallEffect>(), m.on(CallEvent.Missed(call)))

        val m2 = CallMachine()
        m2.on(CallEvent.Rang(ring(), now))
        assertEquals(listOf(CallEffect.CancelRing(call), CallEffect.TelecomEnd(call, EndCause.MISSED)), m2.on(CallEvent.Missed(call)))
    }

    @Test
    fun staleRingsAndRingsForOtherCalls() {
        val m = CallMachine()
        val r = ring()
        assertEquals(emptyList<CallEffect>(), m.on(CallEvent.Rang(r, r.until)))
        assertEquals(CallState.Idle, m.state)
        m.on(CallEvent.Rang(r, now))
        // Another call while this one rings: left to ring out on the server.
        assertEquals(emptyList<CallEffect>(), m.on(CallEvent.Rang(ring(other), now)))
        // The same call rung again (a group call's Ring): rings again, fresh token.
        val again = ring(at = now + 20_000)
        assertEquals(listOf(CallEffect.ShowRing(again)), m.on(CallEvent.Rang(again, now + 20_000)))
        assertEquals(CallState.Ringing(again), m.state)
        // Stop for a call that isn't ringing here.
        assertEquals(emptyList<CallEffect>(), m.on(CallEvent.Stopped(other)))
    }

    // ---------------------------------------------------------------- busy: End and answer

    @Test
    fun endAndAnswer() {
        val m = CallMachine()
        m.on(CallEvent.Rang(ring(), now))
        m.on(CallEvent.Answer(call, now))
        m.on(CallEvent.Connected(call))

        val second = ring(other)
        val shown = m.on(CallEvent.Rang(second, now + 60_000 - 59_000))
        val waiting = second.copy(busy = true)
        assertEquals(listOf(CallEffect.ShowRing(waiting), CallEffect.TelecomIncoming(waiting)), shown)
        assertEquals("End and answer", CallNote.answerLabel(waiting))

        val out = m.on(CallEvent.Answer(other, now + 2_000))
        assertEquals(
            listOf(
                CallEffect.CancelRing(other),
                CallEffect.Leave(call),
                CallEffect.TelecomEnd(call, EndCause.LOCAL),
                CallEffect.TelecomAnswer(other, false),
                CallEffect.Answer(waiting),
            ),
            out,
        )
        assertEquals(CallState.Active(other, false, "ann", connected = false), m.state)
    }

    @Test
    fun aWaitingCallCanBeDeclinedOrRingsOnWhenTheCallEnds() {
        val m = CallMachine()
        m.on(CallEvent.Rang(ring(), now))
        m.on(CallEvent.Answer(call, now))
        val second = ring(other)
        m.on(CallEvent.Rang(second, now + 1_000))
        val waiting = second.copy(busy = true)
        assertEquals(
            listOf(CallEffect.CancelRing(other), CallEffect.Decline(waiting), CallEffect.TelecomEnd(other, EndCause.REJECTED)),
            m.on(CallEvent.Decline(other)),
        )
        assertEquals(CallState.Active(call, false, "ann", connected = false), m.state)

        m.on(CallEvent.Rang(second, now + 2_000))
        // The other person hangs up: the waiting call rings on, as an ordinary ring.
        val out = m.on(CallEvent.Ended(call, "ended"))
        assertEquals(listOf(CallEffect.TelecomEnd(call, EndCause.REMOTE), CallEffect.ShowRing(second)), out)
        assertEquals(CallState.Ringing(second), m.state)
    }

    @Test
    fun answerThatCouldntConnectSaysSo() {
        val m = CallMachine()
        m.on(CallEvent.Rang(ring(), now))
        m.on(CallEvent.Answer(call, now))
        val out = m.on(CallEvent.Ended(call, "failed"))
        assertEquals(CallEffect.TelecomEnd(call, EndCause.MISSED), out[0])
        assertTrue(out[1] is CallEffect.Tell)
        assertEquals(CallState.Idle, m.state)
        // Taken on another device: no words, Telecom told it ended elsewhere.
        val m2 = CallMachine()
        m2.on(CallEvent.Rang(ring(), now))
        m2.on(CallEvent.Answer(call, now))
        assertEquals(listOf(CallEffect.TelecomEnd(call, EndCause.REMOTE)), m2.on(CallEvent.Ended(call, "replaced")))
    }

    // ---------------------------------------------------------------- the server's answers

    @Test
    fun parsesTheAnswer() {
        val j = CallProtocol.parseJoin(
            """{"call":{"id":"$call","media":"video","group":false,"answered_at":"2026-11-09T01:00:00+00:00"},
               "url":"/livekit","token":"lk","identity":"u:x","lk_room":"c_$call","room_id":"$other",
               "session":"jwt","session_id":"s1","device":"android","max_stream":"1080p30"}""",
        )
        assertEquals(call, j.callId)
        assertTrue(j.video)
        assertEquals("c_$call", j.lkRoom)
        assertEquals(other, j.roomId)
        assertEquals("jwt", j.session)
        assertEquals("/rooms/r/$other?call=$call", CallProtocol.pagePath(j.roomId, j.callId))
        assertEquals(RingState(ringing = false, ended = true), CallProtocol.parseRingState("""{"ringing":false,"ring":"declined","ended":true,"in_call_here":false}"""))
        assertEquals("""{"token":"t.x","device":"android"}""", CallProtocol.answerBody("t.x"))
    }

    @Test
    fun thePagesRemoteControlComesFromTheServerOnly() {
        val mute = """{"action":"mute"}""".toByteArray()
        assertEquals(CallProtocol.Control.MUTE, CallProtocol.parseControl(mute, "call.control", fromServer = true))
        assertEquals(CallProtocol.Control.SPEAKER_ON, CallProtocol.parseControl("""{"action":"speaker_on"}""".toByteArray(), "call.control", true))
        // Another participant, another topic, junk: ignored.
        assertNull(CallProtocol.parseControl(mute, "call.control", fromServer = false))
        assertNull(CallProtocol.parseControl(mute, "voice.control", fromServer = true))
        assertNull(CallProtocol.parseControl("nope".toByteArray(), "call.control", fromServer = true))
        assertNull(CallProtocol.parseControl("""{"action":"leave"}""".toByteArray(), "call.control", fromServer = true))
    }

    @Test
    fun rejoinGivesUpWhenTheServerSaysSoOrAfterTwoMinutes() {
        val p = CallRejoin(now)
        assertEquals(CallRejoin.Step.Retry(1_000), p.next(CallRefresh.Failed("x"), now))
        assertEquals(CallRejoin.Step.Retry(2_000), p.connectFailed(now + 1_000))
        assertEquals(CallRejoin.Step.Stop("ended"), p.next(CallRefresh.Gone, now + 2_000))
        assertEquals(CallRejoin.Step.Stop("lost"), p.next(CallRefresh.Failed("x"), now + 120_000))
    }

    // ---------------------------------------------------------------- words and routes

    @Test
    fun theNotificationsWords() {
        val n = CallNote.of("ann", video = false, status = CallNote.Status.CONNECTED, muted = true, speaker = false, seconds = 125, others = 1, group = false)
        assertEquals("Call with ann", n.title)
        assertEquals("2:05 · you're muted", n.text)
        assertEquals("Unmute", n.muteLabel)
        assertEquals("Speaker", n.speakerLabel)
        val g = CallNote.of("The Lads", video = true, status = CallNote.Status.CONNECTED, muted = false, speaker = true, seconds = 3725, others = 3, group = true)
        assertEquals("Video call with The Lads", g.title)
        assertEquals("1:02:05 · 3 others", g.text)
        assertEquals("Speaker off", g.speakerLabel)
        assertEquals("Connecting…", CallNote.of("ann", false, CallNote.Status.CONNECTING, false, false, 0, 0, false).text)
        assertNotNull(CallNote.busyLine(ring(busy = true)))
        assertNull(CallNote.busyLine(ring()))
    }

    @Test
    fun routes() {
        val all = listOf(Routing.Kind.EARPIECE, Routing.Kind.SPEAKER, Routing.Kind.BLUETOOTH)
        assertEquals(Routing.Kind.BLUETOOTH, Routing.pick(all, speaker = false))
        assertEquals(Routing.Kind.SPEAKER, Routing.pick(all, speaker = true))
        assertEquals(Routing.Kind.EARPIECE, Routing.pick(listOf(Routing.Kind.SPEAKER, Routing.Kind.EARPIECE), speaker = false))
        assertEquals(Routing.Kind.WIRED, Routing.pick(listOf(Routing.Kind.SPEAKER, Routing.Kind.WIRED, Routing.Kind.EARPIECE), speaker = false))
        assertNull(Routing.pick(emptyList(), speaker = true))
        assertTrue(Routing.startsOnSpeaker(video = true))
        assertFalse(Routing.startsOnSpeaker(video = false))
    }
}
