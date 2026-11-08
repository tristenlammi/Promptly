package org.promptly.sync.maps.offline

import java.io.File

/**
 * The downloaded squares' maps (`cells/<cell>/map.pmtiles`), open for reading.
 * [reload] notices a square that arrived, went, or changed (a new map build), and
 * reopens just that one. A tile is read from the first square under it that has it:
 * each square's file holds every tile that touches it, the low zooms included.
 */
class SquareMaps(private val cellsDir: File) {
    private class Open(val cell: Cells.Cell, val reader: PmTiles, val modified: Long, val length: Long)

    @Volatile private var open: Map<String, Open> = emptyMap()

    @Synchronized
    fun reload() {
        val now = HashMap<String, Open>()
        val before = open
        val found = cellsDir.listFiles().orEmpty().filter { it.isDirectory }
        for (dir in found) {
            val cell = Cells.parse(dir.name) ?: continue
            val f = File(dir, "map.pmtiles")
            if (!f.isFile) continue
            val was = before[dir.name]
            if (was != null && was.modified == f.lastModified() && was.length == f.length()) {
                now[dir.name] = was
                continue
            }
            val reader = runCatching { PmTiles.open(f) }.getOrNull() ?: continue
            now[dir.name] = Open(cell, reader, f.lastModified(), f.length())
        }
        open = now
        // Whatever was replaced or removed: a read in flight just misses, and the next
        // tier answers it.
        for ((name, o) in before) if (now[name] !== o) runCatching { o.reader.close() }
    }

    val cells: Set<String> get() = open.keys

    private fun under(z: Int, x: Int, y: Int): Sequence<Open> {
        val b = TileMath.bounds(z, x, y)
        return open.values.asSequence().filter { o ->
            o.cell.west < b[2] && o.cell.east > b[0] && o.cell.south < b[3] && o.cell.north > b[1]
        }
    }

    /** The tile from a square, as stored, or null. */
    fun tile(z: Int, x: Int, y: Int): ByteArray? {
        for (o in under(z, x, y)) {
            val bytes = runCatching { o.reader.tile(z, x, y) }.getOrNull()
            if (bytes != null) return bytes
        }
        return null
    }

    fun has(z: Int, x: Int, y: Int): Boolean = under(z, x, y).any { o -> runCatching { o.reader.locate(z, x, y) != null }.getOrDefault(false) }

    /** Whether a downloaded square is under this point. */
    fun covers(lat: Double, lon: Double): Boolean = open.values.any { o ->
        lon >= o.cell.west && lon < o.cell.east && lat >= o.cell.south && lat < o.cell.north
    }

    @Synchronized
    fun close() {
        open.values.forEach { runCatching { it.reader.close() } }
        open = emptyMap()
    }
}
