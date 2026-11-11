package org.promptly.sync.maps

import java.time.Instant
import java.time.ZoneId
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

/** Which colours the map wears. */
enum class MapTheme {
    /** Light by day, dark from sunset to sunrise where you are. */
    AUTO,
    LIGHT,
    DARK;

    val label: String
        get() = when (this) {
            AUTO -> "Automatic"
            LIGHT -> "Always light"
            DARK -> "Always dark"
        }
}

/** Is it night where you are? Worked out on the phone from where and when: the sun's
 *  height above the horizon, good to well under a minute of sunrise and sunset, which
 *  is plenty for choosing map colours. Nothing is looked up anywhere. */
object Daylight {
    /** The sun's centre is this far below a flat horizon when its top edge touches it. */
    private const val HORIZON = -0.833

    /** How high the sun is, in degrees: below zero, it's under the horizon. */
    fun sunElevation(lat: Double, lon: Double, at: Instant): Double {
        // Days since noon on 1 January 2000, the almanac's starting point.
        val n = at.toEpochMilli() / 86_400_000.0 + 2440587.5 - 2451545.0
        val meanLongitude = Math.toRadians(turn(280.460 + 0.9856474 * n))
        val anomaly = Math.toRadians(turn(357.528 + 0.9856003 * n))
        val longitude = meanLongitude + Math.toRadians(1.915 * sin(anomaly) + 0.020 * sin(2 * anomaly))
        val tilt = Math.toRadians(23.439 - 0.0000004 * n)
        val rightAscension = atan2(cos(tilt) * sin(longitude), cos(longitude))
        val declination = asin(sin(tilt) * sin(longitude))
        val greenwichHours = 18.697374558 + 24.06570982441908 * n
        val hourAngle = Math.toRadians(turn(greenwichHours * 15.0 + lon)) - rightAscension
        val latitude = Math.toRadians(lat)
        return Math.toDegrees(asin(sin(latitude) * sin(declination) + cos(latitude) * cos(declination) * cos(hourAngle)))
    }

    private fun turn(degrees: Double): Double = ((degrees % 360.0) + 360.0) % 360.0

    /** Between sunset and sunrise at this spot. */
    fun dark(lat: Double, lon: Double, at: Instant): Boolean = sunElevation(lat, lon, at) < HORIZON

    /** Not knowing where you are: dark from six in the evening to six in the morning. */
    fun darkByClock(at: Instant, zone: ZoneId): Boolean {
        val hour = at.atZone(zone).hour
        return hour >= 18 || hour < 6
    }

    /** Should the map be dark now? [position] is latitude then longitude, if known. */
    fun mapDark(
        theme: MapTheme,
        position: Pair<Double, Double>?,
        at: Instant = Instant.now(),
        zone: ZoneId = ZoneId.systemDefault(),
    ): Boolean = when (theme) {
        MapTheme.LIGHT -> false
        MapTheme.DARK -> true
        MapTheme.AUTO -> position?.let { dark(it.first, it.second, at) } ?: darkByClock(at, zone)
    }
}
