package org.promptly.sync.maps.offline

import org.json.JSONObject
import java.io.File
import java.io.IOException

/**
 * Directions with no server: Valhalla on the phone (valhalla-mobile, Valhalla
 * 3.9.0), reading the downloaded squares' routing tiles in `routing/`. Those are
 * all one map build ([OfflineStore]); when a new build is swapped in, the engine is
 * reopened on it before the next route. The engine is only open while something
 * needs it (it takes about 40 MB with its tile cache), and [release] closes it.
 *
 * [open] makes the engine from a config file: Valhalla itself on the phone, a stand-in
 * in tests.
 */
class LocalRouter(
    private val store: OfflineStore,
    private val configFile: File,
    private val open: (File) -> Engine = ::ValhallaEngine,
    private val cacheBytes: Long = CACHE_BYTES,
) : AutoCloseable {
    interface Engine : AutoCloseable {
        /** Valhalla's `/route`: a request body in, the answer's JSON out. Throws when there's no route. */
        fun route(body: String): String
    }

    /** These squares have no offline directions on this phone. */
    class MissingSquares(val cells: List<String>) : IOException("No offline directions for ${cells.joinToString()}")

    /** The squares are here, but the phone found no way through them (a road leaves them). */
    class NoRoute(message: String?) : IOException(message ?: "No route offline")

    private var engine: Engine? = null
    private var engineBuild: String? = null

    /** How many times an engine was started (for tests and logs). */
    @Volatile var opened = 0
        private set

    /** The squares of [cells] that offline directions can't use (none: all ready, one build). */
    fun missing(cells: Collection<String>): List<String> {
        val ready = runCatching { store.routingReady(cells) }.getOrDefault(false)
        if (ready) return emptyList()
        val routing = runCatching { store.state.routing.keys.toSet() }.getOrDefault(emptySet())
        return cells.filter { "$it/route" !in routing }.ifEmpty { cells.toList() }
    }

    /** A route for Valhalla's request [body], from the phone. [cells]: the squares the trip's
     *  points are in, which must all be downloaded. */
    @Synchronized
    fun route(body: String, cells: Collection<String>): String {
        val missing = missing(cells)
        if (missing.isNotEmpty()) throw MissingSquares(missing)
        val build = store.state.routingBuild
        val current = engine?.takeIf { engineBuild == build } ?: reopen(build)
        return try {
            current.route(body)
        } catch (e: Exception) {
            // Valhalla's own error (170: "unconnected regions", 442: "no path"), in words.
            throw NoRoute(e.message)
        }
    }

    private fun reopen(build: String?): Engine {
        engine?.let { runCatching { it.close() } }
        engine = null
        writeConfig(configFile, store.routingDir, cacheBytes)
        val made = open(configFile)
        engine = made
        engineBuild = build
        opened++
        return made
    }

    /** Frees the engine's memory; the next route opens it again. */
    @Synchronized
    fun release() {
        engine?.let { runCatching { it.close() } }
        engine = null
        engineBuild = null
    }

    override fun close() = release()

    /** Valhalla itself. */
    class ValhallaEngine(config: File) : Engine {
        private val valhalla = com.valhalla.valhalla.Valhalla(config.absolutePath)
        override fun route(body: String): String = valhalla.routeRaw(body)
        override fun close() = valhalla.close()
    }

    companion object {
        /** Valhalla's tile cache on a phone: 48 MB measured well in WP-M0 (96 MB costs 40 MB more). */
        const val CACHE_BYTES = 48L * 1024 * 1024

        /** Valhalla's own defaults for the version on the phone, pointed at the tile
         *  folder, with the cache capped and the server-only data left out. */
        fun writeConfig(out: File, tileDir: File, cacheBytes: Long = CACHE_BYTES): File {
            // Read as a resource, without loading Valhalla's classes (and its native code).
            val defaults = LocalRouter::class.java.classLoader?.getResourceAsStream("com/valhalla/valhalla/default.json")
                ?.use { it.readBytes().toString(Charsets.UTF_8) }
                ?: throw IOException("Offline directions are missing their settings")
            val config = JSONObject(defaults)
            val mjolnir = config.getJSONObject("mjolnir")
            mjolnir.put("max_cache_size", cacheBytes)
            mjolnir.put("tile_dir", tileDir.absolutePath)
            // Nothing on the phone has these, and Valhalla skips what it isn't given.
            listOf("tile_extract", "traffic_extract", "admin", "timezone", "landmarks", "transit_dir").forEach { mjolnir.remove(it) }
            out.parentFile?.mkdirs()
            val tmp = File(out.parentFile, out.name + ".new")
            tmp.writeText(config.toString())
            if (!tmp.renameTo(out)) {
                out.delete()
                if (!tmp.renameTo(out)) throw IOException("Couldn't set up offline directions")
            }
            return out
        }
    }
}
