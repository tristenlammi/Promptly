package org.promptly.sync.maps.offline

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.GZIPInputStream

/** WP-M0 spike: a small PMTiles v3 reader (header, varint directories, Hilbert tile
 *  ids). The spec is BSD-3 (github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
 *  WP-M4 moves this into main with its own tests; it lives in the debug source set
 *  until then so nothing here ships. */
class PmTiles(file: File) : AutoCloseable {
    private val raf = RandomAccessFile(file, "r")
    val minZoom: Int
    val maxZoom: Int
    private val rootOffset: Long
    private val rootLength: Long
    private val leafOffset: Long
    private val dataOffset: Long
    private val internalGzip: Boolean
    val tilesGzip: Boolean
    private val leaves = object : LinkedHashMap<Long, List<Entry>>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, List<Entry>>?) = size > 64
    }
    private val root: List<Entry>

    init {
        val head = ByteArray(127)
        raf.seek(0)
        raf.readFully(head)
        require(String(head, 0, 7, Charsets.US_ASCII) == "PMTiles" && head[7].toInt() == 3) { "Not a PMTiles v3 file" }
        val b = ByteBuffer.wrap(head).order(ByteOrder.LITTLE_ENDIAN)
        rootOffset = b.getLong(8)
        rootLength = b.getLong(16)
        leafOffset = b.getLong(40)
        dataOffset = b.getLong(56)
        internalGzip = head[97].toInt() == 2
        tilesGzip = head[98].toInt() == 2
        minZoom = head[100].toInt() and 0xFF
        maxZoom = head[101].toInt() and 0xFF
        require(head[97].toInt() in 1..2 && head[98].toInt() in 1..2) { "Only none or gzip compression is supported" }
        root = directory(rootOffset, rootLength)
    }

    data class Entry(val tileId: Long, val offset: Long, val length: Int, val runLength: Long)

    private fun read(offset: Long, length: Int): ByteArray = synchronized(raf) {
        val out = ByteArray(length)
        raf.seek(offset)
        raf.readFully(out)
        out
    }

    private fun inflate(bytes: ByteArray): ByteArray = GZIPInputStream(bytes.inputStream()).use { input ->
        val out = ByteArrayOutputStream(bytes.size * 4)
        input.copyTo(out)
        out.toByteArray()
    }

    private fun directory(offset: Long, length: Long): List<Entry> {
        val raw = read(offset, length.toInt())
        val bytes = if (internalGzip) inflate(raw) else raw
        var pos = 0
        fun varint(): Long {
            var result = 0L
            var shift = 0
            while (true) {
                val c = bytes[pos++].toInt() and 0xFF
                result = result or ((c and 0x7F).toLong() shl shift)
                if (c < 0x80) return result
                shift += 7
            }
        }
        val n = varint().toInt()
        val ids = LongArray(n)
        var last = 0L
        for (i in 0 until n) {
            last += varint()
            ids[i] = last
        }
        val runs = LongArray(n) { varint() }
        val lengths = IntArray(n) { varint().toInt() }
        val offsets = LongArray(n)
        for (i in 0 until n) {
            val v = varint()
            offsets[i] = if (v == 0L && i > 0) offsets[i - 1] + lengths[i - 1] else v - 1
        }
        return List(n) { Entry(ids[it], offsets[it], lengths[it], runs[it]) }
    }

    private fun find(entries: List<Entry>, id: Long): Entry? {
        var lo = 0
        var hi = entries.size - 1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            val c = entries[mid].tileId.compareTo(id)
            when {
                c < 0 -> lo = mid + 1
                c > 0 -> hi = mid - 1
                else -> return entries[mid]
            }
        }
        // The entry before: a run may cover this id, or a leaf may hold it.
        if (hi >= 0) {
            val e = entries[hi]
            if (e.runLength == 0L) return e
            if (id - e.tileId < e.runLength) return e
        }
        return null
    }

    /** The tile's bytes, uncompressed, or null if this file has no such tile. */
    fun tile(z: Int, x: Int, y: Int): ByteArray? {
        if (z < minZoom || z > maxZoom) return null
        val id = tileId(z, x, y)
        var entries = root
        repeat(4) { // the spec allows at most three levels of leaves
            val e = find(entries, id) ?: return null
            if (e.runLength > 0) {
                val bytes = read(dataOffset + e.offset, e.length)
                return if (tilesGzip) inflate(bytes) else bytes
            }
            entries = synchronized(leaves) { leaves[e.offset] } ?: directory(leafOffset + e.offset, e.length.toLong()).also {
                synchronized(leaves) { leaves[e.offset] = it }
            }
        }
        return null
    }

    override fun close() = raf.close()

    companion object {
        /** Z/X/Y to the Hilbert-ordered tile id the spec uses. */
        fun tileId(z: Int, x: Int, y: Int): Long {
            var acc = 0L
            for (a in 0 until z) acc += (1L shl a) * (1L shl a)
            if (z == 0) return 0L
            var xx = x.toLong()
            var yy = y.toLong()
            var d = 0L
            var s = (1L shl z) / 2
            while (s > 0) {
                val rx = if ((xx and s) > 0) 1L else 0L
                val ry = if ((yy and s) > 0) 1L else 0L
                d += s * s * ((3 * rx) xor ry)
                if (ry == 0L) {
                    if (rx == 1L) {
                        xx = s - 1 - xx
                        yy = s - 1 - yy
                    }
                    val t = xx
                    xx = yy
                    yy = t
                }
                s /= 2
            }
            return acc + d
        }
    }
}
