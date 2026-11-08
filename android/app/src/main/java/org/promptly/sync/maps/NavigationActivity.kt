package org.promptly.sync.maps

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.lifecycleScope
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.stadiamaps.ferrostar.composeui.config.NavigationViewComponentBuilder
import com.stadiamaps.ferrostar.composeui.config.VisualNavigationViewConfig
import com.stadiamaps.ferrostar.composeui.config.withInstructionsView
import com.stadiamaps.ferrostar.composeui.config.withProgressView
import com.stadiamaps.ferrostar.composeui.config.withSpeedLimitStyle
import com.stadiamaps.ferrostar.composeui.runtime.KeepScreenOnDisposableEffect
import com.stadiamaps.ferrostar.composeui.views.components.InstructionsView
import com.stadiamaps.ferrostar.composeui.views.components.TripProgressView
import com.stadiamaps.ferrostar.composeui.views.components.speedlimit.SignageStyle
import com.stadiamaps.ferrostar.ui.formatters.DistanceMeasurementSystem
import com.stadiamaps.ferrostar.ui.formatters.LocalizedDistanceFormatter
import com.stadiamaps.ferrostar.core.measurement.MeasurementSpeedUnit
import com.stadiamaps.ferrostar.maplibreui.runtime.rememberNavigationMapState
import com.stadiamaps.ferrostar.maplibreui.views.DynamicallyOrientingNavigationView
import kotlinx.coroutines.launch
import org.maplibre.compose.style.BaseStyle
import org.promptly.sync.maps.offline.Offline

/** The driving screen: `promptlymaps://navigate?server=…&code=…&stops=…`.
 *  Native because voice with the screen off and steady GPS need an app, not a
 *  web page. Everything else in P Maps is the web app.
 *
 *  With no trip it's P Maps' own map, "Drive" ([DriveHome]): what the P Maps icon opens
 *  with no signal, the long-press Drive shortcut, and where a trip ends. */
class NavigationActivity : ComponentActivity() {
    private val request = mutableStateOf<Trip?>(null)
    private val driveAsk = mutableStateOf<DriveAsk?>(null)

    private data class Trip(val server: String?, val code: String?, val stops: List<Stop>, val options: TripOptions, val through: List<ThroughPoint>)

    private fun parse(uri: Uri?): Trip? {
        uri ?: return null
        val stops = (uri.getQueryParameter("stops") ?: "").split(";").mapNotNull { row ->
            val parts = row.split(",", limit = 3)
            val lat = parts.getOrNull(0)?.toDoubleOrNull()
            val lon = parts.getOrNull(1)?.toDoubleOrNull()
            if (lat == null || lon == null) null else Stop(lat, lon, parts.getOrNull(2) ?: "Destination")
        }
        if (stops.isEmpty()) return null
        return Trip(
            uri.getQueryParameter("server"),
            uri.getQueryParameter("code"),
            stops,
            TripOptions(
                uri.getQueryParameter("mode") ?: "drive",
                uri.getQueryParameter("tolls") == "1",
                uri.getQueryParameter("highways") == "1",
                uri.getQueryParameter("ferries") == "1",
            ),
            // The route you picked in the app.
            (uri.getQueryParameter("through") ?: "").split(";").mapNotNull { row ->
                val parts = row.split(",")
                val lat = parts.getOrNull(0)?.toDoubleOrNull()
                val lon = parts.getOrNull(1)?.toDoubleOrNull()
                if (lat == null || lon == null) null else ThroughPoint(lat, lon, parts.getOrNull(2)?.toDoubleOrNull()?.toInt())
            },
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Nav.init(this)
        // The map's tiles come from the phone first (squares, this week's trips).
        org.promptly.sync.maps.offline.MapTiles.install(this)
        enableEdgeToEdge()
        // Recreated (the phone switching to dark at sunset, or after Android closed it in the
        // background), the trip it was opened for is usually running in Nav already, or over:
        // starting it again would restart a trip mid-drive, or after arriving. Only one that
        // hadn't started yet is picked up again.
        if (savedInstanceState == null || savedInstanceState.getBoolean(PENDING)) {
            request.value = parse(intent?.data)
            driveAsk.value = DriveAsk.fromWebPath(intent?.getStringExtra(MapLinkActivity.EXTRA_PATH))
        }
        // Ended anywhere (here, the car's End, the assistant, arriving): back to the map
        // with Where to?, not a map with no trip on it.
        lifecycleScope.launch {
            Nav.ended.collect {
                request.value = null
                driveAsk.value = null
            }
        }
        setContent {
            val dark = isSystemInDarkTheme()
            MaterialTheme(colorScheme = if (dark) darkColorScheme(primary = Color(0xFFE08B6D), onPrimary = Color(0xFF3A1A0E)) else lightColorScheme(primary = Color(0xFFD97757), onPrimary = Color.White)) {
                Surface(Modifier.fillMaxSize()) {
                    val trip by request
                    val ask by driveAsk
                    Driving(trip, ask) { finish() }
                }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(PENDING, request.value != null && !Nav.onTrip() && !Nav.arrived.value)
    }

    private companion object {
        const val PENDING = "trip_pending"
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val trip = parse(intent.data)
        if (trip != null) {
            // The trip a recreated screen picks up again if it hadn't started.
            setIntent(intent)
            request.value = trip
        }
        else DriveAsk.fromWebPath(intent.getStringExtra(MapLinkActivity.EXTRA_PATH))?.let { if (!Nav.onTrip()) driveAsk.value = it }
    }

    @Composable
    private fun Driving(trip: Trip?, driveAsk: DriveAsk?, onDone: () -> Unit) {
        val context = LocalContext.current
        val scope = rememberCoroutineScope()
        var signedIn by remember { mutableStateOf(false) }
        var problem by remember { mutableStateOf<String?>(null) }
        var hasLocation by remember {
            mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED)
        }
        val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            hasLocation = it[Manifest.permission.ACCESS_FINE_LOCATION] == true
            if (!hasLocation) problem = "Directions need your location. Allow it in Settings, then try again."
        }
        LaunchedEffect(Unit) {
            if (!hasLocation) {
                val wanted = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
                if (Build.VERSION.SDK_INT >= 33) wanted += Manifest.permission.POST_NOTIFICATIONS
                ask.launch(wanted.toTypedArray())
            }
        }
        LaunchedEffect(trip) {
            runCatching { Maps.signIn(context, trip?.server, trip?.code) }
                .onSuccess {
                    signedIn = true
                    Nav.loadStyle(this)
                }
                .onFailure {
                    problem = if (trip == null && Maps.server(context) == null) {
                        "Sign in to P Maps on this phone first: start a trip from P Maps on the web once, or pair this phone in Promptly."
                    } else it.message ?: "Couldn't sign in."
                }
        }
        val style by Nav.style.collectAsState()
        val navError by Nav.error.collectAsState()
        LaunchedEffect(signedIn, hasLocation, trip, style) {
            if (signedIn && hasLocation && trip != null && style != null) Nav.start(trip.stops, trip.options, trip.through)
        }
        val message = problem ?: navError
        val styleUri = style
        if (message != null && (styleUri == null || !signedIn || !hasLocation)) {
            Centre {
                Text(message, modifier = Modifier.padding(24.dp))
                Button(onClick = onDone) { Text("Close") }
            }
            return
        }
        if (!signedIn || !hasLocation || styleUri == null) {
            Centre { CircularProgressIndicator() }
            return
        }
        val vm = remember(trip) { Nav.viewModel(trip?.options ?: Nav.driveOptions()) }
        val state by vm.navigationUiState.collectAsState()
        val arrived by Nav.arrived.collectAsState()
        // A trip that couldn't start (no route offline, say) goes back to Drive, saying why.
        var startProblem by remember { mutableStateOf<String?>(null) }
        LaunchedEffect(navError, trip) {
            if (trip != null && navError != null && !state.isNavigating()) {
                startProblem = navError
                request.value = null
            }
        }
        if (!state.isNavigating() && !arrived && trip == null) {
            DriveHome(
                style = styleUri,
                ask = driveAsk,
                problem = startProblem,
                onStart = { stop, route, options ->
                    startProblem = null
                    request.value = Trip(null, null, listOf(stop), options, route.through)
                },
                onClose = onDone,
            )
            return
        }
        KeepScreenOnDisposableEffect()
        val camera by Nav.camera.collectAsState()
        val trafficNow by Nav.traffic.collectAsState()
        val faster by Nav.faster.collectAsState()
        val hazard by Nav.hazard.collectAsState()
        val voice by Voice.state.collectAsState()
        val said by Voice.reply.collectAsState()
        val addedStop by Nav.addedStop.collectAsState()
        val noSignal by Nav.noSignal.collectAsState()
        val source by Nav.routeSource.collectAsState()
        val offRoute by Nav.offRoute.collectAsState()
        var addingStop by remember { mutableStateOf(false) }
        val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
            if (ok) Voice.press(applicationContext)
        }
        LaunchedEffect(said) {
            if (said != null) {
                kotlinx.coroutines.delay(8000)
                Voice.clearReply()
            }
        }
        // Cameras, warnings and arriving are Nav's: they work with this screen closed.
        val mapState = rememberNavigationMapState()
        Box(Modifier.fillMaxSize()) {
            DynamicallyOrientingNavigationView(
                modifier = Modifier.fillMaxSize(),
                baseStyle = BaseStyle.Uri(styleUri),
                navigationMapState = mapState,
                viewModel = vm,
                config = VisualNavigationViewConfig.Default().withSpeedLimitStyle(SignageStyle.ViennaConvention),
                views = metricViews,
                // Ending the trip goes back to Drive (Nav.ended).
                onTapExit = { Nav.stop() },
                mapContent = { TrafficOnRoute() },
            )
            // The road's limit in km/h, when the map has one (many Australian roads don't).
            val limit = state.currentAnnotation?.speedLimit?.value(MeasurementSpeedUnit.KilometersPerHour)
            val kmh = state.location?.speed?.value?.let { (it * 3.6).toInt() }
            Column(
                // Under the speed limit sign, clear of your position on the map.
                Modifier.align(Alignment.TopStart).safeDrawingPadding().padding(start = 12.dp, top = 185.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                hazard?.let { h ->
                    val distance = if (h.metres >= 1000) "${Math.round(h.metres / 100f) / 10f} km" else "${h.metres} m"
                    val adds = if (h.hazard.delayMinutes >= 1) ", +${h.hazard.delayMinutes} min" else ""
                    Pill("${h.hazard.label} $distance$adds", Color(0xFFB3261E), Color.White)
                }
                if (noSignal) {
                    // Traffic, warnings and faster routes wait for signal; nothing's queued.
                    Pill("No signal · no traffic info", MaterialTheme.colorScheme.surface, MaterialTheme.colorScheme.onSurface)
                } else trafficNow?.let { t ->
                    val text = if (t.addsMinutes >= 1) "Traffic adds ${t.addsMinutes} min" else "No traffic delays"
                    Pill(text, if (t.addsMinutes >= 5) Color(0xFFB45309) else MaterialTheme.colorScheme.surface, if (t.addsMinutes >= 5) Color.White else MaterialTheme.colorScheme.onSurface)
                }
                if (source == RouteSource.PHONE) {
                    SmallPill("Offline route")
                }
                // No signal and no downloaded map under you: the route still draws, on a plain map.
                val at = state.location
                if (noSignal && at != null && !org.promptly.sync.maps.offline.MapTiles.coversOffline(at.coordinates.lat, at.coordinates.lng)) {
                    SmallPill("No offline map here")
                }
                (camera as? CameraAlert.Ahead)?.let { c ->
                    Pill("Speed camera ${c.metres} m", Color(0xFFB3261E), Color.White)
                }
                Pill(
                    "Add stop",
                    MaterialTheme.colorScheme.primary,
                    MaterialTheme.colorScheme.onPrimary,
                    Modifier.clickable { addingStop = true },
                )
                addedStop?.let { stop ->
                    Pill("Remove ${stop.name.take(18)}", MaterialTheme.colorScheme.surface, MaterialTheme.colorScheme.onSurface, Modifier.clickable { Nav.removeStop() })
                }
                Pill(
                    when {
                        voice == Voice.State.HEARD -> "Listening…"
                        voice == Voice.State.THINKING -> "Thinking…"
                        else -> "Ask Promptly"
                    },
                    if (voice == Voice.State.HEARD || voice == Voice.State.THINKING) Color(0xFFD97757) else MaterialTheme.colorScheme.surface,
                    if (voice == Voice.State.HEARD || voice == Voice.State.THINKING) Color.White else MaterialTheme.colorScheme.onSurface,
                    Modifier.clickable {
                        // With no signal it answers straight away (it needs your server), so no mic.
                        if (!Voice.allowed(context) && org.promptly.sync.maps.offline.Offline.online(context)) askMic.launch(Manifest.permission.RECORD_AUDIO)
                        else Voice.press(context)
                    },
                )
                if (kmh != null) {
                    val over = limit != null && kmh > limit + 2
                    Pill("$kmh km/h", if (over) Color(0xFFB3261E) else MaterialTheme.colorScheme.surface, if (over) Color.White else MaterialTheme.colorScheme.onSurface)
                }
            }
            when {
                // Started from Drive or the web, while the route is worked out.
                trip != null && !state.isNavigating() && !arrived && message == null ->
                    Pill(
                        "Finding your route…",
                        Color(0xFF3A3A3A),
                        Color.White,
                        Modifier.align(Alignment.TopCenter).safeDrawingPadding().padding(top = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
                    )
                message != null ->
                    Pill(message, Color(0xFF3A3A3A), Color.White, Modifier.align(Alignment.TopCenter).safeDrawingPadding().padding(top = 8.dp))
                // Off the route where the phone has no map data to find a new one with.
                offRoute != null ->
                    Pill(
                        offRoute!!,
                        Color(0xFF3A3A3A),
                        Color.White,
                        Modifier.align(Alignment.TopCenter).safeDrawingPadding().padding(top = 8.dp, start = 24.dp, end = 24.dp).semantics { liveRegion = LiveRegionMode.Polite },
                    )
                // After a wrong turn, while the new way is worked out.
                state.isCalculatingNewRoute == true ->
                    Pill(
                        "Finding a new route…",
                        Color(0xFF3A3A3A),
                        Color.White,
                        Modifier.align(Alignment.TopCenter).safeDrawingPadding().padding(top = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
                    )
            }
            said?.let {
                Pill(it, Color(0xFF3A3A3A), Color.White, Modifier.align(Alignment.Center).padding(horizontal = 24.dp))
            }
            if (addingStop) {
                AddStopSheet { addingStop = false }
            }
            faster?.let { offer ->
                LaunchedEffect(offer.savesMinutes) {
                    kotlinx.coroutines.delay(30_000)
                    Nav.declineFaster()
                }
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    tonalElevation = 6.dp,
                    shadowElevation = 6.dp,
                    // Clear of the road ahead, and of your position on the map.
                    modifier = Modifier.align(Alignment.BottomCenter).safeDrawingPadding().padding(start = 24.dp, end = 24.dp, bottom = 92.dp),
                ) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(offer.reason ?: "Faster route saves ${offer.savesMinutes} min", fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
                        offer.viaName?.let { Text("Via $it", fontSize = 14.sp) }
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Button(onClick = { Nav.takeFaster() }) { Text(if (offer.reason != null) "Go around" else "Take it") }
                            OutlinedButton(onClick = { Nav.declineFaster() }) { Text("No thanks") }
                        }
                    }
                }
            }
            if (arrived) {
                Arrival(
                    at = Nav.arrivedAt,
                    onPark = {
                        scope.launch {
                            val saved = Nav.parkHere()
                            Toast.makeText(context, Parking.said(saved), if (saved == Parking.Saved.LATER) Toast.LENGTH_LONG else Toast.LENGTH_SHORT).show()
                            Nav.finishArrival()
                        }
                    },
                    onDone = { Nav.finishArrival() },
                )
            }
        }
    }
}

/** Kilometres, whatever the phone's language says. */
private val metricViews = NavigationViewComponentBuilder.Default()
    .withInstructionsView { modifier, uiState ->
        uiState.visualInstruction?.let {
            InstructionsView(
                modifier = modifier,
                instructions = it,
                remainingSteps = uiState.remainingSteps,
                distanceToNextManeuver = uiState.progress?.distanceToNextManeuver,
                distanceFormatter = KILOMETRES,
            )
        }
    }
    .withProgressView { modifier, uiState, onTapExit ->
        uiState.progress?.let { progress ->
            // With traffic, this bar shows the same arrival time as everything else.
            val traffic by Nav.traffic.collectAsState()
            val left = traffic?.let { java.time.Duration.between(java.time.Instant.now(), it.arriveAt).seconds.toDouble() }
            val shown = if (left != null && left > 0) progress.copy(durationRemaining = left) else progress
            TripProgressView(modifier = modifier, progress = shown, onTapExit = onTapExit, distanceFormatter = KILOMETRES)
        }
    }

private val KILOMETRES = LocalizedDistanceFormatter(distanceMeasurementSystemOverride = DistanceMeasurementSystem.SI)

@Composable
private fun Centre(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) { content() }
}

@Composable
private fun Pill(text: String, background: Color, foreground: Color, modifier: Modifier = Modifier) {
    Text(
        text,
        color = foreground,
        fontWeight = FontWeight.SemiBold,
        fontSize = 15.sp,
        modifier = modifier.clip(RoundedCornerShape(50)).background(background).padding(horizontal = 14.dp, vertical = 8.dp),
    )
}

/** A quiet note: where the route came from, or that there's no map here. */
@Composable
private fun SmallPill(text: String) {
    Text(
        text,
        color = Color.White,
        fontSize = 13.sp,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(Color(0xFF5F6368)).padding(horizontal = 10.dp, vertical = 5.dp),
    )
}

/** Fuel, food and so on along the rest of the trip. Back closes it (or goes back to
 *  the kinds of stop), not the driving screen. */
@Composable
internal fun AddStopSheet(onClose: () -> Unit) {
    val context = LocalContext.current
    var category by remember { mutableStateOf<Pair<String, String>?>(null) }
    BackHandler { if (category == null) onClose() else category = null }
    var rows by remember { mutableStateOf<List<Maps.Nearby>?>(null) }
    LaunchedEffect(category) {
        val picked = category ?: return@LaunchedEffect
        rows = null
        val ahead = Nav.ahead()
        rows = if (ahead == null) emptyList() else runCatching {
            Maps.onTheWay(context, picked.first, ahead.first, ahead.second, ahead.third)
        }.getOrDefault(emptyList())
    }
    Box(Modifier.fillMaxSize().background(Color(0x66000000)).clickable(onClick = onClose), contentAlignment = Alignment.BottomCenter) {
        Surface(shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp), modifier = Modifier.fillMaxWidth().clickable(enabled = false) {}) {
            Column(Modifier.safeDrawingPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                val picked = category
                Text(picked?.second ?: "Add a stop", fontWeight = FontWeight.SemiBold, fontSize = 20.sp)
                if (picked == null) {
                    listOf("fuel" to "Fuel", "food" to "Food", "coffee" to "Coffee", "groceries" to "Groceries", "toilets" to "Toilets", "chemist" to "Chemist").forEach { kind ->
                        Text(kind.second, fontSize = 18.sp, modifier = Modifier.fillMaxWidth().clickable { category = kind }.padding(vertical = 10.dp))
                    }
                } else {
                    val found = rows
                    when {
                        found == null -> CircularProgressIndicator()
                        found.isEmpty() -> Text(if (Offline.online(context)) "Nothing close to your route." else "No signal, and nothing close to your route in your offline areas.")
                        else -> {
                            if (found.any { it.stop.offline }) {
                                Text("No signal: from your offline map, without detour times.", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            found.take(6).forEach { n ->
                            Column(Modifier.fillMaxWidth().clickable {
                                Nav.addStop(n.stop)
                                onClose()
                            }.padding(vertical = 8.dp)) {
                                Text(n.stop.name, fontSize = 18.sp)
                                val detail = listOfNotNull(
                                    n.addsMinutes?.let { if (it < 1) "No extra time" else "+$it min" },
                                    n.aheadKm?.let { String.format(java.util.Locale.ENGLISH, "%.1f km ahead", it) },
                                ).joinToString(" · ")
                                if (detail.isNotEmpty()) Text(detail, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        }
                    }
                }
                OutlinedButton(onClick = { if (picked == null) onClose() else category = null }) { Text(if (picked == null) "Close" else "Back") }
            }
        }
    }
}

@Composable
private fun Arrival(at: String?, onPark: () -> Unit, onDone: () -> Unit) {
    Box(Modifier.fillMaxSize().background(Color(0x66000000)), contentAlignment = Alignment.BottomCenter) {
        Surface(shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.safeDrawingPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(if (at != null) "You've arrived at $at" else "You've arrived", fontWeight = FontWeight.SemiBold, fontSize = 20.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button(onClick = onPark) { Text("Save where I parked") }
                    OutlinedButton(onClick = onDone) { Text("Done") }
                }
            }
        }
    }
}
