package org.promptly.sync.maps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class TripClockTest {
    private val now = Instant.parse("2026-11-16T12:27:00Z")

    @Test fun `with no traffic answer the trip's own count is the arrival time`() {
        assertEquals(now.plusSeconds(780), TripClock.arrive(now, null, null, 780.0))
    }

    @Test fun `a fresh traffic answer is the arrival time`() {
        val arrive = now.plusSeconds(900)
        assertEquals(arrive, TripClock.arrive(now, arrive, now.minusSeconds(60), 780.0))
    }

    @Test fun `an old traffic answer gives way to the trip's own count`() {
        // The asks stopped being answered half an hour ago: 11:04 must not stay on the screen.
        val stale = now.plusSeconds(37 * 60)
        assertEquals(now.plusSeconds(780), TripClock.arrive(now, stale, now.minusSeconds(30 * 60), 780.0))
        // An arrival time already in the past isn't shown either.
        assertEquals(now.plusSeconds(780), TripClock.arrive(now, now.minusSeconds(5), now.minusSeconds(60), 780.0))
    }

    @Test fun `an answer far beyond the trip's own count isn't believed`() {
        assertTrue(TripClock.believable(15 * 60, 13.0 * 60))
        assertTrue(TripClock.believable(14 * 60, 5.0 * 60))  // a real jam on a short trip
        assertFalse(TripClock.believable(60 * 60, 13.0 * 60))
    }

    @Test fun `the road asked about starts where you are, not where the current step began`() {
        // One long motorway step going north, then a short one. You're most of the way along.
        val motorway = (0..30).map { -27.0 + it * 0.01 to 153.0 }
        val exit = listOf(-26.70 to 153.0, -26.70 to 153.01)
        val whole = RouteRuler(motorway + exit).length
        val ahead = TripClock.roadAhead(listOf(motorway, exit), -26.80 to 153.0001)
        val left = RouteRuler(ahead).length
        assertEquals(-26.80, ahead.first().first, 0.001)
        assertTrue("only the road ahead: $left of $whole", left < whole * 0.4)
        assertEquals(exit.last(), ahead.last())
        // Each minute further on, less is asked about.
        val later = RouteRuler(TripClock.roadAhead(listOf(motorway, exit), -26.75 to 153.0)).length
        assertTrue(later < left)
    }
}
