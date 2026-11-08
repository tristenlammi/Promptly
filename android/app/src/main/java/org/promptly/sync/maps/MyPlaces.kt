package org.promptly.sync.maps

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.Locale

/** A way you usually drive somewhere (P Maps' "usual routes"). */
data class UsualRoute(val id: String, val name: String?, val from: Stop, val to: Stop)

/**
 * Your saved places, recents, where you parked and your usual routes, kept on the
 * phone from the last good answer of `/api/maps/places` and `/api/maps/preferred`, so
 * Home is still Home with no signal. Each copy is tagged with the server it came
 * from, and another server's copy is never shown.
 *
 * Plain files, so the rules are tested on the JVM.
 */
class PlacesCache(private val dir: File) {
    private val placesFile get() = File(dir, "maps-places.json")
    private val routesFile get() = File(dir, "maps-preferred.json")

    /** The server's `/places` answer, as last saved for [server]. */
    fun places(server: String): JSONObject? = read(placesFile, server)?.optJSONObject("places")

    fun routes(server: String): List<UsualRoute> {
        val rows = read(routesFile, server)?.optJSONObject("preferred")?.optJSONArray("routes") ?: return emptyList()
        return List(rows.length()) { rows.getJSONObject(it) }.mapNotNull { r ->
            runCatching {
                fun stop(j: JSONObject, fallback: String) = Stop(j.getDouble("lat"), j.getDouble("lon"), text(j, "name") ?: fallback, "usual")
                UsualRoute(r.getString("id"), text(r, "name"), stop(r.getJSONObject("from"), "Start"), stop(r.getJSONObject("to"), "Destination"))
            }.getOrNull()
        }
    }

    fun savePlaces(server: String, places: JSONObject) = write(placesFile, JSONObject().put("server", server).put("places", places))

    fun saveRoutes(server: String, preferred: JSONObject) = write(routesFile, JSONObject().put("server", server).put("preferred", preferred))

    /** A place you just picked, first in the recents kept here (the server keeps its own). */
    fun addRecent(server: String, stop: Stop) {
        val places = places(server) ?: JSONObject().put("places", JSONArray()).put("recents", JSONArray()).put("parked", JSONObject.NULL)
        val old = places.optJSONArray("recents") ?: JSONArray()
        val key = key(stop.lat, stop.lon)
        val recents = JSONArray().put(
            JSONObject().put("name", stop.name).put("address", stop.address ?: JSONObject.NULL).put("lat", stop.lat).put("lon", stop.lon),
        )
        for (i in 0 until old.length()) {
            val r = old.getJSONObject(i)
            if (key(r.getDouble("lat"), r.getDouble("lon")) != key && recents.length() < MAX_RECENTS) recents.put(r)
        }
        savePlaces(server, places.put("recents", recents))
    }

    /** Where you parked, as the phone last saved it (offline too). */
    fun setParked(server: String, lat: Double, lon: Double, at: String) {
        val places = places(server) ?: JSONObject().put("places", JSONArray()).put("recents", JSONArray())
        savePlaces(server, places.put("parked", JSONObject().put("lat", lat).put("lon", lon).put("note", JSONObject.NULL).put("at", at)))
    }

    private fun read(file: File, server: String): JSONObject? {
        val j = runCatching { JSONObject(file.readText()) }.getOrNull() ?: return null
        // Only this server's places, never another account's.
        return j.takeIf { it.optString("server") == server }
    }

    private fun write(file: File, json: JSONObject) {
        dir.mkdirs()
        val tmp = File(dir, file.name + ".new")
        tmp.writeText(json.toString())
        if (!tmp.renameTo(file)) {
            file.writeText(json.toString())
            tmp.delete()
        }
    }

    companion object {
        const val MAX_RECENTS = 10

        private fun key(lat: Double, lon: Double) = "%.4f,%.4f".format(Locale.ROOT, lat, lon)

        private fun text(row: JSONObject, key: String): String? =
            if (row.isNull(key)) null else row.optString(key).takeIf { it.isNotBlank() }

        /** Your own places whose words all match [query] (the server's `_matches`): Home and
         *  Work by those words too, "my car" for where you parked, and usual routes by name. */
        fun matching(places: List<Stop>, routes: List<UsualRoute>, query: String): List<Stop> {
            val words = query.lowercase(Locale.ROOT).split(Regex("\\s+")).filter { it.isNotEmpty() }
            if (words.isEmpty()) return emptyList()
            val q = words.joinToString(" ")
            fun matches(vararg fields: String?) = fields.filterNotNull().joinToString(" ").lowercase(Locale.ROOT).let { t -> words.all { it in t } }
            val out = mutableListOf<Stop>()
            if (q in setOf("my car", "the car", "car", "where i parked", "parked", "my parked car")) out += places.filter { it.kind == "parked" }
            out += places.filter { it.kind != "parked" && matches(it.name, it.address, if (it.kind == "home" || it.kind == "work") it.kind else null) }
            out += routes.filter { matches(it.name, it.to.name) }.map { it.to.copy(address = it.name?.let { n -> "Usual route · $n" } ?: "Usual route") }
            return out.distinctBy { key(it.lat, it.lon) }
        }
    }
}

/** [PlacesCache] for this phone's sign-in. */
object MyPlaces {
    private const val TAG = "PromptlyMaps"

    fun cache(context: Context) = PlacesCache(context.applicationContext.filesDir)

    /** Your places: from your server (saved for later), else the copy from last time. */
    suspend fun load(context: Context, timeoutSeconds: Long = Maps.CAR_TIMEOUT_SECONDS): List<Stop> = withContext(Dispatchers.IO) {
        val server = Maps.server(context) ?: throw IOException("Not signed in")
        val cache = cache(context)
        val mine = try {
            if (!org.promptly.sync.maps.offline.Offline.online(context)) throw IOException("No connection")
            Maps.get(context, "/api/maps/places", timeoutSeconds).also { cache.savePlaces(server, it) }
        } catch (e: IOException) {
            cache.places(server) ?: throw e
        }
        Maps.placesFrom(mine)
    }

    /** What's kept on the phone, with no server call. */
    fun saved(context: Context): List<Stop> {
        val server = Maps.server(context) ?: return emptyList()
        return cache(context).places(server)?.let { runCatching { Maps.placesFrom(it) }.getOrNull() }.orEmpty()
    }

    fun usualRoutes(context: Context): List<UsualRoute> {
        val server = Maps.server(context) ?: return emptyList()
        return cache(context).routes(server)
    }

    /** Both lists from your server, kept for no signal. Quietly does nothing without one. */
    suspend fun refresh(context: Context) = withContext(Dispatchers.IO) {
        val server = Maps.server(context) ?: return@withContext
        if (!org.promptly.sync.maps.offline.Offline.online(context)) return@withContext
        val cache = cache(context)
        runCatching { cache.savePlaces(server, Maps.get(context, "/api/maps/places", Maps.CAR_TIMEOUT_SECONDS)) }
            .onFailure { Log.i(TAG, "Places not refreshed: ${it.message}") }
        runCatching { cache.saveRoutes(server, Maps.get(context, "/api/maps/preferred", Maps.CAR_TIMEOUT_SECONDS)) }
            .onFailure { Log.i(TAG, "Usual routes not refreshed: ${it.message}") }
    }

    /** You picked [stop]: it's a recent here at once, and on your server when it can be told. */
    suspend fun picked(context: Context, stop: Stop) = withContext(Dispatchers.IO) {
        val server = Maps.server(context) ?: return@withContext
        if (stop.kind in setOf("home", "work", "parked")) return@withContext
        cache(context).addRecent(server, stop)
        if (org.promptly.sync.maps.offline.Offline.online(context)) {
            val body = JSONObject().put("name", stop.name.take(200)).put("lat", stop.lat).put("lon", stop.lon)
            stop.address?.let { body.put("address", it.take(400)) }
            runCatching { Maps.send(context, "POST", "/api/maps/recents", body, Maps.CAR_TIMEOUT_SECONDS) }
        }
    }
}
