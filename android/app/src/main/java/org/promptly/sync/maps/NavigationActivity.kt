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
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
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
import com.stadiamaps.ferrostar.composeui.config.withRoadNameView
import com.stadiamaps.ferrostar.composeui.runtime.paddingForGridView
import com.stadiamaps.ferrostar.composeui.theme.DefaultNavigationUITheme
import com.stadiamaps.ferrostar.composeui.theme.NavigationUITheme
import androidx.compose.ui.unit.DpSize
import com.stadiamaps.ferrostar.composeui.runtime.KeepScreenOnDisposableEffect
import com.stadiamaps.ferrostar.core.measurement.MeasurementSpeedUnit
import com.stadiamaps.ferrostar.core.boundingBox
import com.stadiamaps.ferrostar.maplibreui.routeline.BorderedPolyline
import com.stadiamaps.ferrostar.maplibreui.routeline.RouteOverlayBuilder
import com.stadiamaps.ferrostar.maplibreui.runtime.rememberNavigationMapState
import com.stadiamaps.ferrostar.maplibreui.NavigationMapPuckStyle
import kotlinx.coroutines.launch
import org.maplibre.compose.style.BaseStyle
import org.promptly.sync.R
import org.promptly.sync.maps.offline.Offline
import uniffi.ferrostar.DrivingSide

/** The driving screen: `promptlymaps://navigate?server=…&code=…&stops=…`.
 *  Native because voice with the screen off and steady GPS need an app, not a
 *  web page. Everything else in P Maps is the web app.
 *
 *  With no trip it's P Maps' own map, "Drive" ([DriveHome]): what the P Maps icon opens
 *  with no signal, the long-press Drive shortcut, and where a trip ends. */
class NavigationActivity : ComponentActivity() {
    private val request = mutableStateOf<Trip?>(null)
    private val driveAsk = mutableStateOf<DriveAsk?>(null)

    /** Sign-in handed over with no trip (the web's "Just drive"): server and code. */
    private val pair = mutableStateOf<Pair<String, String>?>(null)

    /** Opened by a tap on the P Maps icon, not by a link or from inside the app. */
    private var fromIcon = false

    private fun pairOf(uri: Uri?): Pair<String, String>? {
        val server = uri?.getQueryParameter("server") ?: return null
        val code = uri.getQueryParameter("code") ?: return null
        return server to code
    }

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
            pair.value = pairOf(intent?.data)
            fromIcon = intent?.getBooleanExtra(EXTRA_FROM_ICON, false) == true
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
            DriveTheme {
                // The clock and battery over the map: dark on the day map, light on the night one.
                val dark = LocalDriveDark.current
                LaunchedEffect(dark) {
                    val bars = if (dark) SystemBarStyle.dark(android.graphics.Color.TRANSPARENT) else SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT)
                    enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
                }
                Surface(Modifier.fillMaxSize()) {
                    val trip by request
                    val ask by driveAsk
                    val signIn by pair
                    Driving(trip, ask, signIn) { finish() }
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

        /** Set by the P Maps launcher (SuiteLauncher) when its icon was tapped. */
        const val EXTRA_FROM_ICON = "org.promptly.app.FROM_ICON"
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val trip = parse(intent.data)
        pairOf(intent.data)?.let { pair.value = it }
        if (trip != null) {
            // The trip a recreated screen picks up again if it hadn't started.
            setIntent(intent)
            request.value = trip
        }
        else DriveAsk.fromWebPath(intent.getStringExtra(MapLinkActivity.EXTRA_PATH))?.let { if (!Nav.onTrip()) driveAsk.value = it }
    }

    @Composable
    private fun Driving(trip: Trip?, driveAsk: DriveAsk?, pair: Pair<String, String>?, onDone: () -> Unit) {
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
        LaunchedEffect(trip, pair) {
            runCatching { Maps.signIn(context, trip?.server ?: pair?.first, trip?.code ?: pair?.second) }
                .onSuccess {
                    problem = null
                    signedIn = true
                    Nav.loadStyle(this)
                }
                .onFailure {
                    if (signedIn) return@onFailure
                    // The icon, on a phone the map hasn't been signed in on yet: P Maps on
                    // your server instead of a dead end. "Just drive" there signs this in.
                    if (trip == null && fromIcon) {
                        fromIcon = false
                        openWebMaps(context)
                        onDone()
                        return@onFailure
                    }
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
        val asking by org.promptly.sync.talk.CarTalk.question.collectAsState()
        // The same one press, one turn as the car's screen (Talk, WP-T8).
        val askTalk = { org.promptly.sync.talk.CarTalk.press(applicationContext, null) { Voice.press(applicationContext) }?.let { Voice.showReply(it) } }
        val sharedWith by Nav.sharedWith.collectAsState()
        val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
            if (ok) askTalk()
        }
        LaunchedEffect(said) {
            if (said != null) {
                kotlinx.coroutines.delay(8000)
                Voice.clearReply()
            }
        }
        // Cameras, warnings and arriving are Nav's: they work with this screen closed.
        val mapState = rememberNavigationMapState()
        val dark = LocalDriveDark.current
        val sound by Nav.soundNow.collectAsState()
        var soundNote by remember { mutableStateOf<String?>(null) }
        LaunchedEffect(soundNote) {
            if (soundNote != null) {
                kotlinx.coroutines.delay(2500)
                soundNote = null
            }
        }
        val navigating = state.isNavigating()
        val density = LocalDensity.current
        // Clear of the turn card above and the arrival bar below, whatever size they are.
        val under = if (navigating) with(density) { DriveLayout.banner.toDp() } else 0.dp
        val above = if (navigating) with(density) { DriveLayout.eta.toDp() } else 0.dp
        val routeLine = remember(dark) {
            RouteOverlayBuilder(navigationPath = { ui ->
                ui.routeGeometry?.let { BorderedPolyline(points = it, color = DriveColours.route(dark), borderColor = DriveColours.routeEdge(dark)) }
            })
        }
        val you = DriveColours.you(dark)
        val puck = remember(you) {
            NavigationMapPuckStyle(
                dotFillColorCurrentLocation = you,
                dotFillColorOldLocation = you,
                accuracyStrokeColor = you,
                accuracyFillColor = you.copy(alpha = 0.16f),
                bearingColor = you,
            )
        }
        // The sheets are for a trip that's running.
        LaunchedEffect(navigating) {
            if (!navigating) {
                DriveLayout.sharing = false
                DriveLayout.options = false
            }
        }
        Box(Modifier.fillMaxSize()) {
            DriveNavigationView(
                modifier = Modifier.fillMaxSize(),
                baseStyle = BaseStyle.Uri(styleUri),
                navigationMapState = mapState,
                viewModel = vm,
                // The buttons are ours, below: one size, one look, and only the ones a drive needs.
                config = VisualNavigationViewConfig(),
                views = driveViews,
                theme = NoLibraryButtons,
                routeOverlayBuilder = routeLine,
                locationPuckStyle = puck,
                // Ending the trip goes back to Drive (Nav.ended).
                onTapExit = { Nav.stop() },
                mapContent = { TrafficOnRoute() },
            )
            // The road's limit in km/h, when the map has one (many Australian roads don't).
            val limit = state.currentAnnotation?.speedLimit?.value(MeasurementSpeedUnit.KilometersPerHour)?.let { Math.round(it).toInt() }?.takeIf { it in 5..150 }
            val kmh = state.location?.speed?.value?.let { Math.round(it * 3.6).toInt() }
            val status = when {
                // Started from Drive or the web, while the route is worked out.
                trip != null && !navigating && !arrived && message == null -> "Finding your route…"
                message != null -> message
                // Off the route where the phone has no map data to find a new one with.
                offRoute != null -> offRoute
                // After a wrong turn, while the new way is worked out.
                state.isCalculatingNewRoute == true -> "Finding a new route…"
                else -> null
            }
            val listening = voice == Voice.State.HEARD || voice == Voice.State.THINKING
            Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.systemBars).padding(paddingForGridView())) {
                // What you need to know, under the turn card: the urgent first, in red.
                Column(Modifier.align(Alignment.TopStart).padding(top = under + 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    status?.let { Notice(it) }
                    hazard?.let { h ->
                        val distance = if (h.metres >= 1000) "${Math.round(h.metres / 100f) / 10f} km" else "${h.metres} m"
                        val adds = if (h.hazard.delayMinutes >= 1) ", +${h.hazard.delayMinutes} min" else ""
                        Alert("${h.hazard.label} $distance$adds")
                    }
                    (camera as? CameraAlert.Ahead)?.let { c -> Alert("Speed camera ${c.metres} m") }
                    // Traffic, warnings and faster routes wait for signal; nothing's queued.
                    if (noSignal) Notice("No signal · no traffic info")
                    if (source == RouteSource.PHONE) Notice("Offline route")
                    // No signal and no downloaded map under you: the route still draws, on a plain map.
                    val at = state.location
                    if (noSignal && at != null && !org.promptly.sync.maps.offline.MapTiles.coversOffline(at.coordinates.lat, at.coordinates.lng)) {
                        Notice("No offline map here")
                    }
                    // Talk asked something: Yes and No, as well as saying it (Talk, WP-T8).
                    asking?.let { q ->
                        Notice(q.text.take(90))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf("Yes" to true, "No" to false).forEach { (word, yes) ->
                                Surface(
                                    onClick = { org.promptly.sync.talk.CarTalk.confirm(yes) },
                                    shape = RoundedCornerShape(50),
                                    color = if (yes) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface,
                                    contentColor = if (yes) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                                    shadowElevation = 3.dp,
                                    modifier = Modifier.defaultMinSize(minWidth = 72.dp, minHeight = 48.dp),
                                ) {
                                    Box(contentAlignment = Alignment.Center) {
                                        Text(word, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 16.dp))
                                    }
                                }
                            }
                        }
                    }
                    addedStop?.let { stop ->
                        Surface(
                            onClick = { Nav.removeStop() },
                            shape = RoundedCornerShape(50),
                            shadowElevation = 3.dp,
                            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        ) {
                            Box(contentAlignment = Alignment.Center) {
                                Text("Remove stop: ${stop.name.take(18)}", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 16.dp))
                            }
                        }
                    }
                }
                Row(
                    Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(bottom = above + 12.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    if (kmh != null) SpeedBadge(kmh, limit)
                    Box(Modifier.weight(1f).padding(horizontal = 8.dp), contentAlignment = Alignment.BottomCenter) {
                        if (navigating && mapState.isTrackingUser) state.currentStepRoadName?.takeIf { it.isNotBlank() }?.let { RoadName(it) }
                    }
                    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (listening) Notice(if (voice == Voice.State.HEARD) "Listening…" else "Thinking…")
                            RoundButton(R.drawable.ic_map_mic, "Ask Promptly", filled = listening) {
                                // With no signal it answers straight away (it needs your server), so no mic.
                                if (!Voice.allowed(context) && org.promptly.sync.maps.offline.Offline.online(context)) askMic.launch(Manifest.permission.RECORD_AUDIO)
                                else askTalk()
                            }
                        }
                        if (navigating) {
                            RoundButton(R.drawable.ic_map_add_stop, "Add a stop") { addingStop = true }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            soundNote?.let { Notice(it) }
                            RoundButton(sound.icon(), "${sound.label}. Tap to change what's said.") {
                                val next = sound.next()
                                Nav.setSound(next)
                                soundNote = next.label
                            }
                        }
                        if (navigating) {
                            if (mapState.isTrackingUser) {
                                RoundButton(R.drawable.ic_map_overview, "Show the whole route") {
                                    state.routeGeometry?.boundingBox()?.let {
                                        mapState.showRouteOverview(it, PaddingValues(start = 48.dp, end = 48.dp, top = under + 96.dp, bottom = above + 96.dp))
                                    }
                                }
                            } else {
                                WordButton("Re-centre", R.drawable.ic_map_heading) { mapState.recenter(true) }
                            }
                        }
                    }
                }
            }
            said?.let {
                Notice(it, Modifier.align(Alignment.Center).padding(horizontal = 24.dp))
            }
            if (addingStop) {
                AddStopSheet { addingStop = false }
            }
            if (DriveLayout.sharing && navigating) {
                ShareTripSheet(sharedWith) { DriveLayout.sharing = false }
            }
            if (DriveLayout.options && navigating) {
                TripOptionsSheet { DriveLayout.options = false }
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
                    modifier = Modifier.align(Alignment.BottomCenter).safeDrawingPadding().padding(start = 24.dp, end = 24.dp, bottom = above + 28.dp),
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

/** How tall the turn card and the arrival bar are just now, so nothing sits under them. */
private object DriveLayout {
    var banner by mutableIntStateOf(0)
    var eta by mutableIntStateOf(0)

    /** Asked for from the arrival bar: who can watch this trip, and the trip's options. */
    var sharing by mutableStateOf(false)
    var options by mutableStateOf(false)
}

/** The turn card and the arrival bar: ours, in kilometres whatever the phone's language says. */
/** The navigation library always draws its own re-centre / whole-route button, whatever
 *  it's told. Ours is in the button column, so theirs gets no room at all. */
private object NoLibraryButtons : NavigationUITheme by DefaultNavigationUITheme {
    override val buttonSize: DpSize
        @Composable get() = DpSize.Zero
}

private val driveViews = NavigationViewComponentBuilder.Default()
    .withInstructionsView { modifier, uiState ->
        uiState.visualInstruction?.let { instruction ->
            // The turn straight after this one, when there's no time to wait to be told.
            val then = uiState.remainingSteps?.getOrNull(1)?.takeIf { it.distance < 400 }
                ?.visualInstructions?.firstOrNull()?.primaryContent
            TurnBanner(
                instruction = instruction,
                metres = uiState.progress?.distanceToNextManeuver,
                then = then,
                side = uiState.remainingSteps?.firstOrNull()?.drivingSide ?: DrivingSide.LEFT,
                modifier = modifier.onSizeChanged { DriveLayout.banner = it.height },
            )
        }
    }
    .withProgressView { modifier, uiState, onTapExit ->
        uiState.progress?.let { progress ->
            // With traffic, this bar shows the same arrival time as everything else.
            val traffic by Nav.traffic.collectAsState()
            val watching by Nav.sharedWith.collectAsState()
            val context = LocalContext.current
            val now = java.time.Instant.now()
            val arriveAt = traffic?.arriveAt?.takeIf { it.isAfter(now) } ?: now.plusSeconds(progress.durationRemaining.toLong())
            EtaBar(
                arrive = android.text.format.DateFormat.getTimeFormat(context).format(java.util.Date.from(arriveAt)),
                left = duration(java.time.Duration.between(now, arriveAt).seconds.toInt()),
                distance = KILOMETRES.format(progress.distanceRemaining),
                trafficAddsMinutes = traffic?.addsMinutes,
                onEnd = { onTapExit?.invoke() },
                modifier = modifier.onSizeChanged { DriveLayout.eta = it.height },
                sharing = watching.isNotEmpty(),
                onShare = { DriveLayout.sharing = true },
                onOptions = { DriveLayout.options = true },
            )
        }
    }
    // The road you're on sits between the speed and the buttons, drawn with them.
    .withRoadNameView { _, _, _ -> }

@Composable
private fun Centre(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) { content() }
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
