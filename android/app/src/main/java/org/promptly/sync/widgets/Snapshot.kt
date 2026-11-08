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

/** The whole cached snapshot. [fetchedAt]: when the phone last heard from the server. */
data class Snapshot(
    val fetchedAt: Long,
    val tz: String?,
    val calendar: CalendarSection?,
    val tasks: TasksSection?,
    val notes: JSONObject?,
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
