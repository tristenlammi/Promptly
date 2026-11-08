package org.promptly.sync.maps.offline

import android.content.Context
import android.os.Looper
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONArray
import org.json.JSONObject
import org.promptly.sync.maps.Maps
import org.promptly.sync.maps.offline.Offline.keepTripMaps
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * One tile source for every P Maps map on the phone and in the car. Both styles
 * point their map at a made-up host, `tiles.promptly.invalid`, and MapLibre's
 * global OkHttp client answers it here ([TileServer]): downloaded squares, then
 * the trip cache, then your server's basemap, then nothing. So one style works
 * online and offline, and saved areas save data even with signal.
 *
 * [install] runs before the first map is drawn (driving screen, car, Offline
 * areas), not when the app starts: photo backup and Passwords' autofill run in
 * this process too, and shouldn't load MapLibre's native code.
 */
object MapTiles {
    const val HOST = "tiles.promptly.invalid"
    const val ORIGIN = "https://$HOST"
    const val TILES = "$ORIGIN/tiles/{z}/{x}/{y}.mvt"
    private const val TAG = "PromptlyTiles"

    @Volatile private var installed = false
    @Volatile private var server: TileServer? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private lateinit var squares: SquareMaps
    private lateinit var trip: TripCache
    private val basemaps = HashMap<String, ServerBasemap>()
    private val answered = AtomicInteger()
    private val passed = AtomicInteger()

    /** Sets MapLibre up to ask here for everything. Call on the main thread, before a map. */
    @OptIn(FlowPreview::class)
    fun install(context: Context) {
        if (installed) return
        check(Looper.myLooper() == Looper.getMainLooper()) { "MapTiles.install on the main thread" }
        val app = context.applicationContext
        val store = Offline.store(app)
        squares = SquareMaps(store.cellsDir)
        trip = TripCache(tripDir(app))
        server = TileServer(
            squares, trip,
            basemap = { basemap(app) },
            assets = { store.assetsDir },
            serverAsset = { path -> serverAsset(app, path) },
            online = { Offline.online(app) },
        )
        // MapLibre first, or HttpRequestImpl's class init throws.
        org.maplibre.android.MapLibre.getInstance(app)
        // With no network, MapLibre stops asking for tiles at all, even ones answered
        // here. Every request comes here, and this knows whether the server's there.
        org.maplibre.android.MapLibre.setConnected(true)
        org.maplibre.android.module.http.HttpRequestUtil.setOkHttpClient(client())
        installed = true
        scope.launch {
            squares.reload()
            val gone = trip.prune()
            if (gone > 0) Log.i(TAG, "Trip maps: $gone tiles older than a week removed")
        }
        // A square arrived, went or changed: reopen just that one. While a download
        // runs, each finished file counts.
        combine(Offline.changed, Offline.run) { c, r -> c to (r?.done?.size ?: -1) }
            .distinctUntilChanged()
            .debounce(500)
            .onEach { squares.reload() }
            .launchIn(scope)
    }

    private fun tripDir(context: Context) = File(Offline.store(context).root, "trips")

    /** The trip cache, for the settings screen's size and its switch. */
    fun tripCache(context: Context): TripCache = if (::trip.isInitialized) trip else TripCache(tripDir(context.applicationContext))

    private fun basemap(app: Context): ServerBasemap? {
        val at = Maps.server(app) ?: return null
        synchronized(basemaps) {
            return basemaps.getOrPut(at) {
                ServerBasemap(
                    link = {
                        val path = Maps.get(app, "/api/maps/config", 10).optString("basemap")
                        if (path.isEmpty() || path == "null") null else at + path
                    },
                    http = { Maps.client(app, 15) },
                )
            }
        }
    }

    private fun serverAsset(app: Context, path: String): ByteArray? {
        val at = Maps.server(app) ?: return null
        val url = at + "/map-assets/" + path.split('/').joinToString("/") { java.net.URLEncoder.encode(it, "UTF-8").replace("+", "%20") }
        Maps.client(app, 15).newCall(Request.Builder().url(url).build()).execute().use { r ->
            return if (r.isSuccessful) r.body.bytes() else null
        }
    }

    private val interceptor = Interceptor { chain ->
        val request = chain.request()
        val tiles = server
        if (request.url.host != HOST || tiles == null) {
            passed.incrementAndGet()
            return@Interceptor chain.proceed(request)
        }
        val a = tiles.answer(request.url.pathSegments)
        if (answered.incrementAndGet() % 25 == 0) Log.i(TAG, "Map requests: ${tiles.summary()}, passed on ${passed.get()}")
        Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(a.code)
            .message(if (a.code < 300) "OK" else "Not found")
            .header("Cache-Control", a.cacheControl)
            .body(a.bytes.toResponseBody(a.type?.toMediaTypeOrNull()))
            .build()
    }

    private fun client(): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .addInterceptor(interceptor)
        .build()

    /** What answered the map so far (for logs and the emulator checks). */
    fun summary(): String = (server?.summary() ?: "not installed") + ", passed on ${passed.get()}"

    /** Whether there's a detailed map at this point with no server: a square or this week's trips. */
    fun coversOffline(lat: Double, lon: Double): Boolean =
        installed && (squares.covers(lat, lon) || trip.covers(lat, lon))

    /**
     * The server's style with its map pointed here: `__ORIGIN__` (fonts, sprites) and
     * the `protomaps` source (`pmtiles://__BASEMAP__` on the web) both go to [HOST].
     */
    fun style(raw: String): String {
        val text = raw.replace("__ORIGIN__", ORIGIN).replace("__BASEMAP__", "$ORIGIN/basemap.pmtiles")
        val style = JSONObject(text)
        style.optJSONObject("sources")?.optJSONObject("protomaps")?.let { source ->
            source.remove("url")
            source.put("tiles", JSONArray().put(TILES))
            source.put("minzoom", 0)
            source.put("maxzoom", 15)
        }
        return style.toString()
    }

    /**
     * Saves the map along a trip for a week (the "Keep each trip's map for a week"
     * switch). Only with signal; tiles a square already has aren't saved twice.
     */
    fun saveTrip(context: Context, line: List<Pair<Double, Double>>) {
        val app = context.applicationContext
        if (!installed || !app.keepTripMaps || line.size < 2 || !Offline.online(app)) return
        val server = basemap(app) ?: return
        tripJob?.cancel()
        tripJob = scope.launch {
            val started = System.currentTimeMillis()
            try {
                val saved = trip.save(line, server, inSquares = { squares.has(it.z, it.x, it.y) }, stopped = { !isActive })
                Log.i(TAG, "Trip map: ${saved.tiles} tiles saved (${saved.bytes / 1024} KB), ${saved.kept} kept another week${if (saved.full) ", full" else ""}, in ${System.currentTimeMillis() - started} ms")
            } catch (e: IOException) {
                Log.w(TAG, "Couldn't save the trip's map: ${e.message}")
            }
        }
    }

    @Volatile private var tripJob: kotlinx.coroutines.Job? = null

    /** The switch turned off: nothing kept. */
    fun clearTrips(context: Context) {
        tripJob?.cancel()
        tripCache(context).clear()
    }
}
