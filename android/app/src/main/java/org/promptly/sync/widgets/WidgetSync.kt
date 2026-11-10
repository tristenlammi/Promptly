package org.promptly.sync.widgets

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.promptly.sync.Refused
import org.promptly.sync.Store
import org.promptly.sync.Unlinked
import org.promptly.sync.capture.Capture
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Brings the widgets up to date: sends the outbox (in order, each change
 * once thanks to its client_id), then asks for the snapshot with the etags we
 * have, saves it and redraws. Runs:
 *  - every 30 minutes while there are widgets (`widgets-refresh`, needs network);
 *  - right after a change on a widget (a tick, a Quick task);
 *  - 2 minutes after a Promptly app is opened (you're back on the home screen by then);
 *  - after a reboot, a clock or time-zone change.
 * The no-network redraws (an event starting, midnight) are [Boundaries].
 */
class WidgetSync(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val ctx = applicationContext
        val store = Store(ctx)
        val account = if (store.hasAccount && !store.unlinked) store.account else null
        val outcome = if (account == null) {
            if (store.unlinked) WidgetStore.wipe(ctx)
            SyncLogic.Outcome.NOT_LINKED
        } else {
            SyncLogic.run(
                ctx, WidgetApi(account), Widgets.wanted(ctx), System.currentTimeMillis(), Widgets.noteIds(ctx),
                albums = PhotoWidget.albums(ctx), showing = PhotoWidget.showing(ctx),
            )
        }
        if (outcome == SyncLogic.Outcome.REMOVED) store.unlinked = true
        Widgets.redraw(ctx)
        if (outcome == SyncLogic.Outcome.RETRY) Result.retry() else Result.success()
    }

    companion object {
        private const val PERIODIC = "widgets-refresh"
        private const val NOW = "widgets-now"
        private const val SOON = "widgets-soon"
        private const val TAG = "widgets"

        private fun network() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** While any widget is on the home screen. */
        fun periodic(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                PERIODIC, ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<WidgetSync>(30, TimeUnit.MINUTES, 10, TimeUnit.MINUTES)
                    .setConstraints(network()).addTag(TAG).build(),
            )
        }

        fun cancel(ctx: Context) {
            val wm = WorkManager.getInstance(ctx)
            wm.cancelUniqueWork(PERIODIC)
            wm.cancelUniqueWork(SOON)
        }

        /** After a change made on a widget. [delayMs]: a tick waits out its moment of
         *  being struck through, so an undo never reaches the server. */
        fun now(ctx: Context, delayMs: Long = 0) {
            val b = OneTimeWorkRequestBuilder<WidgetSync>().setConstraints(network()).addTag(TAG)
            if (delayMs > 0) b.setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
            // Expedited only where it needs no notification of its own (Android 12+).
            else if (Build.VERSION.SDK_INT >= 31) b.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            WorkManager.getInstance(ctx).enqueueUniqueWork(NOW, ExistingWorkPolicy.APPEND_OR_REPLACE, b.build())
        }

        /** A Promptly app was opened: refresh once you're likely back home. */
        fun soon(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniqueWork(
                SOON, ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<WidgetSync>().setConstraints(network()).setInitialDelay(2, TimeUnit.MINUTES).addTag(TAG).build(),
            )
        }
    }
}

/** The sync itself, apart from WorkManager (tested on its own). */
object SyncLogic {
    enum class Outcome { OK, RETRY, REMOVED, OFF, NOT_LINKED }

    private const val DAYS = 7
    private const val MAX_TRIES = 20

    suspend fun run(
        ctx: Context, api: WidgetBackend, want: List<String>, now: Long, noteIds: List<String> = emptyList(),
        albums: List<String> = emptyList(), showing: Set<String> = emptySet(),
    ): Outcome {
        try {
            // The outbox first, oldest first: an add then a tick of it arrive in order.
            for (queued in WidgetStore.load(ctx).ops) {
                var op = queued
                try {
                    // A note's pictures and recordings go up first (resumable), then the note.
                    op = upload(ctx, api, op)
                    WidgetStore.done(ctx, op, api.send(op))
                } catch (e: Refused) {
                    when {
                        e.status == 403 -> return off(ctx)
                        e.status == 429 -> return Outcome.RETRY
                        else -> WidgetStore.refused(ctx, op, now, e.message.takeIf { e.status == 413 || e.status == 507 || e.status == 400 })
                    }
                } catch (e: IOException) {
                    if (e is Unlinked) throw e
                    // A recording or picture is never given up on for a bad signal: it waits on the phone.
                    if (op.tries + 1 >= MAX_TRIES && Capture.files(op).isEmpty()) WidgetStore.refused(ctx, op, now) else WidgetStore.tried(ctx, op)
                    return Outcome.RETRY
                }
            }
            Capture.sweep(ctx, WidgetStore.state.value.ops, now)
            if (want.isNotEmpty()) {
                val answer = api.snapshot(want, DAYS, someday = true, etags = WidgetStore.etags(), noteIds = noteIds)
                WidgetsOff.set(ctx, false)
                WidgetStore.merge(ctx, answer, now)
            }
            // Photo widgets: a few of each album's photos, kept small on the phone.
            if (albums.isNotEmpty()) {
                withContext(Dispatchers.IO) { PhotoSync.run(ctx, api, albums, now, showing) }
                WidgetsOff.set(ctx, false)
            }
            return Outcome.OK
        } catch (e: Unlinked) {
            WidgetStore.wipe(ctx)
            return Outcome.REMOVED
        } catch (e: Refused) {
            return if (e.status == 403) off(ctx) else Outcome.RETRY
        } catch (e: IOException) {
            Log.i("PromptlyWidgets", "Refresh failed: ${e.message}")
            return Outcome.RETRY
        } catch (e: org.json.JSONException) {
            Log.w("PromptlyWidgets", "Odd answer from the server", e)
            return Outcome.RETRY
        }
    }

    /** Send [op]'s files that aren't up yet; the op as it is now (with their Drive ids). */
    private suspend fun upload(ctx: Context, api: WidgetBackend, op: Op): Op {
        var now = op
        for (f in Capture.files(op)) {
            if (f.optString("file_id").isNotBlank()) continue
            val id = f.optString("id")
            val fileId = withContext(Dispatchers.IO) {
                api.upload(
                    java.io.File(f.optString("path")), f.optString("name", "Recording.m4a"), f.optString("mime", "audio/mp4"),
                    f.optString("tus").ifBlank { null },
                ) { where -> kotlinx.coroutines.runBlocking { WidgetStore.uploading(ctx, op.id, id, "tus", where) } }
            }
            WidgetStore.uploading(ctx, op.id, id, "file_id", fileId)
            now = WidgetStore.state.value.ops.firstOrNull { it.id == op.id } ?: now
        }
        return now
    }

    /** Widgets were turned off for this phone (Account → Devices): forget what they showed. */
    private suspend fun off(ctx: Context): Outcome {
        WidgetsOff.set(ctx, true)
        WidgetStore.wipe(ctx)
        return Outcome.OFF
    }
}

/** "Widgets are off for this phone" — the server said 403 to the widgets scope. */
object WidgetsOff {
    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences("widgets", Context.MODE_PRIVATE)
    fun get(ctx: Context): Boolean = prefs(ctx).getBoolean("off", false)
    fun set(ctx: Context, off: Boolean) {
        if (get(ctx) != off) prefs(ctx).edit().putBoolean("off", off).apply()
    }
}
