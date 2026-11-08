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
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.car.app.navigation.model.MapWithContentTemplate
import androidx.car.app.navigation.model.MessageInfo
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.car.app.navigation.model.RoutingInfo
import androidx.car.app.navigation.model.Step
import androidx.car.app.versioning.CarAppApiLevels
import com.stadiamaps.ferrostar.car.app.template.models.toCarDistance
import com.stadiamaps.ferrostar.car.app.template.models.toCarLane
import com.stadiamaps.ferrostar.car.app.template.models.toCarManeuver
import uniffi.ferrostar.DrivingSide
import uniffi.ferrostar.VisualInstruction
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
import org.promptly.sync.maps.offline.Offline
import com.stadiamaps.ferrostar.core.location.toUserLocation
import uniffi.ferrostar.GeographicCoordinate
import uniffi.ferrostar.RouteRequest
import uniffi.ferrostar.Waypoint
import uniffi.ferrostar.WaypointKind
import uniffi.ferrostar.createValhallaRequestGenerator
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
    /** Worked out on the phone (no signal): no traffic in it. */
    val offline: Boolean = false,
)

/** Where you're thinking of going: still looking, or the ways there. */
data class CarTripPlan(val stop: Stop, val routes: List<CarRoute>? = null, val selected: Int = 0, val options: TripOptions = TripOptions()) {
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

    /** The ways to [stop], avoiding what your last drive on the phone avoided, unless
     *  whoever sent you here (another app's "navigate to") said otherwise. */
    fun show(context: Context, stop: Stop, options: TripOptions = Nav.driveOptions()) {
        asking?.cancel()
        _plan.value = CarTripPlan(stop, options = options)
        asking = scope.launch {
            try {
                val here = freshLocation() ?: throw NoFix()
                val routes = routesTo(context, here, stop, options)
                if (routes.isEmpty()) throw IOException("none")
                _plan.value = CarTripPlan(stop, routes, options = options)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: NoFix) {
                giveUp("Waiting for GPS. Try again in a moment.")
            } catch (e: OfflineRouteUnavailable) {
                Log.w(TAG, "No route offline", e)
                giveUp(
                    if (e.outside) "No signal, and this trip goes outside your offline areas."
                    else "No signal, and there's no way there within your offline areas.",
                )
            } catch (e: Exception) {
                Log.w(TAG, "Couldn't get a route", e)
                giveUp(if (e.message?.contains("422") == true) "No route from here to there." else "Couldn't get a route. Check your connection.")
            }
        }
    }

    /** "Navigate to <words>" from another app: the nearest match, then its routes. */
    fun showQuery(context: Context, words: String, options: TripOptions = Nav.driveOptions()) {
        asking?.cancel()
        asking = scope.launch {
            try {
                val here = runCatching { Nav.locationProvider.lastLocation() }.getOrNull()
                val found = Maps.search(context, words, here?.let { it.latitude to it.longitude }).firstOrNull()
                if (found == null) giveUp("Couldn't find $words.") else show(context, found, options)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Couldn't look that up", e)
                giveUp("Couldn't reach your server.")
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
        // Not driving: the offline engine's memory back until it's needed again.
        if (!Nav.onTrip()) runCatching { Offline.router(appContext ?: return).release() }
    }

    private var appContext: Context? = null

    /** Off the route screen and on the road, the way you picked. */
    fun go() {
        val plan = _plan.value ?: return
        val route = plan.route ?: return
        Nav.start(listOf(plan.stop), plan.options, route.through)
        clear()
    }

    private suspend fun freshLocation(): Location? =
        withTimeoutOrNull(12_000) { Nav.locationProvider.locationUpdates(1000L).first { System.currentTimeMillis() - it.time < 60_000 } }
            ?: withTimeoutOrNull(8_000) { Nav.locationProvider.locationUpdates(1000L).first() }

    /** The ways there: your server's (with traffic), or with no signal the phone's own,
     *  from the downloaded squares (up to three, no traffic). */
    private suspend fun routesTo(context: Context, here: Location, stop: Stop, options: TripOptions): List<CarRoute> = withContext(Dispatchers.IO) {
        appContext = context.applicationContext
        val stops = JSONArray()
            .put(JSONObject().put("lat", here.latitude).put("lon", here.longitude).put("name", "Your location"))
            .put(JSONObject().put("lat", stop.lat).put("lon", stop.lon).put("name", stop.name))
        val body = JSONObject().put("stops", stops).put("mode", "drive")
            .put("avoid_tolls", options.tolls).put("avoid_highways", options.highways).put("avoid_ferries", options.ferries)
        val problem = if (!Offline.online(context)) IOException("No connection") else try {
            return@withContext parseRoutes(Maps.send(context, "POST", "/api/maps/route", body, PREVIEW_TIMEOUT_SECONDS))
        } catch (e: IOException) {
            // "Server said 422" is an answer (no route), not a missing server.
            if (e.message?.startsWith("Server said 4") == true && e.message?.startsWith("Server said 401") != true) throw e
            e
        }
        Log.i(TAG, "Route preview from the phone: ${problem.message}")
        phoneRoutes(context, here, stop, options)
    }

    /** How long the preview waits for your server before the phone answers. */
    private const val PREVIEW_TIMEOUT_SECONDS = 10L

    /** Up to three ways there from Valhalla on the phone, asked the same way as the server. */
    private fun phoneRoutes(context: Context, here: Location, stop: Stop, options: TripOptions): List<CarRoute> {
        val ask = ServerRoutes.requestOptions(options).put("alternates", 2)
        val generator = createValhallaRequestGenerator("https://promptly.invalid/route", ServerRoutes.profileOf(options), ask.toString())
        val request = generator.generateRequest(here.toUserLocation(), listOf(Waypoint(coordinate = GeographicCoordinate(stop.lat, stop.lon), kind = WaypointKind.BREAK)))
            as? RouteRequest.HttpPost ?: throw IOException("Unexpected route request")
        val cells = HybridRouting.cellsOf(listOf(here.latitude to here.longitude, stop.lat to stop.lon))
        val answer = try {
            Offline.router(context).route(String(request.body), cells)
        } catch (e: org.promptly.sync.maps.offline.LocalRouter.MissingSquares) {
            throw OfflineRouteUnavailable(true, e.cells, e)
        } catch (e: org.promptly.sync.maps.offline.LocalRouter.NoRoute) {
            throw OfflineRouteUnavailable(false, emptyList(), e)
        }
        return parsePhoneRoutes(JSONObject(answer))
    }

    /** Valhalla's OSRM-style answer (with alternates) as the car's route rows. The first
     *  is the one the phone would pick anyway; the others carry a few points along
     *  them, so starting the trip follows the one you chose. */
    internal fun parsePhoneRoutes(body: JSONObject): List<CarRoute> {
        val rows = body.optJSONArray("routes") ?: return emptyList()
        return List(rows.length()) { i ->
            val r = rows.getJSONObject(i)
            val legs = r.optJSONArray("legs") ?: JSONArray()
            val via = (0 until legs.length()).mapNotNull { legs.getJSONObject(it).optString("summary").takeIf { s -> s.isNotBlank() } }
                .firstOrNull()?.split(",")?.first()?.trim()
            val line = decodeShape(r.optString("geometry"))
            CarRoute(
                seconds = r.optDouble("duration", 0.0).toInt(),
                km = r.optDouble("distance", 0.0) / 1000.0,
                via = via,
                addsMinutes = 0,
                line = line,
                through = if (i == 0) emptyList() else throughPoints(line),
                offline = true,
            )
        }
    }

    /** A few points along a route ((lon, lat) line), with the way you're going at each,
     *  so a new request lands on the same road in the same direction. */
    internal fun throughPoints(line: List<Pair<Double, Double>>): List<ThroughPoint> {
        if (line.size < 3) return emptyList()
        val along = DoubleArray(line.size)
        for (i in 1 until line.size) {
            along[i] = along[i - 1] + org.promptly.sync.maps.offline.TripCache.distance(line[i - 1].second, line[i - 1].first, line[i].second, line[i].first)
        }
        val total = along.last()
        if (total < 1000) return emptyList()
        return listOf(0.25, 0.5, 0.75).map { f ->
            // The point that far along, on its stretch of road, and that stretch's direction.
            val want = total * f
            val i = along.indexOfFirst { it >= want }.coerceIn(1, line.size - 1)
            val (aLon, aLat) = line[i - 1]
            val (bLon, bLat) = line[i]
            val part = if (along[i] > along[i - 1]) (want - along[i - 1]) / (along[i] - along[i - 1]) else 0.0
            val x = (bLon - aLon) * Math.cos(Math.toRadians(aLat))
            val heading = ((Math.toDegrees(Math.atan2(x, bLat - aLat)) + 360) % 360).toInt()
            ThroughPoint(aLat + (bLat - aLat) * part, aLon + (bLon - aLon) * part, heading)
        }
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

    /** "no tolls", so a route avoiding them doesn't look like a mistake. */
    fun avoiding(options: TripOptions): String? = listOfNotNull(
        if (options.tolls) "no tolls" else null,
        if (options.highways) "no highways" else null,
        if (options.ferries) "no ferries" else null,
    ).joinToString(", ").ifEmpty { null }

    /** "22 min", which the car writes in its own way, and how that compares. */
    private fun routeRow(route: CarRoute, fastest: Int, avoid: String?): Row {
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
            avoid,
            if (route.offline) "offline route" else null,
        ).joinToString(" · ")
        if (notes.isNotEmpty()) row.addText(notes)
        return row.build()
    }

    private fun goAction(onGo: () -> Unit): Action =
        Action.Builder().setTitle("Go").setFlags(Action.FLAG_PRIMARY).setBackgroundColor(CarColor.BLUE).setOnClickListener { onGo() }.build()

    /** The route on the map, how long it takes, and one big Go. Cars on car API 7 or
     *  later get the map-with-a-list template that replaced the route preview one
     *  (deprecated in car-app 1.7); older cars keep the one they know. */
    fun preview(plan: CarTripPlan, limit: Int, onSelect: (Int) -> Unit, onGo: () -> Unit, onBack: Action = Action.BACK, carApi: Int = CarAppApiLevels.LEVEL_7): Template {
        val header = Header.Builder().setStartHeaderAction(onBack).setTitle(plan.stop.name).build()
        val routes = plan.routes?.take(limit.coerceAtLeast(1))
        val list = routes?.takeIf { it.isNotEmpty() }?.let { found ->
            val items = ItemList.Builder().setOnSelectedListener { onSelect(it) }.setSelectedIndex(plan.selected.coerceIn(0, found.lastIndex))
            val fastest = found.minOf { it.seconds }
            val avoid = avoiding(plan.options)
            found.forEach { items.addItem(routeRow(it, fastest, avoid)) }
            items.build()
        }
        if (carApi >= CarAppApiLevels.LEVEL_7) {
            // The list's own buttons can only be icons, so Go sits in the action strip.
            val content = ListTemplate.Builder().setHeader(header)
            val template = MapWithContentTemplate.Builder()
            if (list == null) content.setLoading(true) else {
                content.setSingleList(list)
                template.setActionStrip(ActionStrip.Builder().addAction(goAction(onGo)).build())
            }
            return template.setContentTemplate(content.build()).build()
        }
        @Suppress("DEPRECATION")
        val builder = androidx.car.app.navigation.model.RoutePreviewNavigationTemplate.Builder().setHeader(header)
        if (list == null) return builder.setLoading(true).build()
        return builder.setItemList(list).setNavigateAction(goAction(onGo)).build()
    }

    /** The card at the top while driving: the next turn, its lanes, and how far.
     *  While a new route is being worked out after a wrong turn, the car's own
     *  "loading" card, so it's clear something is happening. */
    fun routingInfo(context: Context, instruction: VisualInstruction?, metresToTurn: Double?, side: DrivingSide, exit: Int?, rerouting: Boolean): RoutingInfo? {
        if (rerouting) return RoutingInfo.Builder().setLoading(true).build()
        if (instruction == null || metresToTurn == null) return null
        val primary = instruction.primaryContent
        val step = Step.Builder(primary.text).setManeuver(primary.toCarManeuver(context, side, exit))
        instruction.secondaryContent?.text?.takeIf { it.isNotBlank() }?.let { step.setRoad(it) }
        // The server's router sends lanes with the instruction under the turn, not on it.
        val lanes = instruction.subContent?.laneInfo?.takeIf { it.isNotEmpty() } ?: primary.laneInfo?.takeIf { it.isNotEmpty() }
        if (lanes != null) {
            lanes.forEach { step.addLane(it.toCarLane()) }
            // The car only shows lanes it's given a picture of.
            step.setLanesImage(CarIcon.Builder(IconCompat.createWithBitmap(LaneImage.draw(lanes, side))).build())
        }
        return RoutingInfo.Builder().setCurrentStep(step.build(), metresToTurn.toCarDistance()).build()
    }

    /** "You've arrived", on the map, with what's next. */
    fun arrival(context: Context, at: String?, onPark: () -> Unit, onDone: () -> Unit): Template {
        val message = MessageInfo.Builder("You've arrived")
            .setImage(icon(context, R.drawable.ic_map_place, tint = true))
        at?.let { message.setText(it) }
        val strip = ActionStrip.Builder()
            .addAction(Action.Builder().setTitle("Save parking").setIcon(icon(context, R.drawable.ic_map_car)).setOnClickListener { onPark() }.build())
            .addAction(Action.Builder().setTitle("Done").setFlags(Action.FLAG_PRIMARY).setOnClickListener { onDone() }.build())
        return NavigationTemplate.Builder()
            .setNavigationInfo(message.build())
            .setActionStrip(strip.build())
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
