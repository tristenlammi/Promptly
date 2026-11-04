package org.promptly.sync.maps

import android.content.Intent
import androidx.car.app.CarAppService
import android.util.Log
import androidx.car.app.CarToast
import androidx.car.app.media.CarAudioRecord
import androidx.car.app.versioning.CarAppApiLevels
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.car.app.SessionInfo
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarColor
import androidx.car.app.model.CarIcon
import androidx.car.app.model.DateTimeWithZone
import androidx.car.app.model.CarText
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.SearchTemplate
import androidx.car.app.model.Template
import androidx.car.app.navigation.NavigationManager
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.car.app.navigation.model.TravelEstimate
import androidx.car.app.validation.HostValidator
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.core.graphics.drawable.IconCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import com.rallista.car.app.compose.ComposableScreen
import com.stadiamaps.ferrostar.car.app.navigation.NavigationManagerBridge
import com.stadiamaps.ferrostar.car.app.navigation.TurnByTurnNotificationManager
import com.stadiamaps.ferrostar.car.app.template.icons.InterfaceCarIcons
import com.stadiamaps.ferrostar.car.app.template.models.FerrostarRoutingInfo
import com.stadiamaps.ferrostar.car.app.template.models.toCarDistance
import com.stadiamaps.ferrostar.composeui.config.VisualNavigationViewConfig
import com.stadiamaps.ferrostar.composeui.config.withSpeedLimitStyle
import com.stadiamaps.ferrostar.composeui.views.components.speedlimit.SignageStyle
import com.stadiamaps.ferrostar.core.NavigationUiState
import com.stadiamaps.ferrostar.maplibreui.runtime.navigationCameraOptions
import com.stadiamaps.ferrostar.maplibreui.runtime.rememberNavigationMapState
import com.stadiamaps.ferrostar.ui.maplibre.car.app.CarAppNavigationView
import com.stadiamaps.ferrostar.ui.maplibre.car.app.runtime.SurfaceAreaTracker
import com.stadiamaps.ferrostar.ui.maplibre.car.app.runtime.screenSurfaceState
import com.stadiamaps.ferrostar.ui.maplibre.car.app.runtime.surfaceStableFractionalPadding
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import org.promptly.sync.R

/** P Maps on the car's screen (Android Auto). */
class PromptlyCarService : CarAppService() {
    // Sideloaded with no Play listing, so there's no allowlist of hosts to check against.
    override fun createHostValidator(): HostValidator = HostValidator.ALLOW_ALL_HOSTS_VALIDATOR

    override fun onCreateSession(sessionInfo: SessionInfo): Session = PromptlyCarSession()
}

class PromptlyCarSession : Session() {
    override fun onCreateScreen(intent: Intent): Screen {
        Nav.init(carContext)
        if (Maps.server(carContext) == null) {
            return NotReady(carContext, "Open P Maps on your phone and start a trip once, then come back.")
        }
        return DriveScreen(carContext)
    }
}

private class NotReady(context: CarContext, private val text: String) : Screen(context) {
    override fun onGetTemplate(): Template =
        MessageTemplate.Builder(text).setTitle("P Maps").setHeaderAction(Action.APP_ICON).build()
}

/** The map, and turn-by-turn once a trip's running. */
private class DriveScreen(context: CarContext) : ComposableScreen(context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val vm = Nav.viewModel()
    private val notifications = TurnByTurnNotificationManager(context = carContext, smallIconRes = R.drawable.ic_map_status)
    private val bridge = NavigationManagerBridge(
        navigationManager = carContext.getCarService(NavigationManager::class.java),
        viewModel = vm,
        context = carContext,
        notificationManager = notifications,
        onStopNavigation = { Nav.stop() },
        onAutoDriveEnabled = { },
        isCarForeground = { lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) },
    )
    private var uiState: NavigationUiState? = null
    private val surfaceArea = SurfaceAreaTracker { surfaceGestureCallback = it }

    init {
        Nav.loadStyle(scope)
        bridge.start(scope)
        vm.navigationUiState.onEach {
            val wasNavigating = uiState?.isNavigating() == true
            uiState = it
            it.location?.let { at -> Nav.onLocation(at.coordinates.lat, at.coordinates.lng) }
            if (wasNavigating != it.isNavigating() || it.isNavigating()) invalidate()
        }.launchIn(scope)
        Nav.style.onEach { invalidate() }.launchIn(scope)
        Nav.traffic.onEach { invalidate() }.launchIn(scope)
        Nav.faster.onEach { invalidate() }.launchIn(scope)
        // What the assistant said, on the screen as well.
        Voice.reply.onEach { said ->
            if (said != null) {
                CarToast.makeText(carContext, said.take(120), CarToast.LENGTH_LONG).show()
                Voice.clearReply()
            }
        }.launchIn(scope)
        Voice.start(carContext)
        // A warning on the car's screen as you come up to it; the voice comes from the phone.
        var shown: String? = null
        Nav.hazard.onEach { alert ->
            if (alert != null && alert.hazard.id != shown) {
                shown = alert.hazard.id
                CarToast.makeText(carContext, "${alert.hazard.label} ahead", CarToast.LENGTH_LONG).show()
            }
        }.launchIn(scope)
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onDestroy(owner: LifecycleOwner) {
                // The car's screen going away is where you parked.
                val at = uiState?.location
                if (at != null) {
                    CoroutineScope(Dispatchers.IO).launch {
                        runCatching { Maps.park(carContext, at.coordinates.lat, at.coordinates.lng, "auto") }
                    }
                }
                bridge.stop()
                scope.cancel()
            }
        })
    }

    @Composable
    override fun content() {
        val style by Nav.style.collectAsState()
        val styleUri = style ?: return
        val area by screenSurfaceState(surfaceArea)
        val padding = surfaceStableFractionalPadding(area?.compositeArea)
        val tracking = surfaceStableFractionalPadding(area?.compositeArea, top = 0.5f)
        val options = navigationCameraOptions().copy(browsingPadding = padding, navigationPadding = tracking)
        val mapState = rememberNavigationMapState(navigationCameraOptions = options)
        CarAppNavigationView(
            modifier = Modifier.fillMaxSize(),
            styleUrl = styleUri,
            navigationMapState = mapState,
            navigationCameraOptions = options,
            viewModel = vm,
            config = VisualNavigationViewConfig.Default().withSpeedLimitStyle(SignageStyle.ViennaConvention),
            surfaceAreaTracker = surfaceArea,
            mapContent = { TrafficOnRoute() },
        )
    }

    /** Turn-by-turn, with the arrival time in current traffic, and any quicker way. */
    private fun drivingTemplate(state: NavigationUiState): Template {
        val strip = ActionStrip.Builder()
        Nav.faster.value?.let { offer ->
            strip.addAction(
                Action.Builder()
                    .setTitle(if (offer.reason != null) "Go around" else "Faster: ${offer.savesMinutes} min")
                    .setFlags(Action.FLAG_PRIMARY)
                    .setOnClickListener {
                        Nav.takeFaster()
                        CarToast.makeText(carContext, "Taking the faster route", CarToast.LENGTH_SHORT).show()
                    }
                    .build(),
            )
            strip.addAction(Action.Builder().setTitle("No").setOnClickListener { Nav.declineFaster() }.build())
        }
        strip.addAction(Action.Builder().setTitle("Add stop").setOnClickListener { screenManager.push(AddStopScreen(carContext)) }.build())
        strip.addAction(Action.Builder().setTitle("Stop").setOnClickListener { Nav.stop() }.build())
        val builder = NavigationTemplate.Builder().setActionStrip(strip.build())
        val icons = InterfaceCarIcons(carContext)
        builder.setMapActionStrip(
            ActionStrip.Builder()
                .addAction(Action.Builder().setIcon(icons.mute(state.isMuted ?: false)).setOnClickListener { vm.toggleMute() }.build())
                .addAction(
                    Action.Builder()
                        .setIcon(CarIcon.Builder(IconCompat.createWithResource(carContext, R.drawable.ic_map_mic)).build())
                        .setOnClickListener { askFromCar() }
                        .build(),
                )
                .build(),
        )
        state.tripState?.let { trip ->
            FerrostarRoutingInfo.Builder(carContext).setTripState(trip).build()?.let { builder.setNavigationInfo(it) }
        }
        state.progress?.let { progress ->
            val traffic = Nav.traffic.value
            val arrive = traffic?.arriveAt ?: java.time.Instant.now().plusSeconds(progress.durationRemaining.toLong())
            val left = java.time.Duration.between(java.time.Instant.now(), arrive).coerceAtLeast(java.time.Duration.ZERO)
            val adds = traffic?.addsMinutes ?: 0
            builder.setDestinationTravelEstimate(
                TravelEstimate.Builder(progress.distanceRemaining.toCarDistance(), DateTimeWithZone.create(arrive.toEpochMilli(), java.util.TimeZone.getDefault()))
                    .setRemainingTime(left)
                    .setRemainingTimeColor(if (adds >= 10) CarColor.RED else if (adds >= 3) CarColor.YELLOW else CarColor.GREEN)
                    .build(),
            )
        }
        return builder.build()
    }

    /** The car's own microphone, for when you press its button. */
    private fun askFromCar() {
        if (!Voice.allowed(carContext)) {
            CarToast.makeText(carContext, "Allow the microphone on your phone first", CarToast.LENGTH_LONG).show()
            return
        }
        if (carContext.carAppApiLevel < CarAppApiLevels.LEVEL_5) {
            CarToast.makeText(carContext, "Say \"Hey Promptly\" instead", CarToast.LENGTH_LONG).show()
            return
        }
        scope.launch(Dispatchers.IO) {
            VoiceService.paused = true
            val release = Voice.holdFocus(carContext)
            val record = CarAudioRecord.create(carContext)
            try {
                record.startRecording()
                val bytes = ByteArray(CarAudioRecord.AUDIO_CONTENT_BUFFER_SIZE)
                val clip = Voice.capture(200.0) { frame ->
                    val want = minOf(bytes.size, frame.size * 2)
                    val got = record.read(bytes, 0, want)
                    for (i in 0 until got / 2) {
                        frame[i] = ((bytes[i * 2 + 1].toInt() shl 8) or (bytes[i * 2].toInt() and 0xFF)).toShort()
                    }
                    if (got <= 0) -1 else got / 2
                }
                runCatching { record.stopRecording() }
                if (clip != null) Voice.ask(carContext, clip)
            } catch (e: Exception) {
                Log.w("PromptlyVoice", "Couldn't use the car's microphone", e)
            } finally {
                release()
                VoiceService.paused = false
            }
        }
    }

    override fun onGetTemplate(): Template {
        val state = uiState
        if (state?.isNavigating() == true) {
            return drivingTemplate(state)
        }
        val go = Action.Builder()
            .setTitle("Go")
            .setOnClickListener { screenManager.push(PlacesScreen(carContext)) }
            .build()
        return NavigationTemplate.Builder()
            .setActionStrip(ActionStrip.Builder().addAction(go).build())
            .build()
    }
}

/** Where to? Your saved places and recents, or a search. */
private val STOP_KINDS = listOf("fuel" to "Fuel", "food" to "Food", "coffee" to "Coffee", "groceries" to "Groceries", "toilets" to "Toilets", "chemist" to "Chemist")

/** Add a stop: what you're after. */
private class AddStopScreen(context: CarContext) : Screen(context) {
    override fun onGetTemplate(): Template {
        val list = ItemList.Builder()
        STOP_KINDS.forEach { (id, name) ->
            list.addItem(
                Row.Builder().setTitle(name).setBrowsable(true)
                    .setOnClickListener { screenManager.push(OnTheWayScreen(carContext, id, name)) }
                    .build(),
            )
        }
        return ListTemplate.Builder().setTitle("Add a stop").setHeaderAction(Action.BACK).setSingleList(list.build()).build()
    }
}

/** What's on the way, and how long each adds. */
private class OnTheWayScreen(context: CarContext, category: String, private val title: String) : Screen(context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var rows: List<Maps.Nearby>? = null

    init {
        scope.launch {
            val ahead = Nav.ahead()
            rows = if (ahead == null) emptyList() else runCatching {
                Maps.onTheWay(carContext, category, ahead.first, ahead.second, ahead.third)
            }.getOrDefault(emptyList())
            invalidate()
        }
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onDestroy(owner: LifecycleOwner) = scope.cancel()
        })
    }

    override fun onGetTemplate(): Template {
        val builder = ListTemplate.Builder().setTitle(title).setHeaderAction(Action.BACK)
        val found = rows
        if (found == null) return builder.setLoading(true).build()
        val list = ItemList.Builder().setNoItemsMessage("Nothing close to your route.")
        found.take(6).forEach { n ->
            val row = Row.Builder().setTitle(CarText.create(n.stop.name)).setOnClickListener {
                Nav.addStop(n.stop)
                CarToast.makeText(carContext, "Adding ${n.stop.name}", CarToast.LENGTH_SHORT).show()
                screenManager.popToRoot()
            }
            val detail = listOfNotNull(
                n.addsMinutes?.let { if (it < 1) "No extra time" else "+$it min" },
                n.aheadKm?.let { String.format(java.util.Locale.ENGLISH, "%.1f km ahead", it) },
            ).joinToString(" · ")
            if (detail.isNotEmpty()) row.addText(detail)
            list.addItem(row.build())
        }
        return builder.setSingleList(list.build()).build()
    }
}

private class PlacesScreen(context: CarContext) : Screen(context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var places: List<Stop>? = null
    private var failed = false

    init {
        scope.launch {
            runCatching { Maps.myPlaces(carContext) }
                .onSuccess { places = it }
                .onFailure { failed = true }
            invalidate()
        }
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onDestroy(owner: LifecycleOwner) = scope.cancel()
        })
    }

    override fun onGetTemplate(): Template {
        val search = Action.Builder()
            .setIcon(CarIcon.Builder(IconCompat.createWithResource(carContext, R.drawable.ic_map_search)).build())
            .setOnClickListener { screenManager.push(SearchScreen(carContext)) }
            .build()
        val builder = ListTemplate.Builder()
            .setTitle("Where to?")
            .setHeaderAction(Action.BACK)
            .setActionStrip(ActionStrip.Builder().addAction(search).build())
        val rows = places
        when {
            failed -> builder.setSingleList(ItemList.Builder().setNoItemsMessage("Couldn't reach your server.").build())
            rows == null -> builder.setLoading(true)
            else -> builder.setSingleList(stopList(carContext, rows, "Nothing saved yet. Search, or save places in P Maps.") { go(it) })
        }
        return builder.build()
    }

    private fun go(stop: Stop) {
        Nav.start(listOf(stop), TripOptions())
        screenManager.popToRoot()
    }
}

private class SearchScreen(context: CarContext) : Screen(context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var results: List<Stop> = emptyList()

    init {
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onDestroy(owner: LifecycleOwner) = scope.cancel()
        })
    }

    override fun onGetTemplate(): Template = SearchTemplate.Builder(object : SearchTemplate.SearchCallback {
        override fun onSearchSubmitted(searchText: String) {
            scope.launch {
                results = runCatching { Maps.search(carContext, searchText, null) }.getOrDefault(emptyList())
                invalidate()
            }
        }
    })
        .setHeaderAction(Action.BACK)
        .setSearchHint("Search for a place")
        .setItemList(stopList(carContext, results, "Search for a place") {
            Nav.start(listOf(it), TripOptions())
            screenManager.popToRoot()
        })
        .build()
}

private fun stopList(context: CarContext, stops: List<Stop>, empty: String, onPick: (Stop) -> Unit): ItemList {
    val list = ItemList.Builder().setNoItemsMessage(empty)
    val limit = 6
    stops.take(limit).forEach { stop ->
        list.addItem(
            Row.Builder()
                .setTitle(CarText.create(stop.name))
                .setBrowsable(false)
                .setOnClickListener { onPick(stop) }
                .build(),
        )
    }
    return list.build()
}
