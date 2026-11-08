package org.promptly.sync.maps.offline

import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** One file at a time from a signed `/m/` link: resumed with HTTP Range from what's
 *  already on the phone, checked against its SHA-256, then moved into place in one
 *  step. Links are fetched with no sign-in header: the link is the permission. */
class Downloader(private val http: OkHttpClient = plain) {

    /** Fetches [url] into [part] (resuming) and, once it's whole and its SHA-256 is
     *  [sha256], renames it to [done]. [onBytes] hears how much of the file is here.
     *  Throws [LinkGone] (ask for links again), [Damaged] (the part was deleted; start
     *  over), [Stopped] or an IOException (the part is kept for next time). */
    fun fetch(url: String, bytes: Long, sha256: String, part: File, done: File, stopped: () -> Boolean, onBytes: (Long) -> Unit) {
        try {
            download(url, bytes, sha256, part, done, stopped, onBytes)
        } catch (e: Damaged) {
            part.delete()
            throw e
        }
    }

    private fun download(url: String, bytes: Long, sha256: String, part: File, done: File, stopped: () -> Boolean, onBytes: (Long) -> Unit) {
        if (done.isFile && done.length() == bytes) return
        part.parentFile?.mkdirs()
        var have = if (part.isFile) part.length() else 0L
        if (have > bytes) {
            part.delete()
            have = 0
        }
        if (have < bytes) {
            var attempt = 0
            while (true) {
                attempt++
                val request = Request.Builder().url(url).apply { if (have > 0) header("Range", "bytes=$have-") }.build()
                val restart = http.newCall(request).execute().use { r ->
                    when {
                        r.code == 404 || r.code == 410 || r.code == 403 -> throw LinkGone()
                        r.code == 401 -> throw LinkGone()
                        // Asked past the end: what's here isn't this file after all.
                        r.code == 416 -> true
                        r.code == 206 && rangeStart(r.header("Content-Range")) != have -> true
                        r.code == 200 || r.code == 206 -> {
                            val append = r.code == 206
                            if (!append) have = 0
                            FileOutputStream(part, append).use { out ->
                                val input = r.body.byteStream()
                                val buf = ByteArray(1 shl 16)
                                var lastHeard = 0L
                                while (true) {
                                    if (stopped()) throw Stopped()
                                    val n = input.read(buf)
                                    if (n < 0) break
                                    if (have + n > bytes) throw Damaged("too long")
                                    out.write(buf, 0, n)
                                    have += n
                                    if (have - lastHeard >= PROGRESS_STEP) {
                                        lastHeard = have
                                        onBytes(have)
                                    }
                                }
                                out.fd.sync()
                            }
                            false
                        }
                        r.code >= 500 -> throw IOException("The server had a problem (${r.code}). It'll try again.")
                        else -> throw IOException("The download was refused (${r.code}).")
                    }
                }
                if (!restart) break
                part.delete()
                have = 0
                if (attempt >= 2) throw Damaged("the server sent the wrong part")
            }
        }
        onBytes(have)
        if (have != bytes) throw IOException("Download stopped: no connection. It'll carry on by itself.")
        if (sha256(part) != sha256.lowercase()) throw Damaged("its check didn't match")
        done.parentFile?.mkdirs()
        if (!part.renameTo(done)) {
            done.delete()
            if (!part.renameTo(done)) throw IOException("Couldn't save a download.")
        }
    }

    companion object {
        private const val PROGRESS_STEP = 256L * 1024

        val plain: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()

        private fun rangeStart(header: String?): Long? =
            header?.removePrefix("bytes ")?.substringBefore('-')?.trim()?.toLongOrNull()

        fun sha256(file: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            FileInputStream(file).use { input ->
                val buf = ByteArray(1 shl 16)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                }
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
