package org.promptly.sync.maps

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.speech.tts.TextToSpeech
import android.util.Log
import androidx.lifecycle.viewModelScope
import com.stadiamaps.ferrostar.composeui.notification.DefaultForegroundNotificationBuilder
import com.stadiamaps.ferrostar.core.AndroidTtsObserver
import com.stadiamaps.ferrostar.core.AndroidTtsStatusListener
import com.stadiamaps.ferrostar.core.DefaultNavigationViewModel
import com.stadiamaps.ferrostar.core.FerrostarCore
import com.stadiamaps.ferrostar.core.annotation.valhalla.valhallaExtendedOSRMAnnotationPublisher
import com.stadiamaps.ferrostar.core.http.OkHttpClientProvider.Companion.toOkHttpClientProvider
import com.stadiamaps.ferrostar.core.location.NavigationLocationProvider
import com.stadiamaps.ferrostar.core.location.SimulatedLocationProvider
import com.stadiamaps.ferrostar.core.location.toUserLocation
import com.stadiamaps.ferrostar.core.service.FerrostarForegroundServiceManager
import com.stadiamaps.ferrostar.core.withJsonOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.delay
import org.json.JSONObject
import uniffi.ferrostar.CourseFiltering
import uniffi.ferrostar.GeographicCoordinate
import uniffi.ferrostar.NavigationControllerConfig
import uniffi.ferrostar.RouteDeviationTracking
import uniffi.ferrostar.Waypoint
import uniffi.ferrostar.WaypointAdvanceMode
import uniffi.ferrostar.WaypointKind
import uniffi.ferrostar.WellKnownRouteProvider
import uniffi.ferrostar.stepAdvanceDistanceEntryAndExit
import uniffi.ferrostar.stepAdvanceDistanceToEndOfStep
import java.time.Instant
import java.util.Locale

/** How you asked to travel. */
data class ThroughPoint(val lat: Double, val lon: Double, val heading: Int?)

data class TripOptions(val mode: String = "drive", val tolls: Boolean = false, val highways: Boolean = false, val ferries: Boolean = false)

sealed interface CameraAlert {
    data object None : CameraAlert
    data class Ahead(val metres: Int, val limit: Int?) : CameraAlert
}

/** The trip in progress, shared by the phone's driving screen and the car's.
 *  Uses Android's own GPS, never Google Play's location service, and asks only
 *  this server for routes. */
object Nav {
    private const val TAG = "PromptlyNav"
    private const val SAME_PLACE_METRES = 500f

    @SuppressLint("StaticFieldLeak") // the application context
    private lateinit var app: Context
    private var core: FerrostarCore? = null
    private var model: TripModel? = null
    private var tts: AndroidTtsObserver? = null
    private var liveJob: Job? = null
    private var lastOptions: TripOptions? = null
    private val _style = MutableStateFlow<String?>(null)
    val style = _style.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error = _error.asStateFlow()
    private val _camera = MutableStateFlow<CameraAlert>(CameraAlert.None)
    val camera = _camera.asStateFlow()
    /** What traffic adds to the rest of the trip, and the arrival time with it. */
    data class TrafficNow(val addsMinutes: Int, val arriveAt: Instant, val jams: List<Jam> = emptyList())

    /** A stretch of the road ahead that's slow ("slow") or nearly stopped ("jam"). */
    data class Jam(val kind: String, val line: List<Pair<Double, Double>>)

    /** Another way that's enough quicker to mention. */
    data class FasterRoute(val savesMinutes: Int, val viaName: String?, val through: List<ThroughPoint>, val reason: String? = null)

    /** Something reported on the road ahead. */
    data class Hazard(val id: String, val label: String, val text: String, val road: String?, val lat: Double, val lon: Double, val delayMinutes: Int, val closed: Boolean, val remainingThere: Double)
    data class HazardAlert(val hazard: Hazard, val metres: Int)
    private val _hazard = MutableStateFlow<HazardAlert?>(null)
    val hazard = _hazard.asStateFlow()
    private var hazards: List<Hazard> = emptyList()
    private val spokenHazards = mutableSetOf<String>()
    private var lastRemaining = 0.0

    /** A stop added during the drive, which can be taken off again. */
    private val _addedStop = MutableStateFlow<Stop?>(null)
    val addedStop = _addedStop.asStateFlow()
    private var lastWarningCheck = 0L
    private val _faster = MutableStateFlow<FasterRoute?>(null)
    val faster = _faster.asStateFlow()
    private var declinedAt = 0L
    private var declinedSaves = 0
    private var destination: Stop? = null
    private var multiStop = false

    private val _traffic = MutableStateFlow<TrafficNow?>(null)
    val traffic = _traffic.asStateFlow()
    private var trafficJob: Job? = null
    private val _arrived = MutableStateFlow(false)
    val arrived = _arrived.asStateFlow()

    private var cameras: List<Camera> = emptyList()
    private val warned = mutableSetOf<Camera>()
    private val closestSoFar = mutableMapOf<Camera, Float>()

    val locationProvider: NavigationLocationProvider by lazy {
        NavigationLocationProvider(
            liveProviding = LiveLocation(app),
            simulatedProvider = SimulatedLocationProvider(warpFactor = 2u, initialLocation = Location("sim")),
        )
    }

    fun init(context: Context) {
        if (!::app.isInitialized) app = context.applicationContext
    }

    fun loadStyle(scope: kotlinx.coroutines.CoroutineScope) {
        scope.launch {
            runCatching { Maps.styleFile(app) }
                .onSuccess { _style.value = it }
                .onFailure { _error.value = it.message ?: "Couldn't load the map." }
        }
    }

    /** The car's map: light or dark by the car's own setting, not the phone's. */
    private val _carStyle = MutableStateFlow<String?>(null)
    val carStyle = _carStyle.asStateFlow()

    fun loadCarStyle(scope: kotlinx.coroutines.CoroutineScope, dark: Boolean) {
        scope.launch {
            runCatching { Maps.styleFile(app, dark) }
                .onSuccess { _carStyle.value = it }
                .onFailure { _error.value = it.message ?: "Couldn't load the map." }
        }
    }

    /** The view model the screens draw from. */
    fun viewModel(options: TripOptions = lastOptions ?: TripOptions()): TripModel {
        model?.takeIf { lastOptions == options }?.let { return it }
        val profile = when (options.mode) {
            "walk" -> "pedestrian"
            "cycle" -> "bicycle"
            else -> "auto"
        }
        val costing = mutableMapOf<String, Any>()
        if (options.tolls) costing["use_tolls"] = 0.0
        if (options.highways && profile == "auto") costing["use_highways"] = 0.0
        if (options.ferries) costing["use_ferry"] = 0.0
        val server = Maps.server(app) ?: throw IllegalStateException("Not signed in")
        val provider = WellKnownRouteProvider.Valhalla("$server/api/maps/navigate/route", profile)
            .withJsonOptions(
                mapOf(
                    "costing_options" to mapOf(profile to costing),
                    "units" to "kilometers",
                    "language" to "en-GB",
                ),
            )
        val config = NavigationControllerConfig(
            WaypointAdvanceMode.WaypointWithinRange(60.0),
            stepAdvanceDistanceEntryAndExit(30u, 5u, 32u),
            stepAdvanceDistanceToEndOfStep(10u, 32u),
            RouteDeviationTracking.StaticThreshold(15U, 60.0),
            CourseFiltering.SNAP_TO_ROUTE,
        )
        val built = FerrostarCore(
            provider,
            httpClient = Maps.client(app).toOkHttpClientProvider(),
            locationProvider = locationProvider,
            foregroundServiceManager = FerrostarForegroundServiceManager(app, DefaultForegroundNotificationBuilder(app)),
            navigationControllerConfig = config,
        )
        val observer = tts ?: AndroidTtsObserver(app).also { t ->
            t.statusObserver = object : AndroidTtsStatusListener {
                override fun onTtsInitialized(tts: TextToSpeech?, status: Int) {
                    tts?.language = Locale.forLanguageTag("en-AU")
                }

                override fun onTtsSpeakError(utteranceId: String, status: Int) {
                    Log.w(TAG, "Couldn't speak an instruction: $status")
                }

                override fun onTtsShutdownAndRelease() = Unit
            }
            t.start()
            tts = t
        }
        observer.setMuted(savedMuted())
        built.spokenInstructionObserver = observer
        core = built
        lastOptions = options
        return TripModel(built).also { model = it }
    }

    private fun startsHere(stops: List<Stop>, here: Location): Boolean {
        val first = stops.firstOrNull() ?: return false
        if (first.name == "Your location") return true
        if (stops.size < 2) return false
        val metres = FloatArray(1)
        Location.distanceBetween(here.latitude, here.longitude, first.lat, first.lon, metres)
        return metres[0] <= SAME_PLACE_METRES
    }

    /** Ask for the route from where you are, and go. */
    fun start(stops: List<Stop>, options: TripOptions, through: List<ThroughPoint> = emptyList()) {
        val vm = viewModel(options)
        _error.value = null
        _arrived.value = false
        _camera.value = CameraAlert.None
        warned.clear()
        closestSoFar.clear()
        vm.viewModelScope.launch(Dispatchers.IO) {
            try {
                // A fresh fix if one comes quickly. The phone's last known position
                // can be from yesterday, somewhere else entirely.
                val here = withTimeoutOrNull(12_000) {
                    locationProvider.locationUpdates(1000L).first { System.currentTimeMillis() - it.time < 60_000 }
                } ?: withTimeoutOrNull(20_000) { locationProvider.locationUpdates(1000L).first() }
                    ?: throw IllegalStateException("Waiting for GPS. Try again outside.")
                val c = core ?: return@launch
                // "Your location", or a start you're already standing at ("Home"), is
                // where the trip begins, not somewhere to drive to first.
                val rest = if (startsHere(stops, here)) stops.drop(1) else stops
                destination = rest.lastOrNull()
                multiStop = rest.size > 1
                hazards = emptyList()
                spokenHazards.clear()
                lastRemaining = 0.0
                _addedStop.value = null
                lastWarningCheck = 0L
                _hazard.value = null
                _faster.value = null
                declinedAt = 0L
                fun stopAt(s: Stop) = Waypoint(coordinate = GeographicCoordinate(s.lat, s.lon), kind = WaypointKind.BREAK)
                // The way you picked is the way into the last stop. Going through it
                // first would drive the whole route, come back, and drive it again.
                val waypoints = rest.dropLast(1).map(::stopAt) + through.map(::viaPoint) + rest.takeLast(1).map(::stopAt)
                val route = c.getRoutes(here.toUserLocation(), waypoints).first()
                vm.setDestination(rest.lastOrNull()?.name)
                withContext(Dispatchers.Main) {
                    if (vm.navigationUiState.value.isNavigating()) c.replaceRoute(route) else c.startNavigation(route)
                }
                val shape = Maps.encodeShape(route.geometry.map { it.lat to it.lng })
                cameras = runCatching { Maps.cameras(app, shape) }.getOrDefault(emptyList())
                liveLoop(vm)
                trafficLoop(vm)
            } catch (e: Exception) {
                Log.w(TAG, "Couldn't start the trip", e)
                _error.value = when {
                    e is IllegalStateException -> e.message
                    e is com.stadiamaps.ferrostar.core.InvalidStatusCodeException && e.statusCode == 422 -> "No route from here to there."
                    else -> "Couldn't get a route. Check your connection."
                }
            }
        }
    }

    private fun takeHazards(rows: org.json.JSONArray, remaining: Double) {
        hazards = List(rows.length()) { i ->
            val h = rows.getJSONObject(i)
            Hazard(
                h.getString("id"), h.getString("label"), h.optString("text"), h.optString("from").takeIf { it.isNotEmpty() && it != "null" },
                h.getDouble("lat"), h.getDouble("lon"), Math.round(h.optDouble("delay_seconds", 0.0) / 60).toInt(), h.optBoolean("closed"),
                remaining - h.getDouble("along_km") * 1000,
            )
        }
    }

    /** The next reported thing on the road ahead, spoken once as you near it. Measured
     *  along the route: a road can wind away from a place before reaching it. */
    private fun checkHazards() {
        val remaining = model?.navigationUiState?.value?.progress?.distanceRemaining ?: return
        // A new, longer way: what was ahead on the old one no longer applies.
        if (remaining > lastRemaining + 300 && lastRemaining > 0) {
            hazards = emptyList()
            lastWarningCheck = 0L
        }
        lastRemaining = remaining
        val hit = hazards.map { it to remaining - it.remainingThere }.filter { it.second > -50 && it.second < 5000 }.minByOrNull { it.second }
        _hazard.value = hit?.let { HazardAlert(it.first, it.second.coerceAtLeast(0.0).toInt()) }
        if (hit != null && spokenHazards.add(hit.first.id)) {
            val km = Math.round(hit.second / 100.0) / 10.0
            val adds = if (hit.first.delayMinutes >= 1) ", adds about ${hit.first.delayMinutes} minutes" else ""
            speak("${hit.first.label} ahead, $km kilometres$adds.")
        }
    }

    private fun savedMuted(): Boolean =
        app.getSharedPreferences("maps_nav", Context.MODE_PRIVATE).getBoolean("muted", false)

    /** You turned the voice off, so it stays off, this trip and the next, until you turn it on. */
    fun setMuted(muted: Boolean) {
        app.getSharedPreferences("maps_nav", Context.MODE_PRIVATE).edit().putBoolean("muted", muted).apply()
        tts?.setMuted(muted)
    }

    /** Warn once for each camera ahead. */
    fun onLocation(lat: Double, lon: Double) {
        // Anything else that switched it back on doesn't get to decide.
        tts?.let { if (it.isMuted != savedMuted()) it.setMuted(savedMuted()) }
        checkHazards()
        val point = FloatArray(1)
        var nearest: Pair<Camera, Float>? = null
        for (c in cameras) {
            Location.distanceBetween(lat, lon, c.lat, c.lon, point)
            val closest = closestSoFar[c]
            if (closest == null || point[0] < closest) closestSoFar[c] = point[0]
            // Getting further away again: you've gone past it.
            val passed = closest != null && point[0] > closest + 30f
            if (!passed && point[0] < (nearest?.second ?: 500f)) nearest = c to point[0]
        }
        val hit = nearest
        if (hit == null) {
            _camera.value = CameraAlert.None
            return
        }
        val limit = hit.first.maxSpeed?.toInt()
        _camera.value = CameraAlert.Ahead(hit.second.toInt(), limit)
        if (warned.add(hit.first)) {
            speak(if (limit != null) "Speed camera ahead. $limit limit." else "Speed camera ahead.")
        }
    }

    private var speaker: TextToSpeech? = null

    // Called when the sentence with this id has finished, or couldn't be said.
    private val afterSpeech = java.util.concurrent.ConcurrentHashMap<String, () -> Unit>()
    private val utterances = java.util.concurrent.atomic.AtomicInteger()

    /** An answer you asked for, so it's spoken even with directions muted. */
    fun say(text: String, done: (() -> Unit)? = null) {
        talk(text, done)
    }

    /** You've moved on: stop saying it. */
    fun hush() {
        SpokenAnswer.stop()
        speaker?.stop()
    }

    /** Are you being given directions right now? */
    fun onTrip(): Boolean = model?.navigationUiState?.value?.isNavigating() == true

    private fun speak(text: String) {
        if (tts?.isMuted == true) return
        talk(text)
    }

    private fun talk(text: String, done: (() -> Unit)? = null) {
        val id = "promptly-${utterances.incrementAndGet()}"
        if (done != null) afterSpeech[id] = done
        val s = speaker
        if (s != null) {
            if (s.speak(text, TextToSpeech.QUEUE_ADD, null, id) != TextToSpeech.SUCCESS) spoke(id)
        } else {
            speaker = TextToSpeech(app) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    speaker?.language = Locale.forLanguageTag("en-AU")
                    speaker?.setOnUtteranceProgressListener(object : android.speech.tts.UtteranceProgressListener() {
                        override fun onStart(utteranceId: String?) = Unit
                        override fun onDone(utteranceId: String?) = spoke(utteranceId)
                        @Deprecated("Deprecated in Java")
                        override fun onError(utteranceId: String?) = spoke(utteranceId)
                        override fun onStop(utteranceId: String?, interrupted: Boolean) = spoke(utteranceId)
                    })
                    speaker?.speak(text, TextToSpeech.QUEUE_ADD, null, id)
                } else {
                    spoke(id)
                }
            }
        }
    }

    private fun spoke(id: String?) {
        id?.let { afterSpeech.remove(it)?.invoke() }
    }

    fun arrivedNow() {
        _arrived.value = true
        cameras = emptyList()
        _camera.value = CameraAlert.None
    }

    fun dismissArrival() {
        _arrived.value = false
    }

    private fun viaPoint(p: ThroughPoint): Waypoint {
        // Its direction of travel, so it lands on the right side of the road.
        val properties = p.heading?.let { JSONObject().put("heading", it).put("heading_tolerance", 45).toString().toByteArray() }
        return Waypoint(coordinate = GeographicCoordinate(p.lat, p.lon), kind = WaypointKind.VIA, properties = properties)
    }

    /** Go somewhere on the way to where you're going. */
    fun addStop(stop: Stop) {
        val to = destination ?: return
        reroute(listOf(stop, to), "Couldn't add that stop.") {
            multiStop = true
            _addedStop.value = stop
        }
    }

    fun removeStop() {
        val to = destination ?: return
        if (_addedStop.value == null) return
        reroute(listOf(to), "Couldn't take that stop off.") {
            multiStop = false
            _addedStop.value = null
        }
    }

    private fun reroute(stops: List<Stop>, failed: String, then: () -> Unit) {
        val c = core ?: return
        val vm = model ?: return
        vm.viewModelScope.launch(Dispatchers.IO) {
            runCatching {
                val here = vm.navigationUiState.value.location ?: return@launch
                val route = c.getRoutes(here, stops.map { Waypoint(coordinate = GeographicCoordinate(it.lat, it.lon), kind = WaypointKind.BREAK) }).first()
                withContext(Dispatchers.Main) { c.replaceRoute(route) }
                then()
                val shape = Maps.encodeShape(route.geometry.map { it.lat to it.lng })
                cameras = runCatching { Maps.cameras(app, shape) }.getOrDefault(cameras)
                hazards = emptyList()
                lastWarningCheck = 0L
                trafficLoop(vm)
            }.onFailure {
                Log.w(TAG, "Couldn't change the route", it)
                _error.value = failed
                say(failed)
            }
        }
    }

    /** The road left to drive, and where you are, for looking along it. */
    fun ahead(): Triple<String, Stop, Stop>? {
        val state = model?.navigationUiState?.value ?: return null
        val to = destination ?: return null
        val at = state.location ?: return null
        val line = state.remainingSteps.orEmpty().flatMap { it.geometry }.map { it.lat to it.lng }
        if (line.size < 2) return null
        return Triple(Maps.encodeShape(line), Stop(at.coordinates.lat, at.coordinates.lng, "You"), to)
    }

    /** What your server needs to know to answer you. */
    fun assistantState(): JSONObject {
        val body = JSONObject()
        val clock = java.time.format.DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)
        val zone = java.time.ZoneId.systemDefault()
        body.put("now", java.time.ZonedDateTime.now(zone).format(java.time.format.DateTimeFormatter.ofPattern("EEE d MMM yyyy, h:mm a", Locale.ENGLISH)))
        val state = model?.navigationUiState?.value ?: return body
        state.location?.let { at ->
            body.put("lat", at.coordinates.lat).put("lon", at.coordinates.lng)
            at.courseOverGround?.let { body.put("heading", it.degrees.toInt()) }
        }
        val progress = state.progress
        if (!state.isNavigating() || progress == null) return body
        val line = state.remainingSteps.orEmpty().flatMap { it.geometry }.map { it.lat to it.lng }
        if (line.size >= 2) body.put("shapes", org.json.JSONArray().put(Maps.encodeShape(line)))
        body.put("seconds", progress.durationRemaining).put("km", progress.distanceRemaining / 1000.0)
        destination?.let { body.put("to", JSONObject().put("lat", it.lat).put("lon", it.lon).put("name", it.name)) }
        val traffic = _traffic.value
        val arrive = traffic?.arriveAt ?: Instant.now().plusSeconds(progress.durationRemaining.toLong())
        body.put("arrive", arrive.atZone(zone).format(clock))
        traffic?.let { body.put("adds_minutes", it.addsMinutes) }
        _addedStop.value?.let { body.put("added_stop", it.name) }
        return body
    }

    /** Carry out what the assistant decided. */
    fun act(action: JSONObject) {
        fun stop(): Stop? = action.optJSONObject("stop")?.let { Stop(it.getDouble("lat"), it.getDouble("lon"), it.optString("name", "Stop")) }
        when (action.optString("type")) {
            "add_stop" -> stop()?.let(::addStop)
            "remove_stop" -> removeStop()
            "go" -> stop()?.let { start(listOf(it), lastOptions ?: TripOptions()) }
            "end_trip" -> this.stop()
        }
    }

    /** Take the quicker way that was offered. */
    fun takeFaster() {
        val offer = _faster.value ?: return
        val to = destination ?: return
        val c = core ?: return
        val vm = model ?: return
        _faster.value = null
        vm.viewModelScope.launch(Dispatchers.IO) {
            runCatching {
                val here = vm.navigationUiState.value.location ?: return@launch
                val waypoints = offer.through.map(::viaPoint) + Waypoint(coordinate = GeographicCoordinate(to.lat, to.lon), kind = WaypointKind.BREAK)
                val route = c.getRoutes(here, waypoints).first()
                withContext(Dispatchers.Main) { c.replaceRoute(route) }
                val shape = Maps.encodeShape(route.geometry.map { it.lat to it.lng })
                cameras = runCatching { Maps.cameras(app, shape) }.getOrDefault(cameras)
                speak("Taking the faster route.")
                // Traffic on the new road, right away.
                trafficLoop(vm)
            }.onFailure {
                Log.w(TAG, "Couldn't change route", it)
                _error.value = "Couldn't change route. Staying on this one."
            }
        }
    }

    /** No thanks: don't ask again for a while, unless it gets much better. */
    fun declineFaster() {
        declinedSaves = _faster.value?.savesMinutes ?: 0
        declinedAt = System.currentTimeMillis()
        _faster.value = null
    }

    private fun offerFaster(found: JSONObject?) {
        if (found == null) {
            _faster.value = null
            return
        }
        val saves = Math.round(found.getDouble("saves_seconds") / 60).toInt()
        val reason = found.optString("reason").takeIf { it.isNotEmpty() && it != "null" }
        val quiet = System.currentTimeMillis() - declinedAt < 600_000
        if (quiet && reason == null && saves < declinedSaves + 3) return
        val rows = found.optJSONArray("through")
        val through = List(rows?.length() ?: 0) { i ->
            val p = rows!!.getJSONObject(i)
            ThroughPoint(p.getDouble("lat"), p.getDouble("lon"), if (p.isNull("heading")) null else p.getInt("heading"))
        }
        val isNew = _faster.value == null
        _faster.value = FasterRoute(saves, found.optString("via_name").takeIf { it.isNotEmpty() && it != "null" }, through, reason)
        if (isNew) speak(if (reason != null) "$reason. There's a way around it." else "A faster route is available. It saves $saves minutes.")
    }

    // A check going wrong costs that check, never the drive.
    private val keepDriving = kotlinx.coroutines.CoroutineExceptionHandler { _, e -> Log.w(TAG, "Background check stopped", e) }

    /** Ask your server about traffic on the road ahead every few minutes. Only
     *  your server is told where you're going. */
    private fun trafficLoop(vm: TripModel) {
        trafficJob?.cancel()
        _traffic.value = null
        trafficJob = vm.viewModelScope.launch(Dispatchers.IO + keepDriving) {
            var asked = false
            while (isActive) {
                val state = vm.navigationUiState.value
                val progress = state.progress
                if (!state.isNavigating() || progress == null) break
                val ahead = state.remainingSteps.orEmpty().flatMap { it.geometry }.map { it.lat to it.lng }
                if (ahead.size >= 2) {
                    val body = JSONObject()
                        .put("shapes", org.json.JSONArray().put(Maps.encodeShape(ahead)))
                        .put("seconds", progress.durationRemaining)
                        .put("km", progress.distanceRemaining / 1000.0)
                    val to = destination
                    val at = state.location
                    asked = at != null
                    if (to != null && at != null && !multiStop) {
                        body.put("lat", at.coordinates.lat).put("lon", at.coordinates.lng)
                            .put("to", JSONObject().put("lat", to.lat).put("lon", to.lon).put("name", to.name))
                            .put("mode", lastOptions?.mode ?: "drive")
                        at.courseOverGround?.let { body.put("heading", it.degrees.toInt()) }
                    }
                    // Incident checks are scarce: every 10 minutes, not every traffic check.
                    val checkWarnings = System.currentTimeMillis() - lastWarningCheck >= 600_000
                    if (checkWarnings) body.put("warnings", true)
                    runCatching {
                        val answer = Maps.send(app, "POST", "/api/maps/traffic/route", body)
                        val found = answer.optJSONObject("traffic")
                        _traffic.value = found?.let {
                            val rows = it.optJSONArray("jams")
                            val jams = List(rows?.length() ?: 0) { i ->
                                val j = rows!!.getJSONObject(i)
                                val line = j.getJSONArray("line")
                                Jam(j.getString("kind"), List(line.length()) { k -> line.getJSONArray(k).let { p -> p.getDouble(0) to p.getDouble(1) } })
                            }
                            TrafficNow(Math.round(it.getDouble("adds_seconds") / 60).toInt(), Instant.now().plusSeconds(it.getLong("seconds")), jams)
                        }
                        offerFaster(answer.optJSONObject("faster"))
                        if (checkWarnings) {
                            lastWarningCheck = System.currentTimeMillis()
                            answer.optJSONArray("incidents")?.let { takeHazards(it, progress.distanceRemaining) }
                        }
                    }.onFailure { Log.w(TAG, "Traffic check failed: ${it.message}") }
                }
                // No position yet means no faster-route check: try again soon.
                delay(if (vm.navigationUiState.value.location == null || !asked) 15_000 else 180_000)
            }
        }
    }

    /** Tell the people you're sharing with, while there are any. */
    private fun liveLoop(vm: TripModel) {
        liveJob?.cancel()
        liveJob = vm.viewModelScope.launch(Dispatchers.IO + keepDriving) {
            while (isActive) {
                val state = vm.navigationUiState.value
                val at = state.location
                if (!state.isNavigating() || at == null) break
                val body = JSONObject()
                    .put("lat", at.coordinates.lat)
                    .put("lon", at.coordinates.lng)
                    .put("speed", at.speed?.value ?: JSONObject.NULL)
                    .put("destination", state.destination ?: JSONObject.NULL)
                state.progress?.let { body.put("eta", Instant.now().plusSeconds(it.durationRemaining.toLong()).toString()) }
                val sharing = runCatching { Maps.send(app, "POST", "/api/maps/live", body).optBoolean("sharing") }.getOrDefault(true)
                delay(if (sharing) 30_000 else 300_000)
            }
        }
    }

    fun stop() {
        _addedStop.value = null
        liveJob?.cancel()
        trafficJob?.cancel()
        _traffic.value = null
        _faster.value = null
        hazards = emptyList()
        _hazard.value = null
        cameras = emptyList()
        _camera.value = CameraAlert.None
        model?.stopNavigation()
    }
}

/** The trip's state, with your own location shown before it starts. */
class TripModel(core: FerrostarCore) : DefaultNavigationViewModel(core, valhallaExtendedOSRMAnnotationPublisher()) {
    private val ferrostar = core

    override fun toggleMute() {
        val observer = ferrostar.spokenInstructionObserver ?: return
        Nav.setMuted(!observer.isMuted)
    }

    override fun stopNavigation() {
        ferrostar.stopNavigation()
    }
}
