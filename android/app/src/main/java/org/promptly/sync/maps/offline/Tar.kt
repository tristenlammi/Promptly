package org.promptly.sync.maps.offline

import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream

/** Unpacks the server's routing tars (plain ustar, `tarfile.USTAR_FORMAT` in
 *  `maps/areas.py`) into the phone's one Valhalla tile folder. Only regular files
 *  with plain relative names are written; anything else is refused. */
object Tar {
    private const val BLOCK = 512

    class Member(val path: String, val bytes: Long)

    /** Every member's name and size, without writing anything. */
    fun list(tar: File): List<Member> = read(tar, null)

    /** Writes each member under [into] (each through a temporary name, then
     *  renamed, so a half-written tile never sits under its real name) and returns
     *  what was written. */
    fun extract(tar: File, into: File, stopped: () -> Boolean = { false }): List<Member> = read(tar, into, stopped)

    private fun read(tar: File, into: File?, stopped: () -> Boolean = { false }): List<Member> {
        val out = mutableListOf<Member>()
        BufferedInputStream(FileInputStream(tar), 1 shl 16).use { input ->
            val header = ByteArray(BLOCK)
            var longName: String? = null
            while (true) {
                if (!fill(input, header)) break
                if (header.all { it == 0.toByte() }) break
                val size = octal(header, 124, 12)
                val type = header[156].toInt().toChar()
                val name = longName ?: run {
                    val base = text(header, 0, 100)
                    val prefix = if (text(header, 257, 6).startsWith("ustar")) text(header, 345, 155) else ""
                    if (prefix.isEmpty()) base else "$prefix/$base"
                }
                longName = null
                val padded = (size + BLOCK - 1) / BLOCK * BLOCK
                when (type) {
                    // GNU long name: the next header's name.
                    'L' -> {
                        val bytes = ByteArray(size.toInt())
                        if (!fill(input, bytes)) throw IOException("A routing file ended early.")
                        skip(input, padded - size)
                        longName = String(bytes, Charsets.UTF_8).trimEnd('\u0000')
                    }
                    '0', '\u0000' -> {
                        val path = safe(name)
                        if (into != null) {
                            if (stopped()) throw Stopped()
                            val dest = File(into, path)
                            dest.parentFile?.mkdirs()
                            val tmp = File(dest.parentFile, dest.name + ".tmp")
                            tmp.outputStream().use { o -> copy(input, o, size) }
                            if (!tmp.renameTo(dest)) {
                                dest.delete()
                                if (!tmp.renameTo(dest)) throw IOException("Couldn't put a routing file in place.")
                            }
                        } else {
                            skip(input, size)
                        }
                        skip(input, padded - size)
                        out += Member(path, size)
                    }
                    // Folders are made as needed; anything else (links, devices) is skipped.
                    else -> skip(input, padded)
                }
            }
        }
        return out
    }

    /** A plain relative path: no absolute paths, no `..`. */
    internal fun safe(name: String): String {
        val clean = name.trim().removePrefix("./")
        val parts = clean.split('/').filter { it.isNotEmpty() }
        if (clean.startsWith("/") || clean.contains('\\') || parts.isEmpty() || parts.any { it == ".." || it == "." }) {
            throw IOException("A routing file had an unsafe name.")
        }
        return parts.joinToString("/")
    }

    private fun text(b: ByteArray, at: Int, len: Int): String {
        var end = at
        while (end < at + len && b[end] != 0.toByte()) end++
        return String(b, at, end - at, Charsets.UTF_8)
    }

    private fun octal(b: ByteArray, at: Int, len: Int): Long {
        val s = text(b, at, len).trim()
        if (s.isEmpty()) return 0
        return s.toLong(8)
    }

    private fun fill(input: InputStream, buf: ByteArray): Boolean {
        var got = 0
        while (got < buf.size) {
            val n = input.read(buf, got, buf.size - got)
            if (n < 0) return if (got == 0) false else throw IOException("A routing file ended early.")
            got += n
        }
        return true
    }

    private fun skip(input: InputStream, n: Long) {
        var left = n
        val buf = ByteArray(8192)
        while (left > 0) {
            val r = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (r < 0) throw IOException("A routing file ended early.")
            left -= r
        }
    }

    private fun copy(input: InputStream, output: java.io.OutputStream, n: Long) {
        var left = n
        val buf = ByteArray(1 shl 16)
        while (left > 0) {
            val r = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (r < 0) throw IOException("A routing file ended early.")
            output.write(buf, 0, r)
            left -= r
        }
    }
}
