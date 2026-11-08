package org.promptly.sync.maps

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import org.maplibre.compose.camera.CameraPosition
import org.maplibre.compose.camera.rememberCameraState
import org.maplibre.compose.expressions.dsl.const
import org.maplibre.compose.layers.CircleLayer
import org.maplibre.compose.map.MapOptions
import org.maplibre.compose.map.MaplibreMap
import org.maplibre.compose.map.OrnamentOptions
import org.maplibre.compose.sources.GeoJsonData
import org.maplibre.compose.sources.rememberGeoJsonSource
import org.maplibre.compose.style.BaseStyle
import org.maplibre.compose.util.MaplibreComposable
import org.maplibre.spatialk.geojson.BoundingBox
import org.maplibre.spatialk.geojson.Position
import org.promptly.sync.R
import org.promptly.sync.maps.offline.Offline
import org.promptly.sync.maps.offline.OfflineAreasActivity
import java.io.IOException
import java.util.Locale

/** What the Drive screen was opened for: a place to show the way to, or words to search. */
data class DriveAsk(val place: Stop? = null, val query: String? = null) {
    companion object {
        /** From a P Maps web path ("/maps?to=lat,lon,name" or "/maps?q=words"), as another app's
         *  link hands it over, so it still works with no signal. */
        fun fromWebPath(path: String?): DriveAsk? {
            if (path == null || !path.startsWith("/maps")) return null
            val uri = Uri.parse("https://promptly.invalid$path")
            uri.getQueryParameter("to")?.split(",", limit = 3)?.let { parts ->
                val lat = parts.getOrNull(0)?.toDoubleOrNull()
                val lon = parts.getOrNull(1)?.toDoubleOrNull()
                if (lat != null && lon != null) return DriveAsk(place = Stop(lat, lon, parts.getOrNull(2)?.takeIf { it.isNotBlank() } ?: "Dropped pin"))
            }
            return uri.getQueryParameter("q")?.takeIf { it.isNotBlank() }?.let { DriveAsk(query = it) }
        }
    }
}

/**
 * P Maps' own map on the phone, with no trip yet ("Drive"): where you are, Where to?,
 * your places, and Start. It's what opens with no signal, so everything here works
 * offline: search runs on your server when there's signal and on the phone when not,
 * routes come from the phone's offline areas, and your places are the copy kept on the
 * phone. Picking a place shows the ways there; Start hands over to the driving screen.
 */
@Composable
fun DriveHome(
    style: String,
    ask: DriveAsk?,
    problem: String?,
    onStart: (Stop, CarRoute, TripOptions) -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val accent = MaterialTheme.colorScheme.primary

    var here by remember { mutableStateOf<Location?>(null) }
    LaunchedEffect(Unit) {
        runCatching { Nav.locationProvider.lastLocation() }.getOrNull()?.let { here = it }
        Nav.locationProvider.locationUpdates(2_000L).collect { here = it }
    }
    var online by remember { mutableStateOf(Offline.online(context)) }
    LaunchedEffect(Unit) {
        while (true) {
            online = Offline.online(context)
            delay(3_000)
        }
    }
    val areas = remember(online) { downloadedAreas(context) }
    var mine by remember { mutableStateOf(MyPlaces.saved(context)) }
    var usual by remember { mutableStateOf(MyPlaces.usualRoutes(context)) }
    LaunchedEffect(online) {
        if (!online) return@LaunchedEffect
        MyPlaces.refresh(context)
        mine = MyPlaces.saved(context)
        usual = MyPlaces.usualRoutes(context)
        // "Save where I parked" from a dead spot, now there's signal.
        withContext(Dispatchers.IO) { runCatching { Parking.flush(context) } }
    }

    var query by rememberSaveable { mutableStateOf(ask?.query ?: "") }
    var searchOpen by remember { mutableStateOf(ask?.query != null) }
    var result by remember { mutableStateOf<PlaceSearch.Result?>(null) }
    var searching by remember { mutableStateOf(false) }
    LaunchedEffect(query) {
        val words = query.trim()
        if (words.length < 2) {
            result = null
            searching = false
            return@LaunchedEffect
        }
        delay(350)
        searching = true
        val near = here?.let { it.latitude to it.longitude }
        result = runCatching { PlaceSearch.find(context, words, near) }.getOrNull()
        searching = false
    }

    var picked by remember { mutableStateOf(ask?.place) }
    var routes by remember { mutableStateOf<List<CarRoute>?>(null) }
    var selected by remember { mutableIntStateOf(0) }
    var planProblem by remember { mutableStateOf<String?>(null) }
    val options = remember { Nav.driveOptions() }
    // Asked again while open (another app's map link): that place, or those words.
    LaunchedEffect(ask) {
        ask?.place?.let {
            searchOpen = false
            picked = it
        }
        ask?.query?.let {
            query = it
            searchOpen = true
        }
    }
    LaunchedEffect(picked) {
        val stop = picked ?: return@LaunchedEffect
        routes = null
        planProblem = null
        selected = 0
        val from = here ?: withTimeoutOrNull(15_000) { Nav.locationProvider.locationUpdates(1_000L).first() }
        if (from == null) {
            planProblem = "Waiting for GPS. Try again outside."
            return@LaunchedEffect
        }
        try {
            routes = Routing.plan(context, from, stop, options).ifEmpty { throw IOException("No routes") }
        } catch (e: CancellationException) {
            throw e
        } catch (e: OfflineRouteUnavailable) {
            planProblem = if (e.outside) "No signal, and this trip goes outside your offline areas." else "No signal, and there's no way there within your offline areas."
        } catch (e: Exception) {
            planProblem = if (e.message?.contains("422") == true) "No route from here to there." else "Couldn't get a route. Check your connection."
        }
    }

    // The map: where you are first (Home until there's a fix), then the ways to where you picked.
    val start = remember { mine.firstOrNull { it.kind == "home" } }
    val camera = rememberCameraState(
        if (start != null) CameraPosition(target = Position(start.lon, start.lat), zoom = 12.0) else CameraPosition(target = Position(134.0, -27.0), zoom = 3.4),
    )
    var centred by remember { mutableStateOf(false) }
    LaunchedEffect(here) {
        val h = here ?: return@LaunchedEffect
        if (centred || picked != null) return@LaunchedEffect
        // Not before the map is there to move, or the move is lost.
        camera.awaitProjection()
        runCatching { camera.animateTo(CameraPosition(target = Position(h.longitude, h.latitude), zoom = 14.0)) }
            .onSuccess { centred = true }
    }
    LaunchedEffect(routes, selected, picked) {
        val stop = picked ?: return@LaunchedEffect
        camera.awaitProjection()
        val points = routes?.getOrNull(selected)?.line?.takeIf { it.size > 1 }
            ?: listOfNotNull(stop.lon to stop.lat, here?.let { it.longitude to it.latitude })
        if (points.size == 1) {
            runCatching { camera.animateTo(CameraPosition(target = Position(stop.lon, stop.lat), zoom = 14.0)) }
            return@LaunchedEffect
        }
        runCatching {
            camera.animateTo(
                boundingBox = BoundingBox(points.minOf { it.first }, points.minOf { it.second }, points.maxOf { it.first }, points.maxOf { it.second }),
                padding = PaddingValues(start = 48.dp, end = 48.dp, top = 140.dp, bottom = 430.dp),
            )
        }
    }

    BackHandler(enabled = picked != null || searchOpen) {
        if (searchOpen) {
            searchOpen = false
            query = ""
            focus.clearFocus()
        } else {
            picked = null
            routes = null
        }
    }

    fun pick(stop: Stop) {
        searchOpen = false
        focus.clearFocus()
        picked = stop
        scope.launch { MyPlaces.picked(context, stop) }
    }

    Box(Modifier.fillMaxSize()) {
        MaplibreMap(
            modifier = Modifier.fillMaxSize().semantics { contentDescription = "Map" },
            baseStyle = BaseStyle.Uri(style),
            cameraState = camera,
            options = MapOptions(ornamentOptions = OrnamentOptions.OnlyLogo),
        ) {
            RoutesOnMap(routes.orEmpty(), selected, accent)
            Spot("promptly-picked", picked?.let { it.lat to it.lon }, accent, 9)
            Spot("promptly-here", here?.let { it.latitude to it.longitude }, Color(0xFF1A73E8), 7)
        }

        // While searching, the results fill the space above the keyboard.
        val fill = if (searchOpen) Modifier.fillMaxSize().imePadding() else Modifier.fillMaxWidth()
        Column(fill.statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SearchBar(
                query = query,
                onQuery = {
                    query = it
                    searchOpen = true
                },
                onFocus = { if (it) searchOpen = true },
                onClear = {
                    query = ""
                    searchOpen = false
                    focus.clearFocus()
                },
                open = searchOpen,
                online = online,
                onClose = onClose,
                start = ask?.query != null,
            )
            if (searchOpen) {
                Results(query, result, searching, here, onPick = ::pick, modifier = Modifier.weight(1f, fill = false))
            } else if (picked == null) {
                Shortcuts(mine, usual, onPick = ::pick)
                Status(online, areas)
                problem?.let { Note(it) }
            }
        }

        picked?.let { stop ->
            if (!searchOpen) {
                RouteSheet(
                    stop = stop,
                    routes = routes,
                    selected = selected,
                    problem = planProblem,
                    options = options,
                    onSelect = { selected = it },
                    onStart = { routes?.getOrNull(selected)?.let { onStart(stop, it, options) } },
                    onBack = {
                        picked = null
                        routes = null
                    },
                    modifier = Modifier.align(Alignment.BottomCenter),
                )
            }
        }
    }
}

// ---- The parts -----------------------------------------------------------------------

@Composable
private fun SearchBar(
    query: String,
    onQuery: (String) -> Unit,
    onFocus: (Boolean) -> Unit,
    onClear: () -> Unit,
    open: Boolean,
    online: Boolean,
    onClose: () -> Unit,
    start: Boolean,
) {
    val context = LocalContext.current
    val focusRequester = remember { FocusRequester() }
    var menu by remember { mutableStateOf(false) }
    LaunchedEffect(start) { if (start) runCatching { focusRequester.requestFocus() } }
    Surface(shape = RoundedCornerShape(28.dp), shadowElevation = 4.dp, tonalElevation = 2.dp, modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextField(
                value = query,
                onValueChange = onQuery,
                placeholder = { Text("Where to?") },
                leadingIcon = { Icon(painterResource(R.drawable.ic_map_search), contentDescription = null, modifier = Modifier.size(22.dp)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { onQuery(query) }),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent,
                    unfocusedContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                ),
                modifier = Modifier.weight(1f).focusRequester(focusRequester).onFocusChanged { onFocus(it.isFocused) }
                    .semantics { contentDescription = "Where to? Search for a place or address" },
            )
            if (open || query.isNotEmpty()) {
                TextButton(onClick = onClear) { Text(if (query.isEmpty()) "Cancel" else "Clear") }
            }
            Box {
                IconButton(onClick = { menu = true }, modifier = Modifier.semantics { contentDescription = "More" }) {
                    Text("⋮", fontSize = 22.sp, fontWeight = FontWeight.Bold)
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("Offline areas") }, onClick = {
                        menu = false
                        context.startActivity(Intent(context, OfflineAreasActivity::class.java))
                    })
                    if (online) {
                        DropdownMenuItem(text = { Text("Open P Maps on the web") }, onClick = {
                            menu = false
                            openWebMaps(context)
                        })
                    }
                    DropdownMenuItem(text = { Text("Close") }, onClick = {
                        menu = false
                        onClose()
                    })
                }
            }
        }
    }
}

@Composable
private fun Results(query: String, result: PlaceSearch.Result?, searching: Boolean, here: Location?, onPick: (Stop) -> Unit, modifier: Modifier) {
    Surface(shape = RoundedCornerShape(20.dp), shadowElevation = 4.dp, modifier = modifier.fillMaxWidth()) {
        Column {
            if (searching) LinearProgressIndicator(Modifier.fillMaxWidth())
            val r = result
            when {
                query.trim().length < 2 -> Hint("Search for a place, an address like \"12 Smith St\", or \"fuel\".")
                r == null && !searching -> Hint("Couldn't search just now.")
                r == null -> Hint("Searching…")
                r.stops.isEmpty() -> Hint(r.empty)
                else -> {
                    r.from?.let { from ->
                        Text(
                            from,
                            style = MaterialTheme.typography.labelLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp).semantics { liveRegion = LiveRegionMode.Polite },
                        )
                    }
                    LazyColumn {
                        items(r.stops) { stop ->
                            PlaceRow(stop, here, onPick)
                            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Hint(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(16.dp).semantics { liveRegion = LiveRegionMode.Polite },
    )
}

@Composable
private fun PlaceRow(stop: Stop, here: Location?, onPick: (Stop) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button) { onPick(stop) }.padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(iconOf(stop)), contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(stop.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val line = listOfNotNull(here?.let { distanceText(it, stop) }, stop.address?.takeIf { it.isNotBlank() }).joinToString(" · ")
            if (line.isNotEmpty()) {
                Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** Home, Work, then your favourites, where you parked, usual routes and recents. */
@Composable
private fun Shortcuts(mine: List<Stop>, usual: List<UsualRoute>, onPick: (Stop) -> Unit) {
    val home = mine.firstOrNull { it.kind == "home" }
    val work = mine.firstOrNull { it.kind == "work" }
    val rest = (
        mine.filter { it.kind == "favourite" || it.kind == "list" || it.kind == "parked" } +
            usual.map { it.to.copy(name = it.name ?: it.to.name) } +
            mine.filter { it.kind == "recent" }
        ).distinctBy { "%.4f,%.4f".format(Locale.ROOT, it.lat, it.lon) }
    val chips = listOfNotNull(home, work) + rest.filter { r -> listOfNotNull(home, work).none { it.lat == r.lat && it.lon == r.lon } }.take(10)
    if (chips.isEmpty()) return
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        chips.forEach { stop ->
            val label = when (stop.kind) {
                "home" -> "Home"
                "work" -> "Work"
                else -> stop.name
            }
            AssistChip(
                onClick = { onPick(stop) },
                label = { Text(label.take(28), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                leadingIcon = { Icon(painterResource(iconOf(stop)), contentDescription = null, modifier = Modifier.size(AssistChipDefaults.IconSize)) },
                colors = AssistChipDefaults.assistChipColors(containerColor = MaterialTheme.colorScheme.surface),
                elevation = AssistChipDefaults.assistChipElevation(elevation = 2.dp),
            )
        }
    }
}

@Composable
private fun Status(online: Boolean, areas: List<String>) {
    if (online) return
    val text = if (areas.isEmpty()) "No signal · no offline areas on this phone" else "No signal · using your offline areas"
    Text(
        text,
        color = Color.White,
        fontSize = 13.sp,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(Color(0xFF5F6368)).padding(horizontal = 12.dp, vertical = 6.dp).semantics { liveRegion = LiveRegionMode.Polite },
    )
}

@Composable
private fun Note(text: String) {
    Surface(shape = RoundedCornerShape(14.dp), color = Color(0xFF3A3A3A), shadowElevation = 3.dp) {
        Text(text, color = Color.White, fontSize = 15.sp, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp).semantics { liveRegion = LiveRegionMode.Polite })
    }
}

@Composable
private fun RouteSheet(
    stop: Stop,
    routes: List<CarRoute>?,
    selected: Int,
    problem: String?,
    options: TripOptions,
    onSelect: (Int) -> Unit,
    onStart: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier,
) {
    Surface(shape = RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp), shadowElevation = 8.dp, tonalElevation = 2.dp, modifier = modifier.fillMaxWidth()) {
        Column(Modifier.navigationBarsPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stop.name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
            stop.address?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            when {
                problem != null -> Text(problem, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                routes == null -> Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text("Finding routes…", style = MaterialTheme.typography.bodyLarge)
                }
                else -> {
                    val fastest = routes.minOf { it.seconds }
                    val avoid = CarTemplates.avoiding(options)
                    Column {
                        routes.forEachIndexed { i, route ->
                            Row(
                                Modifier.fillMaxWidth().selectable(selected = i == selected, role = Role.RadioButton) { onSelect(i) }.padding(vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(selected = i == selected, onClick = null)
                                Spacer(Modifier.width(10.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(duration(route.seconds), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                    val details = listOfNotNull(String.format(Locale.ENGLISH, "%.1f km", route.km), route.via?.let { "via $it" }).joinToString(" · ")
                                    Text(details, style = MaterialTheme.typography.bodyMedium)
                                    val notes = listOfNotNull(
                                        if (route.seconds > fastest + 60) "${Math.round((route.seconds - fastest) / 60.0)} min longer" else null,
                                        if (route.addsMinutes >= 1) "${route.addsMinutes} min of traffic" else null,
                                        avoid,
                                        if (route.offline) "offline route, no traffic info" else null,
                                    ).joinToString(" · ")
                                    if (notes.isNotEmpty()) Text(notes, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = onStart, enabled = !routes.isNullOrEmpty() && problem == null) { Text("Start") }
                OutlinedButton(onClick = onBack) { Text("Back") }
            }
        }
    }
}

/** A dot on the map: you, or the place you picked. */
@Composable
@MaplibreComposable
private fun Spot(id: String, at: Pair<Double, Double>?, colour: Color, radius: Int) {
    val json = remember(at) {
        val features = JSONArray()
        at?.let { (lat, lon) ->
            features.put(
                JSONObject().put("type", "Feature").put("properties", JSONObject())
                    .put("geometry", JSONObject().put("type", "Point").put("coordinates", JSONArray().put(lon).put(lat))),
            )
        }
        JSONObject().put("type", "FeatureCollection").put("features", features).toString()
    }
    val source = rememberGeoJsonSource(GeoJsonData.JsonString(json))
    CircleLayer(id = id, source = source, radius = const(radius.dp), color = const(colour), strokeColor = const(Color.White), strokeWidth = const(2.5.dp))
}

private fun iconOf(stop: Stop): Int = when (stop.kind) {
    "home" -> R.drawable.ic_map_home
    "work" -> R.drawable.ic_map_work
    "favourite", "list" -> R.drawable.ic_map_star
    "recent", "usual" -> R.drawable.ic_map_recent
    "parked" -> R.drawable.ic_map_car
    else -> R.drawable.ic_map_place
}

private fun distanceText(here: Location, stop: Stop): String {
    val metres = FloatArray(1)
    Location.distanceBetween(here.latitude, here.longitude, stop.lat, stop.lon, metres)
    return if (metres[0] < 1000) "${metres[0].toInt()} m" else String.format(Locale.ENGLISH, "%.1f km", metres[0] / 1000)
}

/** "22 min", "1 h 5 min". */
internal fun duration(seconds: Int): String {
    val minutes = Math.round(seconds / 60.0).toInt().coerceAtLeast(1)
    return if (minutes < 60) "$minutes min" else "${minutes / 60} h" + (minutes % 60).let { if (it > 0) " $it min" else "" }
}

/** The names of the offline areas this phone has downloaded. */
private fun downloadedAreas(context: Context): List<String> {
    val store = Offline.store(context)
    return Offline.saved(context)?.areas.orEmpty().filter { it.id !in store.state.deleted && store.has(it.cells, false) }.map { it.name }
}

/** P Maps on the web: its own launcher if it's on the home screen, else Promptly's. Told
 *  not to send you back here (it opens this screen with no connection). */
fun openWebMaps(context: Context, path: String = "/maps") {
    val maps = ComponentName(context.packageName, "org.promptly.app.MapsLauncher")
    val promptly = ComponentName(context.packageName, "org.promptly.app.PromptlyLauncher")
    val pm = context.packageManager
    fun enabled(c: ComponentName) = when (pm.getComponentEnabledSetting(c)) {
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
        PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> runCatching { pm.getActivityInfo(c, 0).enabled }.getOrDefault(false)
        else -> false
    }
    val target = if (enabled(maps)) maps else promptly
    runCatching {
        context.startActivity(
            Intent().setComponent(target)
                .putExtra(MapLinkActivity.EXTRA_PATH, path)
                .putExtra(EXTRA_ONLINE, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}

/** Read by the P Maps launcher (SuiteLauncher): open the web app even if the phone
 *  thinks there's no connection. */
const val EXTRA_ONLINE = "org.promptly.app.ONLINE"
