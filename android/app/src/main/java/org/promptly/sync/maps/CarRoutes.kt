package org.promptly.sync.maps

import android.content.Context
import android.location.Location
import android.text.SpannableString
import android.text.Spanned
import android.util.Log
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarColor
import androidx.car.app.model.CarIcon
import androidx.car.app.model.CarText
import androidx.car.app.model.DurationSpan
import androidx.car.app.model.Header
import androidx.car.app.model.ItemList
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.car.app.navigation.model.RoutePreviewNavigationTemplate
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.core.graphics.drawable.IconCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import org.maplibre.compose.expressions.dsl.const
import org.maplibre.compose.layers.LineLayer
import org.maplibre.compose.sources.GeoJsonData
import org.maplibre.compose.sources.rememberGeoJsonSource
import org.maplibre.compose.util.MaplibreComposable
import org.promptly.sync.R
import java.io.IOException
import java.util.Locale

/** One way of getting there, for the car's route screen. */
data class CarRoute(
    val seconds: Int,
    val km: Double,
    val via: String?,
    val addsMinutes: Int,
    /** (lon, lat), the order the map wants. */
    val line: List<Pair<Double, Double>>,
    val through: List<ThroughPoint>,
)

/** Where you're thinking of going: still looking, or the ways there. */
data class CarTripPlan(val stop: Stop, val routes: List<CarRoute>? = null, val selected: Int = 0) {
    val route: CarRoute? get() = routes?.getOrNull(selected)
}

/** Tapping a place shows the route first. The trip starts when you press Go. */
object CarPreview {
    private const val TAG = "PromptlyCar"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var asking: Job? = null

    private val _plan = MutableStateFlow<CarTripPlan?>(null)
    val plan = _plan.asStateFlow()

    /** Something to tell you on the car's screen. */
    private val _problem = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val problem = _problem.asSharedFlow()

    fun show(context: Context, stop: Stop) {
        asking?.cancel()
        _plan.value = CarTripPlan(stop)
        asking = scope.launch {
            try {
                val here = freshLocation() ?: throw NoFix()
                val routes = routesTo(context, here, stop)
                if (routes.isEmpty()) throw IOException("none")
                _plan.value = CarTripPlan(stop, routes)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: NoFix) {
                giveUp("Waiting for GPS. Try again in a moment.")
            } catch (e: Exception) {
                Log.w(TAG, "Couldn't get a route", e)
                giveUp(if (e.message?.contains("422") == true) "No route from here to there." else "Couldn't get a route. Check your connection.")
            }
        }
    }

    private class NoFix : Exception()

    private fun giveUp(words: String) {
        _plan.value = null
        _problem.tryEmit(words)
    }

    fun select(index: Int) {
        _plan.value = _plan.value?.copy(selected = index)
    }

    fun clear() {
        asking?.cancel()
        _plan.value = null
    }

    /** Off the route screen and on the road, the way you picked. */
    fun go() {
        val plan = _plan.value ?: return
        val route = plan.route ?: return
        Nav.start(listOf(plan.stop), TripOptions(), route.through)
        clear()
    }

    private suspend fun freshLocation(): Location? =
        withTimeoutOrNull(12_000) { Nav.locationProvider.locationUpdates(1000L).first { System.currentTimeMillis() - it.time < 60_000 } }
            ?: withTimeoutOrNull(8_000) { Nav.locationProvider.locationUpdates(1000L).first() }

    private suspend fun routesTo(context: Context, here: Location, stop: Stop): List<CarRoute> = withContext(Dispatchers.IO) {
        val stops = JSONArray()
            .put(JSONObject().put("lat", here.latitude).put("lon", here.longitude).put("name", "Your location"))
            .put(JSONObject().put("lat", stop.lat).put("lon", stop.lon).put("name", stop.name))
        parseRoutes(Maps.send(context, "POST", "/api/maps/route", JSONObject().put("stops", stops).put("mode", "drive")))
    }

    internal fun parseRoutes(body: JSONObject): List<CarRoute> {
        val rows = body.optJSONArray("routes") ?: return emptyList()
        return List(rows.length()) { i ->
            val r = rows.getJSONObject(i)
            val traffic = r.optJSONObject("traffic")
            val seconds = traffic?.optDouble("seconds")?.takeUnless { it.isNaN() } ?: r.optDouble("seconds", 0.0)
            val legs = r.optJSONArray("legs") ?: JSONArray()
            val through = r.optJSONArray("through") ?: JSONArray()
            CarRoute(
                seconds = seconds.toInt(),
                km = r.optDouble("km", 0.0),
                via = r.optString("via_name").takeUnless { it.isEmpty() || it == "null" },
                addsMinutes = Math.round((traffic?.optDouble("adds_seconds", 0.0) ?: 0.0) / 60).toInt(),
                line = List(legs.length()) { decodeShape(legs.getJSONObject(it).optString("shape")) }.flatten(),
                through = List(through.length()) {
                    val p = through.getJSONObject(it)
                    ThroughPoint(p.getDouble("lat"), p.getDouble("lon"), if (p.has("heading") && !p.isNull("heading")) p.getInt("heading") else null)
                },
            )
        }
    }

    /** The server's six-decimal polyline, as (lon, lat). */
    internal fun decodeShape(shape: String): List<Pair<Double, Double>> {
        val out = ArrayList<Pair<Double, Double>>()
        var index = 0
        var lat = 0L
        var lon = 0L
        fun next(): Long {
            var result = 0L
            var shift = 0
            while (index < shape.length) {
                val b = shape[index++].code - 63
                result = result or ((b and 0x1F).toLong() shl shift)
                shift += 5
                if (b < 0x20) break
            }
            return if (result and 1L != 0L) (result shr 1).inv() else result shr 1
        }
        while (index < shape.length) {
            lat += next()
            lon += next()
            out += (lon / 1e6) to (lat / 1e6)
        }
        return out
    }
}

/** The ways there, with the one you've picked on top. */
@Composable
@MaplibreComposable
fun PreviewRoutesOnMap() {
    val plan by CarPreview.plan.collectAsState()
    val routes = plan?.routes.orEmpty()
    val picked = plan?.selected ?: 0
    PreviewLine("promptly-preview-others", routes.filterIndexed { i, _ -> i != picked }, Color(0xFF9AA0A6), 5)
    PreviewLine("promptly-preview", listOfNotNull(routes.getOrNull(picked)), Color(0xFF3D5AFE), 8)
}

@Composable
@MaplibreComposable
private fun PreviewLine(id: String, routes: List<CarRoute>, colour: Color, width: Int) {
    val json = remember(routes) {
        val features = JSONArray()
        routes.forEach { route ->
            val coordinates = JSONArray()
            route.line.forEach { (lon, lat) -> coordinates.put(JSONArray().put(lon).put(lat)) }
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
    LineLayer(id = id, source = source, color = const(colour), width = const(width.dp))
}

/** The car's screens, kept apart from what they do so each can be built and checked
 *  against the car's rules without a car. A template that breaks them stops the app. */
internal object CarTemplates {
    private fun icon(context: Context, res: Int, tint: Boolean = false): CarIcon {
        val builder = CarIcon.Builder(IconCompat.createWithResource(context, res))
        if (tint) builder.setTint(CarColor.DEFAULT)
        return builder.build()
    }

    fun mic(context: Context, onClick: () -> Unit): Action =
        Action.Builder().setIcon(icon(context, R.drawable.ic_map_mic)).setOnClickListener { onClick() }.build()

    /** The map, ready to go: where to, and home and work a tap away. */
    fun landing(context: Context, home: Stop?, work: Stop?, onWhereTo: () -> Unit, onPlace: (Stop) -> Unit, onMic: () -> Unit): Template {
        val strip = ActionStrip.Builder().addAction(
            Action.Builder().setTitle("Where to?").setIcon(icon(context, R.drawable.ic_map_search)).setFlags(Action.FLAG_PRIMARY).setOnClickListener { onWhereTo() }.build(),
        )
        home?.let { s -> strip.addAction(Action.Builder().setTitle("Home").setIcon(icon(context, R.drawable.ic_map_home)).setOnClickListener { onPlace(s) }.build()) }
        work?.let { s -> strip.addAction(Action.Builder().setTitle("Work").setIcon(icon(context, R.drawable.ic_map_work)).setOnClickListener { onPlace(s) }.build()) }
        return NavigationTemplate.Builder()
            .setActionStrip(strip.build())
            .setMapActionStrip(ActionStrip.Builder().addAction(mic(context, onMic)).build())
            .build()
    }

    /** "22 min", which the car writes in its own way, and how that compares. */
    private fun routeRow(route: CarRoute, fastest: Int): Row {
        val title = SpannableString(" ")
        title.setSpan(DurationSpan.create(route.seconds.toLong()), 0, 1, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
        val row = Row.Builder().setTitle(CarText.create(title))
        val details = listOfNotNull(
            String.format(Locale.ENGLISH, "%.1f km", route.km),
            route.via?.let { "via $it" },
        ).joinToString(" · ")
        row.addText(details)
        val notes = listOfNotNull(
            if (route.seconds > fastest + 60) "${Math.round((route.seconds - fastest) / 60.0)} min longer" else null,
            if (route.addsMinutes >= 1) "${route.addsMinutes} min of traffic" else null,
        ).joinToString(" · ")
        if (notes.isNotEmpty()) row.addText(notes)
        return row.build()
    }

    /** The route on the map, how long it takes, and one big Go. */
    fun preview(plan: CarTripPlan, limit: Int, onSelect: (Int) -> Unit, onGo: () -> Unit, onBack: Action = Action.BACK): Template {
        val builder = RoutePreviewNavigationTemplate.Builder()
            .setHeader(Header.Builder().setStartHeaderAction(onBack).setTitle(plan.stop.name).build())
        val routes = plan.routes?.take(limit.coerceAtLeast(1))
        if (routes.isNullOrEmpty()) return builder.setLoading(true).build()
        val list = ItemList.Builder().setOnSelectedListener { onSelect(it) }.setSelectedIndex(plan.selected.coerceIn(0, routes.lastIndex))
        val fastest = routes.minOf { it.seconds }
        routes.forEach { list.addItem(routeRow(it, fastest)) }
        return builder
            .setItemList(list.build())
            .setNavigateAction(Action.Builder().setTitle("Go").setFlags(Action.FLAG_PRIMARY).setBackgroundColor(CarColor.BLUE).setOnClickListener { onGo() }.build())
            .build()
    }

    /** A row for a place: what kind it is, how far, and where. */
    fun placeRow(context: Context, stop: Stop, metres: Float?, onPick: (Stop) -> Unit): Row {
        val res = when (stop.kind) {
            "home" -> R.drawable.ic_map_home
            "work" -> R.drawable.ic_map_work
            "favourite", "list" -> R.drawable.ic_map_star
            "recent" -> R.drawable.ic_map_recent
            "parked" -> R.drawable.ic_map_car
            else -> R.drawable.ic_map_place
        }
        val row = Row.Builder()
            .setTitle(CarText.create(stop.name))
            .setImage(icon(context, res, tint = true))
            .setOnClickListener { onPick(stop) }
        val line = listOfNotNull(
            metres?.let { if (it < 1000) "${it.toInt()} m" else String.format(Locale.ENGLISH, "%.1f km", it / 1000) },
            stop.address?.takeIf { it.isNotBlank() },
        ).joinToString(" · ")
        if (line.isNotEmpty()) row.addText(CarText.create(line))
        return row.build()
    }

    fun places(context: Context, stops: List<Stop>, limit: Int, empty: String, distance: (Stop) -> Float?, onPick: (Stop) -> Unit): ItemList {
        val list = ItemList.Builder().setNoItemsMessage(empty)
        stops.take(limit.coerceAtLeast(1)).forEach { list.addItem(placeRow(context, it, distance(it), onPick)) }
        return list.build()
    }

    /** Ending a trip takes a second press, so a bump in the road doesn't. */
    fun confirmStop(onEnd: () -> Unit, onKeep: () -> Unit): Template =
        MessageTemplate.Builder("End this trip?")
            .setHeader(Header.Builder().setStartHeaderAction(Action.BACK).setTitle("P Maps").build())
            .addAction(Action.Builder().setTitle("End trip").setBackgroundColor(CarColor.RED).setOnClickListener { onEnd() }.build())
            .addAction(Action.Builder().setTitle("Keep going").setOnClickListener { onKeep() }.build())
            .build()
}
