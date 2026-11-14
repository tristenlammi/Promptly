package org.promptly.sync.maps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FollowCameraTest {
    // A straight road due north, then a right-angle turn east (about 111 m a side).
    private val north = listOf(-27.4000 to 153.0300, -27.3990 to 153.0300)
    private val corner = north + listOf(-27.3990 to 153.0311)

    @Test
    fun aPositionBesideTheRoadIsPutOnItAtTheRightDistance() {
        val ruler = RouteRuler(north)
        val along = ruler.project(-27.3995, 153.03005)
        assertEquals(ruler.length / 2, along, 1.0)
        val (lat, lon) = ruler.at(along)
        assertEquals(-27.3995, lat, 1e-6)
        assertEquals(153.0300, lon, 1e-6)
    }

    @Test
    fun theHeadingLooksAheadSoItTurnsBeforeTheCorner() {
        val ruler = RouteRuler(corner)
        assertEquals(0.0, ruler.bearingAt(50.0), 1.0)
        // 5 m before the corner the look-ahead already sees the turn coming.
        val near = ruler.bearingAt(ruler.length / 2 - 5)
        assertTrue("turning toward east: $near", near in 20.0..80.0)
        assertEquals(90.0, ruler.bearingAt(ruler.length - 30), 1.0)
    }

    @Test
    fun theLineAheadStartsWhereYouAreShown() {
        val ruler = RouteRuler(corner)
        val ahead = ruler.from(50.0)
        assertEquals(ruler.at(50.0), ahead.first())
        assertEquals(corner.last(), ahead.last())
        assertEquals(3, ahead.size)
    }

    @Test
    fun gentleKinksAreRoundedButJunctionTurnsStaySharp() {
        // A slight jog (about 10 degrees) over short pieces, then a real 90 degree turn.
        val road = listOf(
            -27.4000 to 153.0300,
            -27.3998 to 153.0300,
            -27.3996 to 153.03004,
            -27.3994 to 153.03004,
            -27.3994 to 153.0303,
        )
        val smooth = RouteAhead.smooth(road)
        // The jog's two corners each became two points; the junction corner stayed.
        assertEquals(road.size + 2, smooth.size)
        assertTrue(smooth.contains(-27.3994 to 153.03004))
        assertEquals(road.first(), smooth.first())
        assertEquals(road.last(), smooth.last())
        // Nothing moved further than the cap from where the road really is.
        for (p in smooth) {
            val nearest = road.minOf { RouteRuler.metres(it, p) }
            assertTrue("moved $nearest m", nearest <= 4.01)
        }
    }

    @Test
    fun theGlideTurnsTheShortWayRound() {
        assertEquals(5.0, Glide.turn(350.0, 20.0, 0.5)!!, 1e-9)
        assertEquals(350.0, Glide.turn(20.0, 320.0, 0.5)!!, 1e-9)
        assertEquals(90.0, Glide.turn(null, 90.0, 0.3)!!, 1e-9)
    }

    @Test
    fun theGlideMovesSmoothlyFromOneFixToTheNext() {
        val g = Glide(durationMs = 1000)
        g.to(-27.4, 153.03, 0.0, 10.0, now = 0)
        g.to(-27.3999, 153.03, 0.0, 10.0, now = 1000)
        g.tick(now = 1500)
        assertEquals(-27.39995, g.current!!.lat, 1e-7)
        g.tick(now = 2500)
        assertEquals(-27.3999, g.current!!.lat, 1e-9)
    }

    @Test
    fun aFixFarAwayIsTakenAtOnce() {
        val g = Glide(durationMs = 1000)
        g.to(-27.4, 153.03, null, null, now = 0)
        g.to(-27.3, 153.03, null, null, now = 1000)
        g.tick(now = 1001)
        assertEquals(-27.3, g.current!!.lat, 1e-9)
    }

    @Test
    fun theZoomFollowsTheSpeed() {
        assertEquals(17.0, FollowZoom.forSpeed(null), 0.0)
        assertEquals(16.0, FollowZoom.forSpeed(60 / 3.6), 0.0)
        assertEquals(15.0, FollowZoom.forSpeed(110 / 3.6), 0.0)
    }

    // Out along a road for about 1.1 km, then back along it (5 m to the east).
    private val outAndBack = listOf(-27.4000 to 153.03000, -27.3900 to 153.03000, -27.3900 to 153.03005, -27.4000 to 153.03005)

    @Test
    fun onARoadTheRouteUsesTwiceYouStayOnThePassYouAreOn() {
        val ruler = RouteRuler(outAndBack)
        // 300 m out, drifting 4 m east: nearer the way back than the way out.
        val lat = -27.4000 + 300.0 / 111_320.0
        val lon = 153.03004
        assertTrue("the plain nearest is the way back", ruler.project(lat, lon) > ruler.length / 2)
        assertEquals(300.0, ruler.project(lat, lon, near = 290.0), 2.0)
    }

    @Test
    fun farFromWhereYouWereItLooksAtTheWholeRoute() {
        // A dog-leg: north 1.1 km, east 1 km, north again. The hint says the start,
        // the position is on the last piece, far beyond the stretch searched.
        val ruler = RouteRuler(listOf(-27.4000 to 153.0300, -27.3900 to 153.0300, -27.3900 to 153.0400, -27.3800 to 153.0400))
        val along = ruler.project(-27.3850, 153.0400, near = 0.0)
        assertTrue("on the last piece: $along", along > ruler.length * 0.7)
    }

    @Test
    fun aRoundTripStartsAtItsBeginningNotItsEnd() {
        val ruler = RouteRuler(outAndBack)
        // At the start, a touch nearer the end of the route (which is 5 m away).
        assertTrue("the plain nearest is the end", ruler.project(-27.4000, 153.03004) > ruler.length / 2)
        assertEquals(0.0, ruler.projectFirst(-27.4000, 153.03004), 1.0)
    }
}
