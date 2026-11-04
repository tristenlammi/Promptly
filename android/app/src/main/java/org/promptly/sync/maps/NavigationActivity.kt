package org.promptly.sync.maps

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
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
import com.stadiamaps.ferrostar.core.annotation.Speed
import com.stadiamaps.ferrostar.maplibreui.runtime.rememberNavigationMapState
import com.stadiamaps.ferrostar.maplibreui.views.DynamicallyOrientingNavigationView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.maplibre.compose.style.BaseStyle
import uniffi.ferrostar.TripState

/** The driving screen: `promptlymaps://navigate?server=…&code=…&stops=…`.
 *  Native because voice with the screen off and steady GPS need an app, not a
 *  web page. Everything else in P Maps is the web app. */
class NavigationActivity : ComponentActivity() {
    private val request = mutableStateOf<Trip?>(null)

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
        enableEdgeToEdge()
        request.value = parse(intent?.data)
        setContent {
            val dark = isSystemInDarkTheme()
            MaterialTheme(colorScheme = if (dark) darkColorScheme(primary = Color(0xFFE08B6D), onPrimary = Color(0xFF3A1A0E)) else lightColorScheme(primary = Color(0xFFD97757), onPrimary = Color.White)) {
                Surface(Modifier.fillMaxSize()) {
                    val trip by request
                    Driving(trip) { finish() }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        parse(intent.data)?.let { request.value = it }
    }

    @Composable
    private fun Driving(trip: Trip?, onDone: () -> Unit) {
        KeepScreenOnDisposableEffect()
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
                .onFailure { problem = it.message ?: "Couldn't sign in." }
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
        val vm = remember(trip) { Nav.viewModel(trip?.options ?: TripOptions()) }
        val state by vm.navigationUiState.collectAsState()
        val camera by Nav.camera.collectAsState()
        val arrived by Nav.arrived.collectAsState()
        val trafficNow by Nav.traffic.collectAsState()
        val faster by Nav.faster.collectAsState()
        val hazard by Nav.hazard.collectAsState()
        LaunchedEffect(state.location) {
            state.location?.let { Nav.onLocation(it.coordinates.lat, it.coordinates.lng) }
        }
        LaunchedEffect(state.tripState) {
            if (state.tripState is TripState.Complete) Nav.arrivedNow()
        }
        val mapState = rememberNavigationMapState()
        Box(Modifier.fillMaxSize()) {
            DynamicallyOrientingNavigationView(
                modifier = Modifier.fillMaxSize(),
                baseStyle = BaseStyle.Uri(styleUri),
                navigationMapState = mapState,
                viewModel = vm,
                config = VisualNavigationViewConfig.Default().withSpeedLimitStyle(SignageStyle.ViennaConvention),
                views = metricViews,
                onTapExit = {
                    Nav.stop()
                    onDone()
                },
                mapContent = { TrafficOnRoute() },
            )
            val limit = (state.currentAnnotation?.speedLimit as? Speed.Value)?.let { it.value }
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
                trafficNow?.let { t ->
                    val text = if (t.addsMinutes >= 1) "Traffic adds ${t.addsMinutes} min" else "No traffic delays"
                    Pill(text, if (t.addsMinutes >= 5) Color(0xFFB45309) else MaterialTheme.colorScheme.surface, if (t.addsMinutes >= 5) Color.White else MaterialTheme.colorScheme.onSurface)
                }
                (camera as? CameraAlert.Ahead)?.let { c ->
                    Pill("Speed camera ${c.metres} m", Color(0xFFB3261E), Color.White)
                }
                if (kmh != null) {
                    val over = limit != null && kmh > limit + 2
                    Pill("$kmh km/h", if (over) Color(0xFFB3261E) else MaterialTheme.colorScheme.surface, if (over) Color.White else MaterialTheme.colorScheme.onSurface)
                }
            }
            if (message != null) {
                Pill(message, Color(0xFF3A3A3A), Color.White, Modifier.align(Alignment.TopCenter).safeDrawingPadding().padding(top = 8.dp))
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
                    onPark = {
                        val at = state.location
                        scope.launch(Dispatchers.IO) {
                            val ok = at != null && runCatching { Maps.park(context, at.coordinates.lat, at.coordinates.lng, "manual") }.isSuccess
                            launch(Dispatchers.Main) {
                                Toast.makeText(context, if (ok) "Parked here" else "Couldn't save that", Toast.LENGTH_SHORT).show()
                                Nav.stop()
                                Nav.dismissArrival()
                                onDone()
                            }
                        }
                    },
                    onDone = {
                        Nav.stop()
                        Nav.dismissArrival()
                        onDone()
                    },
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

@Composable
private fun Arrival(onPark: () -> Unit, onDone: () -> Unit) {
    Box(Modifier.fillMaxSize().background(Color(0x66000000)), contentAlignment = Alignment.BottomCenter) {
        Surface(shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.safeDrawingPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("You've arrived", fontWeight = FontWeight.SemiBold, fontSize = 20.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button(onClick = onPark) { Text("Save where I parked") }
                    OutlinedButton(onClick = onDone) { Text("Done") }
                }
            }
        }
    }
}
