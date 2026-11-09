package org.promptly.sync.widgets

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.Refused
import org.promptly.sync.Unlinked
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException

/** The widgets' saved copy and outbox, and the sync that empties it: optimistic
 *  ticks and undo, safe replays (one client_id per change, kept across retries),
 *  order, refusals, revoke and "turned off" wiping everything. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WidgetSyncTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()

    /** A stand-in server: answers from [snap], records what it was sent. */
    private class Fake : WidgetBackend {
        val sent = mutableListOf<Op>()
        var etagsAsked: Map<String, String> = emptyMap()
        var snap: JSONObject = JSONObject()
        var fail: (Op) -> Exception? = { null }
        var snapFail: Exception? = null

        override fun snapshot(want: List<String>, days: Int, someday: Boolean, etags: Map<String, String>, noteIds: List<String>): JSONObject {
            etagsAsked = etags
            snapFail?.let { throw it }
            return snap
        }

        override fun send(op: Op): JSONObject {
            fail(op)?.let { throw it }
            sent += op
            return when (op.type) {
                Op.COMPLETE -> JSONObject().put("ok", true).put("task", JSONObject().put("id", op.body.getString("task_id")).put("done", op.body.optBoolean("done", true)).put("due", op.body.opt("due")))
                else -> JSONObject().put("ok", true).put("file_id", "F")
                    .put("task", JSONObject().put("id", "srv-${sent.size}").put("title", op.body.getString("title")).put("due", op.body.opt("due")).put("list_id", "inbox"))
            }
        }
    }

    private fun tasksAnswer(etag: String, vararg ids: String) = JSONObject().put("tz", "Australia/Sydney").put(
        "tasks",
        JSONObject().put("etag", etag).put("file_id", "F").put("lists", JSONArray().put(JSONObject().put("id", "inbox").put("name", "Inbox")))
            .put("tasks", JSONArray(ids.map { JSONObject().put("id", it).put("title", "Task $it").put("due", "2026-11-09").put("list_id", "inbox") })),
    )

    @Before
    fun clean() = runBlocking {
        WidgetStore.wipe(ctx)
        WidgetsOff.set(ctx, false)
    }

    @Test
    fun merge_keeps_unchanged_sections_and_saves_to_disk() = runBlocking {
        WidgetStore.merge(ctx, tasksAnswer("t1", "a", "b").put("calendar", JSONObject().put("etag", "c1").put("from", "2026-11-09").put("events", JSONArray())), 1000)
        assertEquals(mapOf("tasks" to "t1", "calendar" to "c1"), WidgetStore.etags())
        WidgetStore.merge(ctx, JSONObject().put("tasks", JSONObject().put("etag", "t1").put("unchanged", true)).put("calendar", JSONObject().put("error", true)), 2000)
        val s = WidgetStore.state.value.snapshot
        assertEquals(listOf("a", "b"), s.tasks!!.tasks.map { it.id })
        assertEquals(2000L, s.fetchedAt)
        assertTrue(s.calendar != null)
        assertTrue(File(ctx.filesDir, "widgets/snapshot.json").readText().contains("\"t1\""))
    }

    @Test
    fun tick_then_undo_inside_the_moment_sends_nothing() = runBlocking {
        WidgetStore.merge(ctx, tasksAnswer("t1", "a"), 1000)
        assertTrue(WidgetStore.toggleTick(ctx, "F", "a", "2026-11-09", "Task a", "inbox", null, 5000))
        assertEquals(1, WidgetStore.state.value.ops.size)
        assertFalse(WidgetStore.toggleTick(ctx, "F", "a", "2026-11-09", "Task a", "inbox", null, 6000))
        assertTrue(WidgetStore.state.value.ops.isEmpty())
        assertTrue(WidgetStore.state.value.ticks.isEmpty())
        val fake = Fake().apply { snap = tasksAnswer("t1", "a") }
        assertEquals(SyncLogic.Outcome.OK, SyncLogic.run(ctx, fake, listOf("tasks"), 7000))
        assertTrue(fake.sent.isEmpty())
    }

    @Test
    fun offline_tick_waits_keeps_its_id_and_is_sent_once_back_online() = runBlocking {
        WidgetStore.merge(ctx, tasksAnswer("t1", "a", "b"), 1000)
        WidgetStore.toggleTick(ctx, "F", "a", "2026-11-09", "Task a", "inbox", null, 5000)
        WidgetStore.addTask(ctx, "Milk", "2026-11-09", null, 5100)
        val ids = WidgetStore.state.value.ops.map { it.id }
        val fake = Fake().apply { fail = { IOException("no signal") } }
        // No signal: nothing lost, same client_ids, the outbox is on disk.
        assertEquals(SyncLogic.Outcome.RETRY, SyncLogic.run(ctx, fake, listOf("tasks"), 6000))
        assertEquals(ids, WidgetStore.state.value.ops.map { it.id })
        assertTrue(File(ctx.filesDir, "widgets/outbox.json").readText().contains(ids[0]))
        // Back online: sent in order, each once, then the fresh snapshot.
        fake.fail = { null }
        fake.snap = JSONObject().put("tasks", JSONObject().put("etag", "t1").put("unchanged", true))
        assertEquals(SyncLogic.Outcome.OK, SyncLogic.run(ctx, fake, listOf("tasks"), 7000))
        assertEquals(ids, fake.sent.map { it.id })
        assertEquals(listOf(Op.COMPLETE, Op.ADD_TASK), fake.sent.map { it.type })
        assertTrue(WidgetStore.state.value.ops.isEmpty())
        // The answers went into the saved copy: "a" is done, the new task is there,
        // and the tasks etag was cleared so the next refresh brings the whole section.
        val tasks = WidgetStore.state.value.snapshot.tasks!!.tasks.map { it.title }
        assertEquals(listOf("Task b", "Milk"), tasks)
        assertFalse(WidgetStore.etags().containsKey("tasks"))
    }

    @Test
    fun a_refused_change_is_dropped_with_a_notice() = runBlocking {
        WidgetStore.merge(ctx, tasksAnswer("t1", "a"), 1000)
        WidgetStore.toggleTick(ctx, "F", "a", "2026-11-09", "Pay rent", "inbox", null, 5000)
        val fake = Fake().apply {
            fail = { Refused(404, "That task isn't there any more.") }
            snap = tasksAnswer("t2")
        }
        assertEquals(SyncLogic.Outcome.OK, SyncLogic.run(ctx, fake, listOf("tasks"), 9000))
        val s = WidgetStore.state.value
        assertTrue(s.ops.isEmpty() && s.ticks.isEmpty())
        assertEquals("Couldn't tick “Pay rent” — the task was deleted.", s.notices.single().text)
        WidgetStore.dismiss(ctx, s.notices.single().id)
        assertTrue(WidgetStore.state.value.notices.isEmpty())
    }

    @Test
    fun revoked_phone_wipes_everything() = runBlocking {
        WidgetStore.merge(ctx, tasksAnswer("t1", "a"), 1000)
        WidgetStore.addTask(ctx, "Secret", null, null, 2000)
        val fake = Fake().apply { fail = { Unlinked() } }
        assertEquals(SyncLogic.Outcome.REMOVED, SyncLogic.run(ctx, fake, listOf("tasks"), 3000))
        val s = WidgetStore.state.value
        assertTrue(s.ops.isEmpty() && s.snapshot.tasks == null)
        assertTrue(File(ctx.filesDir, "widgets").listFiles().isNullOrEmpty())

        // The same from the snapshot call.
        WidgetStore.merge(ctx, tasksAnswer("t1", "a"), 1000)
        assertEquals(SyncLogic.Outcome.REMOVED, SyncLogic.run(ctx, Fake().apply { snapFail = Unlinked() }, listOf("tasks"), 3000))
        assertTrue(WidgetStore.state.value.snapshot.tasks == null)
    }

    @Test
    fun widgets_turned_off_for_the_phone() = runBlocking {
        WidgetStore.merge(ctx, tasksAnswer("t1", "a"), 1000)
        val fake = Fake().apply { snapFail = Refused(403, "This app password can't do that.") }
        assertEquals(SyncLogic.Outcome.OFF, SyncLogic.run(ctx, fake, listOf("tasks"), 2000))
        assertTrue(WidgetsOff.get(ctx))
        assertTrue(WidgetStore.state.value.snapshot.tasks == null)
        // Turned back on: the next refresh works and clears it.
        assertEquals(SyncLogic.Outcome.OK, SyncLogic.run(ctx, Fake().apply { snap = tasksAnswer("t1", "a") }, listOf("tasks"), 3000))
        assertFalse(WidgetsOff.get(ctx))
    }

    @Test
    fun etags_are_sent_back_and_server_errors_retry() = runBlocking {
        WidgetStore.merge(ctx, tasksAnswer("t9", "a"), 1000)
        val fake = Fake().apply { snap = JSONObject().put("tasks", JSONObject().put("etag", "t9").put("unchanged", true)) }
        SyncLogic.run(ctx, fake, listOf("tasks"), 2000)
        assertEquals(mapOf("tasks" to "t9"), fake.etagsAsked)
        assertEquals(SyncLogic.Outcome.RETRY, SyncLogic.run(ctx, Fake().apply { snapFail = IOException("500") }, listOf("tasks"), 3000))
        assertEquals(listOf("a"), WidgetStore.state.value.snapshot.tasks!!.tasks.map { it.id }) // kept
    }
}
