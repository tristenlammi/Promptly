package org.promptly.sync.widgets

import android.util.Base64
import okhttp3.Credentials
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONObject
import org.promptly.sync.Refused
import org.promptly.sync.Store
import org.promptly.sync.Unlinked
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.concurrent.TimeUnit

/** What the widgets need from the server — an interface so the sync logic can
 *  be tested without one. */
interface WidgetBackend {
    /** The snapshot; sections whose etag we sent come back `unchanged`. */
    fun snapshot(want: List<String>, days: Int, someday: Boolean, etags: Map<String, String>, noteIds: List<String>): JSONObject

    /** Send one outbox change; the server's answer. Its files are already up. */
    fun send(op: Op): JSONObject

    /**
     * Send one of a note's files up (tus, `route=note`: My files › Notes),
     * from where an earlier try got to ([location]); [started] keeps a new
     * upload's address for the next try. Returns its Drive file id.
     */
    fun upload(file: File, name: String, mime: String, location: String?, started: (String) -> Unit): String =
        throw Refused(400, "This phone can't send files.")

    /** Your notes for the One note widget's settings (most recent first; [q] narrows). */
    fun pick(q: String): List<NoteCard> = emptyList()

    /** Your photo albums (and ones shared with you) for the Photo widget's settings. */
    fun albums(): List<PhotoAlbum> = emptyList()

    /**
     * A few photos of an album at random, ones the phone doesn't hold
     * ([have]) first: `{album: {title, count}, photos: [{id, url}], gone: [ids]}`.
     * [Refused] 404 when the album isn't there for you any more.
     */
    fun albumPhotos(albumId: String, n: Int, have: List<String>): JSONObject = throw Refused(404, "That album isn't there any more.")

    /** A picture's bytes from one of the server's own short-lived links; nothing over [max] bytes. */
    fun download(url: String, max: Long): ByteArray = throw IOException("This phone can't get pictures.")
}

/** An album to choose from. */
data class PhotoAlbum(val id: String, val title: String, val count: Int, val shared: Boolean)

/**
 * `/api/widgets` with this phone's own app password (scope `widgets`), the way
 * the map signs in. 401 → [Unlinked] (the phone was removed); another 4xx →
 * [Refused]; 5xx and no signal → [IOException] (try again later). Files go up
 * through tus with the same password (its `upload` scope, as photo backup).
 */
class WidgetApi(private val account: Store.Account) : WidgetBackend {
    private val json = "application/json".toMediaType()

    private fun Request.Builder.auth() = header("Authorization", Credentials.basic(account.username, account.password))

    private fun detail(text: String?): String? =
        runCatching { JSONObject(text ?: "").opt("detail") as? String }.getOrNull()?.takeIf { it.isNotBlank() }

    private fun check(code: Int, text: String?) {
        if (code == 401) throw Unlinked()
        if (code == 409) throw IOException(detail(text) ?: "The server is still saving that change.")
        if (code in 400..499) throw Refused(code, detail(text) ?: "The server refused it ($code).")
        if (code >= 500) throw IOException("The server had a problem ($code).")
    }

    private fun call(req: Request): JSONObject {
        http.newCall(req).execute().use { r ->
            val text = r.body.string()
            check(r.code, text)
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        }
    }

    override fun snapshot(want: List<String>, days: Int, someday: Boolean, etags: Map<String, String>, noteIds: List<String>): JSONObject {
        val url = "${account.server}/api/widgets/snapshot".toHttpUrl().newBuilder()
            .addQueryParameter("want", want.joinToString(","))
            .addQueryParameter("days", days.toString())
            .apply {
                if (someday) addQueryParameter("someday", "true")
                etags.forEach { (k, v) -> addQueryParameter("${k}_etag", v) }
                noteIds.forEach { addQueryParameter("note", it) }
            }
            .build()
        return call(Request.Builder().url(url).auth().get().build())
    }

    override fun send(op: Op): JSONObject {
        val b = op.body
        val (method, path, body) = when (op.type) {
            Op.COMPLETE -> Triple("POST", "/api/widgets/tasks/complete", JSONObject(b.toString()).put("client_id", op.id))
            Op.ADD_TASK -> Triple("POST", "/api/widgets/tasks", JSONObject(b.toString()).put("client_id", op.id))
            Op.NEW_NOTE -> Triple(
                "POST", "/api/widgets/notes",
                JSONObject().put("client_id", op.id).put("kind", b.optString("kind", "text")).put("title", b.optString("title"))
                    .put("text", b.optString("text")).put("items", b.optJSONArray("items") ?: JSONArray())
                    .put("source", b.optString("source", "android")).put("files", sentFiles(op)),
            )
            Op.NOTE_ADD -> Triple(
                "POST", "/api/widgets/notes/${seg(b.optString("note_id"))}/add",
                JSONObject().put("client_id", op.id).put("text", b.optString("text")).put("files", sentFiles(op)),
            )
            Op.NOTE_ITEM -> Triple(
                "POST", "/api/widgets/notes/${seg(b.optString("note_id"))}/items",
                JSONObject().put("client_id", op.id).put("text", b.optString("text")),
            )
            Op.NOTE_TICK -> Triple(
                "PATCH", "/api/widgets/notes/${seg(b.optString("note_id"))}/items/${seg(b.optString("item_id"))}",
                JSONObject().put("client_id", op.id).put("checked", b.optBoolean("checked")),
            )
            else -> throw Refused(400, "This phone doesn't know how to send that.")
        }
        val rb = body.toString().toRequestBody(json)
        return call(Request.Builder().url(account.server + path).auth().method(method, rb).build())
    }

    override fun pick(q: String): List<NoteCard> {
        val url = "${account.server}/api/widgets/notes/pick".toHttpUrl().newBuilder()
            .apply { if (q.isNotBlank()) addQueryParameter("q", q.take(200)) }.build()
        val arr = call(Request.Builder().url(url).auth().get().build()).optJSONArray("notes") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }.map { j ->
            Snapshot.note(j).copy(left = j.optInt("left", 0))
        }
    }

    override fun albums(): List<PhotoAlbum> {
        val arr = call(Request.Builder().url("${account.server}/api/widgets/photos/albums").auth().get().build()).optJSONArray("albums") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }.map { j ->
            PhotoAlbum(j.optString("id"), j.optString("title").ifBlank { "Album" }, j.optInt("count"), j.optBoolean("shared"))
        }
    }

    override fun albumPhotos(albumId: String, n: Int, have: List<String>): JSONObject {
        val url = "${account.server}/api/widgets/photos/albums/${seg(albumId)}".toHttpUrl().newBuilder()
            .addQueryParameter("n", n.toString())
            .apply { have.take(60).forEach { addQueryParameter("have", it) } }
            .build()
        return call(Request.Builder().url(url).auth().get().build())
    }

    /** The link signs itself (it carries no password), and only ever goes to our own server. */
    override fun download(url: String, max: Long): ByteArray {
        val base = "${account.server}/".toHttpUrl()
        val full = base.resolve(url)
        if (full == null || full.scheme != base.scheme || full.host != base.host || full.port != base.port) throw Refused(400, "That picture isn't on your server.")
        http.newCall(Request.Builder().url(full).get().build()).execute().use { r ->
            if (r.code in 400..499) throw Refused(r.code, "That picture isn't there any more.")
            if (!r.isSuccessful) throw IOException("The server had a problem (${r.code}).")
            if (r.body.contentLength() > max) throw Refused(413, "That picture is too big.")
            val src = r.body.source()
            val buf = okio.Buffer()
            while (buf.size <= max) {
                if (src.read(buf, 64 * 1024) == -1L) return buf.readByteArray()
            }
            throw Refused(413, "That picture is too big.")
        }
    }

    // ------------------------------------------------------------ tus

    private fun b64(s: String) = Base64.encodeToString(s.toByteArray(), Base64.NO_WRAP)

    override fun upload(file: File, name: String, mime: String, location: String?, started: (String) -> Unit): String {
        val size = file.length()
        if (!file.isFile || size <= 0) throw Refused(400, "The recording isn't on this phone any more.")
        var where = location
        var offset = where?.let { offset(it) }
        if (where == null || offset == null) {
            where = create(name, mime, size)
            started(where)
            offset = 0L
        }
        var at: Long = offset
        var fileId: String? = null
        RandomAccessFile(file, "r").use { raf ->
            while (at < size) {
                val len = minOf(CHUNK, size - at)
                raf.seek(at)
                val req = Request.Builder().url(where).auth()
                    .header("Tus-Resumable", "1.0.0")
                    .header("Upload-Offset", at.toString())
                    .patch(Chunk(raf, len))
                    .build()
                http.newCall(req).execute().use { r ->
                    val text = r.body.string()
                    if (r.code == 404 || r.code == 410) throw IOException("The upload expired; it starts again.")
                    check(r.code, text)
                    at = r.header("Upload-Offset")?.toLongOrNull() ?: (at + len)
                    r.header("Upload-File-Id")?.takeIf { it.isNotBlank() }?.let { fileId = it }
                }
            }
        }
        return fileId ?: throw IOException("The server didn't say where the file went.")
    }

    private fun create(name: String, mime: String, size: Long): String {
        val meta = listOf("filename" to name, "filetype" to mime, "route" to "note", "scope" to "mine")
            .joinToString(",") { (k, v) -> "$k ${b64(v)}" }
        val req = Request.Builder().url("${account.server}/api/files/tus/").auth()
            .header("Tus-Resumable", "1.0.0")
            .header("Upload-Length", size.toString())
            .header("Upload-Metadata", meta)
            .post(ByteArray(0).toRequestBody(null))
            .build()
        http.newCall(req).execute().use { r ->
            val text = r.body.string()
            check(r.code, text)
            val loc = r.header("Location") ?: throw IOException("The server didn't start the upload.")
            return "${account.server}/".toHttpUrl().resolve(loc)?.toString() ?: loc
        }
    }

    /** How much of an earlier upload the server has; null when it's gone (start again). */
    private fun offset(location: String): Long? {
        val req = Request.Builder().url(location).auth().header("Tus-Resumable", "1.0.0").head().build()
        return try {
            http.newCall(req).execute().use { r ->
                if (r.code == 404 || r.code == 410 || r.code == 403) return null
                check(r.code, null)
                r.header("Upload-Offset")?.toLongOrNull()
            }
        } catch (e: Refused) {
            null
        }
    }

    private class Chunk(val raf: RandomAccessFile, val len: Long) : RequestBody() {
        override fun contentType(): MediaType = "application/offset+octet-stream".toMediaType()
        override fun contentLength() = len
        override fun isOneShot() = true
        override fun writeTo(sink: BufferedSink) {
            val buf = ByteArray(1 shl 16)
            var left = len
            while (left > 0) {
                val n = raf.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                if (n < 0) throw IOException("The file got shorter.")
                sink.write(buf, 0, n)
                left -= n
            }
        }
    }

    companion object {
        /** A slice of a recording per request: small, so a bad signal loses little. */
        private const val CHUNK = 4L * 1024 * 1024

        val http: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .callTimeout(5, TimeUnit.MINUTES)
            .build()

        /** A path segment: only an id's own characters get through. */
        fun seg(id: String): String = id.filter { it.isLetterOrDigit() || it == '-' }.ifEmpty { "-" }

        /** The op's files as the server wants them: attachment id, Drive file id, what the recorder measured. */
        fun sentFiles(op: Op): JSONArray {
            val out = JSONArray()
            val arr = op.body.optJSONArray("files") ?: return out
            for (i in 0 until arr.length()) {
                val f = arr.optJSONObject(i) ?: continue
                val j = JSONObject().put("id", f.optString("id")).put("file_id", f.optString("file_id"))
                if (f.has("duration_ms")) j.put("duration_ms", f.optLong("duration_ms"))
                f.optJSONArray("peaks")?.let { j.put("peaks", it) }
                out.put(j)
            }
            return out
        }
    }
}
