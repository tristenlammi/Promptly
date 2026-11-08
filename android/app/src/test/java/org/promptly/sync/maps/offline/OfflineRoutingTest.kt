package org.promptly.sync.maps.offline

import com.stadiamaps.ferrostar.core.InvalidStatusCodeException
import com.sun.net.httpserver.HttpServer
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.maps.Camera
import org.promptly.sync.maps.CarPreview
import org.promptly.sync.maps.HttpStatus
import org.promptly.sync.maps.HybridRouting
import org.promptly.sync.maps.Maps
import org.promptly.sync.maps.OfflineRouteUnavailable
import org.promptly.sync.maps.OkHttpRouteServer
import org.promptly.sync.maps.PhoneRouter
import org.promptly.sync.maps.RoutePost
import org.promptly.sync.maps.RouteServer
import org.promptly.sync.maps.RouteSource
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException
import java.net.InetSocketAddress
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** WP-M5: the server first and the phone when it can't answer, the 6-second limit,
 *  squares that aren't downloaded, the engine following the routing build, the
 *  cameras on the phone, and the car's offline route rows. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class OfflineRoutingTest {
    private val work: File = Files.createTempDirectory("offline-routing").toFile()
    private val closing = mutableListOf<AutoCloseable>()

    @After
    fun tidy() {
        closing.forEach { runCatching { it.close() } }
        work.deleteRecursively()
    }

    private val post = RoutePost("https://example.invalid/api/maps/navigate/route", """{"locations":[]}""".toByteArray())
    private val dubbo = listOf("148_-33")

    private class Phone(val answer: () -> String) : PhoneRouter {
        val asked = AtomicInteger()
        var cells: Collection<String> = emptyList()
        override fun route(body: String, cells: Collection<String>): String {
            asked.incrementAndGet()
            this.cells = cells
            return answer()
        }
    }

    // ---- Server first, then the phone ------------------------------------------------

    @Test
    fun the_server_answers_when_it_can() {
        val phone = Phone { "phone" }
        val a = HybridRouting(RouteServer { _, _, _ -> "server".toByteArray() }, { phone }).answer(post, dubbo, reroute = false)
        assertEquals(RouteSource.SERVER, a.source)
        assertEquals("server", String(a.bytes))
        assertEquals(0, phone.asked.get())
    }

    @Test
    fun no_connection_or_a_broken_server_means_the_phone_answers() {
        for (failure in listOf(IOException("Unable to resolve host"), HttpStatus(502), HttpStatus(401), java.net.SocketTimeoutException("timeout"))) {
            val phone = Phone { "phone" }
            val a = HybridRouting(RouteServer { _, _, _ -> throw failure }, { phone }).answer(post, dubbo, reroute = true)
            assertEquals(failure.toString(), RouteSource.PHONE, a.source)
            assertEquals("phone", String(a.bytes))
            assertEquals(dubbo, phone.cells.toList())
            assertEquals(failure, a.serverProblem)
        }
    }

    @Test
    fun no_route_from_the_server_stays_no_route() {
        for (code in listOf(400, 422)) {
            val phone = Phone { "phone" }
            try {
                HybridRouting(RouteServer { _, _, _ -> throw HttpStatus(code) }, { phone }).answer(post, dubbo, reroute = false)
                fail("expected no route")
            } catch (e: InvalidStatusCodeException) {
                assertEquals(code, e.statusCode)
            }
            assertEquals(0, phone.asked.get())
        }
    }

    @Test
    fun squares_that_arent_downloaded_say_so() {
        val missing = PhoneRouter { _, _ -> throw LocalRouter.MissingSquares(listOf("150_-34")) }
        val e = runCatching {
            HybridRouting(RouteServer { _, _, _ -> throw IOException("offline") }, { missing }).answer(post, listOf("148_-33", "150_-34"), reroute = true)
        }.exceptionOrNull() as OfflineRouteUnavailable
        assertTrue(e.outside)
        assertEquals(listOf("150_-34"), e.missing)
        // The squares are here but no road joins them: a different message.
        val noWay = PhoneRouter { _, _ -> throw LocalRouter.NoRoute("Locations are in unconnected regions") }
        val f = runCatching {
            HybridRouting(RouteServer { _, _, _ -> throw IOException("offline") }, { noWay }).answer(post, dubbo, reroute = false)
        }.exceptionOrNull() as OfflineRouteUnavailable
        assertFalse(f.outside)
        // No offline engine at all.
        val g = runCatching { HybridRouting(RouteServer { _, _, _ -> throw IOException("offline") }, { null }).answer(post, dubbo, false) }.exceptionOrNull()
        assertTrue(g is OfflineRouteUnavailable && g.outside)
    }

    @Test
    fun a_server_that_hangs_is_given_six_seconds_then_the_phone_answers() {
        val release = CountDownLatch(1)
        val hanging = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        hanging.createContext("/") { ex ->
            // Connected, never answers: one bar of signal.
            release.await(30, TimeUnit.SECONDS)
            runCatching { ex.sendResponseHeaders(500, -1) }
            ex.close()
        }
        hanging.executor = java.util.concurrent.Executors.newCachedThreadPool()
        hanging.start()
        closing += AutoCloseable {
            release.countDown()
            hanging.stop(0)
        }
        val url = "http://127.0.0.1:${hanging.address.port}/api/maps/navigate/route"
        val phone = Phone { "phone" }
        val routing = HybridRouting(OkHttpRouteServer { OkHttpClient() }, { phone })
        val started = System.nanoTime()
        val a = routing.answer(RoutePost(url, post.body), dubbo, reroute = true)
        val seconds = (System.nanoTime() - started) / 1e9
        assertEquals(RouteSource.PHONE, a.source)
        assertTrue("took $seconds s", seconds in 5.5..7.5)
        assertEquals(6_000L, HybridRouting.SERVER_TIMEOUT_MILLIS)
    }

    @Test
    fun a_trip_is_in_the_squares_of_its_points() {
        assertEquals(listOf("148_-33", "149_-33"), HybridRouting.cellsOf(listOf(-32.25 to 148.6, -32.23 to 148.24, -32.55 to 149.94)))
        assertEquals("151_-34", Cells.of(-33.87, 151.21))
        assertEquals("-1_0", Cells.of(0.5, -0.5))
    }

    // ---- The engine on the phone ----------------------------------------------------------

    private class FakeEngine(val config: File, val opened: MutableList<FakeEngine>) : LocalRouter.Engine {
        var closed = false
        var answer: () -> String = { """{"routes":[]}""" }
        override fun route(body: String): String = answer()
        override fun close() {
            closed = true
        }
    }

    private fun readyStore(build: String): OfflineStore {
        val store = OfflineStore(File(work, "maps-offline"))
        store.state.routingBuild = build
        store.state.routing["148_-33/route"] = OfflineStore.Installed("sha", 10, build, 10)
        store.state.routing["l0/1072"] = OfflineStore.Installed("sha", 10, build, 10)
        return store
    }

    @Test
    fun the_engine_reopens_when_the_routing_build_changes() {
        val store = readyStore("build-1")
        val engines = mutableListOf<FakeEngine>()
        val router = LocalRouter(store, File(work, "valhalla.json"), open = { FakeEngine(it, engines).also { e -> engines += e } })
        router.route("{}", dubbo)
        router.route("{}", dubbo)
        assertEquals(1, router.opened)
        // A new build swapped into routing/: the old engine's files are gone, so a new one.
        store.state.routingBuild = "build-2"
        router.route("{}", dubbo)
        assertEquals(2, router.opened)
        assertTrue(engines[0].closed)
        assertFalse(engines[1].closed)
        // Released after the trip; opened again when needed.
        router.release()
        assertTrue(engines[1].closed)
        router.route("{}", dubbo)
        assertEquals(3, router.opened)
        // Its settings: the routing folder, a 48 MB tile cache, nothing the phone hasn't got.
        val config = JSONObject(File(work, "valhalla.json").readText()).getJSONObject("mjolnir")
        assertEquals(store.routingDir.absolutePath, config.getString("tile_dir"))
        assertEquals(48L * 1024 * 1024, config.getLong("max_cache_size"))
        assertFalse(config.has("tile_extract"))
        assertFalse(config.has("admin"))
        assertFalse(config.has("timezone"))
    }

    @Test
    fun squares_without_routing_or_mid_swap_arent_routed() {
        val store = readyStore("build-1")
        val engines = mutableListOf<FakeEngine>()
        val router = LocalRouter(store, File(work, "valhalla.json"), open = { FakeEngine(it, engines).also { e -> engines += e } })
        val e = runCatching { router.route("{}", listOf("148_-33", "151_-34")) }.exceptionOrNull()
        assertTrue(e is LocalRouter.MissingSquares)
        assertEquals(listOf("151_-34"), (e as LocalRouter.MissingSquares).cells)
        assertEquals(0, router.opened)
        // A swap in progress: nothing until it's done.
        store.state.swapping = true
        assertTrue(runCatching { router.route("{}", dubbo) }.exceptionOrNull() is LocalRouter.MissingSquares)
        store.state.swapping = false
        // No routing at all yet.
        val empty = LocalRouter(OfflineStore(File(work, "empty")), File(work, "v2.json"), open = { FakeEngine(it, engines) })
        assertEquals(dubbo, empty.missing(dubbo))
        // Valhalla's own "no route" becomes NoRoute.
        val failing = LocalRouter(store, File(work, "v3.json"), open = { FakeEngine(it, engines).apply { answer = { throw IllegalStateException("Locations are in unconnected regions") } } })
        assertTrue(runCatching { failing.route("{}", dubbo) }.exceptionOrNull() is LocalRouter.NoRoute)
    }

    // ---- Cameras with no signal -------------------------------------------------------------

    @Test
    fun cameras_on_the_route_come_from_the_downloaded_list() {
        val file = File(work, "cameras.json")
        file.writeText(
            JSONArray()
                // On the road, 20 km in, with a limit.
                .put(JSONObject().put("lat", -32.2404).put("lon", 148.4050).put("maxspeed", 80))
                // On the road near the start, no limit known.
                .put(JSONObject().put("lat", -32.2562).put("lon", 148.5900).put("maxspeed", JSONObject.NULL))
                // A street away.
                .put(JSONObject().put("lat", -32.2600).put("lon", 148.5000).put("maxspeed", 60))
                // Another state.
                .put(JSONObject().put("lat", -37.81).put("lon", 144.96).put("maxspeed", 40))
                .toString(),
        )
        val all = OfflineCameras.all(file)
        assertEquals(4, all.size)
        val line = listOf(-32.2569 to 148.6011, -32.2400 to 148.4000, -32.2310 to 148.2370)
        val found = OfflineCameras.along(all, line)
        assertEquals(listOf(Camera(-32.2562, 148.5900, null), Camera(-32.2404, 148.4050, 80.0)), found)
        assertTrue(OfflineCameras.along(all, emptyList()).isEmpty())
        assertTrue(OfflineCameras.all(File(work, "none.json")).isEmpty())
    }

    // ---- The car's route preview, offline ----------------------------------------------------

    @Test
    fun the_phones_routes_become_the_cars_rows() {
        val main = listOf(-32.2569 to 148.6011, -32.2450 to 148.5000, -32.2400 to 148.4000, -32.2310 to 148.2370)
        val other = listOf(-32.2569 to 148.6011, -32.3000 to 148.5000, -32.2900 to 148.3000, -32.2310 to 148.2370)
        fun route(line: List<Pair<Double, Double>>, seconds: Double, metres: Double, summary: String) = JSONObject()
            .put("duration", seconds).put("distance", metres)
            .put("geometry", Maps.encodeShape(line))
            .put("legs", JSONArray().put(JSONObject().put("summary", summary)))
        val body = JSONObject().put("routes", JSONArray().put(route(main, 1800.0, 40_000.0, "Mitchell Highway, Narromine Road")).put(route(other, 2100.0, 44_500.0, "")))
        val rows = CarPreview.parsePhoneRoutes(body)
        assertEquals(2, rows.size)
        assertEquals(1800, rows[0].seconds)
        assertEquals(40.0, rows[0].km, 0.001)
        assertEquals("Mitchell Highway", rows[0].via)
        assertNull(rows[1].via)
        assertTrue(rows.all { it.offline && it.addsMinutes == 0 })
        // The first is the phone's own pick; the other is held to its road.
        assertTrue(rows[0].through.isEmpty())
        assertEquals(3, rows[1].through.size)
        // (lon, lat) for the car's map line.
        assertEquals(148.6011, rows[0].line.first().first, 1e-5)
        assertEquals(-32.2569, rows[0].line.first().second, 1e-5)
        // Heading west-ish along the second road.
        assertTrue(rows[1].through.all { it.heading != null && it.heading!! in 200..340 })
    }
}
