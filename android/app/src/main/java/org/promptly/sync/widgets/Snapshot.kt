package org.promptly.sync.widgets

import org.json.JSONArray
import org.json.JSONObject

/*
 * What the server's /api/widgets/snapshot says, as the widgets read it. The
 * cache keeps the JSON as it came (one object per section, with its etag);
 * these are the parsed views of it. Unknown fields are ignored and missing
 * ones have defaults, so an older or newer server never breaks a widget.
 */

data class CalendarInfo(val id: String, val name: String, val color: String, val hidden: Boolean)

/** One occurrence. [start]/[end] are UTC instants ("…Z"), or dates for all-day
 *  ones ([end] is the last day, inclusive). [calendarId] null: an invitation. */
data class Occurrence(
    val id: String,
    val eventId: String,
    val start: String,
    val end: String,
    val allDay: Boolean,
    val title: String,
    val location: String,
    val color: String,
    val calendarId: String?,
)

data class CalendarSection(val etag: String, val from: String, val days: Int, val calendars: List<CalendarInfo>, val events: List<Occurrence>)

data class TaskList(val id: String, val name: String, val color: String?)

data class TaskItem(
    val id: String,
    val title: String,
    val due: String?,
    val time: String?,
    val priority: Int,
    val listId: String,
    val repeats: Boolean,
    /** Made on this phone and not on the server yet. */
    val pending: Boolean = false,
)

data class TasksSection(val etag: String, val fileId: String?, val lists: List<TaskList>, val tasks: List<TaskItem>)

/** One item of a list note. [pending]: added on this phone, not on the server yet.
 *  [settling]: ticked here a moment ago — shown ticked where it was, so a second
 *  tap on the same spot undoes it, then it moves down with the ticked ones. */
data class NoteItemRow(
    val id: String, val text: String, val checked: Boolean, val indent: Boolean, val pending: Boolean = false, val settling: Boolean = false,
)

/**
 * A note as the Notes widgets show it: a card (title, colour, ≤300 characters
 * or ≤12 items) or, for a One note widget, the whole of it. [gone]: it isn't
 * yours to open any more. [pending]: made on this phone, not sent yet.
 */
data class NoteCard(
    val id: String,
    val kind: String = "text",
    val title: String = "",
    val color: String = "default",
    val pinned: Boolean = false,
    val shared: Boolean = false,
    val voice: Boolean = false,
    val image: Boolean = false,
    val text: String = "",
    val items: List<NoteItemRow> = emptyList(),
    val left: Int = 0,
    val total: Int = 0,
    val gone: Boolean = false,
    val pending: Boolean = false,
) {
    val isList: Boolean get() = kind == "list"
}

data class NotesSection(val etag: String, val cards: List<NoteCard>, val notes: List<NoteCard>)

/** The whole cached snapshot. [fetchedAt]: when the phone last heard from the server. */
data class Snapshot(
    val fetchedAt: Long,
    val tz: String?,
    val calendar: CalendarSection?,
    val tasks: TasksSection?,
    val notes: JSONObject?,
    val notesSection: NotesSection? = notes?.let { Snapshot.notes(it) },
) {
    companion object {
        val EMPTY = Snapshot(0, null, null, null, null)

        fun parse(j: JSONObject?): Snapshot {
            if (j == null) return EMPTY
            return Snapshot(
                fetchedAt = j.optLong("fetched_at", 0),
                tz = j.optString("tz").ifBlank { null },
                calendar = j.optJSONObject("calendar")?.let(::calendar),
                tasks = j.optJSONObject("tasks")?.let(::tasks),
                notes = j.optJSONObject("notes"),
            )
        }

        fun note(it: JSONObject): NoteCard = NoteCard(
            id = it.optString("id"),
            kind = it.optString("kind", "text").ifBlank { "text" },
            title = it.optString("title"),
            color = it.optString("color", "default").ifBlank { "default" },
            pinned = it.optBoolean("pinned"),
            shared = it.optBoolean("shared"),
            voice = it.optBoolean("voice"),
            image = it.optBoolean("image"),
            text = it.optString("text"),
            items = it.optJSONArray("items").objects().map { i ->
                NoteItemRow(i.optString("id"), i.optString("text"), i.optBoolean("checked"), i.optBoolean("indent"))
            },
            left = it.optInt("left", 0),
            total = it.optInt("total", 0),
            gone = it.optBoolean("gone"),
        )

        fun notes(j: JSONObject): NotesSection? {
            if (!j.has("cards")) return null
            return NotesSection(
                etag = j.optString("etag"),
                cards = j.optJSONArray("cards").objects().map(::note),
                notes = j.optJSONArray("notes").objects().map(::note),
            )
        }

        private fun JSONArray?.objects(): List<JSONObject> =
            if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

        private fun JSONObject.str(key: String): String? = if (isNull(key)) null else optString(key).ifEmpty { null }

        fun calendar(j: JSONObject): CalendarSection? {
            if (!j.has("events")) return null
            return CalendarSection(
                etag = j.optString("etag"),
                from = j.optString("from"),
                days = j.optInt("days", 7),
                calendars = j.optJSONArray("calendars").objects().map {
                    CalendarInfo(it.optString("id"), it.optString("name"), it.optString("color", "#4F7FE0"), it.optBoolean("hidden"))
                },
                events = j.optJSONArray("events").objects().map {
                    Occurrence(
                        id = it.optString("id"),
                        eventId = it.optString("event_id"),
                        start = it.optString("start"),
                        end = it.optString("end"),
                        allDay = it.optBoolean("all_day"),
                        title = it.optString("title").ifBlank { "Untitled event" },
                        location = it.optString("location"),
                        color = it.optString("color", "#4F7FE0"),
                        calendarId = it.str("calendar_id"),
                    )
                },
            )
        }

        fun task(it: JSONObject, pending: Boolean = false) = TaskItem(
            id = it.optString("id"),
            title = it.optString("title"),
            due = it.str("due"),
            time = it.str("time"),
            priority = it.optInt("priority", 0),
            listId = it.optString("list_id", "inbox").ifBlank { "inbox" },
            repeats = it.optBoolean("repeats"),
            pending = pending,
        )

        fun tasks(j: JSONObject): TasksSection? {
            if (!j.has("tasks")) return null
            return TasksSection(
                etag = j.optString("etag"),
                fileId = j.str("file_id"),
                lists = j.optJSONArray("lists").objects().map { TaskList(it.optString("id"), it.optString("name"), it.str("color")) },
                tasks = j.optJSONArray("tasks").objects().map { task(it) },
            )
        }
    }
}
