package org.promptly.sync.roomscam

import android.content.ContentValues
import android.content.Context
import android.os.Environment
import android.provider.MediaStore
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.ForegroundInfo
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import org.json.JSONObject
import org.promptly.sync.Api
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * A photo or video on its way to a conversation. It's written down (the file
 * and what to do with it) before anything is sent, and WorkManager does the
 * sending, so it still arrives if the signal drops, the camera is closed or
 * Android stops the app half-way. The server takes picture and words in one
 * request and knows the send by its id, so trying again never posts twice.
 */
data class PendingShot(
    val id: String,
    val server: String,
    val ticket: String,
    val file: String,
    val name: String,
    val mime: String,
    val caption: String,
    val video: Boolean,
) {
    fun json(): JSONObject = JSONObject()
        .put("id", id).put("server", server).put("ticket", ticket).put("file", file)
        .put("name", name).put("mime", mime).put("caption", caption).put("video", video)

    companion object {
        fun from(j: JSONObject): PendingShot? = runCatching {
            PendingShot(
                j.getString("id"), j.getString("server"), j.getString("ticket"), j.getString("file"),
                j.getString("name"), j.getString("mime"), j.optString("caption"), j.optBoolean("video"),
            )
        }.getOrNull()
    }
}

object CamStore {
    fun dir(ctx: Context): File = File(ctx.applicationContext.filesDir, "roomscam").apply { mkdirs() }

    /** A new file for the camera to write to. */
    fun newFile(ctx: Context, ext: String): File = File(dir(ctx), "${UUID.randomUUID()}.$ext")

    private fun note(ctx: Context, id: String) = File(dir(ctx), "$id.json")

    fun save(ctx: Context, shot: PendingShot) = note(ctx, shot.id).writeText(shot.json().toString())

    fun load(ctx: Context, id: String): PendingShot? =
        runCatching { PendingShot.from(JSONObject(note(ctx, id).readText())) }.getOrNull()

    /** Sent, or given up on: nothing of it stays in the app. */
    fun forget(ctx: Context, shot: PendingShot) {
        File(shot.file).delete()
        note(ctx, shot.id).delete()
    }

    /** Files no send knows about (a shot you retook, or the app was stopped before Send): gone after a day. */
    fun sweep(ctx: Context, now: Long = System.currentTimeMillis()) {
        val kept = dir(ctx).listFiles { f -> f.name.endsWith(".json") }
            ?.mapNotNull { runCatching { JSONObject(it.readText()).optString("file") }.getOrNull() }?.toSet() ?: emptySet()
        dir(ctx).listFiles()?.forEach { f ->
            if (!f.name.endsWith(".json") && f.absolutePath !in kept && now - f.lastModified() > 24 * 3600 * 1000L) f.delete()
        }
    }

    /**
     * A picture that couldn't be sent, put in the phone's own gallery
     * (Pictures/Promptly or Movies/Promptly) so it isn't lost. True if it's there.
     */
    fun keepOnPhone(ctx: Context, shot: PendingShot): Boolean = runCatching {
        val src = File(shot.file)
        if (!src.exists()) return false
        val video = shot.video
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, shot.name)
            put(MediaStore.MediaColumns.MIME_TYPE, shot.mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, (if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES) + "/Promptly")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val table = if (video) MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        else MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val resolver = ctx.contentResolver
        val uri = resolver.insert(table, values) ?: return false
        resolver.openOutputStream(uri)?.use { out -> src.inputStream().use { it.copyTo(out) } } ?: return false
        resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        true
    }.getOrDefault(false)
}

object CamSend {
    private const val KEY_ID = "id"
    const val KEY_FRACTION = "fraction"
    const val KEY_WHY = "why"
    const val KEY_AGAIN = "again"

    /** Big files on a slow connection: no hurry on the body, a normal one to connect. */
    private val http: OkHttpClient by lazy {
        Api.http.newBuilder().writeTimeout(5, TimeUnit.MINUTES).readTimeout(5, TimeUnit.MINUTES).build()
    }

    private fun workName(id: String) = "roomscam-send-$id"

    /** Write it down and start sending. Returns the work's id, to watch. */
    fun start(ctx: Context, shot: PendingShot): UUID {
        CamStore.save(ctx, shot)
        val work = OneTimeWorkRequestBuilder<CamSendWorker>()
            .setInputData(workDataOf(KEY_ID to shot.id))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            // Sent now, not when Android next gets round to background jobs (it holds
            // ordinary ones for minutes once the app isn't in front).
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .addTag("roomscam")
            .build()
        WorkManager.getInstance(ctx).enqueueUniqueWork(workName(shot.id), ExistingWorkPolicy.REPLACE, work)
        return work.id
    }

    /** Stop trying (Retake after a failure): the shot is the caller's again. */
    fun cancel(ctx: Context, id: String) {
        WorkManager.getInstance(ctx).cancelUniqueWork(workName(id))
    }

    internal fun idOf(params: WorkerParameters): String? = params.inputData.getString(KEY_ID)

    /**
     * One try. Returns the outcome; [progress] is called with the share of
     * the file that has left the phone.
     */
    fun send(shot: PendingShot, progress: (Float) -> Unit, client: OkHttpClient = http): SendState {
        val file = File(shot.file)
        if (!file.exists() || file.length() == 0L) return SendState.Failed("That picture isn't on this phone any more.", again = false)
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("body", shot.caption)
            .addFormDataPart("client_id", shot.id)
            .addFormDataPart("file", shot.name, Counting(file, shot.mime.toMediaType(), progress))
            .build()
        val req = Request.Builder().url("${shot.server}/api/rooms/camera/send")
            .header("X-Promptly-Camera-Ticket", shot.ticket)
            .post(body).build()
        return try {
            client.newCall(req).execute().use { r ->
                val text = r.body.string()
                if (r.isSuccessful) SendState.Sent
                else CamSendRules.failure(r.code, runCatching { JSONObject(text).opt("detail") as? String }.getOrNull())
            }
        } catch (e: IOException) {
            CamSendRules.failure(null, null)
        }
    }

    private class Counting(val file: File, val type: MediaType, val progress: (Float) -> Unit) : RequestBody() {
        override fun contentType() = type
        override fun contentLength() = file.length()
        override fun writeTo(sink: BufferedSink) {
            val total = file.length()
            var sent = 0L
            var told = -1
            file.source().use { src ->
                val buf = okio.Buffer()
                while (true) {
                    val n = src.read(buf, 64 * 1024L)
                    if (n < 0) break
                    sink.write(buf, n)
                    sent += n
                    val pct = (CamSendRules.fraction(sent, total) * 100).toInt()
                    if (pct != told) {
                        told = pct
                        progress(pct / 100f)
                    }
                }
            }
        }
    }
}

class CamSendWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val id = CamSend.idOf(params = workerParams) ?: return Result.failure()
        val shot = CamStore.load(applicationContext, id)
            ?: return Result.failure(workDataOf(CamSend.KEY_WHY to "That picture isn't on this phone any more.", CamSend.KEY_AGAIN to false))
        // A dropped connection is usually back in seconds (a lift, a tunnel, Wi-Fi to mobile):
        // a few quick tries here, before leaving it to Android's own, slower, retry.
        var state: SendState = SendState.Idle
        for (wait in CamSendRules.QUICK_WAITS_MS) {
            if (wait > 0) kotlinx.coroutines.delay(wait)
            state = withContext(Dispatchers.IO) {
                CamSend.send(shot, { f -> setProgressAsync(workDataOf(CamSend.KEY_FRACTION to f)) })
            }
            if (!CamSendRules.quickRetry(state, watched = CamWatch.watching(id))) break
        }
        return when (state) {
            is SendState.Sent -> {
                CamStore.forget(applicationContext, shot)
                Result.success()
            }
            is SendState.Failed -> when {
                // Left alone (the camera screen is closed): keep trying while that could work.
                CamSendRules.retryInBackground(state, runAttemptCount) && !CamWatch.watching(id) -> Result.retry()
                // The camera screen is watching: it says why and offers Try again itself.
                state.again && CamWatch.watching(id) -> Result.failure(workDataOf(CamSend.KEY_WHY to state.why, CamSend.KEY_AGAIN to true))
                else -> {
                    // It won't go from here: don't lose the picture.
                    withContext(Dispatchers.IO) { CamStore.keepOnPhone(applicationContext, shot) }
                    CamStore.forget(applicationContext, shot)
                    Result.failure(workDataOf(CamSend.KEY_WHY to state.why, CamSend.KEY_AGAIN to false))
                }
            }
            else -> Result.failure()
        }
    }

    private val workerParams = params

    /** Android 11 and older run an urgent job as a foreground service, which needs a
     *  notification to show (newer Android shows nothing). */
    override suspend fun getForegroundInfo(): ForegroundInfo {
        val nm = applicationContext.getSystemService(android.app.NotificationManager::class.java)
        nm.createNotificationChannel(
            android.app.NotificationChannel(CHANNEL, "Sending from the camera", android.app.NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shows while a photo or video you took is being sent"
            },
        )
        val n = androidx.core.app.NotificationCompat.Builder(applicationContext, CHANNEL)
            .setSmallIcon(org.promptly.sync.R.drawable.ic_sync)
            .setContentTitle("Sending your photo")
            .setOngoing(true)
            .setSilent(true)
            .build()
        return ForegroundInfo(NOTIFICATION, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }

    private companion object {
        const val CHANNEL = "roomscam-send"
        const val NOTIFICATION = 4107
    }
}

/** Which sends a camera screen is watching right now (it shows failures itself). */
object CamWatch {
    private val ids = java.util.Collections.synchronizedSet(HashSet<String>())
    fun watch(id: String) = ids.add(id)
    fun unwatch(id: String) = ids.remove(id)
    fun watching(id: String) = id in ids
}
