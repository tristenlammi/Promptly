package org.promptly.sync.maps.offline

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption
import java.util.zip.GZIPInputStream

/**
 * A small PMTiles v3 reader: the header, varint directories (gzip or plain), leaf
 * directories and Hilbert tile ids. The spec is BSD-3
 * (github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
 *
 * The bytes come from a [Bytes]: a square's `map.pmtiles` on the phone ([open]), or
 * the server's `basemap.pmtiles` read by HTTP Range ([ServerBasemap]). Tiles come
 * back as stored (the basemap's are gzipped); [MapTiles.plain] unpacks them.
 * Safe to use from several threads.
 */
class PmTiles(private val bytes: Bytes, private val onClose: () -> Unit = {}) : AutoCloseable {
    /** Where the file's bytes come from. */
    fun interface Bytes {
        fun read(offset: Long, length: Int): ByteArray
    }

    /** One tile's place in the file. */
    data class Span(val offset: Long, val length: Int)

    data class Entry(val tileId: Long, val offset: Long, val length: Int, val runLength: Long)

    val minZoom: Int
    val maxZoom: Int
    /** The area the file covers, in degrees: west, south, east, north. */
    val bounds: DoubleArray
    private val leafOffset: Long
    private val dataOffset: Long
    private val internalGzip: Boolean
    private val root: List<Entry>
    private val leaves = object : LinkedHashMap<Long, List<Entry>>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, List<Entry>>?) = size > LEAVES_KEPT
    }

    init {
        val head = bytes.read(0, HEADER)
        if (head.size < HEADER || String(head, 0, 7, Charsets.US_ASCII) != "PMTiles" || head[7].toInt() != 3) {
            throw IOException("Not a PMTiles v3 file")
        }
        val b = ByteBuffer.wrap(head).order(ByteOrder.LITTLE_ENDIAN)
        val rootOffset = b.getLong(8)
        val rootLength = b.getLong(16)
        leafOffset = b.getLong(40)
        dataOffset = b.getLong(56)
        val internal = head[97].toInt()
        val tiles = head[98].toInt()
        if (internal !in 1..2 || tiles !in 0..2) throw IOException("This map file uses a compression the phone can't read")
        internalGzip = internal == 2
        minZoom = head[100].toInt() and 0xFF
        maxZoom = head[101].toInt() and 0xFF
        bounds = doubleArrayOf(b.getInt(102) / 1e7, b.getInt(106) / 1e7, b.getInt(110) / 1e7, b.getInt(114) / 1e7)
        root = directory(rootOffset, rootLength.toInt())
    }

    private fun inflate(raw: ByteArray): ByteArray = GZIPInputStream(raw.inputStream()).use { input ->
        val out = ByteArrayOutputStream(raw.size * 4)
        input.copyTo(out)
        out.toByteArray()
    }

    private fun directory(offset: Long, length: Int): List<Entry> {
        val raw = bytes.read(offset, length)
        val data = if (internalGzip) inflate(raw) else raw
        var pos = 0
        fun varint(): Long {
            var result = 0L
            var shift = 0
            while (true) {
                if (pos >= data.size) throw IOException("A damaged map file")
                val c = data[pos++].toInt() and 0xFF
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

    /** Where a tile is in the file, or null if the file has none there. */
    fun locate(z: Int, x: Int, y: Int): Span? {
        if (z < minZoom || z > maxZoom || x < 0 || y < 0 || x >= (1 shl z) || y >= (1 shl z)) return null
        val id = tileId(z, x, y)
        var entries = root
        repeat(4) { // the spec allows at most three levels of leaf directories
            val e = find(entries, id) ?: return null
            if (e.runLength > 0) return Span(dataOffset + e.offset, e.length)
            entries = synchronized(leaves) { leaves[e.offset] } ?: directory(leafOffset + e.offset, e.length).also {
                synchronized(leaves) { leaves[e.offset] = it }
            }
        }
        return null
    }

    /** The tile's bytes as stored (gzipped for the basemap), or null. */
    fun tile(z: Int, x: Int, y: Int): ByteArray? = locate(z, x, y)?.let { bytes.read(it.offset, it.length) }

    /** Reads spans the caller worked out with [locate] (many tiles in one go). */
    fun read(span: Span): ByteArray = bytes.read(span.offset, span.length)

    override fun close() = onClose()

    companion object {
        const val HEADER = 127
        private const val LEAVES_KEPT = 64

        /** A PMTiles file on the phone. Positional reads, so threads don't queue; and
         *  the file can be replaced while it's open (a new map build moved into place). */
        fun open(file: File): PmTiles {
            val channel = FileChannel.open(file.toPath(), StandardOpenOption.READ)
            return try {
                PmTiles({ offset, length ->
                    val out = ByteBuffer.allocate(length)
                    var at = offset
                    while (out.hasRemaining()) {
                        val n = channel.read(out, at)
                        if (n < 0) throw IOException("A map file ended early")
                        at += n
                    }
                    out.array()
                }) { channel.close() }
            } catch (e: Exception) {
                channel.close()
                throw e
            }
        }

        internal fun find(entries: List<Entry>, id: Long): Entry? {
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
            // The entry before: a run of tiles may cover this id, or it's a leaf that may hold it.
            if (hi >= 0) {
                val e = entries[hi]
                if (e.runLength == 0L) return e
                if (id - e.tileId < e.runLength) return e
            }
            return null
        }

        /** Z/X/Y to the Hilbert-ordered tile id the spec uses. */
        fun tileId(z: Int, x: Int, y: Int): Long {
            if (z == 0) return 0L
            var acc = 0L
            for (a in 0 until z) acc += (1L shl a) * (1L shl a)
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
