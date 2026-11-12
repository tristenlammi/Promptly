package org.promptly.sync.maps

import android.content.Intent
import androidx.car.app.CarAppService
import android.util.Log
import androidx.car.app.CarToast
import androidx.compose.runtime.LaunchedEffect
import androidx.activity.OnBackPressedCallback
import androidx.car.app.constraints.ConstraintManager
import androidx.compose.runtime.LaunchedEffect
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import org.maplibre.spatialk.geojson.BoundingBox
import kotlinx.coroutines.withTimeoutOrNull
import org.maplibre.compose.camera.CameraPosition
import org.maplibre.spatialk.geojson.Position
import androidx.car.app.media.CarAudioRecord
import org.promptly.sync.talk.CarTalk
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.graphics.drawable.IconCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import com.rallista.car.app.compose.ComposableScreen
import com.stadiamaps.ferrostar.car.app.navigation.NavigationManagerBridge
import com.stadiamaps.ferrostar.car.app.navigation.TurnByTurnNotificationManager
import com.stadiamaps.ferrostar.car.app.template.icons.InterfaceCarIcons
import com.stadiamaps.ferrostar.core.extensions.currentStep
import com.stadiamaps.ferrostar.core.extensions.progress
import com.stadiamaps.ferrostar.core.extensions.visualInstruction
import org.promptly.sync.BuildConfig
import uniffi.ferrostar.DrivingSide
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
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import org.promptly.sync.R

/** P Maps on the car's screen (Android Auto). */
class PromptlyCarService : CarAppService() {
    override fun createHostValidator(): HostValidator = carHosts(this, BuildConfig.DEBUG)

    override fun onCreateSession(sessionInfo: SessionInfo): Session = PromptlyCarSession()
}

/** Which apps may show P Maps on a screen. A release build only talks to Google's own
 *  car hosts (Android Auto, and Android Automotive's template host), from the car
 *  library's list of their signing keys. A debug build talks to any, for the Desktop
 *  Head Unit and test hosts. */
internal fun carHosts(context: android.content.Context, debug: Boolean): HostValidator =
    if (debug) HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
    else HostValidator.Builder(context).addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample).build()

class PromptlyCarSession : Session() {
    private val styleScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onCarConfigurationChanged(newConfiguration: android.content.res.Configuration) {
        // The car's headlights came on, or went off.
        Nav.loadCarStyle(styleScope, carContext.isDarkMode)
    }

    override fun onCreateScreen(intent: Intent): Screen {
        Nav.init(carContext)
        if (Maps.server(carContext) == null) {
            return NotReady(carContext, "Open P Maps on your phone and start a trip once, then come back.")
        }
        // The car's map draws from the same tiles as the phone's, offline too.
        org.promptly.sync.maps.offline.MapTiles.install(carContext)
        val screen = DriveScreen(carContext)
        // Opened by "navigate to…" from another app or the assistant. Once this screen
        // is on the car, so anything it opens goes on top of it.
        android.os.Handler(android.os.Looper.getMainLooper()).post { handle(intent, screen) }
        return screen
    }

    override fun onNewIntent(intent: Intent) {
        val root = carContext.getCarService(androidx.car.app.ScreenManager::class.java)
        if (Maps.server(carContext) == null) return
        root.popToRoot()
        handle(intent, root.top as? DriveScreen ?: return)
    }

    private fun handle(intent: Intent, screen: DriveScreen) {
        // Only the car drives: another app's "walk there" still gets the drive preview.
        val drive = Nav.driveOptions()
        when (val ask = MapLinks.read(intent, drive)) {
            is MapLinks.Ask.Navigate ->
                if (ask.addStop && Nav.onTrip()) {
                    Nav.addStop(ask.stop)
                    CarToast.makeText(carContext, "Adding ${ask.stop.name}", CarToast.LENGTH_SHORT).show()
                } else {
                    CarPreview.show(carContext, ask.stop, if (ask.options.mode == "drive") ask.options else drive)
                }
            is MapLinks.Ask.NavigateTo -> CarPreview.showQuery(carContext, ask.query, if (ask.options.mode == "drive") ask.options else drive)
            is MapLinks.Ask.Show -> CarPreview.show(carContext, ask.stop, drive)
            is MapLinks.Ask.Search -> screen.screenManager.push(SearchScreen(carContext, ask.query))
            null -> Unit
        }
    }
}

private class NotReady(context: CarContext, private val text: String) : Screen(context) {
    override fun onGetTemplate(): Template =
        MessageTemplate.Builder(text).setTitle("P Maps").setHeaderAction(Action.APP_ICON).build()
}

/** The map, and turn-by-turn once a trip's running. */
private class DriveScreen(context: CarContext) : ComposableScreen(context) {
    // Something going wrong in one of this screen's jobs costs that job, never the app:
    // an uncaught error here used to stop the whole app, and the car's screen went blank.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main + CoroutineExceptionHandler { _, e ->
        Log.e("PromptlyCarMap", "A car screen job stopped", e)
    })
    private val vm = Nav.viewModel()
    // The link to the car's own navigation (its trip card, the turn notifications) gets
    // the trip with every turn one the car can draw (see CarManeuvers). If it fails anyway,
    // it's started again a little later rather than taking the app down.
    private val bridgeScope = CoroutineScope(SupervisorJob(scope.coroutineContext[kotlinx.coroutines.Job]) + Dispatchers.Main + CoroutineExceptionHandler { _, e ->
        Log.e("PromptlyCarMap", "The car's navigation link stopped; starting it again", e)
        restartBridge()
    })
    private val notifications = TurnByTurnNotificationManager(context = carContext, channelId = "promptly_turns", smallIconRes = R.drawable.ic_map_status)
    private val bridge = NavigationManagerBridge(
        navigationManager = carContext.getCarService(NavigationManager::class.java),
        viewModel = CarManeuvers.CarSafeModel(carContext, vm, scope),
        context = carContext,
        notificationManager = notifications,
        // The car asked: another app started directions, or it was stopped from the car.
        // Kept, so the car can offer to carry on.
        onStopNavigation = { Nav.stop(byYou = false) },
        onAutoDriveEnabled = { },
        isCarForeground = { lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) },
    )
    private var uiState: NavigationUiState? = null
    private val surfaceArea = SurfaceAreaTracker { surfaceGestureCallback = it }
    private var shortcuts: List<Stop> = emptyList()
    private val backFromPreview = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = CarPreview.clear()
    }

    init {
        // Android counts the car's screen as the background: without this, the map with
        // no trip got one position when it opened and none after.
        CarLocationService.start(carContext)
        Nav.loadCarStyle(scope, carContext.isDarkMode)
        bridge.start(bridgeScope)
        // Nav itself watches the trip for arriving, cameras and warnings, so a trip
        // the car started still has them with the phone in a pocket.
        vm.navigationUiState.onEach {
            val wasNavigating = uiState?.isNavigating() == true
            uiState = it
            if (wasNavigating != it.isNavigating() || it.isNavigating()) invalidate()
        }.launchIn(scope)
        Nav.carStyle.onEach { invalidate() }.launchIn(scope)
        Nav.traffic.onEach { invalidate() }.launchIn(scope)
        Nav.arrived.onEach { invalidate() }.launchIn(scope)
        // The voice says it; the screen shows it too, for when the music's loud.
        Nav.cameraWarning.onEach { alert ->
            val text = alert.limit?.let { "Speed camera · $it" } ?: "Speed camera ahead"
            CarToast.makeText(carContext, text, CarToast.LENGTH_LONG).show()
        }.launchIn(scope)
        CarPreview.plan.onEach {
            backFromPreview.isEnabled = it != null
            invalidate()
        }.launchIn(scope)
        // Why nothing happened, rather than nothing happening. Not one from before now.
        CarPreview.problem.onEach { CarToast.makeText(carContext, it, CarToast.LENGTH_LONG).show() }.launchIn(scope)
        Nav.error.drop(1).onEach { said -> if (said != null) CarToast.makeText(carContext, said, CarToast.LENGTH_LONG).show() }.launchIn(scope)
        carContext.onBackPressedDispatcher.addCallback(this, backFromPreview)
        scope.launch {
            shortcuts = runCatching { Maps.myPlaces(carContext) }.getOrDefault(emptyList())
            invalidate()
        }
        Nav.faster.onEach { invalidate() }.launchIn(scope)
        // A trip that stopped without you ending it: say so, and offer to carry on.
        Nav.unfinished.drop(1).onEach { trip ->
            if (trip != null) {
                val to = trip.stops.lastOrNull()?.name?.takeIf { it.isNotBlank() && it != "Destination" }
                CarToast.makeText(carContext, if (to != null) "Your trip to $to stopped. Tap Carry on." else "Your trip stopped. Tap Carry on.", CarToast.LENGTH_LONG).show()
            }
            invalidate()
        }.launchIn(scope)
        // No signal: once a session, say the map and directions now come from the phone.
        var toldOffline = false
        combine(Nav.noSignal, Nav.routeSource) { none, source -> none || source == RouteSource.PHONE }.onEach { offline ->
            if (offline && !toldOffline) {
                toldOffline = true
                CarToast.makeText(carContext, "No signal: using your offline map", CarToast.LENGTH_LONG).show()
            }
            invalidate()
        }.launchIn(scope)
        // Off the route with nothing downloaded there: what to do, on the screen as well.
        Nav.offRoute.onEach { said -> if (said != null) CarToast.makeText(carContext, said, CarToast.LENGTH_LONG).show() }.launchIn(scope)
        // What the assistant said, on the screen as well.
        Voice.reply.onEach { said ->
            if (said != null) {
                CarToast.makeText(carContext, said.take(120), CarToast.LENGTH_LONG).show()
                Voice.clearReply()
            }
        }.launchIn(scope)
        Voice.inCar = true
        // Talk's microphone icon (listening, thinking) follows the conversation.
        Voice.state.drop(1).onEach { invalidate() }.launchIn(scope)
        // A question Talk asked ("Send it?"): the car's own Yes / No alert, next to
        // the spoken question. Either answers it, and so does saying it.
        var alertShown: Int? = null
        CarTalk.question.onEach { q ->
            if (carContext.carAppApiLevel < CarAppApiLevels.LEVEL_5) return@onEach
            val apps = carContext.getCarService(androidx.car.app.AppManager::class.java)
            alertShown?.let { id -> runCatching { apps.dismissAlert(id) } }
            alertShown = null
            if (q != null) {
                val id = (q.id.hashCode() and 0x7FFFFFFF)
                alertShown = id
                runCatching { apps.showAlert(CarTemplates.question(q.text, id, onYes = { CarTalk.confirm(true) }, onNo = { CarTalk.confirm(false) })) }
            }
        }.launchIn(scope)
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
                CarTalk.carGone()
                Voice.inCar = false
                // The car's screen going away is where you parked.
                val at = uiState?.location
                if (at != null) {
                    CoroutineScope(Dispatchers.IO).launch {
                        runCatching { Parking.save(carContext, at.coordinates.lat, at.coordinates.lng, "auto") }
                    }
                }
                // Arrived and switched the car off: that trip is over.
                if (Nav.arrived.value) Nav.finishArrival()
                bridge.stop()
                CarLocationService.stop(carContext)
                scope.cancel()
            }
        })
    }

    private var restarting = false

    private fun restartBridge() {
        if (restarting) return
        restarting = true
        scope.launch {
            delay(3_000)
            restarting = false
            runCatching { bridge.stop() }
            runCatching { bridge.start(bridgeScope) }.onFailure { Log.e("PromptlyCarMap", "Couldn't start the car's navigation link", it) }
        }
    }

    @Composable
    override fun content() {
        val style by Nav.carStyle.collectAsState()
        val styleUri = style ?: return
        val dark = carContext.isDarkMode
        val area by screenSurfaceState(surfaceArea)
        val padding = surfaceStableFractionalPadding(area?.compositeArea)
        // You low on the screen, with the road ahead above you, as Waze has it.
        val tracking = surfaceStableFractionalPadding(area?.compositeArea, top = 0.5f)
        val options = navigationCameraOptions().copy(browsingPadding = padding, navigationPadding = tracking)
        val mapState = rememberNavigationMapState(navigationCameraOptions = options)
        // Where you are with no trip: the trip's own position stops when there isn't one.
        var here by remember { mutableStateOf<android.location.Location?>(null) }
        var heading by remember { mutableStateOf(0f) }
        // With no trip yet, nothing moves the camera, and it would stay on the whole
        // world, most of which this server has no map for. Start where you are, and
        // while you're driving with nowhere set, keep you low on the screen, heading up.
        // Move the map yourself and it's left alone for a while.
        LaunchedEffect(Unit) {
            var placed = false
            // Where the camera said it was after we last moved it: if it's somewhere else
            // now, you moved the map. (Comparing with where we asked it to go was off by
            // the padding that puts you low on the screen.)
            var expected: Position? = null
            var leftAloneUntil = 0L
            while (true) {
                runCatching {
                    Nav.locationProvider.locationUpdates(1000L).collect { fix ->
                        here = fix
                        val driving = fix.hasSpeed() && fix.speed >= DRIVING_MPS
                        if (driving && fix.hasBearing()) heading = fix.bearing
                        if (uiState?.isNavigating() == true || CarPreview.plan.value != null) {
                            placed = false
                            expected = null
                            return@collect
                        }
                        val now = android.os.SystemClock.elapsedRealtime()
                        val target = Position(fix.longitude, fix.latitude)
                        if (!placed) {
                            mapState.cameraState.position = CameraPosition(target = target, zoom = 15.0, bearing = heading.toDouble(), padding = tracking)
                            placed = true
                            expected = null
                            return@collect
                        }
                        val at = mapState.cameraState.position
                        val was = expected
                        if (was == null) {
                            expected = at.target
                        } else if (apart(at.target, was, 0.0005)) {
                            leftAloneUntil = now + LEFT_ALONE_MS
                            expected = at.target
                        }
                        if (now < leftAloneUntil) return@collect
                        // Parked or at the lights: only if the dot would be off where it was.
                        if (!driving && !apart(target, at.target, 0.0003)) return@collect
                        runCatching {
                            mapState.cameraState.animateTo(
                                CameraPosition(target = target, zoom = maxOf(at.zoom, 15.0), bearing = if (driving) heading.toDouble() else at.bearing, tilt = at.tilt, padding = tracking),
                                kotlin.time.Duration.parse("900ms"),
                            )
                        }
                        expected = mapState.cameraState.position.target
                    }
                }.onFailure { Log.w("PromptlyCarMap", "Lost the position on the car map; trying again", it) }
                // The position stopping (or failing) never leaves the map stuck: ask again.
                delay(5_000)
            }
        }
        // The whole route in view, beside the card that describes it.
        val plan by CarPreview.plan.collectAsState()
        LaunchedEffect(plan?.route) {
            val line = plan?.route?.line.orEmpty()
            if (line.size > 1) {
                runCatching {
                    mapState.cameraState.animateTo(
                        boundingBox = BoundingBox(line.minOf { it.first }, line.minOf { it.second }, line.maxOf { it.first }, line.maxOf { it.second }),
                        padding = padding,
                    )
                }
            }
        }
        // The route in Promptly's terracotta, as on the phone, and only the way ahead.
        val routeLine = remember(dark) { routeAheadOverlay(dark) }
        CarAppNavigationView(
            modifier = Modifier.fillMaxSize(),
            styleUrl = styleUri,
            navigationMapState = mapState,
            navigationCameraOptions = options,
            viewModel = vm,
            config = VisualNavigationViewConfig.Default().withSpeedLimitStyle(SignageStyle.ViennaConvention),
            surfaceAreaTracker = surfaceArea,
            routeOverlayBuilder = routeLine,
            // The car view has no setting for its own small dot: the arrow is drawn over it.
            mapContent = { ui ->
                TrafficOnRoute()
                PreviewRoutesOnMap()
                // The arrow: on a trip where the trip puts you, otherwise your last fix.
                if (ui.isNavigating()) YouOnTrip(ui)
                else Puck(here?.let { it.latitude to it.longitude }, heading)
            },
        )
    }

    /** Turn-by-turn, with the arrival time in current traffic, and any quicker way. */
    private fun drivingTemplate(state: NavigationUiState, withCard: Boolean = true): Template {
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
        strip.addAction(Action.Builder().setTitle("End").setOnClickListener { screenManager.push(ConfirmStopScreen(carContext)) }.build())
        val builder = NavigationTemplate.Builder().setActionStrip(strip.build())
        val icons = InterfaceCarIcons(carContext)
        builder.setMapActionStrip(
            ActionStrip.Builder()
                .addAction(Action.Builder().setIcon(icons.mute(state.isMuted ?: false)).setOnClickListener { vm.toggleMute() }.build())
                .addAction(CarTemplates.mic(carContext, { askFromCar() }, Voice.state.value))
                .build(),
        )
        // Our own card rather than Ferrostar's: it adds the lanes (with their picture,
        // which the car requires) and says when a new route is being worked out.
        val trip = state.tripState
        val step = trip?.currentStep()
        if (withCard) CarTemplates.routingInfo(
            carContext,
            instruction = trip?.visualInstruction(),
            metresToTurn = trip?.progress()?.distanceToNextManeuver,
            side = step?.drivingSide ?: DrivingSide.LEFT,
            exit = step?.roundaboutExitNumber?.toInt(),
            rerouting = state.isCalculatingNewRoute == true,
        )?.let { builder.setNavigationInfo(it) }
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

    private val listening = java.util.concurrent.atomic.AtomicBoolean(false)

    /** The car's own microphone, only when you press its button: a Talk turn
     *  ([CarTalk]: one press, one turn). Pressed while it's talking, it stops it. */
    private fun askFromCar() {
        if (carContext.carAppApiLevel < CarAppApiLevels.LEVEL_5) {
            CarToast.makeText(carContext, "This car can't use its microphone for this", CarToast.LENGTH_LONG).show()
            return
        }
        CarTalk.press(carContext, carContext) { askOneShot() }?.let { CarToast.makeText(carContext, it, CarToast.LENGTH_LONG).show() }
    }

    /** One question at a time over `/api/assistant`: only for a server without Talk. */
    private fun askOneShot() {
        if (!org.promptly.sync.maps.offline.Offline.online(carContext)) {
            // The assistant needs your server: no signal is said plainly (Voice.press), with no mic.
            Voice.press(carContext)
            return
        }
        if (!Voice.allowed(carContext)) {
            CarToast.makeText(carContext, "Allow the microphone on your phone first", CarToast.LENGTH_LONG).show()
            return
        }
        if (carContext.carAppApiLevel < CarAppApiLevels.LEVEL_5) {
            CarToast.makeText(carContext, "This car can't use its microphone for this", CarToast.LENGTH_LONG).show()
            return
        }
        if (!listening.compareAndSet(false, true)) return
        CarToast.makeText(carContext, "Listening…", CarToast.LENGTH_SHORT).show()
        scope.launch(Dispatchers.IO) {
            val release = Voice.holdFocus(carContext)
            val record = CarAudioRecord.create(carContext)
            var recording = false
            try {
                Voice.setState(Voice.State.HEARD)
                record.startRecording()
                recording = true
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
                recording = false
                Voice.setState(Voice.State.OFF)
                if (clip != null) Voice.ask(carContext, clip)
            } catch (e: Exception) {
                Log.w("PromptlyVoice", "Couldn't use the car's microphone", e)
            } finally {
                // Stopped even when capturing threw (WP-T0 found it was left running).
                if (recording) runCatching { record.stopRecording() }
                if (Voice.state.value == Voice.State.HEARD) Voice.setState(Voice.State.OFF)
                Voice.quiet()
                release()
                listening.set(false)
            }
        }
    }

    override fun onGetTemplate(): Template {
        val state = uiState
        if (state?.isNavigating() == true) {
            // A turn the car won't take must not take the screen with it.
            return runCatching { drivingTemplate(state) }.getOrElse {
                Log.e("PromptlyCarMap", "Couldn't build the driving card", it)
                drivingTemplate(state, withCard = false)
            }
        }
        if (Nav.arrived.value) {
            return CarTemplates.arrival(
                carContext,
                Nav.arrivedAt,
                onPark = {
                    scope.launch {
                        val saved = Nav.parkHere()
                        // The car's toasts are short: "Parked here" either way, with no signal said plainly.
                        val text = if (saved == Parking.Saved.LATER) "Parked here. Saved when there's signal" else Parking.said(saved)
                        CarToast.makeText(carContext, text, CarToast.LENGTH_LONG).show()
                        Nav.finishArrival()
                    }
                },
                onDone = { Nav.finishArrival() },
            )
        }
        CarPreview.plan.value?.let { plan ->
            return CarTemplates.preview(
                plan,
                carLimit(carContext, ConstraintManager.CONTENT_LIMIT_TYPE_ROUTE_LIST),
                onSelect = CarPreview::select,
                onGo = {
                    CarToast.makeText(carContext, "Starting your trip", CarToast.LENGTH_SHORT).show()
                    CarPreview.go()
                },
                carApi = carContext.carAppApiLevel,
            )
        }
        return CarTemplates.landing(
            carContext,
            home = shortcuts.firstOrNull { it.kind == "home" },
            work = shortcuts.firstOrNull { it.kind == "work" },
            onWhereTo = { screenManager.push(PlacesScreen(carContext)) },
            onPlace = { CarPreview.show(carContext, it) },
            onMic = { askFromCar() },
            micState = Voice.state.value,
            onCarryOn = Nav.unfinished.value?.let { { Nav.carryOn() } },
        )
    }
}

private const val DRIVING_MPS = 2.5f
private const val LEFT_ALONE_MS = 20_000L

/** Further apart than [degrees] in either direction. */
private fun apart(a: Position, b: Position, degrees: Double): Boolean =
    Math.abs(a.latitude - b.latitude) > degrees || Math.abs(a.longitude - b.longitude) > degrees

/** How many rows this car allows, which depends on the car and whether it's moving. */
private fun carLimit(context: CarContext, type: Int): Int =
    runCatching { context.getCarService(ConstraintManager::class.java).getContentLimit(type) }.getOrDefault(6)

/** Straight-line, from the last place the phone knew. Enough to tell near from far. */
private fun distanceTo(stop: Stop, here: android.location.Location?): Float? {
    if (here == null) return null
    val metres = FloatArray(1)
    android.location.Location.distanceBetween(here.latitude, here.longitude, stop.lat, stop.lon, metres)
    return metres[0]
}

private class ConfirmStopScreen(context: CarContext) : Screen(context) {
    override fun onGetTemplate(): Template = CarTemplates.confirmStop(
        onEnd = {
            Nav.stop()
            screenManager.popToRoot()
        },
        onKeep = { screenManager.pop() },
    )
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
                if (n.stop.offline) "Offline" else null,
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
    private var here: android.location.Location? = null

    init {
        scope.launch {
            here = runCatching { Nav.locationProvider.lastLocation() }.getOrNull()
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
            failed -> builder.setSingleList(
                ItemList.Builder().setNoItemsMessage(
                    if (org.promptly.sync.maps.offline.Offline.online(carContext)) "Couldn't reach your server." else "No signal, and no saved places on this phone yet. Search instead.",
                ).build(),
            )
            rows == null -> builder.setLoading(true)
            else -> builder.setSingleList(CarTemplates.places(carContext, rows, carLimit(carContext, ConstraintManager.CONTENT_LIMIT_TYPE_PLACE_LIST), "Nothing saved yet. Search, or save places in P Maps.", { distanceTo(it, here) }) { go(it) })
        }
        return builder.build()
    }

    private fun go(stop: Stop) {
        CarPreview.show(carContext, stop)
        screenManager.popToRoot()
    }
}

/** Search, optionally already asked: "search for coffee" from another app. */
private class SearchScreen(context: CarContext, initial: String = "") : Screen(context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var results: List<Stop> = emptyList()
    private var query = ""
    private var searching = false
    private var failed = false
    private var emptyText = "Nothing found for that."
    private var waiting: kotlinx.coroutines.Job? = null
    private var here: android.location.Location? = null

    init {
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onDestroy(owner: LifecycleOwner) = scope.cancel()
        })
        if (initial.trim().length >= 2) search(initial, 0)
    }

    private fun search(words: String, pause: Long) {
        query = words
        waiting?.cancel()
        if (words.trim().length < 2) {
            results = emptyList()
            searching = false
            failed = false
            invalidate()
            return
        }
        waiting = scope.launch {
            delay(pause)
            searching = true
            failed = false
            invalidate()
            // Nearest first, as you'd expect from a map.
            here = runCatching { Nav.locationProvider.lastLocation() }.getOrNull()
            val near = here?.let { it.latitude to it.longitude }
            // Your server first; with no signal (or no answer in 4 s) the offline areas on the phone.
            val found = runCatching { PlaceSearch.find(carContext, words.trim(), near) }
            results = found.getOrNull()?.stops.orEmpty()
            emptyText = found.getOrNull()?.empty ?: "Nothing found for that."
            failed = found.isFailure
            searching = false
            invalidate()
        }
    }

    override fun onGetTemplate(): Template {
        val builder = SearchTemplate.Builder(object : SearchTemplate.SearchCallback {
            override fun onSearchTextChanged(searchText: String) = search(searchText, 400)

            override fun onSearchSubmitted(searchText: String) = search(searchText, 0)
        })
            .setHeaderAction(Action.BACK)
            .setSearchHint("Search for a place")
            .setInitialSearchText(query)
        if (searching) return builder.setLoading(true).build()
        val empty = when {
            failed -> "Couldn't search just now."
            query.trim().length < 2 -> "Search for a place or address"
            else -> emptyText
        }
        return builder.setItemList(
            CarTemplates.places(carContext, results, carLimit(carContext, ConstraintManager.CONTENT_LIMIT_TYPE_LIST), empty, { distanceTo(it, here) }) {
                CarPreview.show(carContext, it)
                screenManager.popToRoot()
            },
        ).build()
    }
}
