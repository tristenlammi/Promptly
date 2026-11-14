package org.promptly.sync.maps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.promptly.sync.maps.OffRouteWatch.Fix
import org.promptly.sync.maps.StartWatch.Verdict

/** A trip planned from an old position is asked for again from where the car is. */
class StaleStartTest {
    // The route: a road running north for about 1.1 km.
    private val route = listOf(-27.4700 to 153.0200, -27.4600 to 153.0200)
    private val startLat = -27.4700
    private val startLon = 153.0200

    /** [metres] east of the route's start. */
    private fun east(metres: Double, accuracy: Double = 8.0) =
        Fix(startLat, startLon + metres / (111_320.0 * Math.cos(Math.toRadians(startLat))), accuracy, 0.0, 0.0)

    private fun begun(now: Long = 0L) = StartWatch().also { it.begin(startLat, startLon, now) }

    @Test
    fun a_car_far_from_a_stale_start_gets_a_new_route_at_once() {
        val watch = begun()
        // The phone thought you were at the route's start. You're 3 km east of it, parked.
        assertEquals(Verdict.WAIT, watch.check(east(3000.0), 500, 1_000, route))
        assertEquals(Verdict.REPLAN, watch.check(east(3000.0), 500, 2_000, route))
    }

    @Test
    fun the_new_route_from_here_ends_the_matter() {
        val watch = begun()
        watch.check(east(3000.0), 500, 1_000, route)
        assertEquals(Verdict.REPLAN, watch.check(east(3000.0), 500, 2_000, route))
        val here = east(3000.0)
        watch.replanned(here.lat, here.lon)
        // The new route starts on the road beside you.
        val fresh = listOf(here.lat to here.lon + 0.0003, here.lat + 0.01 to here.lon + 0.0003)
        assertEquals(Verdict.WAIT, watch.check(here, 500, 3_000, fresh))
        assertEquals(Verdict.SETTLED, watch.check(here, 500, 4_000, fresh))
        // And nothing after that starts it again.
        repeat(5) { assertEquals(Verdict.SETTLED, watch.check(east(9000.0), 500, 5_000L + it, route)) }
    }

    @Test
    fun a_car_park_or_a_driveway_is_left_alone() {
        val watch = begun()
        // 90 m from the road the route starts on, sitting, then driving out to it.
        repeat(6) { assertEquals(Verdict.WAIT, watch.check(east(90.0), 500, 1_000L * it, route)) }
        assertEquals(Verdict.WAIT, watch.check(east(40.0), 500, 7_000, route))
        assertEquals(Verdict.WAIT, watch.check(east(10.0), 500, 8_000, route))
        assertEquals(Verdict.SETTLED, watch.check(east(5.0), 500, 9_000, route))
    }

    @Test
    fun a_rough_fix_never_moves_the_trip() {
        val watch = begun()
        // Phone masts: "somewhere within 800 m".
        repeat(10) { assertEquals(Verdict.WAIT, watch.check(east(3000.0, accuracy = 800.0), 500, 1_000L * it, route)) }
        repeat(10) { assertEquals(Verdict.WAIT, watch.check(east(3000.0, accuracy = 60.0), 500, 20_000L + it, route)) }
    }

    @Test
    fun an_old_fix_never_moves_the_trip() {
        val watch = begun()
        repeat(10) { assertEquals(Verdict.WAIT, watch.check(east(3000.0), 45_000, 1_000L * it, route)) }
    }

    @Test
    fun the_librarys_own_first_looks_are_ignored() {
        val watch = begun()
        // "Exact", at the route's start: not a real fix, and not you joining the route.
        repeat(3) { assertEquals(Verdict.WAIT, watch.check(east(0.0, accuracy = 0.0), 0, 1_000L * it, route)) }
        assertEquals(Verdict.WAIT, watch.check(east(3000.0), 500, 4_000, route))
        assertEquals(Verdict.REPLAN, watch.check(east(3000.0), 500, 5_000, route))
    }

    @Test
    fun one_stray_fix_is_not_the_car() {
        val watch = begun()
        assertEquals(Verdict.WAIT, watch.check(east(3000.0), 500, 1_000, route))
        assertEquals(Verdict.WAIT, watch.check(east(60.0), 500, 2_000, route))
        assertEquals(Verdict.WAIT, watch.check(east(3000.0), 500, 3_000, route))
    }

    @Test
    fun it_cannot_go_round_in_circles() {
        val watch = begun()
        var asked = 0
        // The worst case: every new route still starts far away, and replanned() is never told otherwise.
        for (second in 1..170) {
            if (watch.check(east(3000.0), 500, second * 1_000L, route) == Verdict.REPLAN) asked++
        }
        assertEquals(StartWatch.MAX_REPLANS, asked)
    }

    @Test
    fun a_second_ask_waits_its_turn() {
        val watch = begun()
        watch.check(east(3000.0), 500, 1_000, route)
        assertEquals(Verdict.REPLAN, watch.check(east(3000.0), 500, 2_000, route))
        // Still far (the new route hasn't come back yet): not again straight away.
        for (second in 3..11) assertEquals(Verdict.WAIT, watch.check(east(3000.0), 500, second * 1_000L, route))
        assertEquals(Verdict.REPLAN, watch.check(east(3000.0), 500, 12_000, route))
    }

    @Test
    fun it_stops_looking_after_a_few_minutes() {
        val watch = begun()
        assertEquals(Verdict.SETTLED, watch.check(east(3000.0), 500, StartWatch.WINDOW_MS + 1, route))
        assertEquals(Verdict.SETTLED, watch.check(east(3000.0), 500, StartWatch.WINDOW_MS + 2_000, route))
    }

    @Test
    fun nothing_happens_without_a_trip() {
        val watch = StartWatch()
        repeat(4) { assertEquals(Verdict.SETTLED, watch.check(east(3000.0), 500, 1_000L * it, route)) }
        val stopped = begun().also { it.stop() }
        repeat(4) { assertEquals(Verdict.SETTLED, stopped.check(east(3000.0), 500, 1_000L * it, route)) }
    }

    @Test
    fun the_arrow_is_drawn_where_you_are_when_that_is_far_from_the_route() {
        assertTrue(StartWatch.arrowOnRoute(12.0, 8.0))
        assertTrue(StartWatch.arrowOnRoute(90.0, 8.0))
        assertFalse(StartWatch.arrowOnRoute(400.0, 8.0))
        // A rough guess far away isn't where you are: stay on the road.
        assertTrue(StartWatch.arrowOnRoute(400.0, 300.0))
        // The library's own "exact" look.
        assertTrue(StartWatch.arrowOnRoute(400.0, 0.0))
    }
}
