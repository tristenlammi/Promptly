package org.promptly.sync.maps.offline

import android.util.Log
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/** WP-M0 spike: one virtual host for the map, answered on the phone. MapLibre's
 *  global OkHttp client (HttpRequestUtil.setOkHttpClient) sends every tile, glyph
 *  and sprite request here; squares' PMTiles answer tiles, a copy of
 *  frontend/public/map-assets answers the rest. Anything else goes to the network
 *  as before. */
object SpikeTiles {
    const val HOST = "tiles.promptly.invalid"
    private const val TAG = "PromptlyOffline"

    @Volatile var archives: List<PmTiles> = emptyList()
    @Volatile var assets: File? = null
    val tileHits = AtomicInteger()
    val tileMisses = AtomicInteger()
    val otherHits = AtomicInteger()
    val passedThrough = AtomicInteger()

    private val MVT = "application/vnd.mapbox-vector-tile".toMediaType()

    val interceptor = Interceptor { chain ->
        val request = chain.request()
        val url = request.url
        if (url.host != HOST) {
            passedThrough.incrementAndGet()
            return@Interceptor chain.proceed(request)
        }
        val path = url.encodedPathSegments.map { java.net.URLDecoder.decode(it, "UTF-8") }
        fun answer(code: Int, bytes: ByteArray, type: okhttp3.MediaType?): Response = Response.Builder()
            .request(request).protocol(Protocol.HTTP_1_1).code(code).message(if (code == 200) "OK" else "Not found")
            .body(bytes.toResponseBody(type)).build()
        if (path.firstOrNull() == "tiles" && path.size == 4) {
            val z = path[1].toInt()
            val x = path[2].toInt()
            val y = path[3].substringBefore('.').toInt()
            val bytes = archives.firstNotNullOfOrNull { it.tile(z, x, y) }
            if (bytes != null) {
                tileHits.incrementAndGet()
                return@Interceptor answer(200, bytes, MVT)
            }
            tileMisses.incrementAndGet()
            // No map here: an empty tile draws the plain background instead of an error.
            return@Interceptor answer(204, ByteArray(0), MVT)
        }
        if (path.firstOrNull() == "map-assets") {
            val base = assets
            val file = base?.let { File(it, path.drop(1).joinToString("/")) }
            if (file != null && file.canonicalPath.startsWith(base.canonicalPath) && file.isFile) {
                otherHits.incrementAndGet()
                val type = when (file.extension) {
                    "png" -> "image/png"
                    "json" -> "application/json"
                    else -> "application/x-protobuf"
                }.toMediaType()
                return@Interceptor answer(200, file.readBytes(), type)
            }
            Log.w(TAG, "No local file for $url")
            return@Interceptor answer(404, ByteArray(0), null)
        }
        answer(404, ByteArray(0), null)
    }

    fun client(): OkHttpClient = OkHttpClient.Builder().addInterceptor(interceptor).build()

    /** The server's style, pointed at the virtual host instead of the server's
     *  basemap.pmtiles link. The same style would serve the phone and the car. */
    fun style(assetsDir: File, dark: Boolean, out: File): String {
        val text = File(assetsDir, "style-${if (dark) "dark" else "light"}.json").readText()
            .replace("__ORIGIN__", "https://$HOST")
        val style = JSONObject(text)
        val source = style.getJSONObject("sources").getJSONObject("protomaps")
        source.remove("url")
        source.put("tiles", JSONArray().put("https://$HOST/tiles/{z}/{x}/{y}.mvt"))
        source.put("minzoom", 0)
        source.put("maxzoom", 15)
        out.writeText(style.toString())
        return "file://${out.absolutePath}"
    }
}
