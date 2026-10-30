package org.promptly.sync

import android.net.Uri
import android.os.Build
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
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit

/** The server refused (4xx) — retrying the same thing won't help. */
class Refused(val status: Int, message: String) : IOException(message)

/** The phone's password no longer works: it was removed in Files → Devices. */
class Unlinked : IOException("This phone was removed from your account.")

/** What a QR code / link carries. */
data class PairLink(val server: String, val code: String)

object Api {
    private val JSON = "application/json".toMediaType()

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .build()

    /** `https://host/sync?code=…` (the QR) or `promptlysync://pair?server=…&code=…`. */
    fun parseLink(raw: String): PairLink? {
        val uri = Uri.parse(raw.trim())
        return when (uri.scheme) {
            "promptlysync" -> {
                val server = uri.getQueryParameter("server") ?: return null
                val code = uri.getQueryParameter("code") ?: return null
                val s = Uri.parse(server)
                if (s.scheme !in setOf("http", "https") || s.host.isNullOrEmpty()) null
                else PairLink(server.trimEnd('/'), code)
            }
            "http", "https" -> {
                if (uri.path?.trimEnd('/') != "/sync") return null
                val code = uri.getQueryParameter("code") ?: return null
                val port = if (uri.port > 0) ":${uri.port}" else ""
                PairLink("${uri.scheme}://${uri.host}$port", code)
            }
            else -> null
        }
    }

    fun deviceName(): String {
        val maker = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
        val model = Build.MODEL
        return if (model.startsWith(maker, ignoreCase = true)) model else "$maker $model"
    }

    private fun detail(body: String?): String? = runCatching {
        val d = JSONObject(body ?: "").opt("detail")
        if (d is String) d else null
    }.getOrNull()

    /** Trade the one-time code for this phone's own app password. */
    fun claim(link: PairLink, device: String): Store.Account {
        val body = JSONObject().put("code", link.code).put("device_name", device).toString().toRequestBody(JSON)
        val req = Request.Builder().url("${link.server}/api/devices/pair/claim").post(body).build()
        http.newCall(req).execute().use { r ->
            val text = r.body.string()
            if (!r.isSuccessful) throw Refused(r.code, detail(text) ?: "The server said no (${r.code}).")
            val j = JSONObject(text)
            return Store.Account(link.server, j.getString("username"), j.getString("password"), j.getString("device_name"))
        }
    }

    private fun Request.Builder.auth(a: Store.Account) = header("Authorization", Credentials.basic(a.username, a.password))

    private fun check(code: Int, text: String?) {
        if (code == 401) throw Unlinked()
        if (code in 400..499) throw Refused(code, detail(text) ?: "The server refused it ($code).")
        if (code >= 500) throw IOException("The server had a problem ($code).")
    }

    /** Of some SHA-256s: [have] — in Photos now (the only proof of a backup);
     *  [skip] — deleted there (in the trash or for good): never send it back. */
    data class Known(val have: Set<String>, val skip: Set<String>)

    fun have(a: Store.Account, hashes: List<String>): Known {
        if (hashes.isEmpty()) return Known(emptySet(), emptySet())
        val body = JSONObject().put("sha256", JSONArray(hashes)).toString().toRequestBody(JSON)
        val req = Request.Builder().url("${a.server}/api/devices/have").auth(a).post(body).build()
        http.newCall(req).execute().use { r ->
            val text = r.body.string()
            check(r.code, text)
            val j = JSONObject(text)
            fun set(key: String): Set<String> {
                val arr = j.optJSONArray(key) ?: return emptySet()
                return (0 until arr.length()).map { arr.getString(it) }.toSet()
            }
            return Known(set("have"), set("skip"))
        }
    }

    // ----------------------------------------------------------------- tus

    private const val CHUNK = 50L * 1024 * 1024 // under Cloudflare's 100 MB request cap
    private fun b64(s: String) = Base64.encodeToString(s.toByteArray(), Base64.NO_WRAP)

    /** Start an upload; returns where to send the bytes. */
    fun tusCreate(a: Store.Account, item: Item): String {
        val meta = listOf(
            "filename" to item.name,
            "filetype" to item.mime,
            "route" to "camera",
            "last_modified" to (item.modified * 1000).toString(),
        ).joinToString(",") { (k, v) -> "$k ${b64(v)}" }
        val req = Request.Builder().url("${a.server}/api/files/tus/").auth(a)
            .header("Tus-Resumable", "1.0.0")
            .header("Upload-Length", item.size.toString())
            .header("Upload-Metadata", meta)
            .post(ByteArray(0).toRequestBody(null))
            .build()
        http.newCall(req).execute().use { r ->
            val text = r.body.string()
            check(r.code, text)
            val loc = r.header("Location") ?: throw IOException("The server didn't start the upload.")
            return "${a.server}/".toHttpUrl().resolve(loc)?.toString() ?: loc
        }
    }

    /** How much of it the server has; null when it's gone (start again). */
    fun tusOffset(a: Store.Account, location: String): Long? {
        val req = Request.Builder().url(location).auth(a).header("Tus-Resumable", "1.0.0").head().build()
        http.newCall(req).execute().use { r ->
            if (r.code == 404 || r.code == 410) return null
            check(r.code, null)
            return r.header("Upload-Offset")?.toLongOrNull()
        }
    }

    /** Send from [offset] to the end, a chunk at a time. */
    fun tusSend(a: Store.Account, location: String, item: Item, offset: Long, open: () -> InputStream, progress: (Long) -> Unit) {
        var at = offset
        open().use { s ->
            var skip = at
            while (skip > 0) {
                val n = s.skip(skip)
                if (n <= 0) {
                    if (s.read() < 0) throw IOException("The file got shorter.")
                    skip -= 1
                } else skip -= n
            }
            while (at < item.size) {
                val len = minOf(CHUNK, item.size - at)
                val req = Request.Builder().url(location).auth(a)
                    .header("Tus-Resumable", "1.0.0")
                    .header("Upload-Offset", at.toString())
                    .patch(StreamBody(s, len, "application/offset+octet-stream".toMediaType()))
                    .build()
                http.newCall(req).execute().use { r ->
                    val text = r.body.string()
                    check(r.code, text)
                    at = r.header("Upload-Offset")?.toLongOrNull() ?: (at + len)
                }
                progress(at)
            }
        }
    }

    private class StreamBody(val s: InputStream, val len: Long, val type: MediaType) : RequestBody() {
        override fun contentType() = type
        override fun contentLength() = len
        override fun isOneShot() = true
        override fun writeTo(sink: BufferedSink) {
            val buf = ByteArray(1 shl 16)
            var left = len
            while (left > 0) {
                val n = s.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                if (n < 0) throw IOException("The file got shorter.")
                sink.write(buf, 0, n)
                left -= n
            }
        }
    }

    // -------------------------------------------------------------- updates

    data class Update(val version: String, val code: Int, val url: String)

    /** A newer PromptlySync on the server, if there is one. */
    fun update(server: String): Update? = runCatching {
        val req = Request.Builder().url("$server/downloads/PromptlySync.json").header("Cache-Control", "no-cache").build()
        http.newCall(req).execute().use { r ->
            if (!r.isSuccessful) return null
            val j = JSONObject(r.body.string())
            val code = j.optInt("version_code", 0)
            if (code > BuildConfig.VERSION_CODE) Update(j.optString("version"), code, "$server/downloads/PromptlySync.apk")
            else null
        }
    }.getOrNull()
}
