package org.promptly.sync.maps

import android.content.Context
import android.location.Location
import android.util.Log
import com.stadiamaps.ferrostar.core.location.toUserLocation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.promptly.sync.maps.offline.LocalRouter
import org.promptly.sync.maps.offline.Offline
import uniffi.ferrostar.GeographicCoordinate
import uniffi.ferrostar.RouteRequest
import uniffi.ferrostar.Waypoint
import uniffi.ferrostar.WaypointKind
import uniffi.ferrostar.createValhallaRequestGenerator
import java.io.IOException

/** The ways from here to a place, before a trip starts: the car's route preview and the
 *  phone's offline map ("Drive") both ask here. */
object Routing {
    private const val TAG = "PromptlyMaps"

    /** How long the preview waits for your server before the phone answers. */
    private const val PREVIEW_TIMEOUT_SECONDS = 10L

    /** Your server's routes (with traffic), or with no signal the phone's own from the
     *  downloaded squares (up to three, no traffic). Throws [OfflineRouteUnavailable] when
     *  neither can answer, and "Server said 422" when there's no way there at all. */
    suspend fun plan(context: Context, here: Location, stop: Stop, options: TripOptions): List<CarRoute> = withContext(Dispatchers.IO) {
        val stops = JSONArray()
            .put(JSONObject().put("lat", here.latitude).put("lon", here.longitude).put("name", "Your location"))
            .put(JSONObject().put("lat", stop.lat).put("lon", stop.lon).put("name", stop.name))
        val body = JSONObject().put("stops", stops).put("mode", "drive")
            .put("avoid_tolls", options.tolls).put("avoid_highways", options.highways).put("avoid_ferries", options.ferries)
        val problem = if (!Offline.online(context) || Maps.server(context) == null) IOException("No connection") else try {
            return@withContext CarPreview.parseRoutes(Maps.send(context, "POST", "/api/maps/route", body, PREVIEW_TIMEOUT_SECONDS))
        } catch (e: IOException) {
            // "Server said 422" is an answer (no route), not a missing server.
            if (e.message?.startsWith("Server said 4") == true && e.message?.startsWith("Server said 401") != true) throw e
            e
        }
        val started = System.nanoTime()
        phoneRoutes(context, here, stop, options).also {
            Log.i(TAG, "Route preview from the phone (${problem.message}): ${it.size} routes in ${(System.nanoTime() - started) / 1_000_000} ms")
        }
    }

    /** Up to three ways there from Valhalla on the phone, asked the same way as the server. */
    private fun phoneRoutes(context: Context, here: Location, stop: Stop, options: TripOptions): List<CarRoute> {
        val ask = ServerRoutes.requestOptions(options).put("alternates", 2)
        val generator = createValhallaRequestGenerator("https://promptly.invalid/route", ServerRoutes.profileOf(options), ask.toString())
        val request = generator.generateRequest(here.toUserLocation(), listOf(Waypoint(coordinate = GeographicCoordinate(stop.lat, stop.lon), kind = WaypointKind.BREAK)))
            as? RouteRequest.HttpPost ?: throw IOException("Unexpected route request")
        val cells = HybridRouting.cellsOf(listOf(here.latitude to here.longitude, stop.lat to stop.lon))
        val answer = try {
            Offline.router(context).route(String(request.body), cells)
        } catch (e: LocalRouter.MissingSquares) {
            throw OfflineRouteUnavailable(true, e.cells, e)
        } catch (e: LocalRouter.NoRoute) {
            throw OfflineRouteUnavailable(false, emptyList(), e)
        }
        return CarPreview.parsePhoneRoutes(JSONObject(answer))
    }
}
