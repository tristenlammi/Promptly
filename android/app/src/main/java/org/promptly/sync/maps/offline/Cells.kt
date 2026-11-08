package org.promptly.sync.maps.offline

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max

/** One-degree squares ("cells" in code, "squares" on screen), named
 *  `<west>_<south>` like the server's `maps/areas.py`: `151_-34` is central and
 *  eastern Sydney. */
object Cells {
    private val NAME = Regex("^(-?\\d{1,3})_(-?\\d{1,2})$")

    data class Cell(val west: Int, val south: Int) {
        val name: String get() = "${west}_$south"
        val east: Int get() = west + 1
        val north: Int get() = south + 1
    }

    fun parse(name: String): Cell? {
        val m = NAME.matchEntire(name) ?: return null
        val west = m.groupValues[1].toInt()
        val south = m.groupValues[2].toInt()
        if (west !in -180..179 || south !in -90..89) return null
        return Cell(west, south)
    }

    /** The squares a box touches, as the server works them out (`box_cells`). */
    fun inBox(west: Double, south: Double, east: Double, north: Double): List<String> {
        val x0 = floor(west).toInt()
        val y0 = floor(south).toInt()
        val x1 = max(ceil(east).toInt(), x0 + 1)
        val y1 = max(ceil(north).toInt(), y0 + 1)
        return buildList { for (y in y0 until y1) for (x in x0 until x1) add("${x}_$y") }
    }

    /** The Valhalla level-0 (motorway, 4-degree) tile a square sits in, as `areas.py::l0_of`. */
    fun level0(cell: String): Int {
        val c = parse(cell) ?: throw IllegalArgumentException("Not a square: $cell")
        return floor((c.south + 90) / 4.0).toInt() * 90 + floor((c.west + 180) / 4.0).toInt()
    }

    /** A number for each square, the same on every phone: the top 32 bits of the
     *  merged search's row ids, so each square has its own id range. */
    fun key(cell: String): Long {
        val c = parse(cell) ?: throw IllegalArgumentException("Not a square: $cell")
        return (c.west + 180).toLong() * 180 + (c.south + 90)
    }

    /** The first and last row id a square's search rows use in `search.db`. */
    fun idRange(cell: String): LongRange {
        val base = key(cell) shl 32
        return base..(base + 0xFFFF_FFFFL)
    }
}
