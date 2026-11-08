package org.promptly.sync.maps.offline

import org.json.JSONArray
import org.promptly.sync.maps.Camera
import java.io.File
import kotlin.math.cos
import kotlin.math.max

/**
 * Speed cameras with no signal: all of Australia's from the downloaded
 * `base/cameras.json`, matched to the route on the phone the way the server's
 * `/api/maps/cameras/along` does (`data.near_line`, within 60 m of the road).
 */
object OfflineCameras {
    private var loaded: Pair<Long, List<Camera>>? = null

    /** The downloaded cameras, read once per file version. Empty if there are none. */
    @Synchronized
    fun all(file: File): List<Camera> {
        if (!file.isFile) return emptyList()
        val stamp = file.lastModified() xor file.length()
        loaded?.let { if (it.first == stamp) return it.second }
        val rows = runCatching { JSONArray(file.readText()) }.getOrNull() ?: return emptyList()
        val out = ArrayList<Camera>(rows.length())
        for (i in 0 until rows.length()) {
            val r = rows.optJSONObject(i) ?: continue
            val lat = r.optDouble("lat")
            val lon = r.optDouble("lon")
            if (lat.isNaN() || lon.isNaN()) continue
            out += Camera(lat, lon, r.optDouble("maxspeed").takeUnless { it.isNaN() })
        }
        loaded = stamp to out
        return out
    }

    /** Cameras within [withinM] of the route [line] (lat, lon), in the order you'd reach them. */
    fun along(cameras: List<Camera>, line: List<Pair<Double, Double>>, withinM: Double = 60.0): List<Camera> {
        if (line.isEmpty() || cameras.isEmpty()) return emptyList()
        // A point every [withinM] or so along the road, as on the server (and between a
        // long straight's two ends too, which the server's dense shapes never have).
        val spacing = minOf(withinM, 1000.0)
        val samples = ArrayList<Triple<Double, Double, Double>>()
        samples += Triple(line[0].first, line[0].second, 0.0)
        var along = 0.0
        var since = 0.0
        for (i in 1 until line.size) {
            val a = line[i - 1]
            val b = line[i]
            val step = TripCache.distance(a.first, a.second, b.first, b.second)
            if (step > spacing) {
                val n = Math.ceil(step / spacing).toInt()
                for (k in 1 until n) {
                    val f = k.toDouble() / n
                    samples += Triple(a.first + (b.first - a.first) * f, a.second + (b.second - a.second) * f, along + step * f)
                }
                since = 0.0
            }
            along += step
            since += step
            if (since >= spacing || step > spacing) {
                samples += Triple(b.first, b.second, along)
                since = 0.0
            }
        }
        samples += Triple(line.last().first, line.last().second, along)
        val padLat = withinM / 111_000.0
        val south = samples.minOf { it.first } - padLat
        val north = samples.maxOf { it.first } + padLat
        val padLon = padLat / max(0.2, cos(Math.toRadians((south + north) / 2)))
        val west = samples.minOf { it.second } - padLon
        val east = samples.maxOf { it.second } + padLon
        val hits = ArrayList<Pair<Camera, Double>>()
        for (c in cameras) {
            if (c.lat < south || c.lat > north || c.lon < west || c.lon > east) continue
            val k = cos(Math.toRadians(c.lat))
            val best = samples.minBy { (it.first - c.lat) * (it.first - c.lat) + ((it.second - c.lon) * k) * ((it.second - c.lon) * k) }
            if (TripCache.distance(best.first, best.second, c.lat, c.lon) <= withinM) hits += c to best.third
        }
        return hits.sortedBy { it.second }.map { it.first }
    }
}
