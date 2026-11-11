package org.promptly.sync.maps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The speeding beep: once when you go over, not a nag. */
class SpeedAlertTest {
    private fun drive(alert: SpeedAlert, over: Int, limit: Int?, vararg speeds: Pair<Long, Double?>): List<Long> =
        speeds.filter { (at, kmh) -> alert.check(kmh, limit, over, at) }.map { it.first }

    @Test
    fun beepsOnceWhenYouGoOverAndStayThere() {
        val beeps = drive(SpeedAlert(), 0, 60, 0L to 58.0, 1000L to 63.0, 2000L to 64.0, 3000L to 65.0, 4000L to 66.0, 60_000L to 66.0)
        assertEquals(listOf(3000L), beeps)
    }

    @Test
    fun aBlipOverTheLimitIsNotSpeeding() {
        assertTrue(drive(SpeedAlert(), 0, 60, 0L to 59.0, 1000L to 64.0, 2000L to 59.0, 3000L to 59.0).isEmpty())
    }

    @Test
    fun theToleranceIsAllowed() {
        assertTrue(drive(SpeedAlert(), 5, 60, 0L to 64.0, 2000L to 65.0, 4000L to 65.0).isEmpty())
        assertEquals(listOf(2000L), drive(SpeedAlert(), 5, 60, 0L to 66.0, 2000L to 66.0))
        assertEquals(listOf(2000L), drive(SpeedAlert(), 10, 100, 0L to 111.0, 2000L to 111.0))
    }

    @Test
    fun againOnlyAfterDroppingBackUnder() {
        val alert = SpeedAlert()
        val beeps = drive(
            alert, 0, 60,
            0L to 65.0, 2000L to 65.0, // over: beep
            3000L to 60.0, 4000L to 65.0, 6000L to 65.0, // touched the line, not back under: quiet
            7000L to 57.0, 8000L to 65.0, 10_000L to 65.0, // back under, over again: beep
        )
        assertEquals(listOf(2000L, 10_000L), beeps)
    }

    @Test
    fun stillOverAFewMinutesLaterIsWorthAReminder() {
        val beeps = drive(SpeedAlert(), 0, 60, 0L to 70.0, 2000L to 70.0, 60_000L to 70.0, 121_000L to 70.0, 123_000L to 70.0)
        assertEquals(listOf(2000L, 123_000L), beeps)
    }

    @Test
    fun aLowerLimitIsANewQuestion() {
        val alert = SpeedAlert()
        assertEquals(listOf(2000L), drive(alert, 0, 80, 0L to 85.0, 2000L to 85.0))
        // Still 85, now in a 60 zone.
        assertEquals(listOf(5000L), drive(alert, 0, 60, 3000L to 85.0, 5000L to 85.0))
    }

    @Test
    fun noLimitOrNoSpeedNoBeep() {
        val alert = SpeedAlert()
        assertFalse(alert.check(120.0, null, 0, 0L))
        assertFalse(alert.check(120.0, null, 0, 5000L))
        assertFalse(alert.check(null, 60, 0, 6000L))
        // And not knowing doesn't count as time spent over.
        assertFalse(alert.check(70.0, 60, 0, 7000L))
    }

    @Test
    fun theBeepIsShortAndNotSilent() {
        val pcm = Beep.samples()
        assertTrue(pcm.size * 1000 / 22_050 <= 300)
        assertTrue(pcm.any { it > 10_000 })
        assertEquals(0, pcm.first().toInt())
    }
}
