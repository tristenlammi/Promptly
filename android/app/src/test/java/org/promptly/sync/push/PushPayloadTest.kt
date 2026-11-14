package org.promptly.sync.push

import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.calls.CallTag
import org.promptly.sync.widgets.Open
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** What the server pushes (the service worker's JSON), read by the app itself. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PushPayloadTest {
    private val call = "0b6f1d2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b"

    @Test
    fun readsARoomMessageWithItsButtons() {
        val p = PushPayload.parse(
            """{"title":"Ann","body":"Dinner at 7?","url":"/rooms/r/abc","tag":"room:abc","category":"room_message",
               "stack":true,"line":"Dinner at 7?","icon":"/api/rooms/avatar/1",
               "actions":[{"action":"room_reply","title":"Reply","token":"t1.sig","type":"text","placeholder":"Message Ann"},
                          {"action":"room_read","title":"Mark as read","token":"t2.sig"},
                          {"action":"broken","title":"No token"}]}""",
        )
        assertEquals("Ann", p.title)
        assertEquals("room:abc", p.tag)
        assertTrue(p.stack)
        assertEquals(2, p.actions.size)
        assertTrue(p.actions[0].text)
        assertEquals("Message Ann", p.actions[0].placeholder)
        assertFalse(p.actions[1].text)
        assertEquals(PushChannel.MESSAGES, PushChannel.of(p.category))
    }

    @Test
    fun plainWordsStillShow() {
        val p = PushPayload.parse("Something happened")
        assertEquals("Promptly", p.title)
        assertEquals("Something happened", p.body)
        assertTrue(p.actions.isEmpty())
    }

    @Test
    fun nullsAndBlanksAreNothing() {
        val p = PushPayload.parse("""{"title":null,"body":"","url":null,"tag":""}""")
        assertEquals("Promptly", p.title)
        assertEquals("", p.body)
        assertNull(p.url)
        assertNull(p.tag)
    }

    @Test
    fun aRingBecomesTheTagTheCallsCodeReads() {
        val token = "abcdefghij.klmnop"
        val p = PushPayload.parse(
            """{"title":"Ann","body":"Incoming video call","category":"call","kind":"call_ring","call_id":"$call",
               "media":"video","busy":true,"group":false,"answer_token":"$token"}""",
        )
        val tag = CallTag.parse(p.callTag())
        assertNotNull(tag)
        assertEquals(CallTag.Kind.RING, tag!!.kind)
        assertEquals(call, tag.callId)
        assertTrue(tag.video)
        assertTrue(tag.busy)
        assertFalse(tag.group)
        assertEquals(token, tag.token)
    }

    @Test
    fun stopAndMissedCalls() {
        fun kind(k: String) = CallTag.parse(PushPayload.parse("""{"category":"call","kind":"$k","call_id":"$call"}""").callTag())!!.kind
        assertEquals(CallTag.Kind.STOP, kind("call_stop"))
        assertEquals(CallTag.Kind.MISSED, kind("call_missed"))
    }

    @Test
    fun everyKindHasAChannel() {
        assertEquals(PushChannel.REMINDERS, PushChannel.of("item_reminder"))
        assertEquals(PushChannel.REMINDERS, PushChannel.of("calendar"))
        assertEquals(PushChannel.MAIL, PushChannel.of("mail"))
        assertEquals(PushChannel.SOCIAL, PushChannel.of("porch"))
        assertEquals(PushChannel.OTHER, PushChannel.of("export_ready"))
        assertEquals(PushChannel.OTHER, PushChannel.of(null))
        assertEquals(PushChannel.OTHER, PushChannel.of("something_new"))
    }

    @Test
    fun aTapOpensThePageInItsOwnApp() {
        assertEquals(Open.ROOMS, PushNotes.launcherFor("/rooms/r/abc"))
        assertEquals(Open.CALENDAR, PushNotes.launcherFor("/calendar?event=1"))
        assertEquals(Open.MAIL, PushNotes.launcherFor("/mail/t/9"))
        assertEquals(Open.PROMPTLY, PushNotes.launcherFor("/app/123/"))
        assertEquals(Open.PROMPTLY, PushNotes.launcherFor("/"))
    }

    @Test
    fun onlyThePathOfALinkIsKept() {
        assertEquals("/rooms/r/abc?m=5", PushNotes.pathOf("https://promptly.example.com/rooms/r/abc?m=5"))
        assertEquals("/rooms/r/abc", PushNotes.pathOf("/rooms/r/abc"))
        assertEquals("/", PushNotes.pathOf(null))
        assertEquals("/", PushNotes.pathOf("https://promptly.example.com"))
    }

    @Test
    fun theLinkOnlyWorksForThisAppsOwnServer() {
        val mine = "https://promptly.example.com"
        fun link(server: String, code: String = "abcdefgh12345678") =
            PushLinkActivity.parse(Uri.parse("promptly://notifications?server=${Uri.encode(server)}&code=$code"), mine)
        assertEquals(mine, link(mine)!!.server)
        assertEquals(mine, link("$mine/")!!.server)
        assertNull(link("https://evil.example.com"))
        assertNull(link(mine, code = "short"))
        // Before the app is set up there's no server to trust.
        assertNull(PushLinkActivity.parse(Uri.parse("promptly://notifications?server=${Uri.encode(mine)}&code=abcdefgh12345678"), null))
        assertNull(PushLinkActivity.parse(Uri.parse("promptly://voice?server=${Uri.encode(mine)}&code=abcdefgh12345678"), mine))
    }

    @Test
    fun aMissedCallCarriesWhatCallBackNeeds() {
        val p = PushPayload.parse(
            """{"title":"Missed video call","body":"Ann tried to call you","url":"/rooms/calls/$call","tag":"call:$call",
               "category":"call","kind":"call_missed","call_id":"$call","media":"video",
               "caller":{"id":"1","username":"Ann"},"callback_token":"abc.def"}""",
        )
        assertEquals("call_missed", p.kind)
        assertEquals("abc.def", p.callbackToken)
        assertEquals("Ann", p.caller)
        assertTrue(p.video)
        // An older server sends neither: no button, nothing else changes.
        val old = PushPayload.parse("""{"title":"Missed call","body":"Ann tried to call you","category":"call","kind":"call_missed","call_id":"$call"}""")
        assertNull(old.callbackToken)
        assertNull(old.caller)
    }
}
