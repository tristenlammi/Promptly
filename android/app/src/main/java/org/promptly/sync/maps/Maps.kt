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
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/** One stop on a trip. */
data class Stop(val lat: Double, val lon: Double, val name: String)

/** Talking to the P Maps part of your Promptly server, and nothing else. The
 *  phone signs in with the same kind of app password as photo backup. */
object Maps {
    private val JSON = "application/json".toMediaType()

    private fun account(context: Context): Store.Account? = Store(context).account

    fun server(context: Context): String? = account(context)?.server

    /** An HTTP client that signs each request in. */
    fun client(context: Context): OkHttpClient {
        val auth = account(context)
        return OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .callTimeout(40, TimeUnit.SECONDS)
            .addInterceptor(Interceptor { chain ->
                val request = chain.request()
                val signed = if (auth != null && request.url.toString().startsWith(auth.server)) {
                    request.newBuilder().header("Authorization", Credentials.basic(auth.username, auth.password)).build()
                } else request
                chain.proceed(signed)
            })
            .build()
    }

    private fun call(context: Context, build: Request.Builder.() -> Unit): Pair<Int, String> {
        val request = Request.Builder().apply(build).build()
        client(context).newCall(request).execute().use { r -> return r.code to r.body.string() }
    }

    fun get(context: Context, path: String): JSONObject {
        val server = server(context) ?: throw IOException("Not signed in")
        val (code, text) = call(context) { url("$server$path") }
        if (code !in 200..299) throw IOException("Server said $code")
        return JSONObject(text)
    }

    fun send(context: Context, method: String, path: String, body: JSONObject): JSONObject {
        val server = server(context) ?: throw IOException("Not signed in")
        val (code, text) = call(context) { url("$server$path").method(method, body.toString().toRequestBody(JSON)) }
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

    /** What you said after "Hey Promptly", and what to do about it. */
    suspend fun assistant(context: Context, clip: ByteArray, state: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val server = server(context) ?: throw IOException("Not signed in")
        val body = okhttp3.MultipartBody.Builder().setType(okhttp3.MultipartBody.FORM)
            .addFormDataPart("state", state.toString())
            .addFormDataPart("audio", "voice.wav", clip.toRequestBody("audio/wav".toMediaType()))
            .build()
        client(context).newCall(Request.Builder().url("$server/api/maps/assistant").post(body).build()).execute().use { r ->
            val text = r.body.string()
            if (!r.isSuccessful) throw IOException("Server said ${r.code}: ${text.take(300)}")
            JSONObject(text)
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

    /** The map style with this server's addresses filled in, as a local file. */
    suspend fun styleFile(context: Context): String = withContext(Dispatchers.IO) {
        val server = server(context) ?: throw IOException("Not signed in")
        val config = get(context, "/api/maps/config")
        val basemap = config.optString("basemap").takeIf { it.isNotEmpty() && it != "null" }
            ?: throw IOException("Maps aren't set up on this server yet.")
        val dark = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        val flavor = if (dark) "dark" else "light"
        val (code, text) = call(context) { url("$server/map-assets/style-$flavor.json") }
        if (code != 200) throw IOException("Server said $code")
        val style = text.replace("__ORIGIN__", server).replace("__BASEMAP__", "$server$basemap")
        val file = File(context.cacheDir, "map-style-$flavor.json")
        file.writeText(style)
        "file://${file.absolutePath}"
    }

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

    /** Places to pick from on the car's screen. */
    suspend fun myPlaces(context: Context): List<Stop> = withContext(Dispatchers.IO) {
        val out = mutableListOf<Stop>()
        val mine = get(context, "/api/maps/places")
        val places = mine.getJSONArray("places")
        val rows = List(places.length()) { places.getJSONObject(it) }
        for (kind in listOf("home", "work", "favourite", "list")) {
            rows.filter { it.getString("kind") == kind }.forEach {
                out += Stop(it.getDouble("lat"), it.getDouble("lon"), it.getString("name"))
            }
        }
        if (!mine.isNull("parked")) {
            val p = mine.getJSONObject("parked")
            out += Stop(p.getDouble("lat"), p.getDouble("lon"), "Your car")
        }
        val recents = mine.getJSONArray("recents")
        for (i in 0 until recents.length()) {
            val r = recents.getJSONObject(i)
            out += Stop(r.getDouble("lat"), r.getDouble("lon"), r.getString("name"))
        }
        out.distinctBy { "%.4f,%.4f".format(it.lat, it.lon) }
    }

    suspend fun search(context: Context, query: String, near: Pair<Double, Double>?): List<Stop> = withContext(Dispatchers.IO) {
        val q = java.net.URLEncoder.encode(query, "UTF-8")
        val at = near?.let { "&lat=${it.first}&lon=${it.second}" } ?: ""
        val rows = get(context, "/api/maps/search?q=$q$at").getJSONArray("results")
        List(rows.length()) { i ->
            val r = rows.getJSONObject(i)
            Stop(r.getDouble("lat"), r.getDouble("lon"), r.getString("name"))
        }
    }

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
