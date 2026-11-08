package org.promptly.sync.maps.offline

import android.database.sqlite.SQLiteDatabase
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException
import java.nio.file.Files

/** The download engine against a fake server: resume, damaged files, a new build
 *  mid-download, no space, expired links, and the one-build routing rule. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class OfflineEngineTest {
    private lateinit var dir: File
    private lateinit var server: FakePackServer
    private lateinit var store: OfflineStore
    private var free = 10L * 1024 * 1024 * 1024

    private val dubbo = "148_-33"
    private val orange = "149_-34"
    private val canberra = "149_-36"

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("offline").toFile()
        server = FakePackServer(File(dir, "fake").apply { mkdirs() })
        store = OfflineStore(File(dir, "phone"))
    }

    @After
    fun tearDown() {
        server.close()
        dir.deleteRecursively()
    }

    private fun engine(stopped: () -> Boolean = { false }, progress: (OfflineEngine.Progress) -> Unit = {}) =
        OfflineEngine(store, OfflineApi(server.url, OkHttpClient()), Downloader(OkHttpClient()), { free }, stopped, progress)

    /** A fresh store, as after the app is killed and started again. */
    private fun restart() {
        store = OfflineStore(File(dir, "phone"))
    }

    private fun pack(key: String) = server.packs.getValue(key)

    private fun routingFiles(root: File = store.routingDir): Set<String> =
        if (!root.exists()) emptySet() else root.walkTopDown().filter { it.isFile }.map { it.relativeTo(root).path.replace('\\', '/') }.toSet()

    private fun membersOf(p: FakePackServer.Pack): Set<String> {
        val f = File(dir, "check.tar")
        f.writeBytes(p.bytes)
        return Tar.list(f).map { it.path }.toSet()
    }

    private fun db(): SQLiteDatabase = SQLiteDatabase.openDatabase(store.search.file.path, null, SQLiteDatabase.OPEN_READONLY)

    @Test
    fun downloads_everything_and_puts_it_in_place() {
        server.publish("build-1", 1, dubbo, orange)
        engine().sync(mapOf(dubbo to true, orange to false))

        val s = store.state
        assertEquals("build-1", s.routingBuild)
        assertEquals("build-1", s.syncedBuild)
        assertTrue(store.has(listOf(dubbo), true))
        assertTrue(store.has(listOf(orange), false))
        assertFalse(store.has(listOf(orange), true))
        // Maps are the server's bytes.
        assertTrue(store.mapFile(dubbo).readBytes().contentEquals(pack("$dubbo/map").bytes))
        assertTrue(File(store.baseDir, "cameras.json").readBytes().contentEquals(pack("base/cameras").bytes))
        // One routing folder: both squares' tiles and the level-0 tile(s).
        val expected = membersOf(pack("$dubbo/route")) + membersOf(pack("$orange/route")) +
            setOf(dubbo, orange).map { Cells.level0(it) }.toSet().flatMap { membersOf(pack("l0/$it")) }
        assertEquals(expected, routingFiles())
        assertTrue(store.routingReady(listOf(dubbo, orange)))
        // Nothing left half-downloaded.
        assertTrue(!store.downloadsDir.exists() || store.downloadsDir.listFiles().isNullOrEmpty())

        // Search: both squares' places in one FTS index, each in its own id range; house numbers only where wanted.
        db().use { db ->
            db.rawQuery("SELECT p.id, p.cell FROM places_fts f JOIN places p ON p.id = f.docid WHERE places_fts MATCH 'caltex'", null).use { c ->
                val rows = buildList { while (c.moveToNext()) add(c.getLong(0) to c.getString(1)) }
                assertEquals(2, rows.size)
                rows.forEach { (id, cell) -> assertTrue(id in Cells.idRange(cell)) }
            }
            db.rawQuery("SELECT count(*) FROM addresses a JOIN streets s ON s.id = a.street WHERE s.cell = ?", arrayOf(dubbo)).use { c ->
                c.moveToFirst(); assertEquals(11, c.getInt(0))
            }
            db.rawQuery("SELECT count(*) FROM streets WHERE cell = ?", arrayOf(orange)).use { c -> c.moveToFirst(); assertEquals(0, c.getInt(0)) }
        }
    }

    @Test
    fun a_cut_connection_resumes_with_range_from_the_same_byte() {
        server.publish("build-1", 1, dubbo)
        server.cutAfter["$dubbo/map"] = 200_000
        try {
            engine().sync(mapOf(dubbo to true))
            fail("the cut download should stop the run")
        } catch (e: IOException) {
            assertFalse(e is NoSpace)
        }
        val part = File(store.downloadsDir, pack("$dubbo/map").sha + ".part")
        assertTrue(part.isFile)
        val have = part.length()
        assertTrue("kept ${have} bytes", have in 1..200_000)

        restart()
        engine().sync(mapOf(dubbo to true))
        val asked = server.ranges.filter { it.first == "$dubbo/map" }
        assertEquals(2, asked.size)
        assertNull(asked[0].second)
        assertEquals("bytes=$have-", asked[1].second)
        assertTrue(store.mapFile(dubbo).readBytes().contentEquals(pack("$dubbo/map").bytes))
    }

    @Test
    fun killed_mid_download_carries_on_where_it_stopped() {
        server.publish("build-1", 1, dubbo, orange)
        var heard = 0L
        try {
            engine(stopped = { heard > 300_000 }) { p -> if (p.current != null) heard = p.currentBytes }
                .sync(mapOf(dubbo to true, orange to true))
            fail("should stop")
        } catch (_: Stopped) {
        }
        val before = store.state.files.keys.toSet()
        restart()
        engine().sync(mapOf(dubbo to true, orange to true))
        // What was in place stayed; the file it stopped in was asked for from where it got to.
        assertTrue(server.ranges.any { it.second != null && it.second != "bytes=0-" })
        before.forEach { key -> assertEquals(1, server.served.count { it == key }) }
        assertTrue(store.has(listOf(dubbo, orange), true))
    }

    @Test
    fun a_damaged_file_is_fetched_again_and_never_installed() {
        server.publish("build-1", 1, dubbo)
        server.damage["$dubbo/route"] = 1
        engine().sync(mapOf(dubbo to true))
        assertEquals(2, server.served.count { it == "$dubbo/route" })
        assertTrue(routingFiles().containsAll(membersOf(pack("$dubbo/route"))))

        // Damaged every time: the run fails and nothing of it is in place.
        val other = OfflineStore(File(dir, "phone2"))
        store = other
        server.damage["$dubbo/map"] = 5
        try {
            engine().sync(mapOf(dubbo to true))
            fail("should fail")
        } catch (e: Damaged) {
        }
        assertFalse(store.mapFile(dubbo).exists())
        assertNull(store.state.files["$dubbo/map"])
        assertFalse(File(store.downloadsDir, pack("$dubbo/map").sha + ".part").exists())
    }

    @Test
    fun an_expired_link_is_asked_for_again() {
        server.publish("build-1", 1, dubbo)
        // Every link from the first list has run out by the time it's used.
        server.linksValidFrom = 2
        engine().sync(mapOf(dubbo to true))
        assertEquals(2, server.listings.get())
        assertTrue(store.has(listOf(dubbo), true))
    }

    @Test
    fun a_new_build_mid_download_never_mixes_routing() {
        server.publish("build-1", 1, dubbo, orange)
        // Halfway through, the server's monthly refresh goes live.
        server.onServe = { key ->
            if (key == "$orange/map" && server.build == "build-1") server.publish("build-2", 2, dubbo, orange)
        }
        engine().sync(mapOf(dubbo to true, orange to true))
        val s = store.state
        assertEquals("build-2", s.routingBuild)
        assertTrue(s.routing.values.all { it.build == "build-2" })
        val expected = membersOf(pack("$dubbo/route")) + membersOf(pack("$orange/route")) +
            setOf(dubbo, orange).map { Cells.level0(it) }.toSet().flatMap { membersOf(pack("l0/$it")) }
        assertEquals(expected, routingFiles())
        for (key in listOf("$dubbo/route", "$orange/route")) assertEquals(pack(key).sha, s.routing.getValue(key).sha)
    }

    @Test
    fun an_update_goes_into_routing_next_and_swaps_whole() {
        server.publish("build-1", 1, dubbo, orange)
        engine().sync(mapOf(dubbo to true, orange to true))
        val oldRouting = routingFiles()

        // build-2 changes everything; stop partway through the update.
        server.publish("build-2", 2, dubbo, orange)
        var files = 0
        try {
            engine(stopped = { files >= 3 }) { p -> files = p.done.size }.sync(mapOf(dubbo to true, orange to true))
            fail("should stop")
        } catch (_: Stopped) {
        }
        // Mid-update: offline routing is still all of build-1, untouched.
        assertEquals("build-1", store.state.routingBuild)
        assertEquals(oldRouting, routingFiles())
        assertTrue(store.routingReady(listOf(dubbo, orange)))

        restart()
        engine().sync(mapOf(dubbo to true, orange to true))
        assertEquals("build-2", store.state.routingBuild)
        assertNull(store.state.nextBuild)
        assertFalse(store.nextDir.exists())
        val expected = membersOf(pack("$dubbo/route")) + membersOf(pack("$orange/route")) +
            setOf(dubbo, orange).map { Cells.level0(it) }.toSet().flatMap { membersOf(pack("l0/$it")) }
        assertEquals(expected, routingFiles())
        assertTrue(store.mapFile(dubbo).readBytes().contentEquals(pack("$dubbo/map").bytes))
    }

    @Test
    fun an_update_with_unchanged_routing_copies_instead_of_downloading() {
        server.publish("build-1", 1, dubbo)
        engine().sync(mapOf(dubbo to true))
        server.served.clear()
        server.publish("build-2", 2, dubbo, sameRouteAs = 1)
        engine().sync(mapOf(dubbo to true))
        assertFalse(server.served.contains("$dubbo/route"))
        assertEquals("build-2", store.state.routingBuild)
        assertTrue(routingFiles().containsAll(membersOf(pack("$dubbo/route"))))
    }

    @Test
    fun a_swap_cut_short_by_a_crash_is_finished_on_the_next_start() {
        server.publish("build-1", 1, dubbo)
        engine().sync(mapOf(dubbo to true))
        server.publish("build-2", 2, dubbo)
        // Do the update by hand up to the first rename, as if the phone died there.
        val s = store.state
        s.nextBuild = "build-2"
        File(store.nextDir, "2/x.gph").apply { parentFile!!.mkdirs(); writeText("new") }
        s.next["$dubbo/route"] = OfflineStore.Installed("abc", 3, "build-2", 3, listOf("2/x.gph"))
        s.swapping = true
        store.save()
        store.routingDir.renameTo(File(store.root, "routing-old"))

        restart()
        store.recover()
        assertEquals("build-2", store.state.routingBuild)
        assertEquals(setOf("2/x.gph"), routingFiles())
        assertFalse(File(store.root, "routing-old").exists())
        assertFalse(store.state.swapping)
    }

    @Test
    fun not_enough_space_says_how_much_and_downloads_nothing() {
        server.publish("build-1", 1, dubbo)
        free = 1_000_000
        try {
            engine().sync(mapOf(dubbo to true))
            fail("should be out of space")
        } catch (e: NoSpace) {
            assertEquals(1_000_000, e.free)
            assertTrue(e.need > pack("$dubbo/map").bytes.size)
            assertFalse(e.canDropOld)
            assertTrue(e.message!!.startsWith("Not enough space: this needs"))
        }
        assertTrue(server.served.isEmpty())
        assertNotNull(store.state.noSpace)
        assertFalse(store.mapFile(dubbo).exists())
    }

    @Test
    fun an_update_short_of_space_can_remove_the_old_copy_first() {
        server.publish("build-1", 1, dubbo)
        engine().sync(mapOf(dubbo to true))
        server.publish("build-2", 2, dubbo)
        // Enough for the new routing only once the old copy is gone.
        val routingDisk = store.state.routing.values.sumOf { it.disk }
        free = OfflineEngine.MARGIN + 900_000L
        try {
            engine().sync(mapOf(dubbo to true))
            fail("should be out of space")
        } catch (e: NoSpace) {
            assertTrue(e.canDropOld)
        }
        assertEquals("build-1", store.state.routingBuild)

        store.state.dropOld = true
        store.save()
        free += routingDisk + 2_000_000
        engine().sync(mapOf(dubbo to true))
        assertEquals("build-2", store.state.routingBuild)
        assertFalse(store.state.dropOld)
        assertNull(store.state.noSpace)
    }

    @Test
    fun deleting_an_area_frees_its_own_squares_and_keeps_shared_ones() {
        server.publish("build-1", 1, dubbo, orange, canberra)
        engine().sync(mapOf(dubbo to true, orange to true, canberra to true))
        val before = store.diskBytes()
        val keepRouting = membersOf(pack("$orange/route")) + membersOf(pack("$canberra/route"))

        // Area A = Dubbo + Orange, area B = Orange + Canberra. Delete A.
        val predicted = store.freedBy(listOf(dubbo, orange), listOf(orange, canberra))
        store.prune(mapOf(orange to true, canberra to true))
        val freed = before - store.diskBytes()

        assertFalse(store.mapFile(dubbo).exists())
        assertTrue(store.mapFile(orange).exists())
        assertNull(store.state.routing["$dubbo/route"])
        assertTrue(routingFiles().containsAll(keepRouting))
        assertTrue(routingFiles().none { it in membersOf(pack("$dubbo/route")) })
        db().use { db ->
            db.rawQuery("SELECT count(*) FROM places WHERE cell = ?", arrayOf(dubbo)).use { c -> c.moveToFirst(); assertEquals(0, c.getInt(0)) }
            db.rawQuery("SELECT count(*) FROM places_fts WHERE places_fts MATCH 'caltex'", null).use { c -> c.moveToFirst(); assertEquals(2, c.getInt(0)) }
        }
        // The map and routing tiles that went are exactly the deleted square's (search is an estimate).
        val tar = File(dir, "check.tar").apply { writeBytes(pack("$dubbo/route").bytes) }
        val exact = pack("$dubbo/map").bytes.size + Tar.list(tar).sumOf { it.bytes }
        assertTrue("freed $freed, map+routing $exact", freed >= exact)
        assertTrue("predicted $predicted vs freed $freed", predicted >= exact && predicted <= freed + 200_000)
    }

    @Test
    fun leaving_out_house_numbers_removes_only_those() {
        server.publish("build-1", 1, dubbo)
        engine().sync(mapOf(dubbo to true))
        store.prune(mapOf(dubbo to false))
        assertNull(store.state.files["$dubbo/addresses"])
        assertNotNull(store.state.files["$dubbo/places"])
        db().use { db ->
            db.rawQuery("SELECT count(*) FROM addresses", null).use { c -> c.moveToFirst(); assertEquals(0, c.getInt(0)) }
            db.rawQuery("SELECT count(*) FROM places", null).use { c -> c.moveToFirst(); assertEquals(3, c.getInt(0)) }
        }
        assertTrue(store.has(listOf(dubbo), false))
        assertFalse(store.has(listOf(dubbo), true))
    }

    @Test
    fun no_areas_left_clears_everything() {
        server.publish("build-1", 1, dubbo)
        engine().sync(mapOf(dubbo to true))
        engine().sync(emptyMap())
        assertFalse(store.routingDir.exists())
        assertFalse(store.search.file.exists())
        assertFalse(store.cellsDir.exists())
        assertNull(store.state.routingBuild)
    }

    @Test
    fun progress_counts_each_area_and_ends_full() {
        server.publish("build-1", 1, dubbo, orange)
        val seen = mutableListOf<OfflineEngine.Progress>()
        engine { seen += it }.sync(mapOf(dubbo to true, orange to true))
        val last = seen.last()
        assertEquals(last.total, last.have)
        val (have, total) = last.forCells(listOf(dubbo))
        assertEquals(total, have)
        assertTrue(total < last.total)
        assertTrue(seen.any { it.current != null && it.currentBytes in 1 until it.total })
    }
}
