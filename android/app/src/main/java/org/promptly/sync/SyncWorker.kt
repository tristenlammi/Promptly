package org.promptly.sync

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.provider.MediaStore
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * One backup run: everything in the chosen folders that isn't on the
 * server yet. Each file is hashed first and the server asked "have it?"
 * (a photo already in Photos — from Takeout, say — is skipped), then sent
 * by tus, resumable across runs. Nothing on the server is ever deleted.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        if (!running.tryLock()) return@withContext Result.success() // another run has it
        try {
            run()
        } finally {
            running.unlock()
            // Wait for the next new photo (queued behind this run, not replacing it).
            if (tags.contains(TRIGGER)) Sync.armTrigger(applicationContext, replace = false)
        }
    }

    private suspend fun run(): Result {
        val store = Store(applicationContext)
        val account = store.account ?: return Result.success()
        val buckets = store.buckets ?: return Result.success()
        if (store.unlinked) return Result.success()
        val ledger = Ledger(applicationContext)

        // Only what changed since the last complete run (Android 11+), with a
        // full look at least once a day in case anything slipped by. Read the
        // position first: what changes during this run is caught by the next.
        val now = System.currentTimeMillis()
        val position = Media.position(applicationContext)
        val since = store.scanGeneration.takeIf {
            position != null && it >= 0 && store.scanVersion == position.first && now - store.lastFullScan < DAY
        }
        val settled = ledger.settled()
        val todo = Media.items(applicationContext, buckets, since).filter { settled[it.id] != it.sig }
        val finish = {
            store.lastSync = System.currentTimeMillis()
            store.lastError = null
            if (position != null) {
                store.scanVersion = position.first
                store.scanGeneration = position.second
            }
            if (since == null) store.lastFullScan = now
        }
        if (todo.isEmpty()) {
            finish()
            return Result.success()
        }
        // A foreground service (and its notification) only for a big backup; a
        // photo or two goes in the job's own few minutes.
        big = todo.size > BIG_COUNT || todo.sumOf { it.size } > BIG_BYTES
        if (big) foreground(0, todo.size)

        var done = 0
        try {
            for (batch in todo.chunked(50)) {
                if (isStopped) return Result.retry()
                // Hash what isn't hashed yet, then ask the server about the lot.
                val hashes = LinkedHashMap<Item, String>()
                for (item in batch) {
                    if (isStopped) return Result.retry()
                    val sha = ledger.pending(item)?.sha ?: runCatching { Media.sha256(applicationContext, item) }
                        .getOrElse { e ->
                            ledger.settle(item, "refused", "Couldn't read it: ${e.message}")
                            null
                        } ?: continue
                    ledger.savePending(item, sha, ledger.pending(item)?.location)
                    hashes[item] = sha
                }
                val there = Api.have(account, hashes.values.toList())
                for ((item, sha) in hashes) {
                    if (isStopped) return Result.retry()
                    if (sha in there) {
                        ledger.settle(item, "done", "already there")
                    } else {
                        try {
                            send(account, ledger, item, sha) { sent -> bytes(done, todo.size, item, sent) }
                            ledger.settle(item, "done")
                        } catch (e: Refused) {
                            if (e.status == 507) throw e // the server is full: stop, not skip
                            ledger.settle(item, "refused", e.message)
                        }
                    }
                    done++
                    progress(done, todo.size, null, 0)
                }
            }
        } catch (e: Unlinked) {
            store.unlinked = true
            store.lastError = e.message
            return Result.failure()
        } catch (e: Refused) {
            store.lastError = e.message
            return Result.retry()
        } catch (e: IOException) {
            store.lastError = "Couldn't reach the server — will try again. (${e.message})"
            return Result.retry()
        }
        finish()
        return Result.success()
    }

    private var big = false

    private fun send(account: Store.Account, ledger: Ledger, item: Item, sha: String, onSent: (Long) -> Unit) {
        var location = ledger.pending(item)?.location
        var offset = location?.let { Api.tusOffset(account, it) }
        if (location == null || offset == null) {
            location = Api.tusCreate(account, item)
            ledger.savePending(item, sha, location)
            offset = 0
        }
        Api.tusSend(account, location, item, offset, { Media.open(applicationContext, item) }, onSent)
    }

    private var lastNotified = 0L

    private suspend fun progress(done: Int, total: Int, item: Item?, sent: Long) {
        setProgress(workDataOf("done" to done, "total" to total, "name" to (item?.name ?: ""), "sent" to sent, "size" to (item?.size ?: 0L)))
        val now = System.currentTimeMillis()
        if (big && now - lastNotified > 1500) {
            lastNotified = now
            foreground(done, total)
        }
    }

    /** Mid-file (called from the upload loop, which isn't a coroutine). */
    private fun bytes(done: Int, total: Int, item: Item, sent: Long) {
        setProgressAsync(workDataOf("done" to done, "total" to total, "name" to item.name, "sent" to sent, "size" to item.size))
    }

    private suspend fun foreground(done: Int, total: Int) {
        val n = NotificationCompat.Builder(applicationContext, CHANNEL)
            .setSmallIcon(R.drawable.ic_sync)
            .setContentTitle("Backing up photos")
            .setContentText("$done of $total")
            .setProgress(total, done, false)
            .setOngoing(true)
            .setSilent(true)
            .build()
        val info = if (Build.VERSION.SDK_INT >= 29) {
            ForegroundInfo(NOTIFICATION, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(NOTIFICATION, n)
        }
        // Not allowed from the background on newer Android: the run still goes
        // on (within its time), and the next one picks up where it stopped.
        runCatching { setForeground(info) }
    }

    companion object {
        const val CHANNEL = "backup"
        const val NOTIFICATION = 1
        const val TRIGGER = "trigger"
        private const val DAY = 24L * 60 * 60 * 1000
        private const val BIG_COUNT = 25
        private const val BIG_BYTES = 100L * 1024 * 1024
        private val running = Mutex()
    }
}

/** When backups run: now (on demand), hourly, and soon after a new photo. */
object Sync {
    private const val NOW = "sync-now"
    private const val HOURLY = "sync-hourly"
    private const val NEW_MEDIA = "sync-new-media"

    fun channel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(SyncWorker.CHANNEL, "Backup", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shows while photos are being backed up"
            }
        )
    }

    private fun constraints(context: Context): Constraints {
        val store = Store(context)
        return Constraints.Builder()
            .setRequiredNetworkType(if (store.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .setRequiresCharging(store.chargingOnly)
            .setRequiresBatteryNotLow(true)
            .build()
    }

    /** Start (or restart, after a settings change) every schedule. New photos
     *  are caught by the trigger; the every-6-hours run is only a safety net,
     *  with a 2-hour window so Android can fold it into another wake-up. */
    fun schedule(context: Context) {
        val wm = WorkManager.getInstance(context)
        wm.enqueueUniquePeriodicWork(
            HOURLY, ExistingPeriodicWorkPolicy.UPDATE,
            PeriodicWorkRequestBuilder<SyncWorker>(6, TimeUnit.HOURS, 2, TimeUnit.HOURS)
                .setConstraints(constraints(context)).addTag(TAG).build(),
        )
        armTrigger(context, replace = true)
        now(context)
    }

    fun now(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            NOW, ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(constraints(context)).addTag(TAG).build(),
        )
    }

    /** Runs once after photos or videos are added — 30 s after the last one,
     *  so a burst of shots is one run (but never more than 2 min late). Re-armed
     *  after each run; [replace] when the settings changed. */
    fun armTrigger(context: Context, replace: Boolean) {
        val store = Store(context)
        val c = Constraints.Builder()
            .setRequiredNetworkType(if (store.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .setRequiresCharging(store.chargingOnly)
            .setRequiresBatteryNotLow(true)
            .addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
            .addContentUriTrigger(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true)
            .setTriggerContentUpdateDelay(30, TimeUnit.SECONDS)
            .setTriggerContentMaxDelay(2, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            NEW_MEDIA, if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.APPEND_OR_REPLACE,
            OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(c).addTag(TAG).addTag(SyncWorker.TRIGGER).build(),
        )
    }

    /** Bump when the schedules above change: an updated app re-registers them
     *  once (WorkManager keeps the old ones across an app update otherwise). */
    private const val SCHEDULE_VERSION = 2

    fun upgrade(context: Context) {
        val store = Store(context)
        if (store.scheduleVersion == SCHEDULE_VERSION) return
        if (store.account != null && store.buckets != null && !store.unlinked) schedule(context)
        store.scheduleVersion = SCHEDULE_VERSION
    }

    fun stop(context: Context) {
        val wm = WorkManager.getInstance(context)
        wm.cancelUniqueWork(NOW)
        wm.cancelUniqueWork(HOURLY)
        wm.cancelUniqueWork(NEW_MEDIA)
    }

    /** On every backup run, for the status screen to watch. */
    const val TAG = "sync"
}
