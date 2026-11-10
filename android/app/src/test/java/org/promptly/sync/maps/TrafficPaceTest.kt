package org.promptly.sync.maps

import org.junit.Assert.assertEquals
import org.junit.Test

class TrafficPaceTest {
    @Test fun `asks again soon with no position or no signal`() {
        assertEquals(TrafficPace.SOON, TrafficPace.pause(false, 20.0, null))
        assertEquals(TrafficPace.SOON, TrafficPace.pause(false, 900.0, 10))
    }

    @Test fun `an ordinary trip asks every minute and a half`() {
        assertEquals(90_000L, TrafficPace.pause(true, 20.0, null))
        assertEquals(90_000L, TrafficPace.pause(true, 150.0, 2))
    }

    @Test fun `asks every minute while traffic is costing time`() {
        assertEquals(60_000L, TrafficPace.pause(true, 20.0, 3))
        assertEquals(60_000L, TrafficPace.pause(true, 80.0, 25))
    }

    @Test fun `a long trip keeps the slow pace even in traffic`() {
        assertEquals(180_000L, TrafficPace.pause(true, 151.0, null))
        assertEquals(180_000L, TrafficPace.pause(true, 600.0, 12))
    }

    @Test fun `a new route is asked about once it has settled`() {
        // Last asked a minute ago, next planned in half a minute: ask in 4 seconds instead.
        assertEquals(104_000L, TrafficPace.afterReroute(now = 100_000, lastAsk = 40_000, planned = 130_000))
    }

    @Test fun `new routes in a row do not ask more than twice a minute`() {
        assertEquals(125_000L, TrafficPace.afterReroute(now = 100_000, lastAsk = 95_000, planned = 185_000))
        assertEquals(125_000L, TrafficPace.afterReroute(now = 105_000, lastAsk = 95_000, planned = 125_000))
    }

    @Test fun `a new route never pushes a planned ask later`() {
        assertEquals(101_000L, TrafficPace.afterReroute(now = 100_000, lastAsk = 99_000, planned = 101_000))
    }
}
