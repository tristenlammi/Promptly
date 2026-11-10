package org.promptly.sync.maps

import org.junit.Assert.assertEquals
import org.junit.Test
import org.promptly.sync.maps.OffRouteWatch.Fix
import org.promptly.sync.maps.OffRouteWatch.Verdict

/** Leaving the route is noticed from the fixes a phone in a car really gives. */
class OffRouteTest {
    // A road running north for about 1.1 km, then one running east.
    private val north = listOf(-27.4700 to 153.0200, -27.4600 to 153.0200)
    private val east = listOf(-27.4600 to 153.0200, -27.4600 to 153.0300)
    private val steps = listOf(north, east)

    /** [metres] east of the north road, halfway up it. */
    private fun beside(metres: Double, accuracy: Double = 8.0, course: Double? = 0.0, speed: Double? = 14.0) =
        Fix(-27.4650, 153.0200 + metres / (111_320.0 * Math.cos(Math.toRadians(-27.465))), accuracy, course, speed)

    /** Already on the road, as you are a moment after setting off. */
    private fun driving() = OffRouteWatch().also { w -> repeat(2) { w.check(beside(5.0), steps) } }

    @Test
    fun starting_away_from_the_road_is_not_a_wrong_turn() {
        // A car park 60 m from the road the route starts on: sitting there, then driving to it.
        val watch = OffRouteWatch()
        // The library's first looks at a route are from the start of the route itself, "exact".
        repeat(3) { watch.check(beside(0.0, accuracy = 0.0, speed = 0.0), steps) }
        repeat(5) { assertEquals(Verdict.ON, watch.check(beside(60.0, speed = 0.0), steps)) }
        assertEquals(Verdict.ON, watch.check(beside(45.0), steps))
        assertEquals(Verdict.ON, watch.check(beside(10.0), steps))
    }

    @Test
    fun driving_away_before_ever_joining_the_route_is_noticed() {
        val watch = OffRouteWatch()
        assertEquals(Verdict.ON, watch.check(beside(60.0), steps))
        assertEquals(Verdict.ON, watch.check(beside(90.0), steps))
        assertEquals(Verdict.ON, watch.check(beside(115.0), steps))
        assertEquals(Verdict.OFF, watch.check(beside(140.0), steps))
    }

    @Test
    fun on_the_road_is_on_the_route() {
        val watch = driving()
        repeat(10) { assertEquals(Verdict.ON, watch.check(beside(12.0), steps)) }
    }

    @Test
    fun a_wrong_turn_is_noticed_on_the_second_fix() {
        val watch = driving()
        assertEquals(Verdict.ON, watch.check(beside(60.0, course = 90.0), steps))
        assertEquals(Verdict.OFF, watch.check(beside(75.0, course = 90.0), steps))
    }

    @Test
    fun one_stray_fix_is_not_a_wrong_turn() {
        val watch = driving()
        assertEquals(Verdict.ON, watch.check(beside(90.0), steps))
        assertEquals(Verdict.ON, watch.check(beside(5.0), steps))
        assertEquals(Verdict.ON, watch.check(beside(90.0), steps))
    }

    @Test
    fun a_vague_fix_still_counts() {
        // 30 m: the library's own check threw these away, so no new route ever came.
        val watch = driving()
        watch.check(beside(120.0, accuracy = 30.0), steps)
        assertEquals(Verdict.OFF, watch.check(beside(140.0, accuracy = 30.0), steps))
    }

    @Test
    fun a_vague_fix_gets_more_room() {
        val watch = driving()
        repeat(5) { assertEquals(Verdict.ON, watch.check(beside(45.0, accuracy = 30.0), steps)) }
    }

    @Test
    fun a_useless_fix_says_nothing() {
        val watch = driving()
        repeat(5) { assertEquals(Verdict.ON, watch.check(beside(400.0, accuracy = 300.0), steps)) }
    }

    @Test
    fun driving_the_other_way_down_the_road_is_off_the_route() {
        val watch = driving()
        repeat(3) { assertEquals(Verdict.ON, watch.check(beside(4.0, course = 180.0), steps)) }
        assertEquals(Verdict.OFF, watch.check(beside(4.0, course = 180.0), steps))
    }

    @Test
    fun facing_the_other_way_while_stopped_is_fine() {
        val watch = driving()
        repeat(10) { assertEquals(Verdict.ON, watch.check(beside(4.0, course = 180.0, speed = 0.5), steps)) }
    }

    @Test
    fun skipping_ahead_onto_a_later_road_says_so() {
        val watch = driving()
        val onEast = Fix(-27.4600, 153.0250, 8.0, 90.0, 14.0)
        watch.check(onEast, steps)
        assertEquals(Verdict.OFF_STEP, watch.check(onEast, steps))
    }

    @Test
    fun a_new_route_drops_the_points_that_pinned_the_old_one() {
        val pinned = listOf(ThroughPoint(-27.46, 153.02, 0), ThroughPoint(-27.45, 153.03, 90))
        // A stop, the two pinned points (one moved a few metres by the router), the end.
        val remaining = listOf(-27.50 to 153.00, -27.46005 to 153.02003, -27.45 to 153.03, -27.40 to 153.10)
        assertEquals(listOf(-27.50 to 153.00, -27.40 to 153.10), OffRouteWatch.stopsOnly(remaining, pinned, { false }) { it })
        // Where you're going stays even if a pinned point sits on it.
        assertEquals(listOf(-27.45 to 153.03), OffRouteWatch.stopsOnly(listOf(-27.46 to 153.02, -27.45 to 153.03), pinned, { false }) { it })
    }
}
