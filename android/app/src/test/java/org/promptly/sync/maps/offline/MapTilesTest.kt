package org.promptly.sync.maps.offline

import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** WP-M4: the PMTiles reader, the one tile source's order (squares, trip cache,
 *  server, nothing), the trip cache's week, and the style pointed at the phone. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MapTilesTest {
    private val work: File = Files.createTempDirectory("maptiles").toFile()
    private val closing = mutableListOf<AutoCloseable>()

    @After
    fun tidy() {
        closing.forEach { runCatching { it.close() } }
        work.deleteRecursively()
    }

    private fun t(z: Int, x: Int, y: Int) = TileMath.Tile(z, x, y)

    /** Dubbo's tiles, the ones the emulator test draws. */
    private val dubbo15 = TileMath.of(-32.25, 148.60, 15)

    private fun text(bytes: ByteArray?): String? = bytes?.let { String(TileServer.plain(it)) }

    // ---- PMTiles ----------------------------------------------------------------

    @Test
    fun tile_ids_follow_the_spec() {
        // The spec's own examples (protomaps/PMTiles js tests).
        assertEquals(0L, PmTiles.tileId(0, 0, 0))
        assertEquals(1L, PmTiles.tileId(1, 0, 0))
        assertEquals(2L, PmTiles.tileId(1, 0, 1))
        assertEquals(3L, PmTiles.tileId(1, 1, 1))
        assertEquals(4L, PmTiles.tileId(1, 1, 0))
        assertEquals(5L, PmTiles.tileId(2, 0, 0))
        assertEquals(19078479L, PmTiles.tileId(12, 3423, 1763))
    }

    @Test
    fun reads_tiles_from_the_root_and_from_leaf_directories() {
        val tiles = buildMap {
            for (z in 0..6) {
                val c = TileMath.of(-32.25, 148.6, z)
                for (dx in -1..1) for (dy in -1..1) {
                    val tile = t(z, c.x + dx, c.y + dy)
                    if (tile.x >= 0 && tile.y >= 0 && tile.x < (1 shl z) && tile.y < (1 shl z)) put(tile, PmTilesWriter.tileBytes(tile, "square"))
                }
            }
        }
        for (leaf in listOf(0, 4)) for (gz in listOf(true, false)) {
            val f = PmTilesWriter.write(File(work, "t-$leaf-$gz.pmtiles"), tiles, leafSize = leaf, gzipDirs = gz)
            PmTiles.open(f).use { p ->
                assertEquals(0, p.minZoom)
                assertEquals(6, p.maxZoom)
                assertEquals(148.0, p.bounds[0], 1e-6)
                for ((tile, bytes) in tiles) assertArrayEquals("$tile leaf=$leaf gz=$gz", bytes, p.tile(tile.z, tile.x, tile.y))
                // Not in the file: just none.
                assertNull(p.tile(6, 0, 0))
                assertNull(p.tile(9, 1, 1))
                assertNull(p.tile(3, 99, 1))
            }
        }
    }

    @Test
    fun a_file_that_isnt_pmtiles_is_refused() {
        val f = File(work, "stub.pmtiles").apply { writeText("stub, not a real map\n" + "x".repeat(200)) }
        assertTrue(runCatching { PmTiles.open(f) }.exceptionOrNull() is IOException)
    }

    // ---- The tile source's order ---------------------------------------------------

    private class Setup(val tiles: TileServer, val squares: SquareMaps, val trip: TripCache, val server: PmTilesWriter.RangeServer?, val online: AtomicInteger)

    private fun setup(squareTiles: Map<TileMath.Tile, ByteArray>, serverTiles: Map<TileMath.Tile, ByteArray>?, now: () -> Long = System::currentTimeMillis): Setup {
        val cells = File(work, "cells")
        if (squareTiles.isNotEmpty()) PmTilesWriter.write(File(cells, "148_-33/map.pmtiles"), squareTiles)
        val squares = SquareMaps(cells).also { it.reload() }
        val trip = TripCache(File(work, "trips"), now)
        val online = AtomicInteger(1)
        val server = serverTiles?.let { PmTilesWriter.RangeServer(PmTilesWriter.write(File(work, "basemap.pmtiles"), it, leafSize = 64, bounds = doubleArrayOf(112.0, -44.0, 154.0, -10.0))) }
        server?.let { closing += it }
        val basemap = server?.let { s -> ServerBasemap(link = { s.url }, http = { OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build() }) }
        val assets = File(work, "map-assets").apply { mkdirs() }
        val tiles = TileServer(squares, trip, { basemap }, { assets }, { path -> if (path == "fonts/x/0-255.pbf") "from server".toByteArray() else null }, { online.get() == 1 })
        closing += AutoCloseable { squares.close() }
        return Setup(tiles, squares, trip, server, online)
    }

    private fun ask(s: Setup, tile: TileMath.Tile) = s.tiles.answer(listOf("tiles", "${tile.z}", "${tile.x}", "${tile.y}.mvt"))

    @Test
    fun squares_first_then_the_trip_cache_then_the_server_then_nothing() {
        val inSquare = dubbo15
        val inTrip = t(15, dubbo15.x + 40, dubbo15.y)
        val onServer = t(15, dubbo15.x + 80, dubbo15.y)
        val nowhere = t(15, dubbo15.x + 120, dubbo15.y)
        val s = setup(
            mapOf(inSquare to PmTilesWriter.tileBytes(inSquare, "square")),
            mapOf(inSquare to PmTilesWriter.tileBytes(inSquare, "server"), inTrip to PmTilesWriter.tileBytes(inTrip, "server"), onServer to PmTilesWriter.tileBytes(onServer, "server")),
        )
        s.trip.put(inTrip.z, inTrip.x, inTrip.y, PmTilesWriter.tileBytes(inTrip, "trip"))

        val a = ask(s, inSquare)
        assertEquals(200, a.code)
        assertEquals(TileServer.From.SQUARE, a.from)
        // Unpacked for MapLibre.
        assertEquals("square 15/${inSquare.x}/${inSquare.y}", String(a.bytes))
        assertEquals("trip 15/${inTrip.x}/${inTrip.y}", String(ask(s, inTrip).bytes))
        assertEquals(TileServer.From.TRIP, ask(s, inTrip).from)
        val b = ask(s, onServer)
        assertEquals(TileServer.From.SERVER, b.from)
        assertEquals("server 15/${onServer.x}/${onServer.y}", String(b.bytes))
        // The square and the trip cache never asked the server.
        val asked = s.server!!.requests.size
        ask(s, inSquare)
        ask(s, inTrip)
        assertEquals(asked, s.server.requests.size)
        // Nothing anywhere: an empty answer MapLibre draws as background, and never keeps.
        val c = ask(s, nowhere)
        assertEquals(204, c.code)
        assertEquals(TileServer.From.EMPTY, c.from)
        assertTrue(c.cacheControl.contains("max-age=0"))
        assertTrue(b.cacheControl.contains("max-age=3600"))
    }

    @Test
    fun with_no_connection_nothing_goes_to_the_network() {
        val inSquare = dubbo15
        val outside = t(15, dubbo15.x + 80, dubbo15.y)
        val s = setup(mapOf(inSquare to PmTilesWriter.tileBytes(inSquare, "square")), mapOf(outside to PmTilesWriter.tileBytes(outside, "server")))
        s.online.set(0)
        assertEquals(TileServer.From.SQUARE, ask(s, inSquare).from)
        assertEquals(TileServer.From.EMPTY, ask(s, outside).from)
        assertEquals(0, s.tiles.network.get())
        assertTrue(s.server!!.requests.isEmpty())
        // Back online: the server fills it in.
        s.online.set(1)
        assertEquals(TileServer.From.SERVER, ask(s, outside).from)
        assertEquals(1, s.tiles.network.get())
    }

    @Test
    fun a_server_that_fails_rests_instead_of_being_asked_for_every_tile() {
        val outside = t(15, dubbo15.x + 80, dubbo15.y)
        val s = setup(emptyMap(), mapOf(outside to PmTilesWriter.tileBytes(outside, "server")))
        s.server!!.status = 500
        assertEquals(TileServer.From.EMPTY, ask(s, outside).from)
        val after = s.server.requests.size
        repeat(5) { assertEquals(TileServer.From.EMPTY, ask(s, outside).from) }
        assertEquals(after, s.server.requests.size)
    }

    @Test
    fun low_zoom_tiles_come_from_any_square_under_them() {
        val low = TileMath.of(-32.5, 148.5, 4)
        val s = setup(mapOf(low to PmTilesWriter.tileBytes(low, "square"), dubbo15 to PmTilesWriter.tileBytes(dubbo15, "square")), null)
        assertEquals(TileServer.From.SQUARE, ask(s, low).from)
        // A square never answers for a tile it isn't under, even at the same zoom.
        assertEquals(TileServer.From.EMPTY, ask(s, t(4, low.x - 3, low.y)).from)
        assertTrue(s.squares.covers(-32.5, 148.5))
        assertFalse(s.squares.covers(-33.5, 148.5))
    }

    @Test
    fun a_square_is_reopened_when_its_file_changes_and_forgotten_when_it_goes() {
        val s = setup(mapOf(dubbo15 to PmTilesWriter.tileBytes(dubbo15, "build-1")), null)
        assertEquals("build-1 15/${dubbo15.x}/${dubbo15.y}", String(ask(s, dubbo15).bytes))
        // A new map build replaces the file (renamed into place, as the downloads do).
        val next = PmTilesWriter.write(File(work, "next.pmtiles"), mapOf(dubbo15 to PmTilesWriter.tileBytes(dubbo15, "build-2 longer")))
        val dest = File(work, "cells/148_-33/map.pmtiles")
        dest.delete()
        assertTrue(next.renameTo(dest))
        dest.setLastModified(System.currentTimeMillis() + 5_000)
        s.squares.reload()
        assertEquals("build-2 longer 15/${dubbo15.x}/${dubbo15.y}", String(ask(s, dubbo15).bytes))
        // Deleted: nothing from it, no stale reader.
        File(work, "cells/148_-33").deleteRecursively()
        s.squares.reload()
        assertEquals(TileServer.From.EMPTY, ask(s, dubbo15).from)
        assertTrue(s.squares.cells.isEmpty())
    }

    @Test
    fun map_files_come_from_the_phone_then_the_server_and_never_from_outside_the_folder() {
        val s = setup(emptyMap(), null)
        File(work, "map-assets/fonts/Noto Sans Regular").mkdirs()
        File(work, "map-assets/fonts/Noto Sans Regular/0-255.pbf").writeText("glyphs")
        File(work, "secret.txt").writeText("no")
        val glyphs = s.tiles.answer(listOf("map-assets", "fonts", "Noto Sans Regular", "0-255.pbf"))
        assertEquals(TileServer.From.ASSET, glyphs.from)
        assertEquals("glyphs", String(glyphs.bytes))
        assertEquals("application/x-protobuf", glyphs.type)
        assertEquals(TileServer.From.SERVER_ASSET, s.tiles.answer(listOf("map-assets", "fonts", "x", "0-255.pbf")).from)
        assertEquals(404, s.tiles.answer(listOf("map-assets", "..", "secret.txt")).code)
        assertEquals(404, s.tiles.answer(listOf("map-assets", "sprites", "nope.png")).code)
        s.online.set(0)
        assertEquals(404, s.tiles.answer(listOf("map-assets", "fonts", "x", "0-255.pbf")).code)
        assertEquals(404, s.tiles.answer(listOf("tiles", "15", "1", "nope")).code)
        assertEquals(404, s.tiles.answer(listOf("elsewhere")).code)
    }

    // ---- The trip cache ---------------------------------------------------------------

    @Test
    fun trip_tiles_last_a_week() {
        var now = 1_000_000_000_000L
        val trip = TripCache(File(work, "trips")) { now }
        trip.put(15, 1, 2, "a".toByteArray())
        trip.put(15, 1, 3, "b".toByteArray())
        now += TripCache.KEEP_MILLIS - 60_000
        assertEquals("a", String(trip.get(15, 1, 2)!!))
        // Used by another trip: another week.
        assertTrue(trip.keep(15, 1, 3))
        now += 120_000
        assertNull(trip.get(15, 1, 2))
        assertFalse(File(work, "trips/15/1/2").exists())
        assertEquals("b", String(trip.get(15, 1, 3)!!))
        now += TripCache.KEEP_MILLIS
        assertEquals(1, trip.prune())
        assertFalse(File(work, "trips/15").exists())
        assertEquals(0L, trip.bytes())
    }

    @Test
    fun the_corridor_follows_the_road_with_the_overview_first() {
        // Dubbo to Narromine, about 40 km west.
        val line = listOf(-32.2569 to 148.6011, -32.2400 to 148.4000, -32.2310 to 148.2370)
        val tiles = TripCache.corridor(line)
        assertEquals((0..15).toList(), tiles.map { it.z }.distinct())
        // Zooms in order, and both ends at full detail.
        assertEquals(tiles.map { it.z }.sorted(), tiles.map { it.z })
        val z15 = tiles.filter { it.z == 15 }
        assertTrue(TileMath.of(-32.2569, 148.6011, 15) in z15)
        assertTrue(TileMath.of(-32.2310, 148.2370, 15) in z15)
        // In drive order: Dubbo's end first.
        assertTrue(z15.indexOf(TileMath.of(-32.2569, 148.6011, 15)) < z15.indexOf(TileMath.of(-32.2310, 148.2370, 15)))
        // A narrow strip, not the whole box: 40 km at ~1 km tiles, a few tiles wide.
        assertTrue("${z15.size} z15 tiles", z15.size in 40..200)
        assertTrue(TileMath.of(-32.40, 148.40, 15) !in z15)
    }

    @Test
    fun saving_a_trip_skips_squares_keeps_what_it_has_and_stops_at_the_cap() {
        val line = listOf(-32.2569 to 148.6011, -32.2310 to 148.2370)
        val corridor = TripCache.corridor(line)
        val serverTiles = corridor.associateWith { PmTilesWriter.tileBytes(it, "server") }
        val s = setup(emptyMap(), serverTiles)
        val inSquare = corridor.filter { it.z == 15 }.take(5).toSet()
        val already = corridor.filter { it.z == 14 }.take(3)
        already.forEach { s.trip.put(it.z, it.x, it.y, "old".toByteArray()) }
        val basemap = ServerBasemap(link = { s.server!!.url }, http = { OkHttpClient() })
        val saved = s.trip.save(line, basemap, inSquares = { it in inSquare })
        assertEquals(corridor.size - inSquare.size - already.size, saved.tiles)
        assertEquals(already.size, saved.kept)
        assertFalse(saved.full)
        for (t in corridor) {
            when (t) {
                in inSquare -> assertFalse(s.trip.has(t.z, t.x, t.y))
                in already -> assertEquals("old", String(s.trip.get(t.z, t.x, t.y)!!))
                else -> assertEquals("server ${t.z}/${t.x}/${t.y}", text(s.trip.get(t.z, t.x, t.y)))
            }
        }
        // Neighbouring tiles were read together, not one request each.
        assertTrue("${s.server!!.requests.size} requests for ${saved.tiles} tiles", s.server.requests.size < saved.tiles / 4)

        // A cap: the overview and the start of the trip, not the rest.
        val small = TripCache(File(work, "trips-small"))
        val capped = small.save(line, basemap, inSquares = { false }, capBytes = 2_000)
        assertTrue(capped.full)
        assertTrue(capped.bytes <= 2_000)
        assertTrue(small.has(0, 0, 0))
    }

    @Test
    fun a_link_that_stops_working_is_asked_for_again_once() {
        val tile = dubbo15
        // Bigger than the first 16 KB read, so the tile itself needs the server.
        val f = PmTilesWriter.write(File(work, "basemap.pmtiles"), mapOf(tile to PmTilesWriter.gzip(kotlin.random.Random(1).nextBytes(40_000))))
        PmTilesWriter.RangeServer(f).use { server ->
            val links = AtomicInteger()
            val basemap = ServerBasemap(link = { links.incrementAndGet(); server.url }, http = { OkHttpClient() })
            assertNotNull(basemap.tile(tile.z, tile.x, tile.y))
            assertEquals(1, links.get())
            // A new build went live on the server: the old link is a 404 once.
            server.status = 404
            assertTrue(runCatching { basemap.tile(tile.z, tile.x, tile.y) }.isFailure)
            assertEquals(2, links.get())
            server.status = null
            assertTrue(basemap.resting())
            // A server that ignores Range is never read whole.
            server.ignoreRange = true
            val fresh = ServerBasemap(link = { server.url }, http = { OkHttpClient() })
            assertTrue(runCatching { fresh.tile(tile.z, tile.x, tile.y) }.exceptionOrNull() is IOException)
        }
    }

    // ---- The style ----------------------------------------------------------------------

    @Test
    fun the_style_points_its_map_fonts_and_sprites_at_the_phone() {
        val frontend = File(System.getProperty("pw.frontend") ?: "../frontend")
        val raw = File(frontend, "public/map-assets/style-light.json").takeIf { it.isFile }?.readText()
            ?: """{"version":8,"glyphs":"__ORIGIN__/map-assets/fonts/{fontstack}/{range}.pbf","sprite":"__ORIGIN__/map-assets/sprites/light","sources":{"protomaps":{"type":"vector","url":"pmtiles://__BASEMAP__"}},"layers":[]}"""
        val style = JSONObject(MapTiles.style(raw))
        val source = style.getJSONObject("sources").getJSONObject("protomaps")
        assertFalse(source.has("url"))
        assertEquals(MapTiles.TILES, source.getJSONArray("tiles").getString(0))
        assertEquals(15, source.getInt("maxzoom"))
        assertEquals("${MapTiles.ORIGIN}/map-assets/fonts/{fontstack}/{range}.pbf", style.getString("glyphs"))
        assertTrue(style.getString("sprite").startsWith(MapTiles.ORIGIN))
        assertFalse(MapTiles.style(raw).contains("__"))
    }
}
