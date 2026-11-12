package org.promptly.sync.maps

import kotlin.math.cos

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

    /** Steps share their end and start points: one of each, so the line has no kinks. */
    private fun tidy(points: List<Pair<Double, Double>>): List<Pair<Double, Double>> {
        val out = ArrayList<Pair<Double, Double>>(points.size)
        for (p in points) if (out.lastOrNull() != p) out.add(p)
        return out
    }
}
