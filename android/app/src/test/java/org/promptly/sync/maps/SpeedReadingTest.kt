package org.promptly.sync.maps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SpeedReadingTest {
    private fun kmh(mps: Float, accuracy: Float? = 0.3f, ageMs: Long = 200, hasSpeed: Boolean = true) =
        SpeedReading.kmh(hasSpeed, mps, accuracy, ageMs)

    @Test
    fun `the gps's own speed is shown as it is`() {
        assertEquals(100.0, kmh(27.7778f)!!, 0.01)
        assertEquals(118.0, kmh(32.7778f)!!, 0.01)
        // No accuracy given (older phones): still shown.
        assertEquals(60.0, kmh(16.6667f, accuracy = null)!!, 0.01)
    }

    @Test
    fun `nothing honest to show is dashes`() {
        assertNull(kmh(20f, hasSpeed = false)) // a position from Wi-Fi, no speed of its own
        assertNull(kmh(20f, ageMs = 3_001)) // a tunnel: the last reading is too old
        assertEquals(72.0, kmh(20f, ageMs = 3_000)!!, 0.01)
        assertNull(kmh(Float.NaN))
        assertNull(kmh(-1f))
        assertEquals("--", SpeedReading.text(null))
        assertEquals("0", SpeedReading.text(0))
    }

    @Test
    fun `standing still is zero, not a wandering one or two`() {
        assertEquals(0.0, kmh(0.3f)!!, 0.0)
        assertEquals(0.0, kmh(0f)!!, 0.0)
        // A rough reading and a small speed: can't tell crawling from standing.
        assertEquals(0.0, kmh(1.2f, accuracy = 2.5f)!!, 0.0)
        // A rough reading at speed is still your speed.
        assertEquals(90.0, kmh(25f, accuracy = 2.5f)!!, 0.01)
        // A good reading while crawling is shown.
        assertEquals(3.6, kmh(1f, accuracy = 0.2f)!!, 0.01)
    }

    @Test
    fun `the number doesn't flick between two`() {
        assertEquals(100, SpeedReading.shown(null, 99.6))
        assertEquals(100, SpeedReading.shown(100, 99.4)) // would round to 99
        assertEquals(100, SpeedReading.shown(100, 100.7)) // would round to 101
        assertEquals(101, SpeedReading.shown(100, 100.9))
        assertEquals(99, SpeedReading.shown(100, 99.1))
        // A real change shows at once: nothing is averaged.
        assertEquals(80, SpeedReading.shown(100, 80.2))
        assertEquals(0, SpeedReading.shown(1, 0.0))
        assertEquals(4, SpeedReading.shown(0, 3.6))
        assertNull(SpeedReading.shown(100, null))
    }

    @Test
    fun `three over the limit is amber, five over is red`() {
        assertEquals(SpeedReading.Level.FINE, SpeedReading.level(110, 110))
        assertEquals(SpeedReading.Level.FINE, SpeedReading.level(112, 110))
        assertEquals(SpeedReading.Level.OVER, SpeedReading.level(113, 110))
        assertEquals(SpeedReading.Level.OVER, SpeedReading.level(114, 110))
        assertEquals(SpeedReading.Level.WELL_OVER, SpeedReading.level(115, 110))
        assertEquals(SpeedReading.Level.WELL_OVER, SpeedReading.level(118, 110))
        assertEquals(SpeedReading.Level.FINE, SpeedReading.level(118, null))
        assertEquals(SpeedReading.Level.FINE, SpeedReading.level(null, 110))
        assertEquals(SpeedReading.Level.FINE, SpeedReading.level(118, 0)) // not a real limit
    }

    @Test
    fun `said for what it is`() {
        assertEquals("118 kilometres an hour by GPS, limit 110", SpeedReading.spoken(118, 110))
        assertEquals("Speed not known", SpeedReading.spoken(null, null))
    }

    @Test
    fun `the cluster's width and the room it leaves the road's name`() {
        assertEquals(76f, SpeedPlace.clusterWidthDp(76f, withLimit = false), 0.01f)
        assertEquals(76f + 6f + 53.2f, SpeedPlace.clusterWidthDp(76f, withLimit = true), 0.01f)
        val cluster = SpeedPlace.clusterWidthDp(76f, true)
        // A wide screen: mirrored, so the name is centred. A narrow one: the name gets the room.
        assertEquals(cluster, SpeedPlace.balanceDp(700f, cluster), 0.01f)
        assertEquals(0f, SpeedPlace.balanceDp(420f, cluster), 0.01f)
    }
}
