package org.promptly.sync.maps

import kotlin.math.cos
import kotlin.math.hypot

/**
 * Was the route planned from somewhere you aren't?
 *
 * A trip is planned from the first position the phone can give. Indoors, or just
 * out of a tunnel or a car park, that can be an old one, or a rough guess from
 * phone masts, a long way from the car. The route then starts over there, and
 * [OffRouteWatch] is deliberately patient with a start that's off the road, so
 * the arrow sat at the route's start until you happened to drive to it.
 *
 * This looks at the first good fixes of a trip instead. If they agree you're far
 * from both the route and the place it was planned from, the trip is asked for
 * again from where you really are, as Waze and Google do. It stops looking once
 * you're on the route, or after [WINDOW_MS], and asks at most [MAX_REPLANS] times,
 * never closer together than [GAP_MS], so it can't go round in circles.
 */
internal class StartWatch {
    enum class Verdict { WAIT, SETTLED, REPLAN }

    private var fromLat = 0.0
    private var fromLon = 0.0
    private var since = 0L
    private var replans = 0
    private var lastReplan = 0L
    private var off = 0
    private var onIt = 0
    private var done = true

    /** A new trip, planned from this position. */
    @Synchronized
    fun begin(lat: Double, lon: Double, now: Long) {
        fromLat = lat
        fromLon = lon
        since = now
        replans = 0
        lastReplan = 0L
        off = 0
        onIt = 0
        done = false
    }

    /** The trip was asked for again from here (after [check] said [Verdict.REPLAN]). */
    @Synchronized
    fun replanned(lat: Double, lon: Double) {
        fromLat = lat
        fromLon = lon
        off = 0
        onIt = 0
    }

    /** The trip's over, or was never started. */
    @Synchronized
    fun stop() {
        done = true
    }

    /**
     * One reading during a trip. [ageMs] is how old the fix is, [route] the whole
     * route as (lat, lon).
     */
    @Synchronized
    fun check(fix: OffRouteWatch.Fix, ageMs: Long, now: Long, route: List<Pair<Double, Double>>): Verdict {
        if (done) return Verdict.SETTLED
        if (now - since > WINDOW_MS) {
            done = true
            return Verdict.SETTLED
        }
        // The library's own first looks (exact, 0 m), a rough guess, or an old fix:
        // none of them says where the car is.
        if (fix.accuracy <= 0.0 || fix.accuracy > GOOD_ACCURACY || ageMs > FRESH_MS || route.size < 2) return Verdict.WAIT
        val toRoute = OffRouteWatch.nearest(fix.lat, fix.lon, route).metres
        if (toRoute <= OffRouteWatch.room(fix.accuracy)) {
            off = 0
            if (++onIt >= ON_FIXES) done = true
            return if (done) Verdict.SETTLED else Verdict.WAIT
        }
        onIt = 0
        val far = toRoute > FAR_METRES && metres(fix.lat, fix.lon, fromLat, fromLon) > FAR_METRES
        if (!far) {
            off = 0
            return Verdict.WAIT
        }
        // One stray fix isn't the car.
        if (++off < OFF_FIXES) return Verdict.WAIT
        if (replans >= MAX_REPLANS) {
            done = true
            return Verdict.SETTLED
        }
        if (lastReplan != 0L && now - lastReplan < GAP_MS) return Verdict.WAIT
        replans++
        lastReplan = now
        off = 0
        return Verdict.REPLAN
    }

    companion object {
        /** Further than this from the route and from where it was planned: not a
         *  car park or a driveway, somewhere else. */
        const val FAR_METRES = 150.0
        /** A fix has to be this sure of itself (metres) to move the whole trip. */
        const val GOOD_ACCURACY = 40.0
        const val FRESH_MS = 10_000L
        const val OFF_FIXES = 2
        const val ON_FIXES = 2
        const val MAX_REPLANS = 2
        const val GAP_MS = 10_000L
        const val WINDOW_MS = 180_000L

        /**
         * Should the arrow be drawn on the route? Yes for anything near it (GPS
         * wobbles, and the route starts on the road, not in the driveway). A good
         * fix a long way off is drawn where it is: that's where you are.
         */
        fun arrowOnRoute(metresFromRoute: Double, accuracy: Double): Boolean =
            !(metresFromRoute > FAR_METRES && accuracy > 0.0 && accuracy <= GOOD_ACCURACY)

        private fun metres(lat: Double, lon: Double, lat2: Double, lon2: Double): Double {
            val k = cos(Math.toRadians((lat + lat2) / 2)) * 111_320.0
            return hypot((lon2 - lon) * k, (lat2 - lat) * 110_540.0)
        }
    }
}
