package org.promptly.sync.widgets

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** A change made on this phone, waiting to reach the server. [id] is its
 *  client_id: sent again after a lost answer, the server does it once. */
data class Op(val id: String, val type: String, val body: JSONObject, val created: Long, val label: String, val tries: Int = 0) {
    fun json(): JSONObject = JSONObject().put("id", id).put("type", type).put("body", body).put("created", created).put("label", label).put("tries", tries)

    companion object {
        const val COMPLETE = "complete"
        const val ADD_TASK = "add_task"

        fun from(j: JSONObject) = Op(j.getString("id"), j.getString("type"), j.optJSONObject("body") ?: JSONObject(), j.optLong("created"), j.optString("label"), j.optInt("tries"))
    }
}

/** A task ticked on the widget: shown struck through for a moment, then gone. */
data class Tick(val fileId: String, val taskId: String, val due: String?, val at: Long, val title: String, val listId: String, val time: String?) {
    val key: String get() = key(fileId, taskId, due)
    fun json(): JSONObject = JSONObject().put("file_id", fileId).put("task_id", taskId).put("due", due ?: JSONObject.NULL).put("at", at)
        .put("title", title).put("list_id", listId).put("time", time ?: JSONObject.NULL)

    companion object {
        fun key(fileId: String, taskId: String, due: String?) = "$fileId/$taskId/${due ?: ""}"
        fun from(j: JSONObject) = Tick(
            j.getString("file_id"), j.getString("task_id"), if (j.isNull("due")) null else j.optString("due"), j.optLong("at"),
            j.optString("title"), j.optString("list_id", "inbox"), if (j.isNull("time")) null else j.optString("time"),
        )
    }
}

/** Something the widget should say once: "Couldn't tick … — the task was deleted." */
data class Notice(val id: String, val text: String, val at: Long)

/** Everything a widget draws from. [version] moves on every change (and on
 *  [WidgetStore.bump]), so a time-based redraw recomposes too. */
data class WidgetState(
    val snapshot: Snapshot = Snapshot.EMPTY,
    val ops: List<Op> = emptyList(),
    val ticks: List<Tick> = emptyList(),
    val notices: List<Notice> = emptyList(),
    val version: Int = 0,
    val loaded: Boolean = false,
)

/**
 * The widgets' saved copy: the last snapshot (``files/widgets/snapshot.json``,
 * written atomically), the outbox of changes made here, ticks and notices.
 * Widgets always draw from this, never from the network, so they work with
 * no signal; [WidgetSync] fills it and empties the outbox.
 */
object WidgetStore {
    const val STRUCK_MS = 3_000L
    private const val NOTICE_MS = 6 * 60 * 60 * 1000L
    private const val TICK_KEEP_MS = 2 * 24 * 60 * 60 * 1000L

    private val lock = Mutex()
    private val _state = MutableStateFlow(WidgetState())
    val state: StateFlow<WidgetState> = _state

    private var raw: JSONObject = JSONObject()

    private fun dir(ctx: Context) = File(ctx.applicationContext.filesDir, "widgets").apply { mkdirs() }

    private fun read(f: File): JSONObject? = runCatching { if (f.exists()) JSONObject(f.readText()) else null }.getOrNull()

    /** Write [text] to [f] all or nothing: a crash mid-write leaves the old file. */
    private fun writeAtomic(f: File, text: String) {
        val tmp = File(f.parentFile, f.name + ".tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(f)) {
            f.delete()
            tmp.renameTo(f)
        }
    }

    /** Read the files once per process (cheap after that). */
    suspend fun load(ctx: Context): WidgetState = withContext(Dispatchers.IO) {
        lock.withLock {
            if (!_state.value.loaded) {
                val d = dir(ctx)
                raw = read(File(d, "snapshot.json")) ?: JSONObject()
                val local = read(File(d, "local.json")) ?: JSONObject()
                val ops = read(File(d, "outbox.json"))?.optJSONArray("ops")
                _state.value = WidgetState(
                    snapshot = Snapshot.parse(raw),
                    ops = ops.list().map(Op::from),
                    ticks = local.optJSONArray("ticks").list().map(Tick::from),
                    notices = local.optJSONArray("notices").list().map { Notice(it.optString("id"), it.optString("text"), it.optLong("at")) },
                    version = 1,
                    loaded = true,
                )
            }
            _state.value
        }
    }

    private fun JSONArray?.list(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

    private fun saveOps(ctx: Context, ops: List<Op>) =
        writeAtomic(File(dir(ctx), "outbox.json"), JSONObject().put("ops", JSONArray(ops.map { it.json() })).toString())

    private fun saveLocal(ctx: Context, ticks: List<Tick>, notices: List<Notice>) = writeAtomic(
        File(dir(ctx), "local.json"),
        JSONObject().put("ticks", JSONArray(ticks.map { it.json() }))
            .put("notices", JSONArray(notices.map { JSONObject().put("id", it.id).put("text", it.text).put("at", it.at) })).toString(),
    )

    private fun saveSnapshot(ctx: Context) = writeAtomic(File(dir(ctx), "snapshot.json"), raw.toString())

    private suspend fun <T> change(ctx: Context, block: (WidgetState) -> Pair<WidgetState, T>): T = withContext(Dispatchers.IO) {
        load(ctx)
        lock.withLock {
            val before = _state.value
            val (after, out) = block(before)
            if (after.ops !== before.ops) saveOps(ctx, after.ops)
            if (after.ticks !== before.ticks || after.notices !== before.notices) saveLocal(ctx, after.ticks, after.notices)
            _state.value = after.copy(version = before.version + 1)
            out
        }
    }

    /** Redraw with nothing changed (a minute passed, midnight, a tick's moment is up). */
    fun bump() {
        _state.value = _state.value.copy(version = _state.value.version + 1)
    }

    // ------------------------------------------------------------ the snapshot

    /** Take the server's answer: a section marked unchanged (or that failed) keeps
     *  what's here; the rest is replaced. Ticks for tasks that are gone are dropped. */
    suspend fun merge(ctx: Context, answer: JSONObject, now: Long) = change(ctx) { s ->
        val next = JSONObject(raw.toString())
        next.put("fetched_at", now)
        answer.optString("tz").takeIf { it.isNotBlank() }?.let { next.put("tz", it) }
        for (name in SECTIONS) {
            val sec = answer.optJSONObject(name) ?: continue
            if (sec.optBoolean("unchanged") || sec.optBoolean("error")) continue
            next.put(name, sec)
        }
        raw = next
        saveSnapshot(ctx)
        val snap = Snapshot.parse(raw)
        val live = snap.tasks?.let { t -> t.tasks.map { Tick.key(t.fileId ?: "", it.id, it.due) }.toSet() } ?: emptySet()
        val pendingKeys = s.ops.filter { it.type == Op.COMPLETE }.map { Tick.key(it.body.optString("file_id"), it.body.optString("task_id"), it.body.str("due")) }.toSet()
        val ticks = s.ticks.filter { (it.key in live || it.key in pendingKeys || now - it.at < STRUCK_MS) && now - it.at < TICK_KEEP_MS }
        s.copy(snapshot = snap, ticks = if (ticks.size == s.ticks.size) s.ticks else ticks) to Unit
    }

    /** The etags we have, for the next request. */
    fun etags(): Map<String, String> =
        SECTIONS.mapNotNull { n -> raw.optJSONObject(n)?.optString("etag")?.takeIf { it.isNotBlank() }?.let { n to it } }.toMap()

    // ------------------------------------------------------------ changes made here

    /** Tick a task off (or, while it's still struck through, untick it).
     *  Returns true when it's now ticked. */
    suspend fun toggleTick(ctx: Context, fileId: String, taskId: String, due: String?, title: String, listId: String, time: String?, now: Long): Boolean =
        change(ctx) { s ->
            val key = Tick.key(fileId, taskId, due)
            val existing = s.ticks.firstOrNull { it.key == key }
            if (existing != null && now - existing.at < STRUCK_MS) {
                // Undo: drop the waiting tick, or send an untick if it already went.
                val waiting = s.ops.firstOrNull { it.type == Op.COMPLETE && it.body.optBoolean("done", true) && it.key() == key }
                val ops = if (waiting != null) s.ops - waiting else s.ops + Op(
                    UUID.randomUUID().toString(), Op.COMPLETE,
                    JSONObject().put("file_id", fileId).put("task_id", taskId).put("due", due ?: JSONObject.NULL).put("done", false),
                    now, title,
                )
                s.copy(ticks = s.ticks - existing, ops = ops) to false
            } else {
                val op = Op(
                    UUID.randomUUID().toString(), Op.COMPLETE,
                    JSONObject().put("file_id", fileId).put("task_id", taskId).put("due", due ?: JSONObject.NULL).put("done", true),
                    now, title,
                )
                val ticks = s.ticks.filter { it.key != key } + Tick(fileId, taskId, due, now, title, listId, time)
                s.copy(ticks = ticks, ops = s.ops + op) to true
            }
        }

    /** A task typed on this phone (Quick task): shown at once, sent when there's signal. */
    suspend fun addTask(ctx: Context, title: String, due: String?, listId: String?, now: Long): Op = change(ctx) { s ->
        val op = Op(
            UUID.randomUUID().toString(), Op.ADD_TASK,
            JSONObject().put("title", title).put("due", due ?: JSONObject.NULL).put("list_id", listId ?: JSONObject.NULL),
            now, title,
        )
        s.copy(ops = s.ops + op) to op
    }

    /** The server did it: out of the outbox, and its answer into the saved copy
     *  (so it doesn't flicker back before the next snapshot). */
    suspend fun done(ctx: Context, op: Op, answer: JSONObject) = change(ctx) { s ->
        val task = answer.optJSONObject("task")
        val tasksRaw = raw.optJSONObject("tasks")
        if (task != null && tasksRaw != null) {
            val arr = tasksRaw.optJSONArray("tasks") ?: JSONArray()
            val kept = JSONArray()
            for (i in 0 until arr.length()) {
                val t = arr.optJSONObject(i) ?: continue
                if (op.type == Op.COMPLETE && t.optString("id") == task.optString("id")) {
                    if (task.optBoolean("done")) continue // gone from the open tasks
                    t.put("due", task.opt("due") ?: JSONObject.NULL) // a repeat moved on
                }
                kept.put(t)
            }
            if (op.type == Op.ADD_TASK) {
                if (tasksRaw.isNull("file_id") || tasksRaw.optString("file_id").isBlank()) tasksRaw.put("file_id", answer.optString("file_id"))
                kept.put(task)
            }
            tasksRaw.put("tasks", kept)
            tasksRaw.put("etag", "") // the next snapshot sends the whole section
            raw.put("tasks", tasksRaw)
            saveSnapshot(ctx)
        }
        s.copy(ops = s.ops.filter { it.id != op.id }, snapshot = Snapshot.parse(raw)) to Unit
    }

    /** The server said no for good (the task was deleted, say): drop it, undo what
     *  it showed, and say so once. */
    suspend fun refused(ctx: Context, op: Op, now: Long) = change(ctx) { s ->
        val text = when (op.type) {
            Op.COMPLETE -> "Couldn't tick “${op.label.take(40)}” — the task was deleted."
            else -> "Couldn't add “${op.label.take(40)}” to Tasks."
        }
        val ticks = if (op.type == Op.COMPLETE) s.ticks.filter { it.key != op.key() } else s.ticks
        s.copy(
            ops = s.ops.filter { it.id != op.id },
            ticks = ticks,
            notices = (s.notices + Notice(op.id, text, now)).filter { now - it.at < NOTICE_MS }.takeLast(3),
        ) to Unit
    }

    suspend fun tried(ctx: Context, op: Op) = change(ctx) { s ->
        s.copy(ops = s.ops.map { if (it.id == op.id) it.copy(tries = it.tries + 1) else it }) to Unit
    }

    suspend fun dismiss(ctx: Context, noticeId: String) = change(ctx) { s ->
        s.copy(notices = s.notices.filter { it.id != noticeId }) to Unit
    }

    /** This phone was removed (or unlinked): nothing of the account stays on it. */
    suspend fun wipe(ctx: Context) = withContext(Dispatchers.IO) {
        lock.withLock {
            dir(ctx).listFiles()?.forEach { it.delete() }
            raw = JSONObject()
            _state.value = WidgetState(version = _state.value.version + 1, loaded = true)
        }
    }

    val SECTIONS = listOf("calendar", "tasks", "notes")
}

private fun JSONObject.str(key: String): String? = if (isNull(key) || !has(key)) null else optString(key).ifEmpty { null }

/** The tick an outbox op is about. */
fun Op.key(): String = Tick.key(body.optString("file_id"), body.optString("task_id"), if (body.isNull("due")) null else body.optString("due").ifEmpty { null })
