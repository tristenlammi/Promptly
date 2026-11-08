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
            SyncLogic.run(ctx, WidgetApi(account), Widgets.wanted(ctx), System.currentTimeMillis())
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

    suspend fun run(ctx: Context, api: WidgetBackend, want: List<String>, now: Long): Outcome {
        try {
            // The outbox first, oldest first: an add then a tick of it arrive in order.
            for (op in WidgetStore.load(ctx).ops) {
                try {
                    WidgetStore.done(ctx, op, api.send(op))
                } catch (e: Refused) {
                    when {
                        e.status == 403 -> return off(ctx)
                        e.status == 429 -> return Outcome.RETRY
                        else -> WidgetStore.refused(ctx, op, now)
                    }
                } catch (e: IOException) {
                    if (e is Unlinked) throw e
                    if (op.tries + 1 >= MAX_TRIES) WidgetStore.refused(ctx, op, now) else WidgetStore.tried(ctx, op)
                    return Outcome.RETRY
                }
            }
            if (want.isEmpty()) return Outcome.OK
            val answer = api.snapshot(want, DAYS, someday = true, etags = WidgetStore.etags(), noteIds = emptyList())
            WidgetsOff.set(ctx, false)
            WidgetStore.merge(ctx, answer, now)
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
