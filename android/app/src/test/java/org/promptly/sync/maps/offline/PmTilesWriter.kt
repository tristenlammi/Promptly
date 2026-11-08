package org.promptly.sync.maps.offline

import com.sun.net.httpserver.HttpServer
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Collections
import java.util.zip.GZIPOutputStream

/** Writes small PMTiles v3 files for tests (no downloads), the way `pmtiles extract`
 *  lays them out: header, gzipped root directory, optional leaf directories, tiles. */
object PmTilesWriter {
    fun gzip(bytes: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        GZIPOutputStream(out).use { it.write(bytes) }
        return out.toByteArray()
    }

    private class E(val id: Long, val offset: Long, val length: Int, val run: Long)

    private fun varint(out: ByteArrayOutputStream, value: Long) {
        var v = value
        while (v >= 0x80) {
            out.write(((v and 0x7F) or 0x80).toInt())
            v = v ushr 7
        }
        out.write(v.toInt())
    }

    private fun directory(entries: List<E>, gzipped: Boolean): ByteArray {
        val out = ByteArrayOutputStream()
        varint(out, entries.size.toLong())
        var last = 0L
        for (e in entries) {
            varint(out, e.id - last)
            last = e.id
        }
        for (e in entries) varint(out, e.run)
        for (e in entries) varint(out, e.length.toLong())
        for ((i, e) in entries.withIndex()) {
            val prev = entries.getOrNull(i - 1)
            varint(out, if (prev != null && e.offset == prev.offset + prev.length) 0 else e.offset + 1)
        }
        return if (gzipped) gzip(out.toByteArray()) else out.toByteArray()
    }

    /**
     * [tiles]: z/x/y to bytes as stored. [leafSize]: put entries in leaf directories of
     * this many (0: all in the root). [bounds]: west, south, east, north.
     */
    fun write(
        file: File,
        tiles: Map<TileMath.Tile, ByteArray>,
        leafSize: Int = 0,
        gzipDirs: Boolean = true,
        gzipTiles: Boolean = true,
        bounds: DoubleArray = doubleArrayOf(148.0, -33.0, 149.0, -32.0),
    ): File {
        val sorted = tiles.entries.sortedBy { PmTiles.tileId(it.key.z, it.key.x, it.key.y) }
        val data = ByteArrayOutputStream()
        val entries = sorted.map { (t, bytes) ->
            val e = E(PmTiles.tileId(t.z, t.x, t.y), data.size().toLong(), bytes.size, 1)
            data.write(bytes)
            e
        }
        val root: ByteArray
        val leaves = ByteArrayOutputStream()
        if (leafSize > 0 && entries.size > leafSize) {
            val pointers = entries.chunked(leafSize).map { chunk ->
                val dir = directory(chunk, gzipDirs)
                val p = E(chunk.first().id, leaves.size().toLong(), dir.size, 0)
                leaves.write(dir)
                p
            }
            root = directory(pointers, gzipDirs)
        } else root = directory(entries, gzipDirs)
        val head = ByteBuffer.allocate(PmTiles.HEADER).order(ByteOrder.LITTLE_ENDIAN)
        val rootOffset = PmTiles.HEADER.toLong()
        val metaOffset = rootOffset + root.size
        val leafOffset = metaOffset
        val dataOffset = leafOffset + leaves.size()
        head.put("PMTiles".toByteArray(Charsets.US_ASCII)).put(3)
        head.putLong(rootOffset).putLong(root.size.toLong())
        head.putLong(metaOffset).putLong(0)
        head.putLong(leafOffset).putLong(leaves.size().toLong())
        head.putLong(dataOffset).putLong(data.size().toLong())
        head.putLong(entries.size.toLong()).putLong(entries.size.toLong()).putLong(entries.size.toLong())
        head.put(1).put(if (gzipDirs) 2 else 1).put(if (gzipTiles) 2 else 1).put(1)
        head.put((sorted.minOfOrNull { it.key.z } ?: 0).toByte()).put((sorted.maxOfOrNull { it.key.z } ?: 0).toByte())
        head.putInt((bounds[0] * 1e7).toInt()).putInt((bounds[1] * 1e7).toInt()).putInt((bounds[2] * 1e7).toInt()).putInt((bounds[3] * 1e7).toInt())
        head.put(0).putInt(0).putInt(0)
        file.parentFile?.mkdirs()
        file.outputStream().use {
            it.write(head.array())
            it.write(root)
            it.write(leaves.toByteArray())
            it.write(data.toByteArray())
        }
        return file
    }

    /** A made-up tile's bytes, gzipped like the basemap's, that say which tile and source. */
    fun tileBytes(t: TileMath.Tile, tag: String): ByteArray = gzip("$tag ${t.z}/${t.x}/${t.y}".toByteArray())

    /** A file served over HTTP with Range, like nginx serves the basemap's `/m/` link. */
    class RangeServer(@Volatile var file: File) : AutoCloseable {
        val requests: MutableList<String> = Collections.synchronizedList(mutableListOf())
        @Volatile var status: Int? = null
        @Volatile var ignoreRange = false
        private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val url: String get() = "http://127.0.0.1:${server.address.port}/m/basemap"

        init {
            server.createContext("/m/") { ex ->
                try {
                    val range = ex.requestHeaders.getFirst("Range")
                    requests += range ?: "all"
                    val forced = status
                    if (forced != null) {
                        ex.sendResponseHeaders(forced, -1)
                        return@createContext
                    }
                    val all = file.readBytes()
                    if (range == null || ignoreRange) {
                        ex.sendResponseHeaders(200, all.size.toLong())
                        ex.responseBody.write(all)
                    } else {
                        val (a, b) = range.removePrefix("bytes=").split("-").map { it.toLong() }
                        val end = minOf(b, all.size - 1L)
                        val part = all.copyOfRange(a.toInt(), end.toInt() + 1)
                        ex.responseHeaders.add("Content-Range", "bytes $a-$end/${all.size}")
                        ex.sendResponseHeaders(206, part.size.toLong())
                        ex.responseBody.write(part)
                    }
                } finally {
                    ex.close()
                }
            }
            server.start()
        }

        override fun close() = server.stop(0)
    }
}
