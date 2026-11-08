package org.promptly.sync.maps

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONObject
import org.promptly.sync.maps.offline.LocalSearch
import org.promptly.sync.maps.offline.Offline
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** Asks your server's search; throws [HttpStatus] or an [IOException]. */
fun interface SearchServer {
    fun search(query: String, near: Pair<Double, Double>?, timeoutMillis: Long): List<Stop>
}

/**
 * Search, your server first and the phone when it can't answer: the server gets a
 * short [timeoutMillis] (a search you're waiting on, on one bar of signal), then the
 * same words go to the phone's offline search. "Nothing found" from the server is an
 * answer; a 4xx about the words is too (no results, not a reason to look offline).
 *
 * Plain code, so the order and the fallbacks are tested on the JVM.
 */
class HybridSearch(
    private val server: SearchServer?,
    private val phone: (String, Pair<Double, Double>?) -> List<Stop>,
    private val timeoutMillis: Long = SERVER_TIMEOUT_MILLIS,
) {
    /** What was found, and whether it came from the phone ([offline]). */
    data class Found(val stops: List<Stop>, val offline: Boolean, val problem: Exception? = null)

    fun find(query: String, near: Pair<Double, Double>?): Found {
        var problem: Exception? = null
        if (server != null) {
            try {
                return Found(server.search(query, near, timeoutMillis), false)
            } catch (e: HttpStatus) {
                // Signed out, overloaded or broken: the phone answers. Anything else is about the words.
                if (e.code in 400..499 && e.code !in setOf(401, 403, 408, 429)) return Found(emptyList(), false, e)
                problem = e
            } catch (e: IOException) {
                problem = e
            }
        }
        return Found(phone(query, near).map { it.copy(offline = true) }, true, problem)
    }

    companion object {
        /** How long a search waits for your server before the phone answers. */
        const val SERVER_TIMEOUT_MILLIS = 4_000L
    }
}

/** Search for the phone's screens and the car's: [HybridSearch] with this phone's sign-in,
 *  saved places and offline areas. */
object PlaceSearch {
    private const val TAG = "PromptlyMaps"

    /** What was found, what to say when it's nothing, and (from the phone) why it came from there. */
    data class Result(val stops: List<Stop>, val offline: Boolean, val empty: String, val from: String? = null)

    suspend fun find(context: Context, query: String, near: Pair<Double, Double>?): Result = withContext(Dispatchers.IO) {
        val app = context.applicationContext
        val server = if (Maps.server(app) != null && Offline.online(app)) SearchServer { q, at, ms -> serverSearch(app, q, at, ms) } else null
        val started = System.nanoTime()
        val found = HybridSearch(server, { q, at -> onPhone(app, q, at) }).find(query.trim(), near)
        val ms = (System.nanoTime() - started) / 1_000_000
        Log.i(TAG, "Search: ${found.stops.size} from the ${if (found.offline) "phone" else "server"} in $ms ms" + (found.problem?.let { " (${it.message})" } ?: ""))
        val from = when {
            !found.offline -> null
            server == null -> "No signal · results from your offline areas"
            else -> "Your server didn't answer · results from your offline areas"
        }
        Result(found.stops, found.offline, if (found.offline) nothingOffline(app, server != null) else "Nothing found for that.", from)
    }

    /** Your own places that match, then the downloaded squares. */
    fun onPhone(context: Context, query: String, near: Pair<Double, Double>?): List<Stop> {
        val mine = PlacesCache.matching(MyPlaces.saved(context), MyPlaces.usualRoutes(context), query)
        val map = LocalSearch(Offline.store(context).search.file).find(query, near)
        return (mine + map).distinctBy { "%.4f,%.4f".format(java.util.Locale.ROOT, it.lat, it.lon) }
    }

    /** "Nothing found offline. You have offline areas for Sydney and Mudgee." */
    fun nothingOffline(context: Context, online: Boolean = false): String {
        val store = Offline.store(context)
        val names = Offline.saved(context)?.areas.orEmpty()
            .filter { it.id !in store.state.deleted && store.has(it.cells, false) }
            .map { it.name }
        return when {
            names.isEmpty() && online -> "Your server didn't answer, and there are no offline areas on this phone yet."
            names.isEmpty() -> "No signal, and there are no offline areas on this phone yet."
            names.size == 1 -> "Nothing found offline. You have an offline area for ${names[0]}."
            else -> "Nothing found offline. You have offline areas for ${names.dropLast(1).joinToString(", ")} and ${names.last()}."
        }
    }

    private fun serverSearch(context: Context, query: String, near: Pair<Double, Double>?, timeoutMillis: Long): List<Stop> {
        val server = Maps.server(context) ?: throw IOException("Not signed in")
        val q = URLEncoder.encode(query, "UTF-8")
        val at = near?.let { "&lat=${it.first}&lon=${it.second}" } ?: ""
        val client = Maps.client(context, maxOf(1L, timeoutMillis / 1000)).newBuilder()
            .connectTimeout(minOf(timeoutMillis, 3_000L), TimeUnit.MILLISECONDS)
            .readTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
            .callTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
            .build()
        client.newCall(Request.Builder().url("$server/api/maps/search?q=$q$at").build()).execute().use { r ->
            if (!r.isSuccessful) throw HttpStatus(r.code)
            return Maps.stopsFrom(JSONObject(r.body.string()))
        }
    }
}
