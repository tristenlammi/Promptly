package org.promptly.sync.maps.offline

import kotlin.math.PI
import kotlin.math.atan
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.sinh
import kotlin.math.tan

/** Web Mercator map tiles (z/x/y), as MapLibre and the basemap number them. */
object TileMath {
    data class Tile(val z: Int, val x: Int, val y: Int)

    private const val MAX_LAT = 85.0511287798

    fun x(lon: Double, z: Int): Int = floor((lon + 180.0) / 360.0 * (1 shl z)).toInt().coerceIn(0, (1 shl z) - 1)

    fun y(lat: Double, z: Int): Int {
        val r = Math.toRadians(lat.coerceIn(-MAX_LAT, MAX_LAT))
        return floor((1.0 - ln(tan(r) + 1.0 / cos(r)) / PI) / 2.0 * (1 shl z)).toInt().coerceIn(0, (1 shl z) - 1)
    }

    fun of(lat: Double, lon: Double, z: Int) = Tile(z, x(lon, z), y(lat, z))

    fun west(x: Int, z: Int): Double = x.toDouble() / (1 shl z) * 360.0 - 180.0

    fun north(y: Int, z: Int): Double = Math.toDegrees(atan(sinh(PI * (1.0 - 2.0 * y / (1 shl z)))))

    /** A tile's box: west, south, east, north. */
    fun bounds(z: Int, x: Int, y: Int): DoubleArray = doubleArrayOf(west(x, z), north(y + 1, z), west(x + 1, z), north(y, z))

    /** About how many metres across a tile is at this latitude. */
    fun metres(lat: Double, z: Int): Double = 40_075_016.7 * cos(Math.toRadians(lat)) / (1 shl z)
}
