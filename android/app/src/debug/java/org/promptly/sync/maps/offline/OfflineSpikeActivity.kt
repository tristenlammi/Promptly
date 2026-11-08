package org.promptly.sync.maps.offline

import android.location.Location
import android.os.Bundle
import android.os.Debug
import android.os.SystemClock
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import com.stadiamaps.ferrostar.composeui.notification.DefaultForegroundNotificationBuilder
import com.stadiamaps.ferrostar.core.DefaultNavigationViewModel
import com.stadiamaps.ferrostar.core.FerrostarCore
import com.stadiamaps.ferrostar.core.annotation.valhalla.valhallaExtendedOSRMAnnotationPublisher
import com.stadiamaps.ferrostar.core.http.OkHttpClientProvider.Companion.toOkHttpClientProvider
import com.stadiamaps.ferrostar.core.location.SimulatedLocationProvider
import com.stadiamaps.ferrostar.core.service.FerrostarForegroundServiceManager
import com.stadiamaps.ferrostar.maplibreui.runtime.rememberNavigationMapState
import com.stadiamaps.ferrostar.maplibreui.views.DynamicallyOrientingNavigationView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.maplibre.android.module.http.HttpRequestUtil
import org.maplibre.compose.style.BaseStyle
import uniffi.ferrostar.CourseFiltering
import uniffi.ferrostar.GeographicCoordinate
import uniffi.ferrostar.NavigationControllerConfig
import uniffi.ferrostar.RouteDeviationTracking
import uniffi.ferrostar.UserLocation
import uniffi.ferrostar.Waypoint
import uniffi.ferrostar.WaypointAdvanceMode
import uniffi.ferrostar.WaypointKind
import uniffi.ferrostar.stepAdvanceDistanceEntryAndExit
import uniffi.ferrostar.stepAdvanceDistanceToEndOfStep
import java.io.File
import java.time.Instant

/** WP-M0 spike (debug builds only): routes with Valhalla on the phone from tiles the
 *  server built, and draws Ferrostar's map from PMTiles on the phone through
 *  MapLibre's global OkHttp client. Data is pushed by adb into
 *  files/spike via /data/local/tmp and run-as (see docs/maps-offline-plan.md, M0).
 *
 *  adb shell am start -n org.promptly.app/org.promptly.sync.maps.offline.OfflineSpikeActivity
 *  Logcat: PromptlyOffline. */
class OfflineSpikeActivity : ComponentActivity() {
    private val log = mutableStateOf("")
    private var router: SpikeRouter? = null

    private fun say(line: String) {
        Log.i(TAG, line)
        log.value = log.value + line + "\n"
    }

    private fun memory(): String {
        val info = Debug.MemoryInfo()
        Debug.getMemoryInfo(info)
        return "PSS ${info.totalPss / 1024} MB, native heap ${Debug.getNativeHeapAllocatedSize() / (1024 * 1024)} MB"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Before any map exists: every MapLibre request goes through this client.
        // MapLibre must be initialised first, or HttpRequestImpl's class init throws.
        org.maplibre.android.MapLibre.getInstance(applicationContext)
        // With no network MapLibre's ConnectivityReceiver tells the native side it's
        // offline, and it stops asking for tiles at all, even ones we answer locally.
        org.maplibre.android.MapLibre.setConnected(true)
        HttpRequestUtil.setOkHttpClient(SpikeTiles.client())
        val dir = File(filesDir, "spike")
        val assets = File(dir, "map-assets")
        SpikeTiles.assets = assets
        SpikeTiles.archives = dir.listFiles().orEmpty().filter { it.extension == "pmtiles" }.sortedBy { it.name }.map(::PmTiles)
        val styleUri = if (File(assets, "style-light.json").isFile) SpikeTiles.style(assets, false, File(cacheDir, "spike-style.json")) else null

        val simulated = SimulatedLocationProvider(warpFactor = 4u, initialLocation = Location("sim").apply {
            latitude = DUBBO.lat
            longitude = DUBBO.lng
        })
        val config = NavigationControllerConfig(
            WaypointAdvanceMode.WaypointWithinRange(60.0),
            stepAdvanceDistanceEntryAndExit(30u, 5u, 32u),
            stepAdvanceDistanceToEndOfStep(10u, 32u),
            RouteDeviationTracking.StaticThreshold(15U, 60.0),
            CourseFiltering.SNAP_TO_ROUTE,
        )
        val ready = mutableStateOf(false)
        val vmState = mutableStateOf<DefaultNavigationViewModel?>(null)
        var core: FerrostarCore? = null

        lifecycleScope.launch(Dispatchers.Default) {
            say("M0 spike, tile cache ${intent.getIntExtra("cacheMb", 96)} MB. pmtiles: ${SpikeTiles.archives.size}, style: ${styleUri != null}")
            say("Before Valhalla: ${memory()}")
            val tiles = File(dir, "tiles")
            if (!tiles.isDirectory) {
                say("No tiles at $tiles")
                return@launch
            }
            val started = SystemClock.elapsedRealtime()
            val r = runCatching { SpikeRouter(SpikeRouter.writeConfig(File(filesDir, "spike-valhalla.json"), tiles, null, intent.getIntExtra("cacheMb", 96) * 1024L * 1024)) }
                .onFailure { say("Valhalla failed to start: $it") }.getOrNull() ?: return@launch
            router = r
            say("Valhalla up in ${SystemClock.elapsedRealtime() - started} ms. ${memory()}")
            for ((name, from, to) in TRIPS) {
                val times = mutableListOf<Long>()
                var summary = ""
                repeat(4) {
                    val result = runCatching {
                        r.getRoutes(here(from), listOf(Waypoint(coordinate = to, kind = WaypointKind.BREAK)))
                    }
                    result.onSuccess { routes ->
                        val route = routes.first()
                        summary = "%.1f km, %d min, %d steps, %d routes".format(route.distance / 1000, (route.steps.sumOf { it.duration } / 60).toInt(), route.steps.size, routes.size)
                    }.onFailure { summary = "no route: ${it.message?.take(160)}" }
                    times += r.lastMillis
                }
                say("$name: $summary. ms cold ${times.first()}, warm ${times.drop(1).joinToString("/")}")
            }
            say("After routes: ${memory()}")
            // The same squares as a tar, the other way the engine can read them.
            val tar = File(dir, "148_-33.tar")
            if (tar.isFile) {
                val t0 = SystemClock.elapsedRealtime()
                runCatching {
                    SpikeRouter(SpikeRouter.writeConfig(File(filesDir, "spike-valhalla-tar.json"), null, tar)).use { tr ->
                        val up = SystemClock.elapsedRealtime() - t0
                        val routes = tr.getRoutes(here(DUBBO), listOf(Waypoint(coordinate = NARROMINE, kind = WaypointKind.BREAK)))
                        say("Tar extract: up in $up ms, Dubbo to Narromine %.1f km in ${tr.lastMillis} ms".format(routes.first().distance / 1000))
                    }
                }.onFailure { say("Tar extract failed: $it") }
            }
            say("Request body: ${r.lastBody.take(400)}")
            withContext(Dispatchers.Main) {
                val c = FerrostarCore(
                    r,
                    okhttp3.OkHttpClient().toOkHttpClientProvider(),
                    simulated,
                    config,
                    FerrostarForegroundServiceManager(applicationContext, DefaultForegroundNotificationBuilder(applicationContext)),
                )
                core = c
                vmState.value = DefaultNavigationViewModel(c, valhallaExtendedOSRMAnnotationPublisher())
                ready.value = true
            }
        }

        setContent {
            MaterialTheme {
                Surface(Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxSize()) {
                        val vm by vmState
                        val model = vm
                        if (styleUri != null && model != null) {
                            DynamicallyOrientingNavigationView(
                                modifier = Modifier.fillMaxSize(),
                                baseStyle = BaseStyle.Uri(styleUri),
                                navigationMapState = rememberNavigationMapState(),
                                viewModel = model,
                                onTapExit = { core?.stopNavigation() },
                            )
                        }
                        var counts by remember { mutableStateOf("") }
                        LaunchedEffect(Unit) {
                            while (true) {
                                counts = "tiles ${SpikeTiles.tileHits.get()} hit / ${SpikeTiles.tileMisses.get()} empty · assets ${SpikeTiles.otherHits.get()} · network ${SpikeTiles.passedThrough.get()}"
                                kotlinx.coroutines.delay(1000)
                            }
                        }
                        Column(
                            Modifier.align(Alignment.BottomStart).fillMaxWidth().safeDrawingPadding()
                                .background(Color(0xCCFFFFFF)).padding(8.dp),
                        ) {
                            Text(counts, fontSize = 11.sp)
                            Text(log.value, fontSize = 10.sp, lineHeight = 12.sp, modifier = Modifier.verticalScroll(rememberScrollState()).padding(top = 4.dp).fillMaxWidth().weight(1f, fill = false))
                            val isReady by ready
                            Row {
                                Button(enabled = isReady, onClick = {
                                    val c = core ?: return@Button
                                    lifecycleScope.launch {
                                        runCatching {
                                            val route = c.getRoutes(here(DUBBO), listOf(Waypoint(coordinate = WELLINGTON, kind = WaypointKind.BREAK))).first()
                                            simulated.setRoute(route)
                                            c.startNavigation(route)
                                            say("Driving Dubbo to Wellington on the local route (simulated GPS)")
                                        }.onFailure { say("Couldn't start: $it") }
                                    }
                                }) { Text("Drive Dubbo to Wellington") }
                            }
                        }
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        router?.close()
        super.onDestroy()
    }

    private fun here(at: GeographicCoordinate) = UserLocation(at, 5.0, null, Instant.now(), null)

    companion object {
        private const val TAG = "PromptlyOffline"
        val DUBBO = GeographicCoordinate(-32.2480, 148.6040)
        val NARROMINE = GeographicCoordinate(-32.2330, 148.2400)
        val WELLINGTON = GeographicCoordinate(-32.5560, 148.9440)
        private val CIVIC = GeographicCoordinate(-35.2809, 149.1300)
        private val TUGGERANONG = GeographicCoordinate(-35.4150, 149.0680)
        private val QUEANBEYAN = GeographicCoordinate(-35.3540, 149.2320)
        private val SYDNEY = GeographicCoordinate(-33.8688, 151.2093)
        private val PARRAMATTA = GeographicCoordinate(-33.8150, 151.0030)
        private val BONDI = GeographicCoordinate(-33.8915, 151.2767)
        val TRIPS = listOf(
            Triple("Dubbo to Narromine", DUBBO, NARROMINE),
            Triple("Dubbo to Wellington", DUBBO, WELLINGTON),
            Triple("Canberra Civic to Tuggeranong", CIVIC, TUGGERANONG),
            Triple("Canberra Civic to Queanbeyan", CIVIC, QUEANBEYAN),
            Triple("Sydney CBD to Parramatta", SYDNEY, PARRAMATTA),
            Triple("Sydney CBD to Bondi", SYDNEY, BONDI),
            Triple("Dubbo to Canberra (squares between missing)", DUBBO, CIVIC),
        )
    }
}
