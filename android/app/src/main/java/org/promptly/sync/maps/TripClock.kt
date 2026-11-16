package org.promptly.sync.maps

import java.time.Instant

/**
 * When you'll arrive. The server's traffic answer gives one arrival time per ask;
 * between asks the trip's own count of the time left carries on. A traffic answer
 * is only believed while it's fresh: if the asks stop being answered (no allowance
 * left, the server unwell), the arrival time must not sit where the last one put it.
 */
object TripClock {
    /** Asks go out every 1–3 minutes ([TrafficPace]); two missed and the answer is old. */
    const val FRESH_MS = 6 * 60_000L

    /** How far an answer may sit from the trip's own count before it isn't believed
     *  at all: three times as long, and at least ten minutes more. Real jams do add
     *  time; a road measured twice is what this catches. */
    fun believable(trafficSeconds: Long, ownSeconds: Double): Boolean =
        trafficSeconds <= maxOf(ownSeconds * 3, ownSeconds + 600)

    fun arrive(now: Instant, trafficArrive: Instant?, trafficAt: Instant?, secondsLeft: Double): Instant {
        val own = now.plusSeconds(secondsLeft.toLong().coerceAtLeast(0))
        if (trafficArrive == null || trafficAt == null) return own
        if (now.toEpochMilli() - trafficAt.toEpochMilli() > FRESH_MS) return own
        if (!trafficArrive.isAfter(now)) return own
        return trafficArrive
    }

    /** The road still to drive, for asking about traffic on it: the step you're on
     *  cut at where you are. Sending the whole of the current step measured a long
     *  motorway stretch from its start every time, so the time left never came down. */
    fun roadAhead(steps: List<List<Pair<Double, Double>>>, here: Pair<Double, Double>?): List<Pair<Double, Double>> =
        RouteAhead.from(steps, here)
}
