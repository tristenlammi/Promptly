package org.promptly.sync.maps

import uniffi.ferrostar.DeviationKind
import uniffi.ferrostar.Route
import uniffi.ferrostar.RouteDeviation
import uniffi.ferrostar.RouteDeviationDetector
import uniffi.ferrostar.TripState
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot

/**
 * Have you left the route? The navigation library's own check ignored every fix less
 * sure of itself than 15 m, which is most of them from a phone in a car's cupholder,
 * so a wrong turn often never got a new route. It also only measured distance, so
 * driving the other way along the same road looked fine.
 *
 * This one takes any usable fix, allows more room the vaguer the fix is, wants two
 * fixes in a row before it believes you've left (one stray fix isn't a wrong turn),
 * and notices you driving against the route.
 */
internal class OffRouteWatch {
    /** One reading: where, how sure (metres), which way (degrees) and how fast (m/s). */
    data class Fix(val lat: Double, val lon: Double, val accuracy: Double, val course: Double? = null, val speed: Double? = null)

    enum class Verdict { ON, OFF_STEP, OFF }

    private var away = 0
    private var against = 0
    // Not on the route yet (it starts on the road; you start in a car park or a
    // driveway): the closest you've been to it so far.
    private var joined = false
    private var onIt = 0
    private var closest = Double.MAX_VALUE

    fun reset() {
        away = 0
        against = 0
        joined = false
        onIt = 0
        closest = Double.MAX_VALUE
    }

    /** [steps] are what's left of the route, the one you're on first, as (lat, lon). */
    fun check(fix: Fix, steps: List<List<Pair<Double, Double>>>): Verdict {
        val current = steps.firstOrNull()?.takeIf { it.isNotEmpty() } ?: return Verdict.ON
        // A tunnel, or a fix from a phone mast: says nothing either way.
        if (fix.accuracy > WORST_ACCURACY) return Verdict.ON
        val room = room(fix.accuracy)
        val near = nearest(fix.lat, fix.lon, current)
        if (near.metres <= room) {
            // The library's first looks at a new route are from the route's own start,
            // not from where you are: those say they're exact (0 m), which no real fix does.
            if (fix.accuracy > 0.0 && ++onIt >= JOINED_FIXES) joined = true
            away = 0
            val course = fix.course
            val moving = (fix.speed ?: 0.0) >= MOVING
            if (course != null && moving && near.bearing != null && turn(course, near.bearing) > AGAINST_DEGREES) against++ else against = 0
            return if (against >= AGAINST_FIXES) Verdict.OFF else Verdict.ON
        }
        against = 0
        onIt = 0
        if (!joined) {
            // Still getting to the road. Only heading away from it is leaving.
            if (near.metres < closest) closest = near.metres
            if (near.metres < closest + LEAVING_METRES) return Verdict.ON
        }
        away++
        if (away < AWAY_FIXES) return Verdict.ON
        val later = steps.drop(1).any { it.isNotEmpty() && nearest(fix.lat, fix.lon, it).metres <= room }
        return if (later) Verdict.OFF_STEP else Verdict.OFF
    }

    internal data class Near(val metres: Double, val bearing: Double?)

    companion object {
        const val WORST_ACCURACY = 100.0
        const val AWAY_FIXES = 2
        const val AGAINST_FIXES = 4
        const val AGAINST_DEGREES = 135.0
        const val MOVING = 4.0
        const val LEAVING_METRES = 50.0
        const val JOINED_FIXES = 2

        /** How far from the line still counts as on it: a wide road plus what the fix can't tell. */
        fun room(accuracy: Double): Double = (20.0 + accuracy).coerceIn(35.0, 75.0)

        /** Degrees between two compass directions, 0 to 180. */
        fun turn(a: Double, b: Double): Double {
            val d = abs(a - b) % 360.0
            return if (d > 180) 360 - d else d
        }

        /** How far this point is from the line, and which way the line runs there. */
        internal fun nearest(lat: Double, lon: Double, line: List<Pair<Double, Double>>): Near {
            // Flat-earth metres around the point: fine over the few hundred metres that matter.
            val k = cos(Math.toRadians(lat)) * 111_320.0
            fun x(p: Pair<Double, Double>) = (p.second - lon) * k
            fun y(p: Pair<Double, Double>) = (p.first - lat) * 110_540.0
            if (line.size == 1) return Near(hypot(x(line[0]), y(line[0])), null)
            var best = Double.MAX_VALUE
            var bearing: Double? = null
            for (i in 1 until line.size) {
                val ax = x(line[i - 1]); val ay = y(line[i - 1])
                val bx = x(line[i]); val by = y(line[i])
                val dx = bx - ax; val dy = by - ay
                val len2 = dx * dx + dy * dy
                val t = if (len2 == 0.0) 0.0 else ((-ax * dx - ay * dy) / len2).coerceIn(0.0, 1.0)
                val d = hypot(ax + t * dx, ay + t * dy)
                if (d < best) {
                    best = d
                    if (len2 > 1.0) bearing = (Math.toDegrees(atan2(dx, dy)) + 360) % 360
                }
            }
            return Near(best, bearing)
        }

        /** The stops still to visit, without the points that only pinned the way you
         *  picked: after a wrong turn the best way from here is wanted, not the way
         *  back to the old one. The last one (where you're going) always stays. */
        fun <T> stopsOnly(remaining: List<T>, pinned: List<ThroughPoint>, isVia: (T) -> Boolean, at: (T) -> Pair<Double, Double>): List<T> {
            if (remaining.size <= 1) return remaining
            val kept = remaining.dropLast(1).filter { w ->
                val (lat, lon) = at(w)
                !isVia(w) && pinned.none { nearest(lat, lon, listOf(it.lat to it.lon)).metres <= PINNED_METRES }
            }
            return kept + remaining.last()
        }

        const val PINNED_METRES = 40.0
    }
}

/** [OffRouteWatch], as the navigation library asks for it. */
internal class OffRouteDetector : RouteDeviationDetector {
    private val watch = OffRouteWatch()
    private var routeKey: Any? = null

    @Synchronized
    override fun checkRouteDeviation(route: Route, tripState: TripState): RouteDeviation {
        val state = tripState as? TripState.Navigating ?: return RouteDeviation.NoDeviation
        val key = Triple(route.geometry.size, route.geometry.firstOrNull(), route.geometry.lastOrNull())
        if (key != routeKey) {
            routeKey = key
            watch.reset()
        }
        val at = state.userLocation
        val fix = OffRouteWatch.Fix(
            at.coordinates.lat, at.coordinates.lng, at.horizontalAccuracy,
            at.courseOverGround?.degrees?.toDouble(), at.speed?.value,
        )
        val steps = state.remainingSteps.map { step -> step.geometry.map { it.lat to it.lng } }
        val metres = steps.firstOrNull()?.takeIf { it.isNotEmpty() }?.let { OffRouteWatch.nearest(fix.lat, fix.lon, it).metres } ?: 0.0
        val verdict = watch.check(fix, steps)
        // In "Recent problems" after a drive: why a new route was asked for.
        if (verdict != OffRouteWatch.Verdict.ON) {
            android.util.Log.i("PromptlyNav", "Left the route ($verdict): ${metres.toInt()} m from it, fix good to ${fix.accuracy.toInt()} m, heading ${fix.course?.toInt()}, ${fix.speed?.toInt()} m/s, ${steps.size} step(s) left, first has ${steps.firstOrNull()?.size} point(s)")
        }
        return when (verdict) {
            OffRouteWatch.Verdict.ON -> RouteDeviation.NoDeviation
            OffRouteWatch.Verdict.OFF_STEP -> RouteDeviation.Deviation(DeviationKind.OffStepOnRoute(metres))
            OffRouteWatch.Verdict.OFF -> RouteDeviation.Deviation(DeviationKind.CompletelyOffRoute(metres))
        }
    }
}
