package org.promptly.sync.maps

import org.junit.Assert.assertEquals
import org.junit.Test

/** The line behind you goes as you drive: only the way ahead is drawn. */
class RouteAheadTest {
    // A road north, then a turn east. Points are latitude, longitude.
    private val north = listOf(-27.000 to 153.000, -26.990 to 153.000, -26.980 to 153.000)
    private val east = listOf(-26.980 to 153.000, -26.980 to 153.010)

    @Test
    fun cuts_the_current_step_where_you_are() {
        val ahead = RouteAhead.from(listOf(north, east), -26.995 to 153.0001)
        assertEquals(-26.995, ahead.first().first, 1e-6)
        assertEquals(153.000, ahead.first().second, 1e-6)
        // Then the rest of this road, and the next step, with the shared corner once.
        assertEquals(listOf(-26.990 to 153.000, -26.980 to 153.000, -26.980 to 153.010), ahead.drop(1))
    }

    @Test
    fun past_the_end_of_the_step_it_starts_at_the_corner() {
        val ahead = RouteAhead.from(listOf(north, east), -26.975 to 153.000)
        assertEquals(-26.980 to 153.000, ahead.first())
        assertEquals(-26.980 to 153.010, ahead.last())
    }

    @Test
    fun a_road_used_twice_is_cut_on_the_step_youre_on() {
        // Out and back along the same road: you're on the way out, near where the way back passes.
        val back = listOf(-26.980 to 153.000, -27.000 to 153.000)
        val ahead = RouteAhead.from(listOf(north, back), -26.985 to 153.000)
        assertEquals(-26.985, ahead.first().first, 1e-6)
        assertEquals(-27.000 to 153.000, ahead.last())
        assertEquals(3, ahead.size)
    }

    @Test
    fun without_a_position_it_is_the_whole_way() {
        assertEquals(north + east.drop(1), RouteAhead.from(listOf(north, east), null))
        assertEquals(emptyList<Pair<Double, Double>>(), RouteAhead.from(emptyList(), -27.0 to 153.0))
    }
}
