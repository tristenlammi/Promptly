package org.promptly.sync.maps.offline

import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException

/**
 * Your server's whole-Australia `basemap.pmtiles`, read a piece at a time with HTTP
 * Range requests on the signed `/m/` link P Maps' config hands out (a week long).
 * It's what fills in the map wherever this phone has no square and no trip cache,
 * the way the web map reads it.
 *
 * [link] asks the server for that link (null: maps aren't set up there). A link
 * that stops working (expired, or a new map build went live) is asked for again
 * once. After a network failure the server rests for [restMillis], so a dead
 * connection costs one wait, not one per tile.
 */
class ServerBasemap(
    private val link: () -> String?,
    private val http: () -> OkHttpClient,
    private val restMillis: Long = 15_000,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private class Gone : IOException("The map link stopped working")

    @Volatile private var archive: PmTiles? = null
    @Volatile private var failedAt = 0L
    private val opening = Any()

    /** True for a while after the server couldn't be reached. */
    fun resting(): Boolean = failedAt != 0L && now() - failedAt < restMillis

    /** Forget the link and what was read, as after the server's map changed. */
    fun forget() {
        archive = null
    }

    private fun get(url: String, offset: Long, length: Int): ByteArray {
        val request = Request.Builder().url(url).header("Range", "bytes=$offset-${offset + length - 1}").build()
        http().newCall(request).execute().use { r ->
            when {
                r.code == 206 -> {
                    val body = r.body.bytes()
                    if (body.size != length && !(offset == 0L && body.size < length)) throw IOException("The server sent part of the map")
                    return body
                }
                // Not a range answer: never read a whole 2 GB map to take a tile from it.
                r.code == 200 -> throw IOException("The server doesn't send the map in pieces")
                r.code == 401 || r.code == 403 || r.code == 404 || r.code == 410 -> throw Gone()
                else -> throw IOException("The server said ${r.code}")
            }
        }
    }

    private fun open(): PmTiles {
        archive?.let { return it }
        synchronized(opening) {
            archive?.let { return it }
            val url = link() ?: throw IOException("Maps aren't set up on this server yet")
            // The header and root directory sit in the first 16 KB: one request for both.
            val prefix = get(url, 0, PREFIX)
            val opened = PmTiles({ offset, length ->
                if (offset + length <= prefix.size) prefix.copyOfRange(offset.toInt(), offset.toInt() + length) else get(url, offset, length)
            })
            archive = opened
            return opened
        }
    }

    private fun <T> guarded(block: (PmTiles) -> T): T {
        try {
            val result = try {
                block(open())
            } catch (e: Gone) {
                forget()
                block(open())
            }
            failedAt = 0L
            return result
        } catch (e: Gone) {
            forget()
            failedAt = now()
            throw e
        } catch (e: IOException) {
            failedAt = now()
            throw e
        }
    }

    /** One tile, as stored (gzipped), or null where the map has none. */
    fun tile(z: Int, x: Int, y: Int): ByteArray? = guarded { it.tile(z, x, y) }

    /**
     * Many tiles at once, for saving a trip's map: neighbours in the file are read
     * in one request. [take] decides, in order, whether each found tile still fits
     * (by its size); [got] hears each one read. Returns the bytes read.
     */
    fun tiles(wanted: List<TileMath.Tile>, take: (TileMath.Tile, Int) -> Boolean, got: (TileMath.Tile, ByteArray) -> Unit): Long = guarded { archive ->
        val found = ArrayList<Pair<TileMath.Tile, PmTiles.Span>>()
        for (t in wanted) {
            val span = archive.locate(t.z, t.x, t.y) ?: continue
            if (!take(t, span.length)) break
            found += t to span
        }
        var total = 0L
        val byOffset = found.sortedBy { it.second.offset }
        var i = 0
        while (i < byOffset.size) {
            // Join spans that sit close together into one read.
            var j = i
            var end = byOffset[i].second.offset + byOffset[i].second.length
            while (j + 1 < byOffset.size) {
                val next = byOffset[j + 1].second
                if (next.offset - end > GAP || next.offset + next.length - byOffset[i].second.offset > MAX_READ) break
                end = maxOf(end, next.offset + next.length)
                j++
            }
            val start = byOffset[i].second.offset
            val block = archive.read(PmTiles.Span(start, (end - start).toInt()))
            total += block.size
            for (k in i..j) {
                val (t, s) = byOffset[k]
                val from = (s.offset - start).toInt()
                got(t, block.copyOfRange(from, from + s.length))
            }
            i = j + 1
        }
        total
    }

    companion object {
        private const val PREFIX = 16_384
        private const val GAP = 32L * 1024
        private const val MAX_READ = 4L * 1024 * 1024
    }
}
