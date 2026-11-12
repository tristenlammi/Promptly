package org.promptly.sync.widgets

import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Made-up notes, events and tasks for the widget picker's previews (Android
 * 15+). Never anyone's own: the picker is seen before a phone is linked,
 * and by anyone holding it.
 */
object Samples {
    const val LIST_ID = "sample-shopping"

    fun now(): Long = System.currentTimeMillis()

    private fun item(id: String, text: String, checked: Boolean = false) = NoteItemRow(id, text, checked, indent = false)

    private val shopping = NoteCard(
        id = LIST_ID, kind = "list", title = "Shopping", color = "sand", pinned = true,
        items = listOf(item("a", "Eggs"), item("b", "Oat milk"), item("c", "Bread"), item("d", "Coffee beans"), item("e", "Lemons", checked = true)),
        left = 4, total = 5,
    )
    private val cards = listOf(
        shopping,
        NoteCard(id = "s2", title = "Gate code", color = "mint", text = "4471, then the side door.\nKey under the blue pot."),
        NoteCard(id = "s3", title = "Song idea", color = "dusk", voice = true, text = "Chorus in G — hum it first, then the words."),
        NoteCard(id = "s4", title = "Holiday packing", color = "fog", image = true, text = "Passports, chargers, the good sunhat."),
        NoteCard(id = "s5", title = "Book list", text = "The Overstory, Piranesi, A Gentleman in Moscow"),
    )

    fun notes(): WidgetState = WidgetState(
        snapshot = Snapshot(now(), null, null, null, null, NotesSection("", cards, listOf(shopping))),
        loaded = true,
    )

    fun calendarAndTasks(zone: ZoneId = ZoneId.systemDefault()): WidgetState {
        val today = LocalDate.now(zone)
        fun at(day: LocalDate, h: Int, m: Int = 0) = ZonedDateTime.of(day, LocalTime.of(h, m), zone).toInstant().toString()
        val nowHour = ZonedDateTime.now(zone).hour.coerceIn(6, 19)
        val cal = CalendarSection(
            "", today.toString(), 7, listOf(CalendarInfo("s", "Personal", "#3B7DD8", false), CalendarInfo("w", "Family", "#22AA55", false)),
            listOf(
                Occurrence("1", "1", at(today, nowHour + 1), at(today, nowHour + 2), false, "Dentist", "12 High St", "#3B7DD8", "s"),
                Occurrence("2", "2", at(today, nowHour + 3, 30), at(today, nowHour + 4), false, "Pick up Sam", "", "#22AA55", "w"),
                Occurrence("3", "3", today.plusDays(1).toString(), today.plusDays(1).toString(), true, "Mum's birthday", "", "#22AA55", "w"),
                Occurrence("4", "4", at(today.plusDays(2), 9), at(today.plusDays(2), 10), false, "Team standup", "", "#3B7DD8", "s"),
            ),
        )
        val tasks = TasksSection(
            "", "sample", listOf(TaskList("inbox", "Inbox", null), TaskList("home", "Home", "#E2725B")),
            listOf(
                TaskItem("t1", "Pay the water bill", today.minusDays(1).toString(), null, 0, "home", false),
                TaskItem("t2", "Book the car service", today.toString(), null, 0, "inbox", false),
                TaskItem("t3", "Water the plants", today.toString(), null, 0, "home", true),
                TaskItem("t4", "Call Alex back", today.toString(), "17:30", 0, "inbox", false),
            ),
        )
        return WidgetState(snapshot = Snapshot(now(), zone.id, cal, tasks, null), loaded = true)
    }

    /** Made-up numbers for the at-a-glance widgets' previews. */
    fun hub(): HubState {
        val eta = java.time.OffsetDateTime.now().plusMinutes(14).toString()
        val j = org.json.JSONObject(
            """
            {"counts": {"rooms": 3, "tasks": 2, "porch": 1, "mail": 4, "calendar": 2},
             "today": {"greeting": "Good morning", "weather": "Sunny, 27 degrees.", "events_left": 2, "tasks_due": 3, "tasks_overdue": 0,
                       "birthdays": ["Sam"], "next": {"title": "School pick-up", "time": "3:15 pm", "leave_by": "2:55 pm", "minutes": 14}},
             "macros": {"kcal": 1240, "kcal_target": 2200, "protein": 72, "protein_target": 140},
             "social": {"rooms": {"unread": 3, "items": [{"name": "Family", "where": "Home", "unread": 2}, {"name": "Sam", "where": "Direct message", "unread": 1}]},
                        "porch": {"new": 2, "from": ["Mum"], "thumb": null}},
             "maps": {"places": [{"kind": "home", "name": "Home", "minutes": 18, "traffic": true}, {"kind": "work", "name": "Work", "minutes": 25}],
                      "next": {"title": "School pick-up", "minutes": 14, "leave_by_label": "2:55 pm"}},
             "trips": [{"user_id": "s", "name": "Sam", "destination": "Home", "eta": "$eta"}],
             "health": {"weight": "82.4 kg", "unit": "kg", "series": [83.5, 83.2, null, 82.9, 82.8, 82.6, 82.4], "change": "−1.1 kg",
                        "workout": {"name": "Upper body", "date": "today", "time": "17:30"}},
             "mail": {"unread": 4, "items": [{"from": "School office", "subject": "Excursion form"}, {"from": "Bank", "subject": "Your statement is ready"}]}}
            """.trimIndent(),
        )
        return HubState(j, now(), null, 1)
    }
}
