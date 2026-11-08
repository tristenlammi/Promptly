package org.promptly.sync.maps

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.maps.offline.AddressQuery
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException
import java.net.SocketTimeoutException
import java.nio.file.Files
import java.time.Instant

/** WP-M6 and WP-M7: search with the server first and the phone when it can't answer,
 *  the places kept on the phone for no signal, "Save where I parked" with no signal,
 *  reading addresses, and what the Drive screen is opened with. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class OfflinePlacesTest {
    private lateinit var work: File

    @Before
    fun setUp() {
        work = Files.createTempDirectory("offline-places").toFile()
    }

    @After
    fun tearDown() {
        work.deleteRecursively()
    }

    private val servo = Stop(-32.25, 148.6, "Caltex Dubbo")
    private val onPhone = listOf(Stop(-32.26, 148.59, "Ampol Dubbo"))

    // ---- Hybrid search ------------------------------------------------------------

    @Test
    fun theServerAnswersFirst() {
        var phoneAsked = false
        var limit = 0L
        val found = HybridSearch(SearchServer { _, _, ms -> limit = ms; listOf(servo) }, { _, _ -> phoneAsked = true; onPhone }).find("caltex", null)
        assertEquals(listOf(servo), found.stops)
        assertFalse(found.offline)
        assertFalse(phoneAsked)
        // A short limit: you're waiting on one bar of signal.
        assertEquals(4_000L, limit)
    }

    @Test
    fun noAnswerInTimeThePhoneAnswers() {
        for (problem in listOf(SocketTimeoutException("timeout"), IOException("No connection"), HttpStatus(503), HttpStatus(502), HttpStatus(401))) {
            val found = HybridSearch(SearchServer { _, _, _ -> throw problem }, { _, _ -> onPhone }).find("ampol", -32.2 to 148.6)
            assertTrue("$problem", found.offline)
            assertEquals("Ampol Dubbo", found.stops.single().name)
            // Results from the phone say so.
            assertTrue(found.stops.all { it.offline })
            assertEquals(problem, found.problem)
        }
    }

    @Test
    fun aRefusalAboutTheWordsIsAnAnswer() {
        var phoneAsked = false
        val found = HybridSearch(SearchServer { _, _, _ -> throw HttpStatus(422) }, { _, _ -> phoneAsked = true; onPhone }).find("x", null)
        assertTrue(found.stops.isEmpty())
        assertFalse(found.offline)
        assertFalse(phoneAsked)
        // Nothing found on the server is nothing found, not a reason to look offline.
        assertTrue(HybridSearch(SearchServer { _, _, _ -> emptyList() }, { _, _ -> onPhone }).find("x", null).stops.isEmpty())
    }

    @Test
    fun withNoServerOnlyThePhone() {
        val found = HybridSearch(null, { q, near -> assertEquals("caltex", q); assertEquals(-32.0 to 148.0, near); onPhone }).find("caltex", -32.0 to 148.0)
        assertTrue(found.offline)
        assertNull(found.problem)
    }

    // ---- Places kept on the phone ------------------------------------------------------

    private fun placesAnswer(): JSONObject = JSONObject()
        .put("places", JSONArray()
            .put(JSONObject().put("kind", "home").put("name", "Home").put("address", "4 Smith St, Dubbo").put("lat", -32.24).put("lon", 148.61))
            .put(JSONObject().put("kind", "work").put("name", "Hospital").put("address", JSONObject.NULL).put("lat", -32.257).put("lon", 148.609))
            .put(JSONObject().put("kind", "favourite").put("name", "Mum's").put("address", "Wellington").put("lat", -32.55).put("lon", 148.94)))
        .put("recents", JSONArray().put(JSONObject().put("name", "Bunnings").put("address", "Dubbo").put("lat", -32.23).put("lon", 148.63)))
        .put("parked", JSONObject().put("lat", -32.245).put("lon", 148.605).put("note", JSONObject.NULL).put("at", "2026-11-09T01:00:00Z"))

    private fun routesAnswer(): JSONObject = JSONObject().put("routes", JSONArray().put(
        JSONObject().put("id", "r1").put("name", "School run").put("mode", "drive")
            .put("from", JSONObject().put("lat", -32.24).put("lon", 148.61).put("name", "Home"))
            .put("to", JSONObject().put("lat", -32.3).put("lon", 148.5).put("name", "Dubbo South School")),
    ))

    @Test
    fun placesAreKeptPerServer() {
        val cache = PlacesCache(work)
        assertNull(cache.places("https://a.example"))
        cache.savePlaces("https://a.example", placesAnswer())
        cache.saveRoutes("https://a.example", routesAnswer())
        val stops = Maps.placesFrom(cache.places("https://a.example")!!)
        assertEquals(listOf("home", "work", "favourite", "parked", "recent"), stops.map { it.kind })
        assertEquals("Dubbo South School", cache.routes("https://a.example").single().to.name)
        // Another server's (another account's) copy is never used.
        assertNull(cache.places("https://b.example"))
        assertTrue(cache.routes("https://b.example").isEmpty())
        // A broken file is nothing kept, not a crash.
        File(work, "maps-places.json").writeText("{not json")
        assertNull(cache.places("https://a.example"))
    }

    @Test
    fun recentsGoFirstOnceEachAndAtMostTen() {
        val cache = PlacesCache(work)
        cache.savePlaces("https://a.example", placesAnswer())
        cache.addRecent("https://a.example", Stop(-32.23, 148.63, "Bunnings Dubbo", address = "Dubbo"))
        var recents = Maps.placesFrom(cache.places("https://a.example")!!).filter { it.kind == "recent" }
        // The same spot again moves to the front with its new name, not twice.
        assertEquals(listOf("Bunnings Dubbo"), recents.map { it.name })
        for (i in 1..12) cache.addRecent("https://a.example", Stop(-30.0 - i, 150.0, "Place $i"))
        recents = Maps.placesFrom(cache.places("https://a.example")!!).filter { it.kind == "recent" }
        assertEquals(PlacesCache.MAX_RECENTS, recents.size)
        assertEquals("Place 12", recents.first().name)
        // With nothing kept yet, a first recent still works.
        val fresh = PlacesCache(File(work, "fresh"))
        fresh.addRecent("https://a.example", servo)
        assertEquals("Caltex Dubbo", Maps.placesFrom(fresh.places("https://a.example")!!).single().name)
    }

    @Test
    fun yourPlacesMatchLikeTheServers() {
        val cache = PlacesCache(work)
        cache.savePlaces("s", placesAnswer())
        cache.saveRoutes("s", routesAnswer())
        val mine = Maps.placesFrom(cache.places("s")!!)
        val routes = cache.routes("s")
        assertEquals("Home", PlacesCache.matching(mine, routes, "home").single().name)
        // Work by the word "work", though it's named Hospital.
        assertEquals("Hospital", PlacesCache.matching(mine, routes, "work").single().name)
        assertEquals("Mum's", PlacesCache.matching(mine, routes, "mum").single().name)
        assertEquals("Bunnings", PlacesCache.matching(mine, routes, "bunn").single().name)
        assertEquals("parked", PlacesCache.matching(mine, routes, "my car").single().kind)
        // A usual route by its name or where it goes.
        val school = PlacesCache.matching(mine, routes, "school run").single()
        assertEquals("Dubbo South School", school.name)
        assertEquals("Usual route · School run", school.address)
        assertTrue(PlacesCache.matching(mine, routes, "   ").isEmpty())
        // Where you parked, saved on the phone with no signal, shows at once.
        cache.setParked("s", -33.0, 151.0, "2026-11-09T02:00:00Z")
        assertEquals(-33.0, Maps.placesFrom(cache.places("s")!!).first { it.kind == "parked" }.lat, 1e-9)
    }

    // ---- Parking with no signal ---------------------------------------------------------

    private fun pending(at: String, lat: Double = -32.0, server: String = "s") = ParkQueue.Pending(server, lat, 148.0, "manual", at)

    @Test
    fun theLatestPlaceWaitsAndIsSentOnce() {
        val q = ParkQueue(File(work, "park.json"))
        assertTrue(q.flush("s") { error("nothing to send") })
        q.put(pending("2026-11-09T01:00:00Z", -32.0))
        q.put(pending("2026-11-09T02:00:00Z", -33.0))
        // An older one arriving later doesn't replace the newer.
        q.put(pending("2026-11-09T00:30:00Z", -34.0))
        assertEquals(-33.0, q.peek()!!.lat, 1e-9)
        val sent = mutableListOf<ParkQueue.Pending>()
        // Still no signal: kept.
        assertFalse(q.flush("s") { throw IOException("No connection") })
        assertEquals(-33.0, q.peek()!!.lat, 1e-9)
        // Back online: sent with the time you parked, then gone.
        assertTrue(q.flush("s") { sent += it })
        assertEquals(listOf("2026-11-09T02:00:00Z"), sent.map { it.at })
        assertNull(q.peek())
    }

    @Test
    fun aRefusalOrAnotherServerDropsIt() {
        val q = ParkQueue(File(work, "park.json"))
        q.put(pending(Instant.now().toString()))
        assertTrue(q.flush("s") { throw IOException("Server said 422: bad") })
        assertNull(q.peek())
        // Signed out (401) waits for a new sign-in.
        q.put(pending(Instant.now().toString()))
        assertFalse(q.flush("s") { throw IOException("Server said 401") })
        // Signed in to another server since: not that one's business.
        assertTrue(q.flush("https://other.example") { error("must not send") })
        assertNull(q.peek())
    }

    @Test
    fun aNewerPlaceSavedWhileSendingStays() {
        val q = ParkQueue(File(work, "park.json"))
        q.put(pending("2026-11-09T01:00:00Z", -32.0))
        assertTrue(q.flush("s") { q.put(pending("2026-11-09T03:00:00Z", -35.0)) })
        assertEquals(-35.0, q.peek()!!.lat, 1e-9)
    }

    // ---- Reading what you typed, and what Drive opens with -------------------------------

    @Test
    fun addressesAreReadFromWhatYouType() {
        assertEquals(AddressQuery("12", null, listOf("smith", "st", "newtown")), AddressQuery.parse("12 Smith St, Newtown"))
        assertEquals(AddressQuery("12a", null, listOf("smith", "st")), AddressQuery.parse("12A Smith St"))
        assertEquals(AddressQuery("12-14", null, listOf("smith", "st")), AddressQuery.parse("12-14 Smith St"))
        assertEquals(AddressQuery("12", "3", listOf("smith", "st")), AddressQuery.parse("3/12 Smith St"))
        assertEquals(AddressQuery("12", "3B", listOf("smith", "st")), AddressQuery.parse("Unit 3B, 12 Smith St"))
        assertEquals(AddressQuery("7", null, listOf("george", "st", "sydney", "nsw", "2000")), AddressQuery.parse("7 George St Sydney NSW 2000"))
        assertNull(AddressQuery.parse("Caltex Mudgee"))
        assertNull(AddressQuery.parse("12"))
        assertNull(AddressQuery.parse("2830 2831"))
        assertNull(AddressQuery.parse("Uralla Street"))
    }

    @Test
    fun driveOpensOnAPlaceOrASearch() {
        val to = DriveAsk.fromWebPath("/maps?to=-33.800000%2C151.200000%2CMum")!!
        assertEquals(-33.8, to.place!!.lat, 1e-9)
        assertEquals("Mum", to.place!!.name)
        assertEquals("coffee", DriveAsk.fromWebPath("/maps?q=coffee")!!.query)
        assertEquals("Dropped pin", DriveAsk.fromWebPath("/maps?to=-33.8,151.2")!!.place!!.name)
        assertNull(DriveAsk.fromWebPath("/photos"))
        assertNull(DriveAsk.fromWebPath(null))
        assertNull(DriveAsk.fromWebPath("/maps"))
        assertEquals("22 min", duration(1310))
        assertEquals("1 h 5 min", duration(3900))
        assertEquals("2 h", duration(7200))
    }
}
