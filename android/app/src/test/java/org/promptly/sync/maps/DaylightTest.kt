package org.promptly.sync.maps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class DaylightTest {
    private fun at(text: String) = Instant.parse(text)

    @Test
    fun `london in midwinter turns at sunrise and sunset`() {
        // 21 December: the sun is up from about 08:04 to 15:53 UTC.
        assertTrue(Daylight.dark(51.5074, -0.1278, at("2026-12-21T07:45:00Z")))
        assertFalse(Daylight.dark(51.5074, -0.1278, at("2026-12-21T08:20:00Z")))
        assertFalse(Daylight.dark(51.5074, -0.1278, at("2026-12-21T15:40:00Z")))
        assertTrue(Daylight.dark(51.5074, -0.1278, at("2026-12-21T16:05:00Z")))
    }

    @Test
    fun `dubbo in november turns at sunrise and sunset`() {
        // 11 November, UTC+11: sunset about 7:36 pm (08:36 UTC), sunrise about 5:55 am (18:55 UTC).
        assertFalse(Daylight.dark(-32.25, 148.6, at("2026-11-11T08:00:00Z")))
        assertTrue(Daylight.dark(-32.25, 148.6, at("2026-11-11T09:15:00Z")))
        assertTrue(Daylight.dark(-32.25, 148.6, at("2026-11-11T18:15:00Z")))
        assertFalse(Daylight.dark(-32.25, 148.6, at("2026-11-11T19:30:00Z")))
    }

    @Test
    fun `noon is light and midnight is dark`() {
        assertTrue(Daylight.sunElevation(-32.25, 148.6, at("2026-11-11T01:30:00Z")) > 60)
        assertTrue(Daylight.sunElevation(-32.25, 148.6, at("2026-11-11T13:30:00Z")) < -30)
        // On the equator at the equinox the sun passes almost overhead.
        assertEquals(90.0, Daylight.sunElevation(0.0, 0.0, at("2026-03-20T12:07:00Z")), 1.5)
    }

    @Test
    fun `the choice wins over the sun`() {
        val noon = at("2026-11-11T01:30:00Z")
        val night = at("2026-11-11T13:30:00Z")
        val dubbo = -32.25 to 148.6
        assertTrue(Daylight.mapDark(MapTheme.DARK, dubbo, noon))
        assertFalse(Daylight.mapDark(MapTheme.LIGHT, dubbo, night))
        assertFalse(Daylight.mapDark(MapTheme.AUTO, dubbo, noon))
        assertTrue(Daylight.mapDark(MapTheme.AUTO, dubbo, night))
    }

    @Test
    fun `with no position it goes by the clock`() {
        val sydney = ZoneId.of("Australia/Sydney")
        // 7 pm, then 7 am, in Sydney.
        assertTrue(Daylight.mapDark(MapTheme.AUTO, null, at("2026-11-11T08:00:00Z"), sydney))
        assertFalse(Daylight.mapDark(MapTheme.AUTO, null, at("2026-11-11T20:00:00Z"), sydney))
        assertTrue(Daylight.mapDark(MapTheme.AUTO, null, at("2026-11-11T18:30:00Z"), sydney))
    }
}
