package org.promptly.sync.maps

import android.annotation.SuppressLint
import android.content.Context
import android.location.LocationManager
import kotlin.math.ln
import org.json.JSONArray

/**
 * Where a map opens before anyone has touched it. In this order:
 *
 *  1. where you are: the phone's last known position, when location is already
 *     allowed (nothing here asks for it), and then the live fix;
 *  2. the maps your server keeps (`bounds` from /api/maps/config, remembered on
 *     the phone so it works with no signal);
 *  3. the whole world.
 *
 * Never a fixed country: a server can keep any country's map.
 */
object MapStart {
    /** A camera position: centre and zoom. [box] is west, south, east, north when the
     *  view is "all of this", so the caller can fit it properly once the map is there. */
    data class View(val lon: Double, val lat: Double, val zoom: Double, val box: DoubleArray? = null, val from: From) {
        override fun equals(other: Any?) = other is View && lon == other.lon && lat == other.lat && zoom == other.zoom && from == other.from
        override fun hashCode() = listOf(lon, lat, zoom, from).hashCode()
    }

    enum class From { HERE, SERVER, WORLD }

    val WORLD = View(lon = 0.0, lat = 20.0, zoom = 0.8, from = From.WORLD)

    /**
     * The opening view. [here] is latitude, longitude; [bounds] is west, south, east,
     * north. [zoomHere] is how close to open on your own position.
     */
    fun view(here: Pair<Double, Double>?, bounds: DoubleArray?, zoomHere: Double): View {
        if (here != null && valid(here.first, here.second)) return View(here.second, here.first, zoomHere, from = From.HERE)
        val box = bounds?.takeIf { validBox(it) } ?: return WORLD
        return View((box[0] + box[2]) / 2, (box[1] + box[3]) / 2, zoomFor(box), box, From.SERVER)
    }

    /** `bounds` as the server sends it ([west, south, east, north]), or null when it
     *  isn't there or isn't a box. */
    fun parseBounds(raw: JSONArray?): DoubleArray? {
        if (raw == null || raw.length() != 4) return null
        val box = DoubleArray(4) { raw.optDouble(it, Double.NaN) }
        return box.takeIf { validBox(it) }
    }

    fun parseBounds(text: String?): DoubleArray? =
        text?.takeIf { it.isNotBlank() }?.let { runCatching { parseBounds(JSONArray(it)) }.getOrNull() }

    fun validBox(box: DoubleArray): Boolean =
        box.size == 4 && box.all { it.isFinite() } && valid(box[1], box[0]) && valid(box[3], box[2]) && box[2] > box[0] && box[3] > box[1]

    private fun valid(lat: Double, lon: Double) = lat.isFinite() && lon.isFinite() && lat in -90.0..90.0 && lon in -180.0..180.0 && !(lat == 0.0 && lon == 0.0)

    /** A zoom that shows the whole box on a phone held upright (a rough fit: the
     *  caller fits it exactly once the map has a size). */
    fun zoomFor(box: DoubleArray): Double {
        val across = ln(360.0 / (box[2] - box[0])) / ln(2.0)
        val up = ln(170.0 / (box[3] - box[1])) / ln(2.0)
        return (minOf(across, up) - 0.6).coerceIn(0.8, 12.0)
    }

    // ---- What the phone remembers and knows right now ----

    private const val PREFS = "maps-start"
    private const val KEY_BOUNDS = "server-bounds"

    /** The server's maps as last heard (works with no signal), or null. */
    fun savedBounds(context: Context): DoubleArray? =
        parseBounds(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_BOUNDS, null))

    /** Remember what /api/maps/config said. A server with no map yet says null, and
     *  that is remembered too (its old maps are gone). */
    fun saveBounds(context: Context, raw: JSONArray?) {
        val box = parseBounds(raw)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply {
            if (box == null) remove(KEY_BOUNDS) else putString(KEY_BOUNDS, JSONArray(box.toList()).toString())
        }.apply()
    }

    /** The phone's last known position as latitude, longitude, read at once. Null when
     *  location isn't allowed (it is never asked for here) or nothing is known yet. */
    @SuppressLint("MissingPermission") // Without the permission this throws, and that is "not known".
    fun lastKnown(context: Context): Pair<Double, Double>? {
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
        return runCatching {
            manager.allProviders
                .mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }
                .maxByOrNull { it.elapsedRealtimeNanos }
                ?.let { it.latitude to it.longitude }
        }.getOrNull()
    }

    /** The centre of the server's maps as latitude, longitude, when it has any. */
    fun centre(bounds: DoubleArray?): Pair<Double, Double>? =
        bounds?.takeIf { validBox(it) }?.let { (it[1] + it[3]) / 2 to (it[0] + it[2]) / 2 }
}
