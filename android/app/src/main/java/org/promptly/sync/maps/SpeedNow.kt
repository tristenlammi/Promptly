package org.promptly.sync.maps

import android.location.Location
import android.os.Build
import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import kotlinx.coroutines.delay

/**
 * How fast you're going, from the GPS's own speed (which it measures directly, from
 * the shift in the satellites' signals, and which is better than working it out from
 * one position to the next). The newest reading is shown as it comes, with nothing
 * averaged in, so it doesn't trail behind the car.
 *
 * What's decided here, apart from any screen: when there's a number to show at all,
 * when "stopped" is the honest answer, and when to leave the number alone rather than
 * flick between two.
 */
object SpeedReading {
    /** How often the GPS is asked. Most phones answer once a second whatever is asked. */
    const val ASK_MS = 250L

    /** A reading older than this isn't how fast you're going any more. */
    const val STALE_MS = 3_000L

    /** Under this the GPS is only wandering: you're stopped. */
    const val STILL_MPS = 0.5f

    /** The GPS's own "give or take" on its speed, past which a small speed means nothing. */
    const val ROUGH_MPS = 1.5f

    /** The shown number holds until the real speed is this far from it (km/h). */
    const val HOLD_KMH = 0.8

    /** This far over the limit is amber, and [RED_OVER_KMH] over is red. Under that it stays plain. */
    const val AMBER_OVER_KMH = 3
    const val RED_OVER_KMH = 5

    /**
     * Your speed in km/h, not yet rounded, or null when there's nothing honest to show:
     * no reading, one too old, or one that didn't come with a speed of its own.
     */
    fun kmh(hasSpeed: Boolean, mps: Float, accuracyMps: Float?, ageMs: Long): Double? {
        if (!hasSpeed || ageMs > STALE_MS || mps.isNaN() || mps < 0f) return null
        if (mps < STILL_MPS) return 0.0
        // Crawling or standing? When the GPS can't tell, standing.
        if (accuracyMps != null && accuracyMps > ROUGH_MPS && mps < accuracyMps) return 0.0
        return mps * 3.6
    }

    /** The whole number on the screen: the nearest, but not flicking between two. */
    fun shown(before: Int?, exact: Double?): Int? {
        if (exact == null) return null
        if (exact == 0.0) return 0
        if (before != null && before != 0 && abs(exact - before) < HOLD_KMH) return before
        return Math.round(exact).toInt()
    }

    enum class Level { FINE, OVER, WELL_OVER }

    fun level(kmh: Int?, limit: Int?): Level = when {
        kmh == null || limit == null || limit !in 5..150 -> Level.FINE
        kmh >= limit + RED_OVER_KMH -> Level.WELL_OVER
        kmh >= limit + AMBER_OVER_KMH -> Level.OVER
        else -> Level.FINE
    }

    /** What the screen says: the number, or two dashes. */
    fun text(kmh: Int?): String = kmh?.toString() ?: "--"

    /** For a screen reader. Says what it is and no more: a GPS reading. */
    fun spoken(kmh: Int?, limit: Int?): String =
        (if (kmh == null) "Speed not known" else "$kmh kilometres an hour by GPS") + (limit?.let { ", limit $it" } ?: "")
}

/** Where the cluster sits along the bottom of the car's map, in dp. */
object SpeedPlace {
    const val GAP_DP = 6f
    const val SIGN_SCALE = 0.7f

    /** The least the road's name needs between the cluster and its mirror. */
    const val ROAD_NAME_MIN_DP = 200f

    /** How wide the cluster draws: your speed, and the limit's sign when there is one. */
    fun clusterWidthDp(sizeDp: Float, withLimit: Boolean): Float =
        if (withLimit) sizeDp + GAP_DP + sizeDp * SIGN_SCALE else sizeDp

    /** Blank space to leave at the far end so the road's name stays centred: as wide as
     *  the cluster when the name still has room, none when it wouldn't. */
    fun balanceDp(areaDp: Float, clusterDp: Float): Float =
        if (areaDp - 2 * clusterDp >= ROAD_NAME_MIN_DP) clusterDp else 0f
}

/** The number on the screen, fed each GPS reading as it arrives. */
class LiveSpeed {
    var kmh by mutableStateOf<Int?>(null)
        private set
    private var last: Location? = null

    fun fix(location: Location) {
        // Only a reading with a speed of its own replaces the last one: a rough
        // position from Wi-Fi mustn't blank a good GPS speed a second old.
        if (location.hasSpeed()) last = location
        tick()
    }

    /** Called a few times a second too, so an old reading turns to dashes on time. */
    fun tick(nowNanos: Long = SystemClock.elapsedRealtimeNanos()) {
        val fix = last
        val exact = if (fix == null) null else SpeedReading.kmh(
            hasSpeed = fix.hasSpeed(),
            mps = fix.speed,
            accuracyMps = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && fix.hasSpeedAccuracy()) fix.speedAccuracyMetersPerSecond else null,
            ageMs = (nowNanos - fix.elapsedRealtimeNanos) / 1_000_000,
        )
        kmh = SpeedReading.shown(kmh, exact)
    }
}

/** Keeps [speed] honest between readings: when they stop, the number goes. */
@Composable
fun KeepSpeedFresh(speed: LiveSpeed) {
    LaunchedEffect(speed) {
        while (true) {
            delay(500)
            speed.tick()
        }
    }
}

/**
 * Your speed, and the road's limit beside it when the map knows one: one cluster, at
 * the bottom of the map, on the phone and in the car. Drawn with its own colours (the
 * car's screen has no theme to borrow), dark or light with the map.
 */
@Composable
fun SpeedCluster(kmh: Int?, limit: Int?, dark: Boolean, modifier: Modifier = Modifier, size: Dp = 80.dp) {
    val level = SpeedReading.level(kmh, limit)
    val face = when (level) {
        SpeedReading.Level.WELL_OVER -> Color(0xFFC62828)
        SpeedReading.Level.OVER -> if (dark) Color(0xFFF2A65A) else Color(0xFFB45309)
        SpeedReading.Level.FINE -> if (dark) Color(0xFF26211E) else Color.White
    }
    val ink = when (level) {
        SpeedReading.Level.WELL_OVER -> Color.White
        SpeedReading.Level.OVER -> if (dark) Color(0xFF1B1B1B) else Color.White
        SpeedReading.Level.FINE -> if (dark) Color.White else Color(0xFF1B1B1B)
    }
    Row(
        modifier.clearAndSetSemantics { contentDescription = SpeedReading.spoken(kmh, limit) },
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(SpeedPlace.GAP_DP.dp),
    ) {
        // A fine rim, so the dark face doesn't sink into the night map (nor the white into the day one).
        val rim = if (dark) Color(0x59FFFFFF) else Color(0x26000000)
        Box(Modifier.size(size).shadow(4.dp, CircleShape).clip(CircleShape).background(face).border(1.5.dp, rim, CircleShape), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                val text = SpeedReading.text(kmh)
                Text(text, color = ink, fontSize = (size.value * if (text.length >= 3) 0.36f else 0.42f).sp, lineHeight = (size.value * 0.42f).sp, fontWeight = FontWeight.Bold)
                Text("km/h", color = ink, fontSize = (size.value * 0.15f).sp, lineHeight = (size.value * 0.16f).sp)
            }
        }
        if (limit != null) {
            // The sign as it looks on the road: a red ring on white, day or night.
            val sign = size * SpeedPlace.SIGN_SCALE
            Box(
                Modifier.size(sign).shadow(3.dp, CircleShape).clip(CircleShape).background(Color.White).border(sign * 0.1f, Color(0xFFD32F2F), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text("$limit", color = Color(0xFF1B1B1B), fontSize = (sign.value * if (limit >= 100) 0.34f else 0.4f).sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}
