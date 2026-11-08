package org.promptly.sync.maps.offline

import android.util.Log
import com.stadiamaps.ferrostar.core.CustomRouteProvider
import com.valhalla.valhalla.Valhalla
import org.json.JSONObject
import uniffi.ferrostar.Route
import uniffi.ferrostar.RouteRequest
import uniffi.ferrostar.UserLocation
import uniffi.ferrostar.Waypoint
import uniffi.ferrostar.createOsrmResponseParser
import uniffi.ferrostar.createValhallaRequestGenerator
import java.io.File

/** WP-M0 spike: Valhalla on the phone, behind Ferrostar's own request generator
 *  and OSRM parser, so the request body is the same JSON the server gets today.
 *  WP-M5 turns this into LocalRouter + HybridRouteProvider. */
class SpikeRouter(private val configFile: File) : CustomRouteProvider, AutoCloseable {
    private val engine = Valhalla(configFile.absolutePath)
    private val parser = createOsrmResponseParser(6u)

    // The same options Nav.viewModel() hands WellKnownRouteProvider.Valhalla.
    private val generator = createValhallaRequestGenerator(
        "https://local.invalid/route",
        "auto",
        JSONObject()
            .put("costing_options", JSONObject().put("auto", JSONObject()))
            .put("units", "kilometers")
            .put("language", "en-GB")
            .toString(),
    )

    var lastMillis = 0L
        private set
    var lastBody: String = ""
        private set

    override suspend fun getRoutes(userLocation: UserLocation, waypoints: List<Waypoint>): List<Route> {
        val request = generator.generateRequest(userLocation, waypoints)
        val body = when (request) {
            is RouteRequest.HttpPost -> String(request.body)
            else -> error("Valhalla's generator should always POST")
        }
        lastBody = body
        val started = System.nanoTime()
        val answer = engine.routeRaw(body)
        lastMillis = (System.nanoTime() - started) / 1_000_000
        Log.i(TAG, "Local route in $lastMillis ms, ${answer.length} bytes")
        return parser.parseResponse(answer.toByteArray())
    }

    override fun close() = engine.close()

    companion object {
        private const val TAG = "PromptlyOffline"

        /** Valhalla's own defaults for the bundled version, pointed at a tile folder
         *  (or a tar), with the tile cache capped for a phone. */
        fun writeConfig(out: File, tileDir: File?, tileTar: File?, cacheBytes: Long = 96L * 1024 * 1024): File {
            val defaults = Valhalla::class.java.getResourceAsStream("/com/valhalla/valhalla/default.json")!!
                .use { it.readBytes().toString(Charsets.UTF_8) }
            val config = JSONObject(defaults)
            val mjolnir = config.getJSONObject("mjolnir")
            mjolnir.put("max_cache_size", cacheBytes)
            if (tileDir != null) mjolnir.put("tile_dir", tileDir.absolutePath) else mjolnir.remove("tile_dir")
            if (tileTar != null) mjolnir.put("tile_extract", tileTar.absolutePath) else mjolnir.remove("tile_extract")
            // Nothing on the phone has these, and Valhalla skips what it isn't given.
            listOf("traffic_extract", "admin", "timezone", "landmarks", "transit_dir").forEach { mjolnir.remove(it) }
            out.writeText(config.toString())
            return out
        }
    }
}
