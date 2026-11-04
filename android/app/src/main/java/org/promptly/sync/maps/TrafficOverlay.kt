package org.promptly.sync.maps

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import org.maplibre.compose.expressions.dsl.const
import org.maplibre.compose.layers.LineLayer
import org.maplibre.compose.sources.GeoJsonData
import org.maplibre.compose.sources.rememberGeoJsonSource
import org.maplibre.compose.util.MaplibreComposable

/** The slow stretches of the road ahead, over the route line, on both the
 *  phone's screen and the car's. */
@Composable
@MaplibreComposable
fun TrafficOnRoute() {
    val traffic by Nav.traffic.collectAsState()
    val jams = traffic?.jams.orEmpty()
    TrafficLayer("promptly-slow", jams.filter { it.kind == "slow" }, Color(0xFFEF9A1A))
    TrafficLayer("promptly-jam", jams.filter { it.kind == "jam" }, Color(0xFFC62828))
}

@Composable
@MaplibreComposable
private fun TrafficLayer(id: String, jams: List<Nav.Jam>, colour: Color) {
    val json = remember(jams) {
        val features = JSONArray()
        jams.forEach { jam ->
            val coordinates = JSONArray()
            jam.line.forEach { (lon, lat) -> coordinates.put(JSONArray().put(lon).put(lat)) }
            features.put(
                JSONObject()
                    .put("type", "Feature")
                    .put("properties", JSONObject())
                    .put("geometry", JSONObject().put("type", "LineString").put("coordinates", coordinates)),
            )
        }
        JSONObject().put("type", "FeatureCollection").put("features", features).toString()
    }
    val source = rememberGeoJsonSource(GeoJsonData.JsonString(json))
    LineLayer(id = id, source = source, color = const(colour), width = const(7.dp))
}
