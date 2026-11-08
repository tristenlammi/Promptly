package org.promptly.sync.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/** The voice service's rules: commands, mute/deafen, reports, the
 *  notification, and what happens when the connection or session goes. */
class VoiceLogicTest {
    private fun cmd(json: String, topic: String? = "voice.control", fromServer: Boolean = true) =
        VoiceProtocol.parseCommand(json.toByteArray(), topic, fromServer)

    // ------------------------------------------------------------ commands

    @Test fun serverCommandsParse() {
        assertEquals(VoiceCommand.Mute, cmd("""{"action":"mute"}"""))
        assertEquals(VoiceCommand.Unmute, cmd("""{"action":"unmute"}"""))
        assertEquals(VoiceCommand.Deafen, cmd("""{"action":"deafen"}"""))
        assertEquals(VoiceCommand.Undeafen, cmd("""{"action":"undeafen"}"""))
        assertEquals(VoiceCommand.Leave("admin"), cmd("""{"action":"leave","reason":"admin"}"""))
        assertEquals(VoiceCommand.Leave("left"), cmd("""{"action":"leave"}"""))
        assertEquals(VoiceCommand.StillThere(120), cmd("""{"action":"still_there","seconds":120}"""))
        assertEquals(
            VoiceCommand.Move("r2", "v_abc", "tok", "sess"),
            cmd("""{"action":"move","room_id":"r2","lk_room":"v_abc","token":"tok","session":"sess"}"""),
        )
    }

    @Test fun onlyTheServerOnTheControlTopicIsObeyed() {
        // Another participant can send data too: never a command.
        assertNull(cmd("""{"action":"mute"}""", fromServer = false))
        assertNull(cmd("""{"action":"mute"}""", topic = "chat"))
        assertNull(cmd("""{"action":"mute"}""", topic = null))
        assertNull(cmd("""{"action":"explode"}"""))
        assertNull(cmd("not json"))
        assertNull(cmd("""["mute"]"""))
        // A move without everything it needs isn't half-done.
        assertNull(cmd("""{"action":"move","room_id":"r2","token":"tok"}"""))
        // Silly countdowns are clamped.
        assertEquals(VoiceCommand.StillThere(600), cmd("""{"action":"still_there","seconds":99999}"""))
    }

    // ------------------------------------------------------------ mute and deafen

    @Test fun deafenMutesAndUndeafenRestoresYourMute() {
        val start = MicState()
        assertTrue(start.micOn && start.hearing)
        val deaf = start.deafen()
        assertTrue(deaf.muted && deaf.deafened && !deaf.micOn && !deaf.hearing)
        assertEquals(start, deaf.undeafen().copy(mutedBeforeDeafen = false))
        // Muted before deafening: still muted after.
        val mutedDeaf = start.mute().deafen()
        assertTrue(mutedDeaf.undeafen().muted)
        // Unmute while deafened undeafens too.
        val un = mutedDeaf.unmute()
        assertFalse(un.deafened)
        assertFalse(un.muted)
        assertTrue(un.micOn)
    }

    @Test fun anAdminsMuteCantBeLiftedFromThePhone() {
        val muted = MicState(serverMuted = true, micGranted = false)
        assertFalse(muted.micOn)
        assertFalse(muted.unmute().micOn)
        assertFalse(muted.apply(VoiceCommand.Unmute).micOn)
        // Your own mute is kept apart, so lifting the admin's mute doesn't unmute you.
        val both = MicState().mute().copy(serverMuted = true, micGranted = false)
        assertFalse(both.copy(serverMuted = false, micGranted = true).micOn)
        // Server-deafened: you don't hear.
        assertFalse(MicState(serverDeafened = true).hearing)
        // No microphone permission: listening only.
        assertFalse(MicState(hasMicPermission = false).micOn)
        assertTrue(MicState(hasMicPermission = false).hearing)
        // "Only admins can talk here".
        assertFalse(MicState(canTalk = false).micOn)
    }

    @Test fun commandsApplyLikeTheButtons() {
        val m = MicState()
        assertEquals(m.mute(), m.apply(VoiceCommand.Mute))
        assertEquals(m.deafen(), m.apply(VoiceCommand.Deafen))
        assertEquals(m.deafen().undeafen(), m.deafen().apply(VoiceCommand.Undeafen))
        assertEquals(m, m.apply(VoiceCommand.Leave("x")))
        assertEquals(m.mute(), m.toggleMute())
        assertEquals(m, m.mute().toggleMute())
        assertEquals(m.deafen(), m.toggleDeafen())
    }

    // ------------------------------------------------------------ reports

    @Test fun stateReportsNameTheSession() {
        assertEquals("""{"voice_session":"S","muted":false,"deafened":false}""", VoiceProtocol.stateBody("S", MicState()))
        assertEquals("""{"voice_session":"S","muted":true,"deafened":true}""", VoiceProtocol.stateBody("S", MicState().deafen()))
        assertEquals("""{"voice_session":"S","on":true}""", VoiceProtocol.speakingBody("S", true))
        assertEquals("""{"voice_session":"S"}""", VoiceProtocol.sessionBody("S"))
        assertEquals("""{"session":"S"}""", VoiceProtocol.refreshBody("S"))
    }

    @Test fun speakingIsDebounced() {
        val d = SpeakingDebouncer()
        assertEquals(1150L, d.input(true, 1000))
        assertNull(d.tick(1100)) // too soon
        assertEquals(true, d.tick(1150))
        assertNull(d.tick(1200)) // already reported
        // A short pause doesn't flicker the ring.
        assertEquals(2400L, d.input(false, 2000))
        assertNull(d.input(true, 2200)) // back before 400 ms: nothing pending
        assertNull(d.tick(2500))
        d.input(false, 3000)
        assertEquals(false, d.tick(3400))
        // Muting turns it off at once.
        d.input(true, 4000)
        d.tick(4200)
        assertTrue(d.forceOff())
        assertFalse(d.forceOff())
    }

    // ------------------------------------------------------------ joining, refresh, drops

    private val joinJson = """{"url":"/livekit","token":"T","identity":"u:1","room_id":"r1","space_id":"s1",
        "channel_name":"Lounge","space_name":"The Lads","lk_room":"v_r1","session":"SESSION","session_id":"sid",
        "device":"android","quality":"good","bitrate":64,"can_talk":true,"can_video":true,
        "server_muted":true,"server_deafened":false,"max_stream":"720p30","members":[]}"""

    @Test fun joinParses() {
        val j = VoiceProtocol.parseJoin(joinJson)
        assertEquals("Lounge", j.channelName)
        assertEquals("The Lads", j.spaceName)
        assertEquals("v_r1", j.lkRoom)
        assertEquals("SESSION", j.session)
        assertEquals(64, j.bitrateKbps)
        assertTrue(j.serverMuted)
        // An older server without names still works.
        val old = VoiceProtocol.parseJoin("""{"token":"T","room_id":"r","lk_room":"v_r","session":"S","session_id":"x"}""")
        assertEquals("Voice", old.channelName)
        assertEquals("/livekit", old.url)
    }

    @Test fun signalUrlIsAWebSocketOnTheServer() {
        assertEquals("wss://p.example.com/livekit", VoiceProtocol.signalUrl("https://p.example.com", "/livekit"))
        assertEquals("ws://10.0.2.2:8093/livekit", VoiceProtocol.signalUrl("http://10.0.2.2:8093/", "/livekit"))
        assertEquals("wss://lk.example.com", VoiceProtocol.signalUrl("https://p.example.com", "wss://lk.example.com"))
    }

    @Test fun refreshDecidesWhatHappensNext() {
        val j = VoiceProtocol.parseJoin(joinJson)
        val plan = Rejoin(startedAt = 0)
        assertEquals(Rejoin.Step.Connect(j), plan.next(Refresh.Ok(j), 0))
        // The session ended (left elsewhere, removed, replaced): stop.
        assertEquals(Rejoin.Step.Stop("ended"), Rejoin(0).next(Refresh.Gone, 0))
        // No answer: back off 1, 2, 4, 8, 15, 30, 30… seconds.
        val r = Rejoin(startedAt = 0)
        val waits = (1..8).map { (r.next(Refresh.Failed("offline"), 1000L * it) as Rejoin.Step.Retry).inMs }
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L, 30_000L, 30_000L, 30_000L), waits)
        // A connect that fails after a good refresh counts the same.
        assertTrue(r.connectFailed(60_000) is Rejoin.Step.Retry)
        // Five minutes with no way through: give up.
        assertEquals(Rejoin.Step.Stop("lost"), r.next(Refresh.Failed("offline"), 5 * 60_000L))
    }

    @Test fun dropsAreSorted() {
        assertEquals(DropKind.OURS, DropKind.of("CLIENT_INITIATED"))
        assertEquals(DropKind.REPLACED, DropKind.of("DUPLICATE_IDENTITY"))
        assertEquals(DropKind.REMOVED, DropKind.of("PARTICIPANT_REMOVED"))
        assertEquals(DropKind.REMOVED, DropKind.of("ROOM_DELETED"))
        assertEquals(DropKind.NETWORK, DropKind.of("SIGNAL_CLOSE"))
        assertEquals(DropKind.NETWORK, DropKind.of("UNKNOWN_REASON"))
        assertEquals(DropKind.NETWORK, DropKind.of(null))
    }

    // ------------------------------------------------------------ the hand-off

    private fun session(sub: String, typ: String = "voice"): String {
        val enc = Base64.getUrlEncoder().withoutPadding()
        val head = enc.encodeToString("""{"alg":"HS256"}""".toByteArray())
        val body = enc.encodeToString("""{"typ":"$typ","sub":"$sub","room":"r","sid":"x"}""".toByteArray())
        return "$head.$body.signature"
    }

    @Test fun handoffOnlyForThisAppsServer() {
        val room = "0b5c2a8e-1d2f-4c3b-9a8e-7f6d5c4b3a21"
        val ok = mapOf("server" to "https://P.example.com:443/rooms", "session" to session("u1"), "room" to room, "channel" to "Lounge", "space" to "The Lads")
        val h = VoiceProtocol.parseHandoff(ok, "https://p.example.com")!!
        assertEquals("https://p.example.com", h.server)
        assertEquals(room, h.roomId)
        assertEquals("Lounge", h.channel)
        // Another server, no server set up, or junk: refused.
        assertNull(VoiceProtocol.parseHandoff(ok, "https://evil.example.com"))
        assertNull(VoiceProtocol.parseHandoff(ok, null))
        assertNull(VoiceProtocol.parseHandoff(ok + ("server" to "http://p.example.com"), "https://p.example.com"))
        assertNull(VoiceProtocol.parseHandoff(ok + ("server" to "javascript:alert(1)"), "https://p.example.com"))
        assertNull(VoiceProtocol.parseHandoff(ok + ("room" to "../../x"), "https://p.example.com"))
        assertNull(VoiceProtocol.parseHandoff(ok - "session", "https://p.example.com"))
        // The emulator's test stack.
        assertEquals("http://10.0.2.2:8093", VoiceProtocol.parseHandoff(ok + ("server" to "http://10.0.2.2:8093"), "http://10.0.2.2:8093")!!.server)
    }

    @Test fun sessionUserIsReadForTheFirstTimeQuestion() {
        assertEquals("u1", VoiceProtocol.sessionUser(session("u1")))
        assertNull(VoiceProtocol.sessionUser(session("u1", typ = "access")))
        assertNull(VoiceProtocol.sessionUser("not-a-jwt"))
    }

    @Test fun identities() {
        assertEquals("0b5c2a8e-1d2f-4c3b-9a8e-7f6d5c4b3a21", userOfIdentity("u:0B5C2A8E-1D2F-4C3B-9A8E-7F6D5C4B3A21"))
        assertNull(userOfIdentity("u:0b5c2a8e-1d2f-4c3b-9a8e-7f6d5c4b3a21:view"))
        assertNull(userOfIdentity("t:whatever"))
    }

    // ------------------------------------------------------------ the notification

    @Test fun notificationSaysWhatsGoingOn() {
        val c = VoiceNote.Status.CONNECTED
        var n = VoiceNote.of("Lounge", "The Lads", MicState(), c, emptyList(), 2)
        assertEquals("🔊 Lounge · The Lads", n.title)
        assertEquals("You and 2 others", n.text)
        assertEquals("Mute", n.muteLabel)
        assertTrue(n.muteEnabled)
        assertEquals("Deafen", n.deafenLabel)

        assertEquals("Just you here", VoiceNote.of("Lounge", "", MicState(), c, emptyList(), 0).text)
        assertEquals("🔊 Lounge", VoiceNote.of("Lounge", "", MicState(), c, emptyList(), 0).title)
        assertEquals("Sam is talking", VoiceNote.of("Lounge", "", MicState(), c, listOf("Sam"), 1).text)
        assertEquals("Sam and Jo are talking", VoiceNote.talkingLine(listOf("Sam", "Jo")))
        assertEquals("Sam, Jo and 2 others are talking", VoiceNote.talkingLine(listOf("Sam", "Jo", "Al", "Bo")))

        assertEquals("Sam is talking · you're muted", VoiceNote.of("Lounge", "", MicState().mute(), c, listOf("Sam"), 1).text)
        assertEquals("Deafened · You and 1 other", VoiceNote.of("Lounge", "", MicState().deafen(), c, listOf("Sam"), 1).text)
        n = VoiceNote.of("Lounge", "", MicState().mute(), c, emptyList(), 1)
        assertEquals("Muted · You and 1 other", n.text)
        assertEquals("Unmute", n.muteLabel)
        n = VoiceNote.of("Lounge", "", MicState().deafen(), c, emptyList(), 1)
        assertEquals("Deafened · You and 1 other", n.text)
        assertEquals("Undeafen", n.deafenLabel)
        assertTrue(n.muteEnabled) // unmute undeafens

        // An admin's mute: said plainly, and no Mute button to press.
        n = VoiceNote.of("Lounge", "", MicState(serverMuted = true, micGranted = false), c, listOf("Sam"), 1)
        assertEquals("An admin muted you", n.text)
        assertFalse(n.muteEnabled)
        assertEquals("An admin deafened you", VoiceNote.of("L", "", MicState(serverDeafened = true), c, emptyList(), 1).text)
        assertEquals("Reconnecting…", VoiceNote.of("L", "", MicState(), VoiceNote.Status.RECONNECTING, emptyList(), 1).text)
        assertEquals("Connecting…", VoiceNote.of("L", "", MicState(), VoiceNote.Status.CONNECTING, emptyList(), 0).text)
        assertTrue(VoiceNote.of("L", "", MicState(hasMicPermission = false), c, emptyList(), 0).text.startsWith("Listening only"))
        n = VoiceNote.of("L", "", MicState(canTalk = false), c, emptyList(), 1)
        assertEquals("Listening · only admins can talk here", n.text)
        assertFalse(n.muteEnabled)
    }
}
