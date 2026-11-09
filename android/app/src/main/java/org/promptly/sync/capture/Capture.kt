package org.promptly.sync.capture

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import org.json.JSONArray
import org.json.JSONObject
import org.promptly.sync.widgets.Op
import java.io.File
import java.io.IOException
import java.util.UUID

/**
 * Where quick capture keeps what it hasn't sent yet: voice recordings and
 * the pictures and recordings shared into Notes. They're copied into the
 * app's own storage (a shared photo's permission ends when the share screen
 * closes), go up with tus when there's signal, and are deleted once the
 * server has them — or when the phone is unlinked.
 */
object Capture {
    /** The most one shared file may be (a long recording fits; a film doesn't). */
    const val MAX_BYTES = 512L * 1024 * 1024

    fun dir(ctx: Context): File = File(ctx.applicationContext.filesDir, "capture").apply { mkdirs() }

    fun newFile(ctx: Context, ext: String): File = File(dir(ctx), "${UUID.randomUUID()}.$ext")

    /** A file for an op's `files`: [id] is the attachment's id on the server. */
    fun ref(file: File, name: String, mime: String, durationMs: Long? = null, peaks: List<Float>? = null): JSONObject =
        JSONObject().put("id", UUID.randomUUID().toString()).put("path", file.absolutePath).put("name", name).put("mime", mime)
            .put("size", file.length()).apply {
                if (durationMs != null) put("duration_ms", durationMs)
                if (!peaks.isNullOrEmpty()) put("peaks", JSONArray(peaks.map { (Math.round(it * 1000) / 1000.0) }))
            }

    /** Copy a shared file in. Null if it can't be read; [TooBig] past [MAX_BYTES]. */
    fun copyIn(ctx: Context, uri: Uri, mime: String): JSONObject? {
        val name = displayName(ctx, uri) ?: defaultName(mime)
        val ext = name.substringAfterLast('.', "").lowercase().takeIf { it.length in 1..5 && it.all(Char::isLetterOrDigit) } ?: extFor(mime)
        val out = newFile(ctx, ext)
        try {
            val input = ctx.contentResolver.openInputStream(uri) ?: return null
            input.use { inp ->
                out.outputStream().use { o ->
                    val buf = ByteArray(1 shl 16)
                    var total = 0L
                    while (true) {
                        val n = inp.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > MAX_BYTES) throw TooBig()
                        o.write(buf, 0, n)
                    }
                }
            }
        } catch (e: TooBig) {
            out.delete()
            throw e
        } catch (e: IOException) {
            out.delete()
            return null
        } catch (e: SecurityException) {
            out.delete()
            return null
        }
        if (out.length() == 0L) {
            out.delete()
            return null
        }
        return ref(out, name, mime)
    }

    class TooBig : IOException("That file is too big to put in a note.")

    private fun displayName(ctx: Context, uri: Uri): String? = runCatching {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }.getOrNull()?.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_")?.take(120)?.takeIf { it.isNotBlank() }

    fun extFor(mime: String): String = when (mime.lowercase()) {
        "image/jpeg" -> "jpg"
        "image/png" -> "png"
        "image/webp" -> "webp"
        "image/gif" -> "gif"
        "image/heic" -> "heic"
        "image/heif" -> "heif"
        "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac" -> "m4a"
        "audio/mpeg" -> "mp3"
        "audio/ogg", "audio/opus" -> "ogg"
        "audio/wav", "audio/x-wav" -> "wav"
        "audio/webm" -> "webm"
        "audio/flac" -> "flac"
        else -> if (mime.startsWith("image/")) "jpg" else "bin"
    }

    private fun defaultName(mime: String): String =
        (if (mime.startsWith("audio/")) "Recording" else "Picture") + "." + extFor(mime)

    /** The files of [op] that are still on the phone (only ours, in [dir]). */
    fun files(op: Op): List<JSONObject> {
        val arr = op.body.optJSONArray("files") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
    }

    /** The op is done (or refused): its copies go. */
    fun delete(op: Op) {
        for (f in files(op)) {
            val file = File(f.optString("path"))
            if (file.parentFile?.name == "capture") file.delete()
        }
    }

    /** Copies nothing refers to any more (a share screen closed mid-copy, say),
     *  a day on. Never the recording being made. */
    fun sweep(ctx: Context, ops: List<Op>, now: Long) {
        val kept = ops.flatMap { files(it) }.map { File(it.optString("path")).name }.toSet()
        val recording = Recorder.state.value.file?.name
        dir(ctx).listFiles()?.forEach { f ->
            if (f.name !in kept && f.name != recording && now - f.lastModified() > 24 * 60 * 60 * 1000L) f.delete()
        }
    }

    fun wipe(ctx: Context) {
        dir(ctx).listFiles()?.forEach { it.deleteRecursively() }
    }
}
