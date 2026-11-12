package org.promptly.sync.maps

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.min

/** The part of the route still in front of you, so the line behind the car goes away as
 *  you drive (the map used to show the whole trip from where you set off).
 *
 *  Works from the steps that are left: the first is the one you're on, and only that one
 *  is cut, at the point on it nearest you. Searching only the current step keeps a route
 *  that comes back along the same road from being cut at the later pass. Points are
 *  latitude then longitude. */
object RouteAhead {
    fun from(steps: List<List<Pair<Double, Double>>>, here: Pair<Double, Double>?): List<Pair<Double, Double>> {
        val current = steps.firstOrNull().orEmpty()
        val rest = steps.drop(1).flatten()
        if (here == null || current.size < 2) return tidy(current + rest)
        val scale = cos(Math.toRadians(here.first))
        var best = Double.MAX_VALUE
        var bestIndex = 0
        var bestPoint = current[0]
        for (i in 0 until current.size - 1) {
            val (point, distance) = nearestOnSegment(current[i], current[i + 1], here, scale)
            if (distance < best) {
                best = distance
                bestIndex = i
                bestPoint = point
            }
        }
        return tidy(listOf(bestPoint) + current.subList(bestIndex + 1, current.size) + rest)
    }

    /** The point on a→b nearest p, and how far it is (in degrees, flattened at this latitude). */
    private fun nearestOnSegment(
        a: Pair<Double, Double>,
        b: Pair<Double, Double>,
        p: Pair<Double, Double>,
        scale: Double,
    ): Pair<Pair<Double, Double>, Double> {
        val ax = a.second * scale
        val ay = a.first
        val bx = b.second * scale
        val by = b.first
        val px = p.second * scale
        val py = p.first
        val dx = bx - ax
        val dy = by - ay
        val length = dx * dx + dy * dy
        val t = if (length == 0.0) 0.0 else (((px - ax) * dx + (py - ay) * dy) / length).coerceIn(0.0, 1.0)
        val x = ax + t * dx
        val y = ay + t * dy
        val d = (px - x) * (px - x) + (py - y) * (py - y)
        return (y to x / scale) to d
    }

    /**
     * Rounds off the small kinks a road's line has (lanes merging, a slight bend drawn as
     * two straight pieces) without moving the route off the road: only bends gentler than
     * [maxTurn] degrees between pieces shorter than [maxPiece] metres are rounded, each
     * by at most [maxShift] metres. Real turns at junctions stay sharp.
     */
    fun smooth(
        points: List<Pair<Double, Double>>,
        maxTurn: Double = 35.0,
        maxPiece: Double = 80.0,
        maxShift: Double = 4.0,
    ): List<Pair<Double, Double>> {
        if (points.size < 3) return points
        val out = ArrayList<Pair<Double, Double>>(points.size * 2)
        out.add(points[0])
        for (i in 1 until points.size - 1) {
            val a = points[i - 1]
            val p = points[i]
            val b = points[i + 1]
            val inLen = RouteRuler.metres(a, p)
            val outLen = RouteRuler.metres(p, b)
            var turn = abs(RouteRuler.bearing(a, p) - RouteRuler.bearing(p, b))
            if (turn > 180) turn = 360 - turn
            if (inLen < 0.5 || outLen < 0.5 || turn > maxTurn || inLen > maxPiece || outLen > maxPiece) {
                out.add(p)
                continue
            }
            // Chaikin's corner cut: a point a quarter of the way back along each side.
            val back = min(inLen / 4, maxShift) / inLen
            val ahead = min(outLen / 4, maxShift) / outLen
            out.add((p.first + (a.first - p.first) * back) to (p.second + (a.second - p.second) * back))
            out.add((p.first + (b.first - p.first) * ahead) to (p.second + (b.second - p.second) * ahead))
        }
        out.add(points.last())
        return out
    }

    /** Steps share their end and start points: one of each, so the line has no kinks. */
    private fun tidy(points: List<Pair<Double, Double>>): List<Pair<Double, Double>> {
        val out = ArrayList<Pair<Double, Double>>(points.size)
        for (p in points) if (out.lastOrNull() != p) out.add(p)
        return out
    }
}
