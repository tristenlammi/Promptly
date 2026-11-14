package org.promptly.sync.maps

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.TwoWayConverter
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import com.stadiamaps.ferrostar.core.NavigationUiState
import com.stadiamaps.ferrostar.maplibreui.runtime.NavigationCameraMode
import com.stadiamaps.ferrostar.maplibreui.runtime.NavigationMapState
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import uniffi.ferrostar.RouteDeviation
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sqrt

/** Where you're drawn on a trip's map, and where the camera points: latitude,
 *  longitude, and the way you're heading in degrees. */
data class Shown(val lat: Double, val lon: Double, val bearing: Double?)

/**
 * A trip's route measured along its length: put a position on it, find a point or a
 * heading a given distance along it.
 *
 * The same maths as the navigation library's map (Ferrostar 0.59's route-snapped
 * display position), so the arrow drawn from [rememberTripShown] sits exactly where the
 * library's camera is pointing. Points are latitude then longitude.
 */
class RouteRuler(points: List<Pair<Double, Double>>) {
    private val pts = points
    private val along: DoubleArray = DoubleArray(points.size).also { d ->
        for (i in 1 until points.size) d[i] = d[i - 1] + metres(points[i - 1], points[i])
    }
    val length: Double get() = along.last()

    /** How far along the route the nearest point to [lat],[lon] is, in metres. */
    fun project(lat: Double, lon: Double): Double = nearest(lat, lon, 0.0, length).first

    /**
     * The same, for a route that passes the same spot more than once (out and back
     * along one road, a round trip that ends where it started): looks first from
     * [back] metres behind [near] to [ahead] metres in front of it, and only if
     * that stretch is further than [give] metres from the position looks at the
     * whole route. Without this the arrow could jump to the return leg of the road.
     */
    fun project(lat: Double, lon: Double, near: Double, back: Double = 60.0, ahead: Double = 400.0, give: Double = 50.0): Double {
        val (along, off) = nearest(lat, lon, near - back, near + ahead)
        return if (off <= give) along else project(lat, lon)
    }

    /**
     * Where a trip begins: the earliest place on the route about as near as the
     * nearest. A round trip starts and ends at the same spot, and the plain nearest
     * could be the end, leaving the arrow parked at the destination.
     */
    fun projectFirst(lat: Double, lon: Double, slack: Double = 15.0): Double {
        val best = nearest(lat, lon, 0.0, length).second
        return nearest(lat, lon, 0.0, length, stopWithin = best + slack).first
    }

    /** The nearest point between [from] and [to] metres along: how far along it is, and
     *  how far from the position (metres). [stopWithin]: take the first that near. */
    private fun nearest(lat: Double, lon: Double, from: Double, to: Double, stopWithin: Double? = null): Pair<Double, Double> {
        var best = Double.POSITIVE_INFINITY
        var bestAlong = from.coerceIn(0.0, length)
        for (i in 0 until pts.size - 1) {
            if (along[i + 1] < from) continue
            if (along[i] > to) break
            val a = pts[i]
            val b = pts[i + 1]
            val mean = Math.toRadians((a.first + b.first + lat) / 3.0)
            val sx = 111_320.0 * cos(mean)
            val sy = 111_320.0
            val ax = a.second * sx; val ay = a.first * sy
            val bx = b.second * sx; val by = b.first * sy
            val px = lon * sx; val py = lat * sy
            val dx = bx - ax; val dy = by - ay
            val len2 = dx * dx + dy * dy
            val t = (if (len2 == 0.0) 0.0 else ((px - ax) * dx + (py - ay) * dy) / len2).coerceIn(0.0, 1.0)
            val qx = ax + dx * t; val qy = ay + dy * t
            val d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy)
            if (d2 < best) {
                best = d2
                bestAlong = along[i] + sqrt(len2) * t
                if (stopWithin != null && sqrt(d2) <= stopWithin) break
            }
        }
        return bestAlong to sqrt(best)
    }

    /** The point [progress] metres along the route. */
    fun at(progress: Double): Pair<Double, Double> {
        val p = progress.coerceIn(0.0, length)
        val i = segmentAt(p)
        val seg = along[i + 1] - along[i]
        if (seg == 0.0) return pts[i]
        val t = (p - along[i]) / seg
        return (pts[i].first + (pts[i + 1].first - pts[i].first) * t) to (pts[i].second + (pts[i + 1].second - pts[i].second) * t)
    }

    /** The route's heading at [progress]: from 5 m behind to 15 m ahead, so the map
     *  doesn't twitch with every wobble in the line. */
    fun bearingAt(progress: Double): Double {
        val p = progress.coerceIn(0.0, length)
        val from = (p - 5.0).coerceAtLeast(0.0)
        val to = (p + 15.0).coerceAtMost(length)
        if (to <= from) {
            val i = segmentAt(p)
            return bearing(pts[i], pts[i + 1])
        }
        return bearing(at(from), at(to))
    }

    /** The route from [progress] metres along to its end: the way still ahead. */
    fun from(progress: Double): List<Pair<Double, Double>> {
        val p = progress.coerceIn(0.0, length)
        val i = segmentAt(p)
        return listOf(at(p)) + pts.subList(i + 1, pts.size)
    }

    private fun segmentAt(p: Double): Int {
        for (i in 0 until along.size - 1) if (p <= along[i + 1]) return i
        return max(0, pts.size - 2)
    }

    companion object {
        fun metres(a: Pair<Double, Double>, b: Pair<Double, Double>): Double {
            val dLat = (b.first - a.first) * 111_320.0
            val dLon = (b.second - a.second) * 111_320.0 * cos(Math.toRadians((a.first + b.first) / 2.0))
            return sqrt(dLat * dLat + dLon * dLon)
        }

        fun bearing(a: Pair<Double, Double>, b: Pair<Double, Double>): Double {
            val dx = (b.second - a.second) * cos(Math.toRadians((a.first + b.first) / 2.0))
            val dy = b.first - a.first
            return (Math.toDegrees(atan2(dx, dy)) + 360.0) % 360.0
        }
    }
}

private val DoubleToVector = TwoWayConverter<Double, AnimationVector1D>(
    convertToVector = { AnimationVector1D(it.toFloat()) },
    convertFromVector = { it.value.toDouble() },
)

/**
 * Where you are on a trip's map, moving smoothly: put on the route and glided there over
 * a second, never backwards. It is exactly what the navigation library's camera follows,
 * so the arrow drawn here stays put on the screen while the map turns and slides under
 * it (the arrow used to jump from fix to fix while the camera glided, and the library's
 * own dot trailed behind it). Off the route, the fix itself.
 */
@Composable
fun rememberTripShown(state: NavigationUiState): Shown? {
    val fix = state.location ?: return null
    val raw = Shown(fix.coordinates.lat, fix.coordinates.lng, fix.courseOverGround?.degrees?.toDouble())
    val ruler = remember(state.routeGeometry) {
        state.routeGeometry?.takeIf { it.size >= 2 }?.let { line -> RouteRuler(line.map { it.lat to it.lng }) }
    }
    if (!state.isNavigating() || state.routeDeviation !is RouteDeviation.NoDeviation || ruler == null) return raw
    val progress = remember(ruler) { Animatable(ruler.projectFirst(fix.coordinates.lat, fix.coordinates.lng), DoubleToVector) }
    // Near where you already are on it: a road the route uses twice isn't mixed up.
    val target = remember(ruler, fix.coordinates.lat, fix.coordinates.lng) { ruler.project(fix.coordinates.lat, fix.coordinates.lng, near = progress.value) }
    val shown by progress.asState()
    LaunchedEffect(ruler, target) {
        val goal = max(progress.value, target)
        if (goal == progress.value) return@LaunchedEffect
        progress.animateTo(goal, tween(durationMillis = 1000, easing = LinearEasing))
    }
    val (lat, lon) = remember(ruler, shown) { ruler.at(shown) }
    return Shown(lat, lon, remember(ruler, shown) { ruler.bearingAt(shown) })
}

/** The zoom for a speed: closer in town, further out on the motorway, as Waze does it. */
object FollowZoom {
    fun forSpeed(metresPerSecond: Double?): Double {
        val kmh = (metresPerSecond ?: 0.0) * 3.6
        return when {
            kmh < 25 -> 17.0
            kmh < 50 -> 16.5
            kmh < 75 -> 16.0
            kmh < 95 -> 15.5
            else -> 15.0
        }
    }
}

/**
 * Keeps a trip's camera the Waze way: behind the car, facing where it's going, tilted,
 * with you low on the screen, and the zoom following your speed.
 *
 * The library only turns that on when it sees a trip *start* while its map is on the
 * screen. A map put up while a trip was already running (the car's screen coming back,
 * the phone's driving screen reopened) stayed flat and north-up for the whole trip.
 * Here it's set from whether a trip is running, every time that's read, and a map you
 * moved yourself comes back after [leaveAloneMs].
 */
@Composable
fun KeepTripCamera(
    mapState: NavigationMapState,
    navigating: Boolean,
    speed: Double?,
    leaveAloneMs: Long? = 15_000L,
    overviewIsOurs: Boolean = false,
) {
    val tripOn by rememberUpdatedState(navigating)
    val now by rememberUpdatedState(speed)
    LaunchedEffect(mapState) {
        snapshotFlow { tripOn to mapState.cameraMode }.collectLatest { (on, mode) ->
            if (!on) return@collectLatest
            when (mode) {
                NavigationCameraMode.FOLLOW_USER -> mapState.cameraMode = NavigationCameraMode.FOLLOW_USER_WITH_BEARING
                // The car's no-trip camera parks the library in OVERVIEW; a trip takes over.
                NavigationCameraMode.OVERVIEW -> if (overviewIsOurs) mapState.cameraMode = NavigationCameraMode.FOLLOW_USER_WITH_BEARING
                // Left alone while you're still moving it: the wait starts again with
                // every pan or pinch, and it comes back once the map has been still.
                NavigationCameraMode.FREE -> if (leaveAloneMs != null) {
                    snapshotFlow { mapState.cameraState.position }.collectLatest {
                        delay(leaveAloneMs)
                        mapState.recenter(true)
                    }
                }
                else -> Unit
            }
        }
    }
    // The zoom follows the speed, a step at a time, and only while following you.
    LaunchedEffect(mapState) {
        while (true) {
            delay(2_000)
            if (!tripOn || mapState.cameraMode != NavigationCameraMode.FOLLOW_USER_WITH_BEARING) continue
            val want = FollowZoom.forSpeed(now)
            val have = mapState.cameraState.position.zoom
            if (abs(want - have) >= 0.35) mapState.zoomIn(want - have, kotlin.time.Duration.parse("1.5s"))
        }
    }
}

/**
 * Where you're drawn with no trip: glides from one GPS fix to the next over about a
 * second (the time between fixes), turning the short way round, so the arrow and the
 * camera move smoothly instead of jumping once a second. A jump of more than
 * [snapMetres] (a fresh fix after a tunnel) is taken at once. Call [tick] every frame.
 */
class Glide(private val durationMs: Long = 1000L, private val snapMetres: Double = 300.0) {
    var current by mutableStateOf<Shown?>(null)
        private set
    var speed: Double? = null
        private set
    private var from: Shown? = null
    private var to: Shown? = null
    private var start = 0L

    fun to(lat: Double, lon: Double, bearing: Double?, speed: Double?, now: Long = android.os.SystemClock.elapsedRealtime()) {
        val here = current
        this.speed = speed
        val next = Shown(lat, lon, bearing ?: here?.bearing)
        if (here == null || RouteRuler.metres(here.lat to here.lon, lat to lon) > snapMetres) {
            from = next
            to = next
            current = next
        } else {
            from = here
            to = next
        }
        start = now
    }

    fun tick(now: Long = android.os.SystemClock.elapsedRealtime()) {
        val a = from ?: return
        val b = to ?: return
        val k = ((now - start).toDouble() / durationMs).coerceIn(0.0, 1.0)
        current = Shown(a.lat + (b.lat - a.lat) * k, a.lon + (b.lon - a.lon) * k, turn(a.bearing, b.bearing, k))
    }

    companion object {
        /** From [a] toward [b] by [k], the short way round. */
        fun turn(a: Double?, b: Double?, k: Double): Double? {
            if (a == null) return b
            if (b == null) return a
            var d = (b - a) % 360.0
            if (d > 180) d -= 360
            if (d < -180) d += 360
            return ((a + d * k) % 360.0 + 360.0) % 360.0
        }
    }
}
