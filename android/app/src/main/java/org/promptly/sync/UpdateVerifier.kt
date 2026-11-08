// Checking a downloaded update against the server's Promptly.json. The installer that uses
// it (Updater) is only in the server build; the Play build is updated by Play.
package org.promptly.sync

import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest

class UpdateHashMismatch : IOException("The download didn't match its checksum, so it wasn't installed.")

/** No Android in here, so the JVM tests run the real thing against a local HTTP server. */
object UpdateVerifier {
    private val SHA256 = Regex("^[0-9a-f]{64}$")

    /** A manifest with no usable hash means no update at all: fail closed. */
    fun validHash(raw: String?): String? = raw?.trim()?.lowercase()?.takeIf { SHA256.matches(it) }

    /** Streams to [dest] and hashes as it goes. On any mismatch [dest] is gone. */
    fun download(http: OkHttpClient, url: String, expectedSha256: String, dest: File, progress: (Long) -> Unit = {}) {
        val want = validHash(expectedSha256) ?: throw UpdateHashMismatch()
        dest.parentFile?.mkdirs()
        val part = File(dest.parentFile, dest.name + ".part")
        val md = MessageDigest.getInstance("SHA-256")
        try {
            http.newCall(Request.Builder().url(url).header("Cache-Control", "no-cache").build()).execute().use { r ->
                if (!r.isSuccessful) throw IOException("The download failed (${r.code}).")
                r.body.byteStream().use { input ->
                    part.outputStream().use { out ->
                        val buf = ByteArray(1 shl 16)
                        var total = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            md.update(buf, 0, n)
                            out.write(buf, 0, n)
                            total += n
                            progress(total)
                        }
                    }
                }
            }
            val got = md.digest().joinToString("") { "%02x".format(it) }
            // Not secret, but no reason to compare any other way.
            if (!MessageDigest.isEqual(got.toByteArray(), want.toByteArray())) throw UpdateHashMismatch()
            dest.delete()
            if (!part.renameTo(dest)) throw IOException("Couldn't save the download.")
        } finally {
            part.delete()
        }
    }
}
