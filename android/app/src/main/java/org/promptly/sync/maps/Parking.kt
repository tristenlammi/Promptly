package org.promptly.sync.maps

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * "Save where I parked" with no signal: one row on the phone (the latest place you
 * parked; an older one is never worth sending), sent with the time you parked when
 * there's a connection again. The server keeps a newer one it already has.
 */
class ParkQueue(private val file: File) {
    data class Pending(val server: String, val lat: Double, val lon: Double, val source: String, val at: String)

    fun peek(): Pending? = runCatching {
        val j = JSONObject(file.readText())
        Pending(j.getString("server"), j.getDouble("lat"), j.getDouble("lon"), j.getString("source"), j.getString("at"))
    }.getOrNull()

    /** Keeps [p] unless what's waiting is newer. */
    fun put(p: Pending) {
        val waiting = peek()
        if (waiting != null && waiting.server == p.server && Instant.parse(waiting.at).isAfter(Instant.parse(p.at))) return
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + ".new")
        tmp.writeText(JSONObject().put("server", p.server).put("lat", p.lat).put("lon", p.lon).put("source", p.source).put("at", p.at).toString())
        if (!tmp.renameTo(file)) {
            file.writeText(tmp.readText())
            tmp.delete()
        }
    }

    /** Takes [p] off, unless something newer has replaced it meanwhile. */
    fun done(p: Pending) {
        if (peek() == p) file.delete()
    }

    /**
     * Sends what's waiting with [send]. True when nothing is left (sent, or nothing to send).
     * A 4xx (other than signed out) is the server saying no: that row is dropped, not retried.
     */
    fun flush(server: String?, send: (Pending) -> Unit): Boolean {
        val p = peek() ?: return true
        if (p.server != server) {
            // Parked while signed in to another server: not this one's business.
            done(p)
            return true
        }
        return try {
            send(p)
            done(p)
            true
        } catch (e: IOException) {
            val refused = e.message?.let { it.startsWith("Server said 4") && !it.startsWith("Server said 401") } == true
            if (refused) done(p)
            refused
        }
    }
}

/** Saving where you parked, now or when there's signal. */
object Parking {
    private const val TAG = "PromptlyMaps"
    private const val WORK = "maps-park"

    enum class Saved { NOW, LATER, NO }

    fun queue(context: Context) = ParkQueue(File(context.applicationContext.filesDir, "maps-park-queue.json"))

    /** Where you are, as where you parked: on your server now, or kept and sent when
     *  there's a connection (shown on the phone straight away either way). */
    fun save(context: Context, lat: Double, lon: Double, source: String): Saved {
        val app = context.applicationContext
        val server = Maps.server(app) ?: return Saved.NO
        val at = Instant.now().toString()
        MyPlaces.cache(app).setParked(server, lat, lon, at)
        return try {
            if (!org.promptly.sync.maps.offline.Offline.online(app)) throw IOException("No connection")
            Maps.park(app, lat, lon, source, at, Maps.CAR_TIMEOUT_SECONDS)
            Saved.NOW
        } catch (e: IOException) {
            if (e.message?.startsWith("Server said 4") == true && e.message?.startsWith("Server said 401") != true) {
                Log.w(TAG, "Parking refused: ${e.message}")
                return Saved.NO
            }
            Log.i(TAG, "Parking kept for later: ${e.message}")
            queue(app).put(ParkQueue.Pending(server, lat, lon, source, at))
            later(app)
            Saved.LATER
        }
    }

    /** Sends a waiting place once there's a connection (WorkManager waits for one). */
    fun later(context: Context) {
        val request = OneTimeWorkRequestBuilder<ParkWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(WORK, ExistingWorkPolicy.REPLACE, request)
    }

    /** Sends the waiting place, if any. True when nothing's left waiting. */
    fun flush(context: Context): Boolean {
        val app = context.applicationContext
        return queue(app).flush(Maps.server(app)) { p -> Maps.park(app, p.lat, p.lon, p.source, p.at, Maps.CAR_TIMEOUT_SECONDS) }
    }

    /** What to say about it. */
    fun said(saved: Saved): String = when (saved) {
        Saved.NOW -> "Parked here"
        Saved.LATER -> "Parked here. It'll be saved to P Maps when there's signal."
        Saved.NO -> "Couldn't save that"
    }
}

class ParkWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        if (Parking.flush(applicationContext)) Result.success() else Result.retry()
    }
}
