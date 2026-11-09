package org.promptly.sync.widgets

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.app.SuiteLauncher
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.Locale

/** What the widgets show, worked out on the phone: the Agenda's days across
 *  midnight and a clock change, the Tasks list, staleness, redraw moments,
 *  and the deep-link path check. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WidgetLogicTest {
    private val syd = ZoneId.of("Australia/Sydney")
    private val clock = Clock(syd, use24 = true, locale = Locale.UK)

    private fun ms(y: Int, mo: Int, d: Int, h: Int, mi: Int = 0, zone: ZoneId = syd) =
        LocalDateTime.of(y, mo, d, h, mi).atZone(zone).toInstant().toEpochMilli()

    private fun utc(y: Int, mo: Int, d: Int, h: Int, mi: Int = 0, zone: ZoneId = syd) =
        java.time.Instant.ofEpochMilli(ms(y, mo, d, h, mi, zone)).toString()

    private fun ev(title: String, start: String, end: String, allDay: Boolean = false, cal: String? = "c1") =
        Occurrence("$title-id:x", "$title-id", start, end, allDay, title, "Room 1", "#123456", cal)

    private fun cal(vararg e: Occurrence, hidden: Boolean = false) = CalendarSection(
        "e1", "2026-11-09", 7,
        listOf(CalendarInfo("c1", "Mine", "#123456", false), CalendarInfo("c2", "Family", "#22AA55", hidden)),
        e.toList(),
    )

    @Test
    fun agenda_groups_days_and_drops_what_finished_today() {
        val now = ms(2026, 11, 9, 13)
        val c = cal(
            ev("Breakfast", utc(2026, 11, 9, 8), utc(2026, 11, 9, 9)),
            ev("Lunch", utc(2026, 11, 9, 12, 30), utc(2026, 11, 9, 14)),
            ev("Dinner", utc(2026, 11, 9, 19), utc(2026, 11, 9, 20)),
            ev("Trip", "2026-11-10", "2026-11-12", allDay = true),
            ev("Late night", utc(2026, 11, 10, 23), utc(2026, 11, 11, 1)),
        )
        val days = Agenda.days(c, AgendaConfig(), now, clock)
        assertEquals(listOf("Today", "Tomorrow", "Wed 11", "Thu 12"), days.map { it.label })
        val today = days[0]
        assertEquals(listOf("Lunch", "Dinner"), today.timed.map { it.occ.title })
        assertTrue(today.timed[0].happening)
        assertEquals("12:30", today.timed[0].label)
        // A long all-day event is on every day it covers; one past midnight continues.
        assertEquals(listOf("Trip"), days[1].allDay.map { it.title })
        assertEquals(listOf("Trip"), days[3].allDay.map { it.title })
        assertEquals("Until 01:00", days[2].timed.single { it.occ.title == "Late night" }.label)
    }

    @Test
    fun agenda_after_midnight_with_no_signal_moves_on() {
        val c = cal(ev("Tomorrow thing", utc(2026, 11, 10, 9), utc(2026, 11, 10, 10)))
        val before = Agenda.days(c, AgendaConfig(), ms(2026, 11, 9, 23, 50), clock)
        assertEquals("Tomorrow", before[1].label)
        val after = Agenda.days(c, AgendaConfig(), ms(2026, 11, 10, 0, 5), clock)
        assertEquals("Today", after[0].label)
        assertEquals(listOf("Tomorrow thing"), after[0].timed.map { it.occ.title })
    }

    @Test
    fun agenda_across_a_daylight_saving_change() {
        // Sydney moves its clocks forward at 2 am on 4 October 2026: that day is 23 hours long.
        val c = cal(ev("Sunday brunch", utc(2026, 10, 4, 10), utc(2026, 10, 4, 11)), ev("Monday", utc(2026, 10, 5, 9), utc(2026, 10, 5, 10)))
        val days = Agenda.days(c, AgendaConfig(), ms(2026, 10, 4, 1), clock)
        assertEquals(listOf("Sunday brunch"), days[0].timed.map { it.occ.title })
        assertEquals("10:00", days[0].timed[0].label)
        assertEquals(LocalDate.of(2026, 10, 5), days[1].date)
        assertEquals("09:00", days[1].timed[0].label)
    }

    @Test
    fun agenda_follows_the_chosen_calendars() {
        val c = cal(
            ev("Mine", utc(2026, 11, 9, 15), utc(2026, 11, 9, 16), cal = "c1"),
            ev("Family dinner", utc(2026, 11, 9, 18), utc(2026, 11, 9, 19), cal = "c2"),
            ev("Invite", utc(2026, 11, 9, 20), utc(2026, 11, 9, 21), cal = null),
            hidden = true,
        )
        val now = ms(2026, 11, 9, 13)
        assertEquals(listOf("Mine", "Invite"), Agenda.days(c, AgendaConfig(), now, clock)[0].timed.map { it.occ.title })
        val picked = AgendaConfig(AgendaConfig.PICK, setOf("c2"))
        assertEquals(listOf("Family dinner"), Agenda.days(c, picked, now, clock)[0].timed.map { it.occ.title })
        val invites = AgendaConfig(AgendaConfig.PICK, setOf(AgendaConfig.INVITED))
        assertEquals(listOf("Invite"), Agenda.days(c, invites, now, clock)[0].timed.map { it.occ.title })
    }

    @Test
    fun agenda_small_and_empty_lines() {
        val now = ms(2026, 11, 9, 13)
        assertEquals(listOf("Nothing on this week"), lines(Agenda.days(cal(), AgendaConfig(), now, clock), small = false).map { (it as Line.Empty).text })
        val later = cal(ev("Thursday", utc(2026, 11, 12, 9), utc(2026, 11, 12, 10)))
        val big = lines(Agenda.days(later, AgendaConfig(), now, clock), small = false)
        assertEquals("Nothing else today", (big[0] as Line.Empty).text)
        val small = lines(Agenda.days(later, AgendaConfig(), now, clock), small = true)
        assertEquals("Thu 12", (small.single() as Line.Timed).prefix)
    }

    private fun tasks(vararg t: TaskItem) = WidgetState(
        snapshot = Snapshot(1, "Australia/Sydney", null, TasksSection("t1", "F", listOf(TaskList("inbox", "Inbox", null), TaskList("home", "Home", "#E2725B")), t.toList()), null),
    )

    private fun task(id: String, due: String?, time: String? = null, list: String = "inbox") = TaskItem(id, "Task $id", due, time, 0, list, false)

    @Test
    fun tasks_today_overdue_and_undated() {
        val now = ms(2026, 11, 9, 13)
        val s = tasks(
            task("a", "2026-11-09"), task("b", "2026-11-05"), task("c", "2026-11-09", "09:00", "home"),
            task("d", "2026-11-09", "17:00"), task("e", "2026-11-10"), task("f", null),
        )
        val v = Tasks.view(s, TasksConfig(), now, clock)
        assertEquals(listOf("b", "c", "d", "a"), v.rows.map { it.id })
        assertEquals(listOf(true, true, false, false), v.rows.map { it.overdue })
        assertEquals(3, v.today)
        assertEquals(2, v.overdue)
        assertEquals("Thu 5", v.rows[0].label)
        assertEquals("Home", v.rows.single { it.id == "c" }.listName)
        assertEquals(listOf("c"), Tasks.view(s, TasksConfig(listId = "home"), now, clock).rows.map { it.id })
        assertTrue("f" in Tasks.view(s, TasksConfig(someday = true), now, clock).rows.map { it.id })
        // Past midnight with no signal: tomorrow's task is today's.
        assertTrue("e" in Tasks.view(s, TasksConfig(), ms(2026, 11, 10, 0, 1), clock).rows.map { it.id })
    }

    @Test
    fun ticked_task_is_struck_then_gone_and_a_local_one_shows() {
        val now = ms(2026, 11, 9, 13)
        val base = tasks(task("a", "2026-11-09"), task("b", "2026-11-09"))
        val add = Op("cid1", Op.ADD_TASK, JSONObject().put("title", "Milk").put("due", "2026-11-09").put("list_id", JSONObject.NULL), now, "Milk")
        val s = base.copy(ticks = listOf(Tick("F", "a", "2026-11-09", now - 1000, "Task a", "inbox", null)), ops = listOf(add))
        val v = Tasks.view(s, TasksConfig(), now, clock)
        assertTrue(v.rows.single { it.id == "a" }.struck)
        assertTrue(v.rows.single { it.id == "local:cid1" }.pending)
        assertEquals(2, v.today) // b and Milk
        val later = Tasks.view(s, TasksConfig(), now + WidgetStore.STRUCK_MS, clock)
        assertFalse("a" in later.rows.map { it.id })
        // Already gone from the snapshot (synced fast): still struck for its moment.
        val gone = s.copy(snapshot = tasks(task("b", "2026-11-09")).snapshot)
        assertTrue(Tasks.view(gone, TasksConfig(), now, clock).rows.single { it.id == "a" }.struck)
    }

    @Test
    fun stale_label_and_redraw_moments() {
        val now = ms(2026, 11, 9, 13)
        assertNull(staleLabel(now - 60_000, now, clock))
        assertNull(staleLabel(0, now, clock))
        assertEquals("Updated 10:42", staleLabel(ms(2026, 11, 9, 10, 42), now, clock))
        assertEquals("Updated yesterday", staleLabel(ms(2026, 11, 8, 10, 42), now, clock))

        val snap = Snapshot(1, null, cal(ev("Soon", utc(2026, 11, 9, 15), utc(2026, 11, 9, 16))), tasks(task("x", "2026-11-09", "14:30")).snapshot.tasks, null)
        assertEquals(ms(2026, 11, 9, 14, 30), Boundaries.next(snap, now, syd))
        assertEquals(ms(2026, 11, 9, 15), Boundaries.next(snap, ms(2026, 11, 9, 14, 31), syd))
        assertEquals(ms(2026, 11, 10, 0), Boundaries.next(snap, ms(2026, 11, 9, 16, 30), syd)) // midnight
    }

    @Test
    fun url_path_takes_only_this_servers_paths() {
        assertEquals("/calendar?event=abc", SuiteLauncher.safePath("/calendar?event=abc"))
        assertEquals("/apps/tasks/f?task=t1", SuiteLauncher.safePath("/apps/tasks/f?task=t1"))
        for (bad in listOf("//evil.example", "https://evil.example/x", "/\\evil.example", "javascript:alert(1)", "", "calendar", "/a b", "/a\nb", null)) {
            assertNull(bad, SuiteLauncher.safePath(bad))
        }
    }

    @Test
    fun task_path_for_server_and_local_tasks() {
        assertEquals("/apps/tasks/F?task=t1", taskPath("F", "t1"))
        assertEquals("/app/open/tasks", taskPath("F", "local:abc"))
        assertEquals("/app/open/tasks", taskPath(null, "t1"))
    }
}
