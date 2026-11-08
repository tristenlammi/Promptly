package org.promptly.sync.maps.offline

import java.io.ByteArrayOutputStream
import java.io.File
import java.util.EnumMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.GZIPInputStream

/**
 * Answers the map's requests on the phone, for the phone's screens and the car's:
 * `https://tiles.promptly.invalid/tiles/{z}/{x}/{y}.mvt` and `/map-assets/...`.
 *
 * A tile comes from, in order: a downloaded square, the trip cache, your server's
 * basemap (only with a connection), else an empty answer, which MapLibre draws as
 * the plain background (the route line still draws on top). Styles, fonts and
 * sprites come from the copy of `map-assets` the downloads keep, else the server.
 *
 * Plain code, no Android, so the order is tested on the JVM ([MapTiles] wires it in).
 */
class TileServer(
    private val squares: SquareMaps,
    private val trip: TripCache,
    private val basemap: () -> ServerBasemap?,
    private val assets: () -> File,
    private val serverAsset: (String) -> ByteArray?,
    private val online: () -> Boolean,
) {
    enum class From { SQUARE, TRIP, SERVER, EMPTY, ASSET, SERVER_ASSET, MISSING }

    class Answer(val code: Int, val bytes: ByteArray, val type: String?, val from: From) {
        /** MapLibre keeps answers in its own cache: never an empty one, so the map fills in
         *  as soon as there's something to show. */
        val cacheControl: String get() = if (from == From.EMPTY || from == From.MISSING) "no-cache, max-age=0, must-revalidate" else "max-age=3600"
    }

    private val counts = EnumMap<From, AtomicInteger>(From::class.java).apply { From.values().forEach { put(it, AtomicInteger()) } }

    /** Requests that went to the network (the server's map or its files). */
    val network = AtomicInteger()

    fun count(from: From): Int = counts.getValue(from).get()

    fun summary(): String = From.values().joinToString(", ") { "${it.name.lowercase()} ${count(it)}" } + ", network ${network.get()}"

    private fun done(a: Answer): Answer {
        counts.getValue(a.from).incrementAndGet()
        return a
    }

    /** [segments]: the request's path, decoded (`tiles`, z, x, `y.mvt`). */
    fun answer(segments: List<String>): Answer = when (segments.firstOrNull()) {
        "tiles" -> tile(segments)
        "map-assets" -> asset(segments.drop(1))
        else -> done(Answer(404, ByteArray(0), null, From.MISSING))
    }

    private fun tile(segments: List<String>): Answer {
        val z = segments.getOrNull(1)?.toIntOrNull()
        val x = segments.getOrNull(2)?.toIntOrNull()
        val y = segments.getOrNull(3)?.substringBefore('.')?.toIntOrNull()
        if (segments.size != 4 || z == null || x == null || y == null || z !in 0..22) return done(Answer(404, ByteArray(0), null, From.MISSING))
        squares.tile(z, x, y)?.let { return done(Answer(200, plain(it), MVT, From.SQUARE)) }
        trip.get(z, x, y)?.let { return done(Answer(200, plain(it), MVT, From.TRIP)) }
        val server = basemap()
        if (server != null && online() && !server.resting()) {
            network.incrementAndGet()
            val got = runCatching { server.tile(z, x, y) }
            got.getOrNull()?.let { return done(Answer(200, plain(it), MVT, From.SERVER)) }
            // The server has no tile there (the sea): that's an answer too.
            if (got.isSuccess) return done(Answer(204, ByteArray(0), MVT, From.EMPTY))
        }
        return done(Answer(204, ByteArray(0), MVT, From.EMPTY))
    }

    private fun asset(path: List<String>): Answer {
        if (path.isEmpty() || path.any { it.isEmpty() || it == "." || it == ".." || '/' in it || '\\' in it }) {
            return done(Answer(404, ByteArray(0), null, From.MISSING))
        }
        val type = typeOf(path.last())
        val base = assets()
        val file = File(base, path.joinToString("/"))
        if (file.isFile && file.canonicalPath.startsWith(base.canonicalPath + File.separator)) {
            runCatching { file.readBytes() }.getOrNull()?.let { return done(Answer(200, it, type, From.ASSET)) }
        }
        if (online()) {
            network.incrementAndGet()
            runCatching { serverAsset(path.joinToString("/")) }.getOrNull()?.let { return done(Answer(200, it, type, From.SERVER_ASSET)) }
        }
        return done(Answer(404, ByteArray(0), null, From.MISSING))
    }

    companion object {
        const val MVT = "application/vnd.mapbox-vector-tile"

        fun typeOf(name: String): String = when (name.substringAfterLast('.', "")) {
            "png" -> "image/png"
            "json" -> "application/json"
            "geojson" -> "application/geo+json"
            "txt" -> "text/plain"
            else -> "application/x-protobuf"
        }

        /** A tile as MapLibre wants it: unpacked if it's gzipped (the basemap's are). */
        fun plain(bytes: ByteArray): ByteArray {
            if (bytes.size < 2 || bytes[0] != 0x1f.toByte() || bytes[1] != 0x8b.toByte()) return bytes
            return GZIPInputStream(bytes.inputStream()).use { input ->
                val out = ByteArrayOutputStream(bytes.size * 3)
                input.copyTo(out)
                out.toByteArray()
            }
        }
    }
}
