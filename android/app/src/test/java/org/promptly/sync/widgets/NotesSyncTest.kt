package org.promptly.sync.widgets

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.Refused
import org.promptly.sync.Unlinked
import org.promptly.sync.capture.Capture
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException

/**
 * The Notes widgets' outbox (W1.3): ticks shown at once and undone by a
 * second tap, quick notes and voice notes made with no signal; a recording
 * goes up first (resuming where it got to), then the note, once; the
 * server's answer replaces the phone's guess; refusals and a removed phone
 * clear the copies; One note widgets' notes are asked for.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NotesSyncTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()

    private class Fake : WidgetBackend {
        val sent = mutableListOf<Op>()
        val uploads = mutableListOf<Pair<String, String?>>() // name, location it resumed from
        var noteIdsAsked: List<String> = emptyList()
        var snap: JSONObject = JSONObject()
        var fail: (Op) -> Exception? = { null }
        var uploadFail: Exception? = null
        var started = 0

        override fun snapshot(want: List<String>, days: Int, someday: Boolean, etags: Map<String, String>, noteIds: List<String>): JSONObject {
            noteIdsAsked = noteIds
            return snap
        }

        override fun upload(file: File, name: String, mime: String, location: String?, started: (String) -> Unit): String {
            uploads += name to location
            if (location == null) {
                this.started++
                started("https://p.test/api/files/tus/up${this.started}")
            }
            uploadFail?.let { throw it }
            assertTrue("the copy is still on the phone", file.isFile)
            return "file-${uploads.size}"
        }

        override fun send(op: Op): JSONObject {
            fail(op)?.let { throw it }
            sent += op
            val id = if (op.type == Op.NEW_NOTE) op.id else op.body.optString("note_id")
            val card = JSONObject().put("id", id).put("kind", "list").put("title", "From the server").put("color", "sand")
                .put("items", JSONArray().put(JSONObject().put("id", "i1").put("text", "Eggs").put("checked", op.type == Op.NOTE_TICK)))
                .put("left", if (op.type == Op.NOTE_TICK) 0 else 1).put("total", 1)
            return JSONObject().put("ok", true).put("note_id", id).put("card", card).put("full", card)
        }
    }

    private fun notesAnswer(etag: String = "n1") = JSONObject().put(
        "notes",
        JSONObject().put("etag", etag).put(
            "cards",
            JSONArray()
                .put(JSONObject().put("id", "L").put("kind", "list").put("title", "Shopping").put("pinned", true).put("left", 2).put("total", 2)
                    .put("items", JSONArray().put(JSONObject().put("id", "i1").put("text", "Eggs")).put(JSONObject().put("id", "i2").put("text", "Milk"))))
                .put(JSONObject().put("id", "T").put("kind", "text").put("title", "Gate").put("text", "4471")),
        ).put("notes", JSONArray().put(JSONObject().put("id", "L").put("kind", "list").put("title", "Shopping").put("left", 2).put("total", 2)
            .put("items", JSONArray().put(JSONObject().put("id", "i1").put("text", "Eggs")).put(JSONObject().put("id", "i2").put("text", "Milk"))))),
    )

    @Before
    fun clean() = runBlocking {
        WidgetStore.wipe(ctx)
        WidgetsOff.set(ctx, false)
    }

    private fun recording(bytes: Int = 4096): JSONObject {
        val f = Capture.newFile(ctx, "m4a")
        f.writeBytes(ByteArray(bytes) { (it % 7).toByte() })
        return Capture.ref(f, "Voice note.m4a", "audio/mp4", 4200, listOf(0.1f, 0.9f, 0.4f))
    }

    @Test
    fun a_tick_shows_at_once_and_a_second_tap_cancels_it() = runBlocking {
        WidgetStore.merge(ctx, notesAnswer(), 1000)
        WidgetStore.tickNoteItem(ctx, "L", "i1", true, "Eggs", 2000)
        val shown = NotesLogic.cards(WidgetStore.state.value).first { it.id == "L" }
        assertEquals(listOf("Milk", "Eggs"), shown.items.map { it.text }) // ticked go last
        assertEquals(1, shown.left)
        assertEquals(true, NotesLogic.one(WidgetStore.state.value, "L")!!.items.last().checked)
        // For a moment it stays where it was, ticked, so a second tap on the same spot undoes it.
        val settling = NotesLogic.one(WidgetStore.state.value, "L", now = 2_500)!!
        assertEquals(listOf("Eggs", "Milk"), settling.items.map { it.text })
        assertTrue(settling.items.first().checked && settling.items.first().settling)
        // Tapped again before it went: nothing to send.
        WidgetStore.tickNoteItem(ctx, "L", "i1", false, "Eggs", 2500)
        assertTrue(WidgetStore.state.value.ops.isEmpty())
        assertEquals(2, NotesLogic.cards(WidgetStore.state.value).first { it.id == "L" }.left)
    }

    @Test
    fun offline_tick_is_sent_once_and_the_answer_replaces_the_guess() = runBlocking {
        WidgetStore.merge(ctx, notesAnswer(), 1000)
        WidgetStore.tickNoteItem(ctx, "L", "i1", true, "Eggs", 2000)
        val id = WidgetStore.state.value.ops.single().id
        val fake = Fake().apply { fail = { IOException("no signal") } }
        assertEquals(SyncLogic.Outcome.RETRY, SyncLogic.run(ctx, fake, listOf("notes"), 3000))
        assertEquals(id, WidgetStore.state.value.ops.single().id)
        fake.fail = { null }
        fake.snap = JSONObject().put("notes", JSONObject().put("etag", "n1").put("unchanged", true))
        assertEquals(SyncLogic.Outcome.OK, SyncLogic.run(ctx, fake, listOf("notes"), 4000, noteIds = listOf("L")))
        assertEquals(listOf(id), fake.sent.map { it.id })
        assertEquals(listOf("L"), fake.noteIdsAsked)
        val card = WidgetStore.state.value.snapshot.notesSection!!.cards.first { it.id == "L" }
        assertEquals("From the server", card.title)
        assertEquals("From the server", WidgetStore.state.value.snapshot.notesSection!!.notes.single().title)
        assertFalse(WidgetStore.etags().containsKey("notes"))
    }

    @Test
    fun a_quick_note_with_no_signal_shows_as_waiting_then_arrives() = runBlocking {
        WidgetStore.merge(ctx, notesAnswer(), 1000)
        val op = WidgetStore.addNote(ctx, "list", "Hardware", "", listOf("Screws", "Glue"), "android", emptyList(), 2000)
        val cards = NotesLogic.cards(WidgetStore.state.value)
        assertEquals(listOf("L", op.id, "T"), cards.map { it.id }) // after the pinned ones
        val pending = cards[1]
        assertTrue(pending.pending)
        assertEquals(listOf("Screws", "Glue"), pending.items.map { it.text })
        assertTrue(pending.items.all { it.pending })

        val fake = Fake().apply { snap = JSONObject().put("notes", JSONObject().put("etag", "n1").put("unchanged", true)) }
        assertEquals(SyncLogic.Outcome.OK, SyncLogic.run(ctx, fake, listOf("notes"), 3000))
        assertEquals(Op.NEW_NOTE, fake.sent.single().type)
        val now = NotesLogic.cards(WidgetStore.state.value)
        assertEquals(listOf("L", op.id, "T"), now.map { it.id })
        assertFalse(now[1].pending)
    }

    @Test
    fun a_voice_note_uploads_first_resumes_and_is_sent_once() = runBlocking {
        val rec = recording()
        val path = rec.getString("path")
        val op = WidgetStore.addNote(ctx, "text", "", "", emptyList(), "voice", listOf(rec), 1000)
        assertEquals("Voice note", NotesLogic.cards(WidgetStore.state.value).single().title)
        assertTrue(NotesLogic.cards(WidgetStore.state.value).single().voice)

        // The upload starts, then the signal goes: the address is kept.
        val fake = Fake().apply { uploadFail = IOException("signal lost") }
        assertEquals(SyncLogic.Outcome.RETRY, SyncLogic.run(ctx, fake, listOf("notes"), 2000))
        val waiting = WidgetStore.state.value.ops.single()
        assertEquals("https://p.test/api/files/tus/up1", Capture.files(waiting).single().optString("tus"))
        assertTrue(File(path).isFile)

        // Many failures later it's still waiting: a recording is never given up for bad signal.
        repeat(25) { SyncLogic.run(ctx, fake, listOf("notes"), 3000L + it) }
        assertEquals(op.id, WidgetStore.state.value.ops.single().id)

        // Back: it carries on from the same upload, then the note goes with its file id.
        fake.uploadFail = null
        fake.snap = JSONObject()
        assertEquals(SyncLogic.Outcome.OK, SyncLogic.run(ctx, fake, listOf("notes"), 9000))
        assertEquals("https://p.test/api/files/tus/up1", fake.uploads.last().second)
        val sent = fake.sent.single()
        val file = WidgetApi.sentFiles(sent).getJSONObject(0)
        assertEquals(rec.getString("id"), file.getString("id"))
        assertTrue(file.getString("file_id").startsWith("file-"))
        assertEquals(4200L, file.getLong("duration_ms"))
        assertTrue(WidgetStore.state.value.ops.isEmpty())
        assertFalse("the copy is deleted once the server has it", File(path).exists())
    }

    @Test
    fun a_refused_note_says_so_and_its_copies_go() = runBlocking {
        val rec = recording()
        WidgetStore.addNote(ctx, "text", "", "", emptyList(), "voice", listOf(rec), 1000)
        val fake = Fake().apply { uploadFail = Refused(413, "That's over your storage limit.") }
        assertEquals(SyncLogic.Outcome.OK, SyncLogic.run(ctx, fake, emptyList(), 2000))
        val s = WidgetStore.state.value
        assertTrue(s.ops.isEmpty())
        assertEquals("Couldn't save the voice note — That's over your storage limit.", s.notices.single().text)
        assertEquals("notes", s.notices.single().area)
        assertFalse(File(rec.getString("path")).exists())
    }

    @Test
    fun a_tick_on_a_note_thats_gone_is_dropped_with_a_notice() = runBlocking {
        WidgetStore.merge(ctx, notesAnswer(), 1000)
        WidgetStore.tickNoteItem(ctx, "L", "i2", true, "Milk", 2000)
        val fake = Fake().apply { fail = { Refused(404, "That note isn't here.") } }
        SyncLogic.run(ctx, fake, emptyList(), 3000)
        assertEquals("Couldn't tick “Milk” — the list or item is gone.", WidgetStore.state.value.notices.single().text)
    }

    @Test
    fun items_added_and_text_shared_into_a_note_show_at_once() = runBlocking {
        WidgetStore.merge(ctx, notesAnswer(), 1000)
        WidgetStore.addNoteItem(ctx, "L", "Bread", 2000)
        WidgetStore.addToNote(ctx, "T", "Gate", "Back door: 1234", emptyList(), 2100)
        val one = NotesLogic.one(WidgetStore.state.value, "L")!!
        assertEquals(listOf("Eggs", "Milk", "Bread"), one.items.map { it.text })
        assertTrue(one.items.last().pending)
        assertEquals(3, one.left)
        assertEquals("4471\nBack door: 1234", NotesLogic.cards(WidgetStore.state.value).first { it.id == "T" }.text)
    }

    @Test
    fun a_removed_phone_wipes_notes_and_recordings() = runBlocking {
        WidgetStore.merge(ctx, notesAnswer(), 1000)
        val rec = recording()
        WidgetStore.addNote(ctx, "text", "", "", emptyList(), "voice", listOf(rec), 2000)
        val fake = Fake().apply { uploadFail = Unlinked() }
        assertEquals(SyncLogic.Outcome.REMOVED, SyncLogic.run(ctx, fake, listOf("notes"), 3000))
        assertNull(WidgetStore.state.value.snapshot.notesSection)
        assertTrue(WidgetStore.state.value.ops.isEmpty())
        assertFalse(File(rec.getString("path")).exists())
    }

    @Test
    fun the_server_answer_goes_in_place_or_after_the_pinned() {
        val section = notesAnswer().getJSONObject("notes")
        val fresh = JSONObject().put("card", JSONObject().put("id", "N").put("title", "New")).put("full", JSONObject().put("id", "N"))
        assertTrue(NotesLogic.applyAnswer(section, fresh))
        assertEquals(listOf("L", "N", "T"), Snapshot.notes(section)!!.cards.map { it.id })
        val again = JSONObject().put("card", JSONObject().put("id", "T").put("title", "Gate 2"))
        NotesLogic.applyAnswer(section, again)
        assertEquals(listOf("L", "N", "T"), Snapshot.notes(section)!!.cards.map { it.id })
        assertEquals("Gate 2", Snapshot.notes(section)!!.cards.last().title)
        NotesLogic.applyAnswer(section, JSONObject().put("card", JSONObject().put("id", "N")).put("archived", true))
        assertEquals(listOf("L", "T"), Snapshot.notes(section)!!.cards.map { it.id })
    }

    @Test
    fun a_gone_note_and_an_unknown_one() = runBlocking {
        WidgetStore.merge(ctx, JSONObject().put("notes", JSONObject().put("etag", "x").put("cards", JSONArray()).put("notes", JSONArray().put(JSONObject().put("id", "G").put("gone", true)))), 1000)
        assertTrue(NotesLogic.one(WidgetStore.state.value, "G")!!.gone)
        assertNull(NotesLogic.one(WidgetStore.state.value, "nope"))
    }
}
