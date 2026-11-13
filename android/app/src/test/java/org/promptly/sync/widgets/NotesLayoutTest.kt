package org.promptly.sync.widgets

import android.content.Context
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.testing.unit.runGlanceAppWidgetUnitTest
import androidx.glance.testing.unit.hasContentDescription
import androidx.glance.testing.unit.hasText
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.Locale

/** The Notes and One note widgets in each state: before the first sync,
 *  empty, cards and lists (tickable), titles only, waiting to sync, a voice
 *  note; One note's pick / gone / list with ticked items / text. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NotesLayoutTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val syd = ZoneId.of("Australia/Sydney")
    private val clock = Clock(syd, use24 = true, locale = Locale.UK)
    private val now = LocalDateTime.of(2026, 11, 9, 13, 0).atZone(syd).toInstant().toEpochMilli()
    private val tall = DpSize(300.dp, 300.dp)
    private val wide = DpSize(300.dp, 140.dp)
    private val small = DpSize(120.dp, 120.dp)
    /** Narrow, and tall enough for a card under the buttons (the widget doesn't scroll). */
    private val narrowTall = DpSize(120.dp, 300.dp)

    private val shopping = NoteCard(
        "L", "list", "Shopping", "sand", pinned = true,
        items = listOf(NoteItemRow("a", "Eggs", false, false), NoteItemRow("b", "Milk", false, false), NoteItemRow("c", "Lemons", true, false)),
        left = 2, total = 3,
    )
    private val gate = NoteCard("T", "text", "Gate", "mint", text = "Code 4471\nSide door")
    private val song = NoteCard("V", "text", "Voice note", "default", voice = true)

    private fun state(cards: List<NoteCard>? = listOf(shopping, gate, song), full: List<NoteCard> = listOf(shopping), fetched: Long = now - 60_000, ops: List<Op> = emptyList()) =
        WidgetState(Snapshot(fetched, null, null, null, null, cards?.let { NotesSection("e", it, full) }), ops = ops, loaded = true)

    @Test
    fun notes_cards_with_tickable_items() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(tall)
        provideComposable { NotesContent(state(), NotesConfig(), now, clock, tall) }
        onNode(hasText("Take a note…")).assertExists()
        onNode(hasContentDescription("New list")).assertExists()
        onNode(hasContentDescription("Voice note")).assertExists()
        onNode(hasText("Shopping")).assertExists()
        onNode(hasContentDescription("Tick Eggs")).assertExists()
        onNode(hasContentDescription("Tick Milk")).assertExists()
        onNode(hasText("Lemons")).assertDoesNotExist() // ticked: not on the card
        onNode(hasText("Code 4471\nSide door")).assertExists()
        onNode(hasContentDescription("Pinned")).assertExists()
    }

    @Test
    fun notes_narrow_has_three_buttons() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(narrowTall)
        provideComposable { NotesContent(state(), NotesConfig(), now, clock, narrowTall) }
        onNode(hasContentDescription("Take a note")).assertExists()
        onNode(hasText("Take a note…")).assertDoesNotExist()
        onNode(hasText("Shopping")).assertExists()
    }

    @Test
    fun notes_too_small_for_a_card_says_how_many_instead_of_cutting_one_off() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(small)
        provideComposable { NotesContent(state(), NotesConfig(), now, clock, small) }
        onNode(hasContentDescription("Take a note")).assertExists()
        onNode(hasText("3 notes")).assertExists()
    }

    @Test
    fun notes_titles_only() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(wide)
        provideComposable { NotesContent(state(), NotesConfig(titlesOnly = true), now, clock, wide) }
        onNode(hasText("Gate")).assertExists()
        onNode(hasText("Code 4471\nSide door")).assertDoesNotExist()
        onNode(hasContentDescription("Tick Eggs")).assertDoesNotExist()
    }

    @Test
    fun notes_empty_and_first_sync() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(wide)
        provideComposable { NotesContent(state(cards = emptyList(), full = emptyList()), NotesConfig(), now, clock, wide) }
        onNode(hasText("No notes yet")).assertExists()
    }

    @Test
    fun notes_before_the_first_sync() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        provideComposable { NotesContent(state(cards = null, fetched = 0), NotesConfig(), now, clock, wide) }
        onNode(hasText("Getting your notes…")).assertExists()
    }

    @Test
    fun a_voice_note_waiting_to_sync() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(tall)
        val op = Op("new1", Op.NEW_NOTE, JSONObject().put("kind", "text").put("source", "voice")
            .put("files", org.json.JSONArray().put(JSONObject().put("id", "a").put("mime", "audio/mp4").put("path", "/x"))), now, "Voice note")
        provideComposable { NotesContent(state(ops = listOf(op)), NotesConfig(), now, clock, tall) }
        onNode(hasText("Will sync")).assertExists()
        onNode(hasContentDescription("Saved on this phone — will sync")).assertExists()
    }

    @Test
    fun notes_stale_and_notice() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(wide)
        val s = state().copy(notices = listOf(Notice("n", "Couldn't save the voice note.", now, "notes"), Notice("t", "A tasks one", now, "tasks")))
        provideComposable { NotesContent(s, NotesConfig(), now, clock, wide) }
        onNode(hasText("Couldn't save the voice note.")).assertExists()
        onNode(hasText("A tasks one")).assertDoesNotExist()
    }

    @Test
    fun one_note_list_with_ticked_below() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(tall)
        provideComposable { OneNoteContent(state(), "L", "Shopping", now, clock, 7) }
        onNode(hasText("Shopping")).assertExists()
        onNode(hasText("2 left")).assertExists()
        onNode(hasContentDescription("Tick Eggs")).assertExists()
        onNode(hasText("1 ticked")).assertExists()
        onNode(hasContentDescription("Untick Lemons")).assertExists()
        onNode(hasContentDescription("Add to Shopping")).assertExists()
    }

    @Test
    fun one_note_text() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(tall)
        provideComposable { OneNoteContent(state(full = listOf(gate)), "T", "Gate", now, clock, 7) }
        onNode(hasText("Code 4471\nSide door")).assertExists()
        onNode(hasContentDescription("Add to Gate")).assertDoesNotExist()
    }

    @Test
    fun one_note_pick_and_gone() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(tall)
        provideComposable { OneNoteContent(state(), null, "", now, clock, 7) }
        onNode(hasText("Pick a note")).assertExists()
    }

    @Test
    fun one_note_gone() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(tall)
        provideComposable { OneNoteContent(state(full = listOf(NoteCard("X", gone = true))), "X", "Old list", now, clock, 7) }
        onNode(hasText("This note isn't available")).assertExists()
    }

    @Test
    fun one_note_not_synced_yet() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(tall)
        provideComposable { OneNoteContent(state(), "new-pick", "Recipes", now, clock, 7) }
        onNode(hasText("Recipes")).assertExists()
        onNode(hasText("Getting it…")).assertExists()
    }

    @Test
    fun previews_draw_from_samples() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(tall)
        provideComposable { NotesContent(Samples.notes(), NotesConfig(), Samples.now(), clock, tall) }
        onNode(hasText("Gate code")).assertExists()
        onNode(hasContentDescription("Tick Oat milk")).assertExists()
    }

    @Test
    fun agenda_and_tasks_previews() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(tall)
        provideComposable { TasksContent(Samples.calendarAndTasks(syd), TasksConfig(), Samples.now(), clock, small = false) }
        onNode(hasText("Book the car service")).assertExists()
    }
}
