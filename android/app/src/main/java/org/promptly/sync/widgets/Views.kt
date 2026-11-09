package org.promptly.sync.widgets

import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

/*
 * What each widget shows, worked out from the saved copy on the phone, the
 * phone's own clock and zone, and the widget's settings — pure functions,
 * tested on their own. "Today" is always now's date here, so a widget is
 * right after midnight (or a flight) with no signal.
 */

/** Words for times and days, the phone's way (12/24-hour, its language). */
class Clock(val zone: ZoneId, val use24: Boolean, val locale: Locale = Locale.getDefault()) {
    private val t24 = DateTimeFormatter.ofPattern("HH:mm", locale)
    private val t12 = DateTimeFormatter.ofPattern("h:mm a", locale)
    private val short = DateTimeFormatter.ofPattern("EEE d", locale)
    private val long = DateTimeFormatter.ofPattern("EEEE d MMMM", locale)
    private val month = DateTimeFormatter.ofPattern("d MMM", locale)

    fun time(t: LocalTime): String = (if (use24) t24 else t12).format(t).replace("AM", "am").replace("PM", "pm")
    fun time(epochMs: Long): String = time(Instant.ofEpochMilli(epochMs).atZone(zone).toLocalTime())

    /** "Today", "Tomorrow", "Wed 12". */
    fun day(d: LocalDate, today: LocalDate): String = when (ChronoUnit.DAYS.between(today, d)) {
        0L -> "Today"
        1L -> "Tomorrow"
        -1L -> "Yesterday"
        in 2L..6L, in -6L..-2L -> short.format(d)
        else -> month.format(d)
    }

    /** "Monday 9 November". */
    fun longDay(d: LocalDate): String = long.format(d)
}

// ------------------------------------------------------------------ Agenda

/** Which calendars an Agenda widget shows. [WEB]: the ones ticked on the web,
 *  and invitations. [picked]: only these ids ("invited" for invitations). */
data class AgendaConfig(val mode: String = WEB, val picked: Set<String> = emptySet(), val titlesOnly: Boolean = false) {
    companion object {
        const val WEB = "web"
        const val PICK = "pick"
        const val INVITED = "invited"
    }
}

data class AgendaRow(val occ: Occurrence, val label: String, val happening: Boolean)

data class AgendaDay(val date: LocalDate, val label: String, val allDay: List<Occurrence>, val timed: List<AgendaRow>)

object Agenda {
    fun instant(s: String): Long? = if (s.length <= 10) null else runCatching { Instant.parse(s).toEpochMilli() }.getOrNull()

    private fun date(s: String): LocalDate? = runCatching { LocalDate.parse(s.take(10)) }.getOrNull()

    fun shown(cal: CalendarSection, cfg: AgendaConfig): List<Occurrence> {
        val hidden = cal.calendars.filter { it.hidden }.map { it.id }.toSet()
        return cal.events.filter { e ->
            val key = e.calendarId ?: AgendaConfig.INVITED
            if (cfg.mode == AgendaConfig.PICK) key in cfg.picked else key !in hidden
        }
    }

    /**
     * Today (what's left of it) and the next days that have something, up to
     * [maxDays] days. Each day: all-day events (a long one on every day it
     * covers), then timed ones overlapping it, by start.
     */
    fun days(cal: CalendarSection?, cfg: AgendaConfig, now: Long, clock: Clock, maxDays: Int = 7): List<AgendaDay> {
        val zone = clock.zone
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val events = cal?.let { shown(it, cfg) } ?: return listOf(AgendaDay(today, "Today", emptyList(), emptyList()))
        val out = mutableListOf<AgendaDay>()
        for (i in 0 until maxDays) {
            val d = today.plusDays(i.toLong())
            val dayStart = d.atStartOfDay(zone).toInstant().toEpochMilli()
            val dayEnd = d.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
            val allDay = events.filter { e ->
                if (!e.allDay) return@filter false
                val s = date(e.start) ?: return@filter false
                val last = date(e.end) ?: s
                !d.isBefore(s) && !d.isAfter(last)
            }
            val timed = events.mapNotNull { e ->
                if (e.allDay) return@mapNotNull null
                val s = instant(e.start) ?: return@mapNotNull null
                val en = instant(e.end) ?: s
                val overlaps = s < dayEnd && maxOf(en, s + 1) > dayStart
                // Today: only what hasn't finished yet.
                if (!overlaps || (i == 0 && en <= now && en > s)) return@mapNotNull null
                val label = when {
                    s >= dayStart -> clock.time(s)
                    en < dayEnd -> "Until ${clock.time(en)}"
                    else -> "All day"
                }
                AgendaRow(e, label, s <= now && now < en)
            }.sortedWith(compareBy({ instant(it.occ.start) ?: 0L }, { it.occ.title }))
            if (i == 0 || allDay.isNotEmpty() || timed.isNotEmpty()) out += AgendaDay(d, clock.day(d, today), allDay, timed)
        }
        return out
    }
}

// ------------------------------------------------------------------ Tasks

/** Which tasks a Tasks widget shows: every list or one, and the undated ones or not. */
data class TasksConfig(val listId: String? = null, val someday: Boolean = false)

data class TaskRow(
    val fileId: String?,
    val id: String,
    val title: String,
    val due: String?,
    val time: String?,
    val listId: String,
    val listName: String,
    val listColor: String?,
    val overdue: Boolean,
    val struck: Boolean,
    val pending: Boolean,
    val label: String,
)

data class TasksView(val today: Int, val overdue: Int, val rows: List<TaskRow>, val listName: String?)

object Tasks {
    /**
     * Overdue (red) then today's, then — if asked — the undated ones; tasks
     * added on this phone and not sent yet included; one ticked here shown
     * struck through for [WidgetStore.STRUCK_MS], then gone.
     */
    fun view(state: WidgetState, cfg: TasksConfig, now: Long, clock: Clock): TasksView {
        val sec = state.snapshot.tasks
        val fileId = sec?.fileId
        val lists = sec?.lists.orEmpty().associateBy { it.id }
        val zoned = Instant.ofEpochMilli(now).atZone(clock.zone)
        val today = zoned.toLocalDate()
        val todayS = today.toString()
        val nowClock = zoned.toLocalTime()

        val ticks = state.ticks.associateBy { it.key }
        val local = state.ops.filter { it.type == Op.ADD_TASK }.map { op ->
            TaskItem("local:${op.id}", op.label, op.body.optString("due").takeIf { !op.body.isNull("due") && it.isNotBlank() }, null, 0,
                op.body.optString("list_id").takeIf { !op.body.isNull("list_id") && it.isNotBlank() } ?: "inbox", repeats = false, pending = true)
        }
        val all = sec?.tasks.orEmpty() + local
        val seen = mutableSetOf<String>()
        val rows = mutableListOf<TaskRow>()
        fun row(t: TaskItem, struck: Boolean): TaskRow {
            val due = t.due?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
            val late = !struck && due != null && (due.isBefore(today) ||
                (due == today && t.time != null && runCatching { LocalTime.parse(t.time) }.getOrNull()?.isBefore(nowClock) == true))
            val label = when {
                due == null -> ""
                due == today -> t.time?.let { runCatching { clock.time(LocalTime.parse(it)) }.getOrNull() } ?: ""
                else -> clock.day(due, today)
            }
            val lst = lists[t.listId]
            return TaskRow(fileId, t.id, t.title, t.due, t.time, t.listId, lst?.name ?: "Inbox", lst?.color, late, struck, t.pending, label)
        }
        for (t in all) {
            if (cfg.listId != null && t.listId != cfg.listId) continue
            val due = t.due
            val inView = when {
                due == null -> cfg.someday
                else -> due <= todayS
            }
            if (!inView) continue
            val tick = ticks[Tick.key(fileId ?: "", t.id, due)]
            if (tick != null && now - tick.at >= WidgetStore.STRUCK_MS) continue
            seen += Tick.key(fileId ?: "", t.id, due)
            rows += row(t, struck = tick != null)
        }
        // Ticked a moment ago and already gone from the snapshot: still shown struck.
        for (tk in state.ticks) {
            if (tk.key in seen || now - tk.at >= WidgetStore.STRUCK_MS || tk.fileId != (fileId ?: tk.fileId)) continue
            if (cfg.listId != null && tk.listId != cfg.listId) continue
            rows += row(TaskItem(tk.taskId, tk.title, tk.due, tk.time, 0, tk.listId, false), struck = true)
        }
        val order = compareBy<TaskRow>(
            { if (it.due == null) 2 else if (it.overdue && it.due < todayS) 0 else 1 },
            { it.due ?: "9999" },
            { it.time ?: "99:99" },
        )
        val sorted = rows.sortedWith(order)
        return TasksView(
            today = sorted.count { !it.struck && it.due == todayS },
            overdue = sorted.count { !it.struck && it.overdue },
            rows = sorted,
            listName = cfg.listId?.let { lists[it]?.name ?: if (it == "inbox") "Inbox" else null },
        )
    }
}

/** "Updated 10:42" once the saved copy is over two hours old (or never fetched). */
fun staleLabel(fetchedAt: Long, now: Long, clock: Clock): String? = when {
    fetchedAt <= 0L -> null
    now - fetchedAt < 2 * 60 * 60 * 1000L -> null
    Instant.ofEpochMilli(fetchedAt).atZone(clock.zone).toLocalDate() == Instant.ofEpochMilli(now).atZone(clock.zone).toLocalDate() ->
        "Updated ${clock.time(fetchedAt)}"
    else -> "Updated " + clock.day(Instant.ofEpochMilli(fetchedAt).atZone(clock.zone).toLocalDate(), Instant.ofEpochMilli(now).atZone(clock.zone).toLocalDate())
        .replace("Yesterday", "yesterday")
}

