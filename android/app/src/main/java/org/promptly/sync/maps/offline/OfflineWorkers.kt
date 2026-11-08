package org.promptly.sync.maps.offline

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.promptly.sync.R
import java.io.IOException

/** Downloads offline map areas: a foreground `dataSync` job with a progress
 *  notification. Stops when the network it was allowed goes (Wi-Fi only, by
 *  default) and carries on from the same byte when it's back. */
class OfflineDownloadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val ctx = applicationContext
        Offline.channel(ctx)
        val store = Offline.store(ctx)
        val before = Offline.saved(ctx)?.areas.orEmpty().filter { store.has(it.cells, it.withAddresses) }.map { it.id }.toSet()
        foreground("Getting ready…", null)
        try {
            val overview = Offline.runSync(ctx, { isStopped }) { p -> notifyProgress(p) }
            val readyNow = overview.areas.filter { it.id !in before && store.has(it.cells, it.withAddresses) }
            if (readyNow.isNotEmpty()) done(readyNow.joinToString(", ") { it.name }, readyNow.size)
            Result.success()
        } catch (e: Stopped) {
            Result.retry()
        } catch (e: NoSpace) {
            problem(e.message ?: "Not enough space.")
            Result.failure()
        } catch (e: SignedOut) {
            problem(e.message ?: "Sign in to P Maps again.")
            Result.failure()
        } catch (e: OffOnServer) {
            Result.failure()
        } catch (e: StillBuilding) {
            Result.retry()
        } catch (e: ServerSaid) {
            problem(e.message ?: "The server said no.")
            Result.failure()
        } catch (e: IOException) {
            // No connection, or a link ran out: it carries on by itself.
            if (runAttemptCount >= 8) {
                problem(e.message ?: "Download stopped.")
                Result.failure()
            } else Result.retry()
        }
    }

    private var last = 0L

    private fun notifyProgress(p: OfflineEngine.Progress) {
        val now = System.currentTimeMillis()
        if (now - last < 1000 && p.current != null) return
        last = now
        val text = if (p.total > 0) "${percent(p.have, p.total)}% · ${Sizes.text(p.have)} of ${Sizes.text(p.total)}" else "Checking for changes"
        val info = info(if (p.updating) "Updating offline maps" else "Downloading offline maps", text, p.have to p.total)
        runCatching { setForegroundAsync(info) }
    }

    private suspend fun foreground(title: String, text: String?) {
        // Not allowed from the background on newer Android: the run still goes on
        // (within the job's own time), and the next one picks up where it stopped.
        runCatching { setForeground(info(title, text, null)) }
    }

    private fun info(title: String, text: String?, progress: Pair<Long, Long>?): ForegroundInfo {
        val n = NotificationCompat.Builder(applicationContext, Offline.CHANNEL)
            .setSmallIcon(R.drawable.ic_map_status)
            .setContentTitle(if (text == null) "Offline maps" else title)
            .setContentText(text ?: title)
            .setContentIntent(open())
            .setOngoing(true)
            .setSilent(true)
            .apply {
                if (progress != null && progress.second > 0) setProgress(1000, (progress.first * 1000 / progress.second).toInt(), false)
                else setProgress(0, 0, true)
            }
            .build()
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(NOTIFY_RUN, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else ForegroundInfo(NOTIFY_RUN, n)
    }

    private fun open(): PendingIntent = PendingIntent.getActivity(
        applicationContext, 0,
        Intent(applicationContext, OfflineAreasActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun done(names: String, count: Int) = post(
        NOTIFY_DONE,
        if (count == 1) "$names is ready offline" else "$names are ready offline",
        "The map, search and directions work with no signal.",
    )

    private fun problem(text: String) = post(NOTIFY_DONE, "Offline maps didn't download", text)

    private fun post(id: Int, title: String, text: String) {
        val n = NotificationCompat.Builder(applicationContext, Offline.CHANNEL)
            .setSmallIcon(R.drawable.ic_map_status)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(open())
            .setAutoCancel(true)
            .build()
        runCatching { NotificationManagerCompat.from(applicationContext).notify(id, n) }
    }

    companion object {
        const val NOTIFY_RUN = 41
        const val NOTIFY_DONE = 42

        fun percent(have: Long, total: Long): Int = if (total <= 0) 0 else ((have * 100) / total).toInt().coerceIn(0, 100)
    }
}

/** Once a day, on Wi-Fi with the battery fine (and charging, with "Update
 *  automatically" on): picks up areas saved or deleted on the web and new map
 *  builds, then hands the downloading to [OfflineDownloadWorker]. With "Update
 *  automatically" off, a new build comes only with Update now or a new area. */
class OfflineSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val ctx = applicationContext
        // Your places, recents and usual routes for the offline map and search, fresh each day.
        runCatching { org.promptly.sync.maps.MyPlaces.refresh(ctx) }
        val overview = runCatching { Offline.refresh(ctx) }.getOrElse { return@withContext Result.retry() }
        if (!overview.enabled || !overview.ready) return@withContext Result.success()
        val store = Offline.store(ctx)
        val areas = overview.areas.filter { it.id !in store.state.deleted }
        val missing = areas.any { !store.has(it.cells, it.withAddresses) }
        val update = areas.isNotEmpty() && store.state.syncedBuild != null && store.state.syncedBuild != overview.build
        Offline.tidy(ctx, overview)
        with(Offline) {
            if (missing || (update && ctx.autoUpdate)) Offline.download(ctx)
        }
        Result.success()
    }
}
