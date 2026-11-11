package org.promptly.sync.maps

/**
 * How often to ask your server about traffic on the road ahead. Every three minutes
 * was slow next to a jam that forms in one: short and middling trips ask every minute
 * and a half, every minute while traffic is already costing you time. Long trips keep
 * the slower pace, since each ask covers a lot of road and the day's allowance of
 * traffic lookups is shared by everyone on the server.
 */
internal object TrafficPace {
    const val SOON = 15_000L
    const val BUSY = 60_000L
    const val USUAL = 90_000L
    const val LONG_TRIP = 180_000L
    const val LONG_TRIP_KM = 150.0
    const val BUSY_MINUTES = 3

    /** After a new route, wait for it to settle, and never ask twice within half a minute. */
    const val AFTER_REROUTE = 4_000L
    const val SMALLEST_GAP = 30_000L

    /** Milliseconds until the next ask. [ready] is false with no position, no answer yet or no signal. */
    fun pause(ready: Boolean, kmLeft: Double, addsMinutes: Int?): Long = when {
        !ready -> SOON
        kmLeft > LONG_TRIP_KM -> LONG_TRIP
        (addsMinutes ?: 0) >= BUSY_MINUTES -> BUSY
        else -> USUAL
    }

    /** A new route arrived at [now]: when to ask about it, given the last ask and the one already planned. */
    fun afterReroute(now: Long, lastAsk: Long, planned: Long): Long =
        minOf(planned, maxOf(now + AFTER_REROUTE, lastAsk + SMALLEST_GAP))
}
