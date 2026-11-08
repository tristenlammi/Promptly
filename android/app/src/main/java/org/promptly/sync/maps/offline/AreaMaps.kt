package org.promptly.sync.maps.offline

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import org.maplibre.compose.camera.CameraPosition
import org.maplibre.compose.camera.rememberCameraState
import org.maplibre.compose.expressions.dsl.const
import org.maplibre.compose.layers.FillLayer
import org.maplibre.compose.layers.LineLayer
import org.maplibre.compose.map.GestureOptions
import org.maplibre.compose.map.MapOptions
import org.maplibre.compose.map.MaplibreMap
import org.maplibre.compose.map.OrnamentOptions
import org.maplibre.compose.sources.GeoJsonData
import org.maplibre.compose.sources.rememberGeoJsonSource
import org.maplibre.compose.style.BaseStyle
import org.maplibre.compose.util.MaplibreComposable
import org.maplibre.spatialk.geojson.BoundingBox
import org.maplibre.spatialk.geojson.Position

/** GeoJSON for squares (filled) and an outline box. */
internal object AreaShapes {
    fun squares(cells: Collection<String>): String {
        val features = JSONArray()
        for (name in cells) {
            val c = Cells.parse(name) ?: continue
            features.put(polygon(c.west.toDouble(), c.south.toDouble(), c.east.toDouble(), c.north.toDouble()))
        }
        return JSONObject().put("type", "FeatureCollection").put("features", features).toString()
    }

    fun outline(box: OfflineApi.Box): String =
        JSONObject().put("type", "FeatureCollection").put("features", JSONArray().put(polygon(box.west, box.south, box.east, box.north))).toString()

    private fun polygon(w: Double, s: Double, e: Double, n: Double): JSONObject {
        val ring = JSONArray()
        for ((x, y) in listOf(w to s, e to s, e to n, w to n, w to s)) ring.put(JSONArray().put(x).put(y))
        return JSONObject().put("type", "Feature").put("properties", JSONObject())
            .put("geometry", JSONObject().put("type", "Polygon").put("coordinates", JSONArray().put(ring)))
    }
}

/** The area page's small map: the area's outline, its squares lightly shaded. With
 *  no map style yet (never online), a plain drawing of the same. */
@Composable
fun AreaMap(style: String?, box: OfflineApi.Box, cells: List<String>, accent: Color, modifier: Modifier = Modifier) {
    if (style == null) {
        SquaresDrawing(box, cells, accent, modifier)
        return
    }
    val bounds = remember(cells, box) {
        val all = cells.mapNotNull(Cells::parse)
        val w = (all.minOfOrNull { it.west.toDouble() } ?: box.west).coerceAtMost(box.west)
        val s = (all.minOfOrNull { it.south.toDouble() } ?: box.south).coerceAtMost(box.south)
        val e = (all.maxOfOrNull { it.east.toDouble() } ?: box.east).coerceAtLeast(box.east)
        val n = (all.maxOfOrNull { it.north.toDouble() } ?: box.north).coerceAtLeast(box.north)
        BoundingBox(w, s, e, n)
    }
    val camera = rememberCameraState(CameraPosition(target = Position((bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2), zoom = 6.0))
    LaunchedEffect(bounds) {
        camera.awaitProjection()
        camera.jumpTo(bounds, 0.0, 0.0, PaddingValues(16.dp))
    }
    MaplibreMap(
        modifier = modifier,
        baseStyle = BaseStyle.Uri(style),
        cameraState = camera,
        options = MapOptions(gestureOptions = GestureOptions.AllDisabled, ornamentOptions = OrnamentOptions.OnlyLogo),
    ) {
        AreaLayers(cells, box, accent)
    }
}

@Composable
@MaplibreComposable
internal fun AreaLayers(cells: List<String>, box: OfflineApi.Box?, accent: Color) {
    val squares = rememberGeoJsonSource(GeoJsonData.JsonString(AreaShapes.squares(cells)))
    FillLayer(id = "offline-squares", source = squares, color = const(accent), opacity = const(0.14f))
    LineLayer(id = "offline-square-edges", source = squares, color = const(accent), opacity = const(0.35f), width = const(1.dp))
    if (box != null) {
        val outline = rememberGeoJsonSource(GeoJsonData.JsonString(AreaShapes.outline(box)))
        LineLayer(id = "offline-outline", source = outline, color = const(accent), width = const(2.5.dp))
    }
}

/** Squares and outline drawn plainly, for when there's no map to draw them on. */
@Composable
private fun SquaresDrawing(box: OfflineApi.Box, cells: List<String>, accent: Color, modifier: Modifier) {
    Canvas(modifier.then(Modifier.fillMaxSize())) {
        val all = cells.mapNotNull(Cells::parse)
        val w = minOf(all.minOfOrNull { it.west.toDouble() } ?: box.west, box.west)
        val s = minOf(all.minOfOrNull { it.south.toDouble() } ?: box.south, box.south)
        val e = maxOf(all.maxOfOrNull { it.east.toDouble() } ?: box.east, box.east)
        val n = maxOf(all.maxOfOrNull { it.north.toDouble() } ?: box.north, box.north)
        val pad = 16.dp.toPx()
        val scale = minOf((size.width - 2 * pad) / (e - w), (size.height - 2 * pad) / (n - s)).toFloat()
        val ox = (size.width - (e - w).toFloat() * scale) / 2
        val oy = (size.height - (n - s).toFloat() * scale) / 2
        fun x(lon: Double) = ox + ((lon - w).toFloat() * scale)
        fun y(lat: Double) = oy + ((n - lat).toFloat() * scale)
        for (c in all) {
            val tl = Offset(x(c.west.toDouble()), y(c.north.toDouble()))
            drawRect(accent.copy(alpha = 0.14f), tl, Size(scale, scale))
            drawRect(accent.copy(alpha = 0.35f), tl, Size(scale, scale), style = Stroke(1.dp.toPx()))
        }
        drawRect(
            accent, Offset(x(box.west), y(box.north)),
            Size(((box.east - box.west).toFloat() * scale), ((box.north - box.south).toFloat() * scale)),
            style = Stroke(2.5.dp.toPx()),
        )
    }
}
