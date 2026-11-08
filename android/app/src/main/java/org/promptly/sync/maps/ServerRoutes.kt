package org.promptly.sync.maps

import android.content.Context
import com.stadiamaps.ferrostar.core.CustomRouteProvider
import com.stadiamaps.ferrostar.core.InvalidStatusCodeException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import uniffi.ferrostar.Route
import uniffi.ferrostar.RouteRequest
import uniffi.ferrostar.UserLocation
import uniffi.ferrostar.Waypoint
import uniffi.ferrostar.createOsrmResponseParser
import uniffi.ferrostar.createValhallaRequestGenerator
import java.io.IOException

/** Turn-by-turn routes from your server, with the options of the trip in hand.
 *
 *  One of these sits behind the one navigation core for the life of the app, so the
 *  phone's driving screen and the car's always look at the same trip. Changing
 *  options (tolls, highways, walking) changes the next request, not the core.
 *
 *  Ferrostar asks here by itself after a wrong turn. Those requests say so, and the
 *  server only checks for road closures on them every few minutes, so a bad day of
 *  wrong turns doesn't use up the closure checks. */
class ServerRoutes(private val app: Context) : CustomRouteProvider {
    @Volatile
    var options: TripOptions = TripOptions()

    private val parser by lazy { createOsrmResponseParser(6u) }

    /** Ferrostar's own call: only after you've left the route. */
    override suspend fun getRoutes(userLocation: UserLocation, waypoints: List<Waypoint>): List<Route> =
        fetch(userLocation, waypoints, reroute = true)

    /** A route you asked for: starting a trip, adding a stop, taking a faster way. */
    suspend fun fetch(userLocation: UserLocation, waypoints: List<Waypoint>, reroute: Boolean = false): List<Route> = withContext(Dispatchers.IO) {
        val server = Maps.server(app) ?: throw IOException("Not signed in")
        val wanted = options
        val generator = createValhallaRequestGenerator("$server/api/maps/navigate/route", profileOf(wanted), requestOptions(wanted).toString())
        val request = generator.generateRequest(userLocation, waypoints) as? RouteRequest.HttpPost
            ?: throw IOException("Unexpected route request")
        val call = Request.Builder()
            .url(request.url)
            .post(request.body.toRequestBody(JSON))
            .apply {
                request.headers.forEach { (k, v) -> header(k, v) }
                if (reroute) header(REROUTE_HEADER, "1")
            }
            .build()
        // Quick to fail on one bar of signal, so the screen can say so and try again.
        Maps.client(app, Maps.DRIVING_TIMEOUT_SECONDS).newCall(call).execute().use { r ->
            if (!r.isSuccessful) throw InvalidStatusCodeException(r.code)
            parser.parseResponse(r.body.bytes())
        }
    }

    companion object {
        const val REROUTE_HEADER = "X-Promptly-Reroute"
        private val JSON = "application/json".toMediaType()

        fun profileOf(options: TripOptions): String = when (options.mode) {
            "walk" -> "pedestrian"
            "cycle" -> "bicycle"
            else -> "auto"
        }

        /** What Valhalla is told on top of the stops: the same as the web app's routes. */
        fun requestOptions(options: TripOptions): JSONObject {
            val profile = profileOf(options)
            val costing = JSONObject()
            if (options.tolls) costing.put("use_tolls", 0.0)
            if (options.highways && profile == "auto") costing.put("use_highways", 0.0)
            if (options.ferries) costing.put("use_ferry", 0.0)
            return JSONObject()
                .put("costing_options", JSONObject().put(profile, costing))
                .put("units", "kilometers")
                .put("language", "en-GB")
        }
    }
}
