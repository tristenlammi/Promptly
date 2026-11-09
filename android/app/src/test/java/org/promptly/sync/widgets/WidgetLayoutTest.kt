package org.promptly.sync.widgets

import android.content.Context
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.testing.unit.runGlanceAppWidgetUnitTest
import androidx.glance.testing.unit.hasContentDescription
import androidx.glance.testing.unit.hasText
import androidx.test.core.app.ApplicationProvider
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.Locale

/** The widgets' layouts in each state: not linked / removed / off, waiting for
 *  the first sync, empty, a list, stale, a notice; small and big sizes. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WidgetLayoutTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val syd = ZoneId.of("Australia/Sydney")
    private val clock = Clock(syd, use24 = true, locale = Locale.UK)
    private val now = LocalDateTime.of(2026, 11, 9, 13, 0).atZone(syd).toInstant().toEpochMilli()
    private fun iso(h: Int, d: Int = 9) = LocalDateTime.of(2026, 11, d, h, 0).atZone(syd).toInstant().toString()

    private val calendar = CalendarSection(
        "c", "2026-11-09", 7, listOf(CalendarInfo("c1", "Mine", "#3B7DD8", false)),
        listOf(
            Occurrence("e1:x", "e1", iso(15), iso(16), false, "Dentist", "12 High St", "#3B7DD8", "c1"),
            Occurrence("e2:x", "e2", "2026-11-10", "2026-11-10", true, "Sam's birthday", "", "#22AA55", "c1"),
            Occurrence("e3:x", "e3", iso(9, 11), iso(10, 11), false, "Standup", "", "#3B7DD8", "c1"),
        ),
    )
    private val tasks = TasksSection(
        "t", "F", listOf(TaskList("inbox", "Inbox", null), TaskList("home", "Home", "#E2725B")),
        listOf(
            TaskItem("a", "Pay rent", "2026-11-09", null, 0, "home", false),
            TaskItem("b", "Call the bank", "2026-11-06", null, 0, "inbox", false),
        ),
    )
    private fun state(cal: CalendarSection? = calendar, t: TasksSection? = tasks, fetched: Long = now - 60_000, notices: List<Notice> = emptyList()) =
        WidgetState(Snapshot(fetched, "Australia/Sydney", cal, t, null), notices = notices, loaded = true)

    private val big = DpSize(300.dp, 300.dp)
    private val small = DpSize(120.dp, 120.dp)

    @Test
    fun link_states() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        provideComposable { LinkMessage(ctx, Link.NOT_LINKED) }
        onNode(hasText("Link this phone to Promptly")).assertExists()
    }

    @Test
    fun removed_state() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        provideComposable { LinkMessage(ctx, Link.REMOVED) }
        onNode(hasText("This phone was removed")).assertExists()
        onNode(hasText("Tap to link it again.")).assertExists()
    }

    @Test
    fun off_state() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        provideComposable { LinkMessage(ctx, Link.OFF) }
        onNode(hasText("Widgets are off for this phone")).assertExists()
    }

    @Test
    fun agenda_list() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(big)
        provideComposable { AgendaContent(state(), AgendaConfig(), now, clock, small = false) }
        onNode(hasText("Monday 9 November")).assertExists()
        onNode(hasText("Dentist")).assertExists()
        onNode(hasText("12 High St")).assertExists()
        onNode(hasText("15:00")).assertExists()
        onNode(hasText("Tomorrow")).assertExists()
        onNode(hasText("Sam's birthday")).assertExists()
        onNode(hasText("Wed 11")).assertExists()
        onNode(hasContentDescription("New event")).assertExists()
    }

    @Test
    fun agenda_titles_only_hides_places() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(big)
        provideComposable { AgendaContent(state(), AgendaConfig(titlesOnly = true), now, clock, small = false) }
        onNode(hasText("Dentist")).assertExists()
        onNode(hasText("12 High St")).assertDoesNotExist()
    }

    @Test
    fun agenda_small_shows_the_next_two() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(small)
        provideComposable { AgendaContent(state(), AgendaConfig(), now, clock, small = true) }
        onNode(hasText("Dentist")).assertExists()
        onNode(hasText("Tomorrow · Sam's birthday")).assertExists()
        onNode(hasText("Standup")).assertDoesNotExist()
    }

    @Test
    fun agenda_empty_and_first_sync() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(big)
        provideComposable { AgendaContent(state(cal = CalendarSection("c", "2026-11-09", 7, emptyList(), emptyList())), AgendaConfig(), now, clock, small = false) }
        onNode(hasText("Nothing on this week")).assertExists()
    }

    @Test
    fun agenda_before_the_first_sync() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        provideComposable { AgendaContent(state(cal = null, fetched = 0), AgendaConfig(), now, clock, small = false) }
        onNode(hasText("Getting your calendar…")).assertExists()
    }

    @Test
    fun agenda_stale() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(big)
        val tenFortyTwo = LocalDateTime.of(2026, 11, 9, 10, 42).atZone(syd).toInstant().toEpochMilli()
        provideComposable { AgendaContent(state(fetched = tenFortyTwo), AgendaConfig(), now, clock, small = false) }
        onNode(hasText("Updated 10:42 · tap to refresh")).assertExists()
    }

    @Test
    fun tasks_list() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(big)
        provideComposable { TasksContent(state(), TasksConfig(), now, clock, small = false) }
        onNode(hasText("Today · 2")).assertExists()
        onNode(hasText("1 overdue")).assertExists()
        onNode(hasText("Pay rent")).assertExists()
        onNode(hasText("Call the bank")).assertExists()
        onNode(hasContentDescription("Tick off Pay rent")).assertExists()
        onNode(hasContentDescription("Quick task")).assertExists()
    }

    @Test
    fun tasks_all_done_and_notice() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(big)
        val done = tasks.copy(tasks = listOf(TaskItem("z", "Later", "2026-11-20", null, 0, "inbox", false)))
        provideComposable { TasksContent(state(t = done, notices = listOf(Notice("n", "Couldn't tick “X” — the task was deleted.", now))), TasksConfig(), now, clock, small = false) }
        onNode(hasText("All done for today")).assertExists()
        onNode(hasText("Couldn't tick “X” — the task was deleted.")).assertExists()
    }

    @Test
    fun tasks_one_list() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(big)
        provideComposable { TasksContent(state(), TasksConfig(listId = "home"), now, clock, small = false) }
        onNode(hasText("Home · 1")).assertExists()
        onNode(hasText("Call the bank")).assertDoesNotExist()
    }
}
