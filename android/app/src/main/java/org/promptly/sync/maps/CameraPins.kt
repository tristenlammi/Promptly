package org.promptly.sync.maps

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import org.maplibre.compose.expressions.dsl.const
import org.maplibre.compose.expressions.dsl.image
import org.maplibre.compose.expressions.value.SymbolAnchor
import org.maplibre.compose.layers.SymbolLayer
import org.maplibre.compose.sources.GeoJsonData
import org.maplibre.compose.sources.rememberGeoJsonSource
import org.maplibre.compose.util.MaplibreComposable
import org.promptly.sync.R
import kotlin.math.cos
import kotlin.math.floor

/**
 * Fixed speed cameras drawn on the map: the ones the map data knows about
 * (OpenStreetMap, kept on your server and with your offline areas), around where
 * you are and along the trip. Nothing is looked up anywhere else, and nobody's
 * reports are used. The map doesn't know every camera.
 */
object CameraPins {
    /** The map is asked for cameras one square at a time (about 25 km a side). */
    const val CELL = 0.25

    /** Enough for a city's worth; further cameras come with the next square. */
    const val MOST = 400

    fun cell(lat: Double, lon: Double): Pair<Int, Int> = floor(lat / CELL).toInt() to floor(lon / CELL).toInt()

    /** `west, south, east, north` of the square you're in and the ones around it. */
    fun box(cell: Pair<Int, Int>): DoubleArray = doubleArrayOf(
        (cell.second - 1) * CELL, (cell.first - 1) * CELL, (cell.second + 2) * CELL, (cell.first + 2) * CELL,
    )

    fun inBox(all: List<Camera>, box: DoubleArray): List<Camera> =
        all.filter { it.lon >= box[0] && it.lat >= box[1] && it.lon <= box[2] && it.lat <= box[3] }

    /** The trip's cameras and the ones around you, each once, the nearest first, at most [MOST]. */
    fun shown(route: List<Camera>, nearby: List<Camera>, at: Pair<Double, Double>?): List<Camera> {
        val seen = HashSet<Pair<Long, Long>>()
        val each = (route + nearby).filter { seen.add(Math.round(it.lat * 1e5) to Math.round(it.lon * 1e5)) }
        if (each.size <= MOST || at == null) return each.take(MOST)
        val k = cos(Math.toRadians(at.first))
        return each.sortedBy { (it.lat - at.first) * (it.lat - at.first) + ((it.lon - at.second) * k) * ((it.lon - at.second) * k) }.take(MOST)
    }

    /** Points for the map, longitude first. Written out plainly: there's nothing to escape. */
    fun geoJson(cameras: List<Camera>): String = cameras.joinToString(",", "{\"type\":\"FeatureCollection\",\"features\":[", "]}") { c ->
        "{\"type\":\"Feature\",\"properties\":{},\"geometry\":{\"type\":\"Point\",\"coordinates\":[${c.lon},${c.lat}]}}"
    }
}

/** The cameras, on the phone's maps and the car's. [at] is where you are (latitude, longitude). */
@Composable
@MaplibreComposable
fun CamerasOnMap(at: Pair<Double, Double>?) {
    val on by Nav.showCamerasNow.collectAsState()
    val route by Nav.routeCameras.collectAsState()
    val nearby by Nav.nearbyCameras.collectAsState()
    val cell = at?.let { CameraPins.cell(it.first, it.second) }
    LaunchedEffect(cell, on) { if (on && cell != null) Nav.loadNearbyCameras(cell) }
    val json = remember(on, route, nearby, cell) { CameraPins.geoJson(if (on) CameraPins.shown(route, nearby, at) else emptyList()) }
    val source = rememberGeoJsonSource(GeoJsonData.JsonString(json))
    SymbolLayer(
        id = "promptly-speed-cameras",
        source = source,
        // Zoomed right out they'd cover the map.
        minZoom = 10f,
        iconImage = image(value = painterResource(R.drawable.ic_map_speed_camera), size = DpSize(26.dp, 26.dp), drawAsSdf = false),
        iconAnchor = const(SymbolAnchor.Center),
        iconAllowOverlap = const(true),
        iconIgnorePlacement = const(true),
    )
}
