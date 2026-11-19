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
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
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
    /** The conversation (for a send in pieces) and who it's to (for a notification). */
    val room: String = "",
    val title: String = "",
    /** The most one request carries; above it the file goes in pieces to [tus]. */
    val maxOne: Long = CamHandoffs.DEFAULT_MAX_BYTES,
    val tus: String = "",
    /** A send in pieces under way: where its pieces go, and what it became once whole. */
    val location: String = "",
    val attachment: String = "",
) {
    fun json(): JSONObject = JSONObject()
        .put("id", id).put("server", server).put("ticket", ticket).put("file", file)
        .put("name", name).put("mime", mime).put("caption", caption).put("video", video)
        .put("room", room).put("title", title).put("maxOne", maxOne).put("tus", tus)
        .put("location", location).put("attachment", attachment)

    companion object {
        fun from(j: JSONObject): PendingShot? = runCatching {
            PendingShot(
                j.getString("id"), j.getString("server"), j.getString("ticket"), j.getString("file"),
                j.getString("name"), j.getString("mime"), j.optString("caption"), j.optBoolean("video"),
                j.optString("room"), j.optString("title"), j.optLong("maxOne", CamHandoffs.DEFAULT_MAX_BYTES), j.optString("tus"),
                j.optString("location"), j.optString("attachment"),
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
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
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
     * the file that has left the phone. A file over what one request carries
     * goes in pieces first; [remember] is told where they're going and what
     * they became, so the next try carries on and never sends it twice.
     */
    fun send(shot: PendingShot, progress: (Float) -> Unit, client: OkHttpClient = http, remember: (PendingShot) -> Unit = {}): SendState {
        val file = File(shot.file)
        if (!file.exists() || file.length() == 0L) return SendState.Failed("That picture isn't on this phone any more.", again = false)
        return try {
            val form = MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("body", shot.caption)
                .addFormDataPart("client_id", shot.id)
            var now = shot
            if (CamPieces.inPieces(file.length(), shot.maxOne, shot.tus)) {
                if (now.attachment.isEmpty()) {
                    val sent = pieces(now, file, progress, client, remember)
                    if (sent.second != null) return sent.second!!
                    now = sent.first
                }
                form.addFormDataPart("attachment_id", now.attachment)
            } else {
                form.addFormDataPart("file", shot.name, Counting(file, shot.mime.toMediaType(), progress))
            }
            val req = Request.Builder().url("${shot.server}/api/rooms/camera/send")
                .header("X-Promptly-Camera-Ticket", shot.ticket)
                .post(form.build()).build()
            client.newCall(req).execute().use { r ->
                val text = r.body.string()
                when {
                    r.isSuccessful -> SendState.Sent
                    r.code == 404 && now.attachment.isNotEmpty() -> {
                        // What was sent in pieces has gone from the server (cleared as never sent): start it again.
                        remember(now.copy(location = "", attachment = ""))
                        SendState.Failed("That took too long to send. Try again.", again = true)
                    }
                    else -> CamSendRules.failure(r.code, detail(text))
                }
            }
        } catch (e: IOException) {
            CamSendRules.failure(null, null)
        }
    }

    private fun detail(text: String): String? = runCatching { JSONObject(text).opt("detail") as? String }.getOrNull()

    /** The file, in pieces (tus). The shot with its attachment's id, or why not. */
    private fun pieces(shot: PendingShot, file: File, progress: (Float) -> Unit, client: OkHttpClient, remember: (PendingShot) -> Unit): Pair<PendingShot, SendState?> {
        val size = file.length()
        fun Request.Builder.tus() = header("Tus-Resumable", "1.0.0").header("X-Promptly-Camera-Ticket", shot.ticket)
        var now = shot
        var offset: Long? = null
        if (now.location.isNotEmpty()) {
            client.newCall(Request.Builder().url(now.location).tus().head().build()).execute().use { r ->
                offset = if (r.isSuccessful) r.header("Upload-Offset")?.toLongOrNull() else null
            }
        }
        if (offset == null) {
            val create = Request.Builder().url(now.server + now.tus).tus()
                .header("Upload-Length", size.toString())
                .header("Upload-Metadata", CamPieces.metadata(now.name, now.mime, now.room))
                .post(ByteArray(0).toRequestBody(null)).build()
            client.newCall(create).execute().use { r ->
                val text = r.body.string()
                if (!r.isSuccessful) return now to CamSendRules.failure(r.code, detail(text))
                val loc = r.header("Location") ?: return now to CamSendRules.failure(502, null)
                now = now.copy(location = "${now.server}/".toHttpUrl().resolve(loc)?.toString() ?: loc)
                remember(now)
            }
            offset = 0
        }
        var at = offset!!
        val type = "application/offset+octet-stream".toMediaType()
        java.io.RandomAccessFile(file, "r").use { raf ->
            while (at < size) {
                val len = CamPieces.next(at, size)
                val bytes = ByteArray(len.toInt())
                raf.seek(at)
                raf.readFully(bytes)
                val patch = Request.Builder().url(now.location).tus().header("Upload-Offset", at.toString()).patch(bytes.toRequestBody(type)).build()
                client.newCall(patch).execute().use { r ->
                    val text = r.body.string()
                    if (!r.isSuccessful) {
                        // Out of step, or gone: forget where it was and let the next try find out.
                        if (r.code == 404 || r.code == 409 || r.code == 410) remember(now.copy(location = "").also { now = it })
                        return now to if (r.code == 404 || r.code == 409 || r.code == 410) SendState.Failed("That didn't finish sending. Try again.", again = true) else CamSendRules.failure(r.code, detail(text))
                    }
                    at = r.header("Upload-Offset")?.toLongOrNull() ?: (at + len)
                    progress(CamSendRules.fraction(at, size))
                    r.header("Upload-File-Id")?.takeIf { it.isNotBlank() }?.let { id ->
                        now = now.copy(attachment = id)
                        remember(now)
                    }
                }
            }
        }
        if (now.attachment.isEmpty()) {
            // All of it arrived but the answer saying what it became didn't: send it afresh next time.
            remember(now.copy(location = "").also { now = it })
            return now to SendState.Failed("That didn't finish sending. Try again.", again = true)
        }
        return now to null
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
                // Read afresh: an earlier try may have got part of the way.
                val latest = CamStore.load(applicationContext, id) ?: shot
                CamSend.send(latest, { f -> setProgressAsync(workDataOf(CamSend.KEY_FRACTION to f)) }, remember = { CamStore.save(applicationContext, it) })
            }
            if (!CamSendRules.quickRetry(state, watched = CamWatch.watching(id))) break
        }
        return when (state) {
            is SendState.Sent -> {
                CamNotes.clear(applicationContext, shot)
                CamStore.forget(applicationContext, shot)
                Result.success()
            }
            is SendState.Failed -> when {
                // Left alone (the camera screen is closed): keep trying while that could work.
                CamSendRules.retryInBackground(state, runAttemptCount) && !CamWatch.watching(id) -> Result.retry()
                // The camera screen is watching: it says why and offers Try again itself.
                state.again && CamWatch.watching(id) -> Result.failure(workDataOf(CamSend.KEY_WHY to state.why, CamSend.KEY_AGAIN to true))
                state.again -> {
                    // Tried for a good while with nobody watching: keep it, and say so, with a way to try again.
                    CamNotes.failed(applicationContext, shot, retry = true)
                    Result.failure(workDataOf(CamSend.KEY_WHY to state.why, CamSend.KEY_AGAIN to true))
                }
                else -> {
                    // It won't go from here: don't lose the picture.
                    val kept = withContext(Dispatchers.IO) { CamStore.keepOnPhone(applicationContext, shot) }
                    CamStore.forget(applicationContext, shot)
                    if (!CamWatch.watching(id)) CamNotes.failed(applicationContext, shot, retry = false, kept = kept)
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

    companion object {
        const val CHANNEL = "roomscam-send"
        const val NOTIFICATION = 4107
    }
}

/**
 * A send that didn't make it while nobody was looking: said plainly, in a
 * notification, never silence. One it can still try has "Try again" (and a
 * tap does the same); one it can't says where the picture was kept.
 */
object CamNotes {
    private fun tag(shot: PendingShot) = "roomscam-${shot.id}"

    fun clear(ctx: Context, shot: PendingShot) {
        ctx.getSystemService(android.app.NotificationManager::class.java).cancel(tag(shot), 1)
    }

    /** What the notification says: title and text. */
    fun words(video: Boolean, to: String, retry: Boolean, kept: Boolean): Pair<String, String> {
        val what = if (video) "video" else "photo"
        val whom = to.ifBlank { "the conversation" }
        return if (retry) "Your $what to $whom hasn't sent" to "Tap to try again. It's kept on this phone until it goes."
        else "Your $what to $whom couldn't be sent" to (if (kept) "It's saved in this phone's gallery, in Promptly." else "Open the conversation and take it again.")
    }

    fun failed(ctx: Context, shot: PendingShot, retry: Boolean, kept: Boolean = false) {
        val nm = ctx.getSystemService(android.app.NotificationManager::class.java)
        nm.createNotificationChannel(
            android.app.NotificationChannel(CamSendWorker.CHANNEL, "Sending from the camera", android.app.NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Tells you when a photo or video you took couldn't be sent"
            },
        )
        val (title, text) = words(shot.video, shot.title, retry, kept)
        val b = androidx.core.app.NotificationCompat.Builder(ctx, CamSendWorker.CHANNEL)
            .setSmallIcon(org.promptly.sync.R.drawable.ic_sync)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
        if (retry) {
            val again = android.app.PendingIntent.getBroadcast(
                ctx, shot.id.hashCode(),
                android.content.Intent(ctx, CamRetryReceiver::class.java).putExtra("id", shot.id),
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
            )
            b.setContentIntent(again).addAction(0, "Try again", again)
        }
        runCatching { nm.notify(tag(shot), 1, b.build()) }
    }
}

/** "Try again" on that notification. */
class CamRetryReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: android.content.Intent) {
        val id = intent.getStringExtra("id") ?: return
        val shot = CamStore.load(context, id) ?: return
        CamNotes.clear(context, shot)
        CamSend.start(context, shot)
    }
}

/** Which sends a camera screen is watching right now (it shows failures itself). */
object CamWatch {
    private val ids = java.util.Collections.synchronizedSet(HashSet<String>())
    fun watch(id: String) = ids.add(id)
    fun unwatch(id: String) = ids.remove(id)
    fun watching(id: String) = id in ids
}
