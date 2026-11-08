package org.promptly.sync.maps.offline

import java.io.File
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.max

/**
 * Each trip's map, kept for a week: when a trip starts with signal, the map tiles
 * along the route are saved here, so a dead spot on the way never blanks the
 * screen, even with no area downloaded ("Keep each trip's map for a week").
 *
 * One file per tile, `<z>/<x>/<y>`, as the server stores it (gzipped). A tile's
 * age is its file's time: a later trip along the same road keeps it another week.
 */
class TripCache(val dir: File, private val now: () -> Long = System::currentTimeMillis) {

    private fun file(z: Int, x: Int, y: Int) = File(dir, "$z/$x/$y")

    private fun fresh(f: File): Boolean = now() - f.lastModified() < KEEP_MILLIS

    /** A tile saved in the last week, or null. An older one is removed on the way. */
    fun get(z: Int, x: Int, y: Int): ByteArray? {
        val f = file(z, x, y)
        if (!f.isFile) return null
        if (!fresh(f)) {
            f.delete()
            return null
        }
        return runCatching { f.readBytes() }.getOrNull()
    }

    fun has(z: Int, x: Int, y: Int): Boolean = file(z, x, y).let { it.isFile && fresh(it) }

    /** Whether there's a detailed map here (for "no map here" on the driving screen). */
    fun covers(lat: Double, lon: Double): Boolean =
        has(14, TileMath.x(lon, 14), TileMath.y(lat, 14)) || has(15, TileMath.x(lon, 15), TileMath.y(lat, 15))

    fun put(z: Int, x: Int, y: Int, bytes: ByteArray) {
        val f = file(z, x, y)
        f.parentFile?.mkdirs()
        val tmp = File(f.parentFile, "$y.new")
        tmp.writeBytes(bytes)
        if (!tmp.renameTo(f)) {
            f.delete()
            tmp.renameTo(f)
        }
        f.setLastModified(now())
    }

    /** Another week for a tile this trip uses again. */
    fun keep(z: Int, x: Int, y: Int): Boolean {
        val f = file(z, x, y)
        return f.isFile && f.setLastModified(now())
    }

    /** Removes tiles older than a week (and empty folders). Returns how many went. */
    fun prune(): Int {
        if (!dir.isDirectory) return 0
        var removed = 0
        dir.walkBottomUp().forEach { f ->
            when {
                f == dir -> Unit
                f.isFile && (!fresh(f) || f.name.endsWith(".new")) -> if (f.delete()) removed++
                f.isDirectory && f.list()?.isEmpty() == true -> f.delete()
            }
        }
        return removed
    }

    fun bytes(): Long = if (!dir.isDirectory) 0 else dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }

    fun clear() {
        dir.deleteRecursively()
    }

    /** What one save did. */
    data class Saved(val tiles: Int, val kept: Int, val bytes: Long, val full: Boolean)

    /**
     * Saves the map along [line] (lat, lon points): tiles already here get another
     * week, tiles a downloaded square has ([inSquares]) are skipped, and the rest
     * come from [server], up to [capBytes] (the low zooms first, then the detail
     * from the start of the trip on).
     */
    fun save(line: List<Pair<Double, Double>>, server: ServerBasemap, inSquares: (TileMath.Tile) -> Boolean, capBytes: Long = CAP_BYTES, stopped: () -> Boolean = { false }): Saved {
        val wanted = corridor(line)
        var kept = 0
        val missing = ArrayList<TileMath.Tile>()
        for (t in wanted) {
            if (inSquares(t)) continue
            if (has(t.z, t.x, t.y)) {
                keep(t.z, t.x, t.y)
                kept++
            } else missing += t
        }
        var planned = 0L
        var full = false
        var tiles = 0
        var bytes = 0L
        server.tiles(missing, take = { _, size ->
            if (stopped()) false
            else if (planned + size > capBytes) {
                full = true
                false
            } else {
                planned += size
                true
            }
        }) { t, data ->
            put(t.z, t.x, t.y, data)
            tiles++
            bytes += data.size
        }
        return Saved(tiles, kept, bytes, full)
    }

    companion object {
        const val KEEP_MILLIS = 7L * 24 * 60 * 60 * 1000

        /** At most this much per trip: Sydney to Melbourne's corridor fits. */
        const val CAP_BYTES = 40L * 1024 * 1024
        const val MAX_ZOOM = 15

        /** How far either side of the road each zoom keeps: the detail close in,
         *  the overview wider. */
        fun buffer(z: Int): Double = when {
            z >= 15 -> 300.0
            z == 14 -> 600.0
            z == 13 -> 1_200.0
            z == 12 -> 2_500.0
            else -> 5_000.0
        }

        /**
         * The tiles along a route, every zoom to [MAX_ZOOM], each zoom's in the order
         * you'd drive past them, low zooms first.
         */
        fun corridor(line: List<Pair<Double, Double>>, maxZoom: Int = MAX_ZOOM): List<TileMath.Tile> {
            if (line.isEmpty()) return emptyList()
            val out = LinkedHashSet<TileMath.Tile>()
            for (z in 0..maxZoom) {
                val b = buffer(z)
                // A sample at least every half tile (or buffer), so nothing between is missed.
                val step = minOf(b, TileMath.metres(line[0].first, z) / 2).coerceAtLeast(50.0)
                fun around(lat: Double, lon: Double) {
                    val dLat = b / 111_320.0
                    val dLon = b / (111_320.0 * max(0.2, cos(Math.toRadians(lat))))
                    val x0 = TileMath.x(lon - dLon, z)
                    val x1 = TileMath.x(lon + dLon, z)
                    val y0 = TileMath.y(lat + dLat, z)
                    val y1 = TileMath.y(lat - dLat, z)
                    for (x in x0..x1) for (y in y0..y1) out += TileMath.Tile(z, x, y)
                }
                around(line[0].first, line[0].second)
                for (i in 1 until line.size) {
                    val (aLat, aLon) = line[i - 1]
                    val (bLat, bLon) = line[i]
                    val metres = distance(aLat, aLon, bLat, bLon)
                    val n = ceil(metres / step).toInt().coerceAtLeast(1)
                    for (k in 1..n) {
                        val f = k.toDouble() / n
                        around(aLat + (bLat - aLat) * f, aLon + (bLon - aLon) * f)
                    }
                }
            }
            return out.toList()
        }

        fun distance(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
            val p1 = Math.toRadians(lat1)
            val p2 = Math.toRadians(lat2)
            val dp = p2 - p1
            val dl = Math.toRadians(lon2 - lon1)
            val a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2)
            return 2 * 6_371_008.8 * Math.asin(minOf(1.0, Math.sqrt(a)))
        }
    }
}
