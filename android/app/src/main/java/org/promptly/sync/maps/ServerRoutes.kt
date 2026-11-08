package org.promptly.sync.maps

import org.json.JSONObject

/** What a turn-by-turn route request says on top of its stops: the same for your
 *  server and for the phone's own engine ([HybridRouteProvider]). */
object ServerRoutes {
    /** Sent with Ferrostar's own requests after a wrong turn: the server only checks for
     *  road closures on those every few minutes, so a bad day of wrong turns doesn't use
     *  up the closure checks. */
    const val REROUTE_HEADER = "X-Promptly-Reroute"

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
