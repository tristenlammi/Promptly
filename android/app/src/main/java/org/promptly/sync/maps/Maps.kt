package org.promptly.sync.maps

import android.content.Context
import android.content.res.Configuration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Credentials
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.promptly.sync.Api
import org.promptly.sync.PairLink
import org.promptly.sync.Store
import org.promptly.sync.maps.offline.MapTiles
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/** One stop on a trip. */
data class Stop(val lat: Double, val lon: Double, val name: String, val kind: String? = null, val address: String? = null)

/** Talking to the P Maps part of your Promptly server, and nothing else. The
 *  phone signs in with the same kind of app password as photo backup. */
object Maps {
    private val JSON = "application/json".toMediaType()

    private fun account(context: Context): Store.Account? = Store(context).account

    fun server(context: Context): String? = account(context)?.server

    /** How long anything the driving screens wait on may take, on one bar of signal:
     *  long enough for a route on a slow connection, short enough to say so and retry. */
    const val DRIVING_TIMEOUT_SECONDS = 20L

    /** The car's lists and search: you're looking at the screen, waiting. */
    const val CAR_TIMEOUT_SECONDS = 12L

    /** An HTTP client that signs each request in, giving up after [timeoutSeconds]. */
    fun client(context: Context, timeoutSeconds: Long = 40): OkHttpClient {
        val auth = account(context)
        return OkHttpClient.Builder()
            .connectTimeout(minOf(10L, timeoutSeconds / 2), TimeUnit.SECONDS)
            .readTimeout(minOf(30L, timeoutSeconds), TimeUnit.SECONDS)
            .callTimeout(timeoutSeconds, TimeUnit.SECONDS)
            .addInterceptor(Interceptor { chain ->
                val request = chain.request()
                val signed = if (auth != null && request.url.toString().startsWith(auth.server)) {
                    request.newBuilder().header("Authorization", Credentials.basic(auth.username, auth.password)).build()
                } else request
                chain.proceed(signed)
            })
            .build()
    }

    private fun call(context: Context, timeoutSeconds: Long = 40, build: Request.Builder.() -> Unit): Pair<Int, String> {
        val request = Request.Builder().apply(build).build()
        client(context, timeoutSeconds).newCall(request).execute().use { r -> return r.code to r.body.string() }
    }

    fun get(context: Context, path: String, timeoutSeconds: Long = 40): JSONObject {
        val server = server(context) ?: throw IOException("Not signed in")
        val (code, text) = call(context, timeoutSeconds) { url("$server$path") }
        if (code !in 200..299) throw IOException("Server said $code")
        return JSONObject(text)
    }

    fun send(context: Context, method: String, path: String, body: JSONObject, timeoutSeconds: Long = 40): JSONObject {
        val server = server(context) ?: throw IOException("Not signed in")
        val (code, text) = call(context, timeoutSeconds) { url("$server$path").method(method, body.toString().toRequestBody(JSON)) }
        if (code !in 200..299) throw IOException("Server said $code: ${text.take(300)}")
        return if (text.isBlank()) JSONObject() else JSONObject(text)
    }

    /** Make sure this phone can use maps: its current sign-in if that works,
     *  or the one-time code the web app just sent along. */
    suspend fun signIn(context: Context, server: String?, code: String?) = withContext(Dispatchers.IO) {
        val usable = account(context)?.let { a ->
            (server == null || a.server == server.trimEnd('/')) && runCatching { get(context, "/api/maps/config") }.isSuccess
        } ?: false
        if (usable) return@withContext
        if (server == null || code == null) throw IOException("Open this from P Maps.")
        val account = Api.claim(PairLink(server.trimEnd('/'), code), Api.deviceName())
        Store(context).account = account
    }

    /** What you said, as sound or tapped words, and what to do about it. */
    suspend fun assistant(context: Context, clip: ByteArray?, text: String?, state: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val server = server(context) ?: throw IOException("Not signed in")
        val body = okhttp3.MultipartBody.Builder().setType(okhttp3.MultipartBody.FORM)
            .addFormDataPart("state", state.toString())
            .apply {
                text?.let { addFormDataPart("text", it) }
                clip?.let { addFormDataPart("audio", "voice.wav", it.toRequestBody("audio/wav".toMediaType())) }
            }
            .build()
        client(context).newCall(Request.Builder().url("$server/api/assistant").post(body).build()).execute().use { r ->
            val text = r.body.string()
            if (!r.isSuccessful) throw IOException("Server said ${r.code}: ${text.take(300)}")
            JSONObject(text)
        }
    }

    /** An answer in your chosen voice. Quick or not at all: there's a fallback, and
     *  you're waiting. Call this off the main thread. */
    fun speech(context: Context, words: String): ByteArray {
        val server = server(context) ?: throw IOException("Not signed in")
        val body = JSONObject().put("text", words).toString().toRequestBody(JSON)
        val quick = client(context).newBuilder().connectTimeout(4, TimeUnit.SECONDS).callTimeout(12, TimeUnit.SECONDS).build()
        quick.newCall(Request.Builder().url("$server/api/assistant/speak").post(body).build()).execute().use { r ->
            if (!r.isSuccessful) throw IOException("Server said ${r.code}")
            return r.body.bytes()
        }
    }

    /** One stop you could make, and what it would cost. */
    data class Nearby(val stop: Stop, val addsMinutes: Int?, val aheadKm: Double?)

    /** Fuel, food and so on along the rest of this trip. */
    suspend fun onTheWay(context: Context, category: String, shape: String, here: Stop, to: Stop): List<Nearby> = withContext(Dispatchers.IO) {
        fun spot(s: Stop) = JSONObject().put("lat", s.lat).put("lon", s.lon).put("name", s.name)
        val body = JSONObject().put("category", category).put("shapes", JSONArray().put(shape)).put("here", spot(here)).put("to", spot(to))
        val rows = send(context, "POST", "/api/maps/nearby/along", body).getJSONArray("results")
        List(rows.length()) { i ->
            val r = rows.getJSONObject(i)
            Nearby(
                Stop(r.getDouble("lat"), r.getDouble("lon"), r.getString("name")),
                if (r.has("adds_seconds")) Math.round(r.getDouble("adds_seconds") / 60).toInt() else null,
                if (r.has("along_m")) r.getDouble("along_m") / 1000 else null,
            )
        }
    }

    /**
     * The map style as a local file, for the phone's screens and the car's. Its map,
     * fonts and sprites all point at [MapTiles.HOST], answered on the phone (downloaded
     * squares, the trip cache, then this server). The style itself is the copy offline
     * downloads keep, else this server's, else the one saved last time, so a car
     * session started with no signal still gets a map.
     */
    suspend fun styleFile(context: Context, forceDark: Boolean? = null): String = withContext(Dispatchers.IO) {
        val server = server(context) ?: throw IOException("Not signed in")
        val dark = forceDark ?: (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES)
        val flavor = if (dark) "dark" else "light"
        val file = File(context.filesDir, "map-style-$flavor.json")
        val kept = File(org.promptly.sync.maps.offline.Offline.store(context).assetsDir, "style-$flavor.json")
        val raw: String? = if (kept.isFile) {
            kept.readText()
        } else {
            try {
                val config = get(context, "/api/maps/config", CAR_TIMEOUT_SECONDS)
                if (config.optString("basemap").let { it.isEmpty() || it == "null" }) throw NotSetUp()
                val (code, text) = call(context, CAR_TIMEOUT_SECONDS) { url("$server/map-assets/style-$flavor.json") }
                if (code != 200) throw IOException("Server said $code")
                text
            } catch (e: NotSetUp) {
                throw IOException("Maps aren't set up on this server yet.")
            } catch (e: IOException) {
                // On a weak signal, the copy saved last time, rather than a blank screen
                // (one made for the phone's own tiles, not an older app's server link).
                if (!file.isFile || !file.readText().contains(MapTiles.HOST)) throw e
                null
            }
        }
        if (raw != null) {
            val style = MapTiles.style(raw)
            val fresh = File(context.filesDir, "map-style-$flavor.json.new")
            fresh.writeText(style)
            if (!fresh.renameTo(file)) {
                file.writeText(style)
                fresh.delete()
            }
        }
        "file://${file.absolutePath}"
    }

    private class NotSetUp : Exception()

    /** Speed cameras within a few metres of this route. */
    suspend fun cameras(context: Context, shape: String): List<Camera> = withContext(Dispatchers.IO) {
        val body = JSONObject().put("shapes", JSONArray().put(shape))
        val rows = send(context, "POST", "/api/maps/cameras/along", body).getJSONArray("cameras")
        List(rows.length()) { i ->
            val c = rows.getJSONObject(i)
            Camera(c.getDouble("lat"), c.getDouble("lon"), c.optDouble("maxspeed").takeUnless { it.isNaN() })
        }
    }

    fun park(context: Context, lat: Double, lon: Double, source: String) {
        send(context, "PUT", "/api/maps/parked", JSONObject().put("lat", lat).put("lon", lon).put("source", source))
    }

    /** Places to pick from on the car's screen. With no answer in time, the ones from
     *  last time: home is still home on one bar of signal. */
    suspend fun myPlaces(context: Context): List<Stop> = withContext(Dispatchers.IO) {
        val saved = File(context.filesDir, "maps-places.json")
        val server = server(context) ?: throw IOException("Not signed in")
        val mine = try {
            get(context, "/api/maps/places", CAR_TIMEOUT_SECONDS).also {
                saved.writeText(JSONObject().put("server", server).put("places", it).toString())
            }
        } catch (e: IOException) {
            // Only this server's places, never another account's.
            val kept = runCatching { JSONObject(saved.readText()) }.getOrNull()
            if (kept == null || kept.optString("server") != server) throw e
            kept.getJSONObject("places")
        }
        placesFrom(mine)
    }

    internal fun placesFrom(mine: JSONObject): List<Stop> {
        val out = mutableListOf<Stop>()
        val places = mine.getJSONArray("places")
        val rows = List(places.length()) { places.getJSONObject(it) }
        for (kind in listOf("home", "work", "favourite", "list")) {
            rows.filter { it.getString("kind") == kind }.forEach {
                out += Stop(it.getDouble("lat"), it.getDouble("lon"), it.getString("name"), kind, textOf(it, "address"))
            }
        }
        if (!mine.isNull("parked")) {
            val p = mine.getJSONObject("parked")
            out += Stop(p.getDouble("lat"), p.getDouble("lon"), "Your car", "parked")
        }
        val recents = mine.getJSONArray("recents")
        for (i in 0 until recents.length()) {
            val r = recents.getJSONObject(i)
            out += Stop(r.getDouble("lat"), r.getDouble("lon"), r.getString("name"), "recent", textOf(r, "address"))
        }
        return out.distinctBy { "%.4f,%.4f".format(java.util.Locale.ROOT, it.lat, it.lon) }
    }

    suspend fun search(context: Context, query: String, near: Pair<Double, Double>?): List<Stop> = withContext(Dispatchers.IO) {
        val q = java.net.URLEncoder.encode(query, "UTF-8")
        val at = near?.let { "&lat=${it.first}&lon=${it.second}" } ?: ""
        val rows = get(context, "/api/maps/search?q=$q$at", CAR_TIMEOUT_SECONDS).getJSONArray("results")
        List(rows.length()) { i ->
            val r = rows.getJSONObject(i)
            Stop(r.getDouble("lat"), r.getDouble("lon"), r.getString("name"), r.optString("kind").ifEmpty { null }, textOf(r, "address"))
        }
    }

    private fun textOf(row: JSONObject, key: String): String? =
        if (row.isNull(key)) null else row.optString(key).takeIf { it.isNotBlank() }

    fun encodeShape(points: List<Pair<Double, Double>>): String {
        val out = StringBuilder()
        var lastLat = 0L
        var lastLon = 0L
        fun one(value: Long) {
            var v = if (value < 0) (value shl 1).inv() else value shl 1
            while (v >= 0x20) {
                out.append(((0x20 or (v and 0x1F).toInt()) + 63).toChar())
                v = v shr 5
            }
            out.append((v.toInt() + 63).toChar())
        }
        for ((lat, lon) in points) {
            val la = Math.round(lat * 1e6)
            val lo = Math.round(lon * 1e6)
            one(la - lastLat)
            one(lo - lastLon)
            lastLat = la
            lastLon = lo
        }
        return out.toString()
    }
}

data class Camera(val lat: Double, val lon: Double, val maxSpeed: Double?)
