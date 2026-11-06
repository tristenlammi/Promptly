// Reads a zip from memory, the way fflate's unzipSync does: from the central directory, so a
// truncated file is an error rather than a partial import, which java.util.zip.ZipInputStream
// can't promise. ZipFile needs a file on disk, and a decrypted export shouldn't be put there.
// Limits on entries and on what comes out, counted while inflating, not taken from the headers:
// the web only adds up the sizes a file declares, and has no entry limit. Pure JVM.
package org.promptly.sync.passwords.core

import java.util.zip.Inflater

internal object SafeZip {
    const val MAX_ENTRIES = 20_000

    /** Everything that comes out of one archive, together. */
    const val MAX_EXPANDED = Importers.MAX_BYTES.toLong()

    private fun bad(): Nothing = throw IllegalArgumentException("That zip file is damaged")

    private fun u16(b: ByteArray, at: Long): Int {
        if (at < 0 || at + 2 > b.size) bad()
        val i = at.toInt()
        return (b[i].toInt() and 255) or ((b[i + 1].toInt() and 255) shl 8)
    }

    private fun u32(b: ByteArray, at: Long): Long {
        if (at < 0 || at + 4 > b.size) bad()
        val i = at.toInt()
        return (b[i].toLong() and 255) or ((b[i + 1].toLong() and 255) shl 8) or ((b[i + 2].toLong() and 255) shl 16) or ((b[i + 3].toLong() and 255) shl 24)
    }

    private fun u64(b: ByteArray, at: Long): Long {
        val v = u32(b, at) or (u32(b, at + 4) shl 32)
        if (v < 0) bad()
        return v
    }

    private class Entry(val name: String, val flags: Int, val method: Int, val compressed: Long, val original: Long, val local: Long)

    private const val FULL32 = 0xFFFFFFFFL

    private fun directory(zip: ByteArray): List<Entry> {
        var e = zip.size.toLong() - 22
        while (true) {
            if (e < 0 || zip.size - e > 65558) bad()
            if (u32(zip, e) == 0x06054B50L) break
            e--
        }
        var count = u16(zip, e + 10).toLong()
        var at = u32(zip, e + 16)
        if (count == 0xFFFFL || at == FULL32) {
            val locator = e - 20
            if (locator < 0 || u32(zip, locator) != 0x07064B50L) bad()
            val record = u64(zip, locator + 8)
            if (u32(zip, record) != 0x06064B50L) bad()
            count = u64(zip, record + 32)
            at = u64(zip, record + 48)
        }
        if (count > MAX_ENTRIES) throw IllegalArgumentException("That archive has too many files in it")
        val out = ArrayList<Entry>(count.toInt())
        repeat(count.toInt()) {
            if (u32(zip, at) != 0x02014B50L) bad()
            val flags = u16(zip, at + 8)
            val method = u16(zip, at + 10)
            var compressed = u32(zip, at + 20)
            var original = u32(zip, at + 24)
            val nameLength = u16(zip, at + 28)
            val extraLength = u16(zip, at + 30)
            val commentLength = u16(zip, at + 32)
            var local = u32(zip, at + 42)
            val nameAt = at + 46
            if (nameAt + nameLength > zip.size) bad()
            val name = String(zip, nameAt.toInt(), nameLength, Charsets.UTF_8)
            if (compressed == FULL32 || original == FULL32 || local == FULL32) {
                var x = nameAt + nameLength
                val extraEnd = x + extraLength
                var found = false
                while (x + 4 <= extraEnd) {
                    val id = u16(zip, x)
                    val size = u16(zip, x + 2)
                    if (id == 1) {
                        var v = x + 4
                        if (original == FULL32) {
                            original = u64(zip, v)
                            v += 8
                        }
                        if (compressed == FULL32) {
                            compressed = u64(zip, v)
                            v += 8
                        }
                        if (local == FULL32) local = u64(zip, v)
                        found = true
                        break
                    }
                    x += 4 + size
                }
                if (!found) bad()
            }
            out += Entry(name, flags, method, compressed, original, local)
            at = nameAt + nameLength + extraLength + commentLength
        }
        return out
    }

    /** The names, without inflating anything. */
    fun names(zip: ByteArray): List<String> = directory(zip).map { it.name }

    /** Attachments in a .1pux aren't read: `files/` is left alone, as on the web. */
    fun read(zip: ByteArray, wanted: (String) -> Boolean = { !it.startsWith("files/") }): Map<String, ByteArray> {
        val out = LinkedHashMap<String, ByteArray>()
        var total = 0L
        for (e in directory(zip)) {
            if (!wanted(e.name)) continue
            if (e.flags and 1 != 0) throw IllegalArgumentException("That archive is encrypted")
            if (e.original > MAX_EXPANDED - total) throw IllegalArgumentException("That archive is too large")
            val start = e.local + 30 + u16(zip, e.local + 26) + u16(zip, e.local + 28)
            if (u32(zip, e.local) != 0x04034B50L || start + e.compressed > zip.size) bad()
            val data = when (e.method) {
                0 -> {
                    if (e.compressed != e.original) bad()
                    zip.copyOfRange(start.toInt(), (start + e.compressed).toInt())
                }
                8 -> inflate(zip, start.toInt(), e.compressed.toInt(), e.original.toInt())
                else -> throw IllegalArgumentException("That archive uses a kind of compression we don't know")
            }
            total += data.size
            // Overlapping entries, every one the same small bomb: this counts each time it's expanded.
            out[e.name] = data
        }
        return out
    }

    /** Exactly the size declared: anything longer or shorter is a file that lied. */
    private fun inflate(zip: ByteArray, at: Int, length: Int, size: Int): ByteArray {
        val inflater = Inflater(true)
        try {
            inflater.setInput(zip, at, length)
            val out = ByteArray(size)
            var done = 0
            while (done < size) {
                val n = try {
                    inflater.inflate(out, done, size - done)
                } catch (_: java.util.zip.DataFormatException) {
                    bad()
                }
                // Finished early, out of input, or asking for a dictionary: never what the header said.
                if (n == 0) bad()
                done += n
            }
            if (!inflater.finished()) {
                val extra = ByteArray(1)
                val n = try {
                    inflater.inflate(extra)
                } catch (_: java.util.zip.DataFormatException) {
                    bad()
                }
                if (n > 0) throw IllegalArgumentException("That archive is too large")
            }
            return out
        } finally {
            inflater.end()
        }
    }
}
