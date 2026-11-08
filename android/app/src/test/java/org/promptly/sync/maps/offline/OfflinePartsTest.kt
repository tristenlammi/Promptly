package org.promptly.sync.maps.offline

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException
import java.nio.file.Files

/** Squares, tars, the map files list and area names. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class OfflinePartsTest {

    @Test
    fun squares_match_the_server() {
        assertEquals(Cells.Cell(151, -34), Cells.parse("151_-34"))
        assertNull(Cells.parse("151-34"))
        assertNull(Cells.parse("181_-34"))
        // maps/areas.py::l0_of: floor((cy + 90) / 4) * 90 + floor((cx + 180) / 4)
        assertEquals(14 * 90 + 82, Cells.level0("151_-34"))
        assertEquals(14 * 90 + 82, Cells.level0("148_-33"))
        assertEquals(13 * 90 + 82, Cells.level0("149_-36"))
        // offline.py::box_cells
        assertEquals(listOf("150_-34", "151_-34", "150_-33", "151_-33"), Cells.inBox(150.2, -33.9, 151.3, -32.5))
        assertEquals(listOf("148_-33"), Cells.inBox(148.1, -32.9, 148.6, -32.1))
    }

    @Test
    fun each_square_has_its_own_id_range() {
        val a = Cells.idRange("151_-34")
        val b = Cells.idRange("151_-33")
        val c = Cells.idRange("-180_-90")
        assertTrue(a.last < b.first || b.last < a.first)
        assertEquals(0L, c.first)
        assertTrue(Cells.idRange("179_89").last < Long.MAX_VALUE)
    }

    @Test
    fun tar_unpacks_and_refuses_unsafe_names() {
        val dir = Files.createTempDirectory("tar").toFile()
        try {
            val tar = File(dir, "t.tar")
            tar.writeBytes(FakePackServer.tar(listOf("2/000/791/234.gph" to ByteArray(700) { 7 }, "1/051/331.gph" to ByteArray(3) { 1 })))
            val out = File(dir, "out")
            val members = Tar.extract(tar, out)
            assertEquals(listOf("2/000/791/234.gph", "1/051/331.gph"), members.map { it.path })
            assertEquals(700, File(out, "2/000/791/234.gph").length())
            assertTrue(File(out, "1/051/331.gph").readBytes().contentEquals(ByteArray(3) { 1 }))

            tar.writeBytes(FakePackServer.tar(listOf("../evil.gph" to ByteArray(1))))
            try {
                Tar.extract(tar, out)
                throw AssertionError("an unsafe name should be refused")
            } catch (_: IOException) {
            }
            assertFalse(File(dir, "evil.gph").exists())
            assertEquals("a/b.gph", Tar.safe("./a/b.gph"))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun map_files_list_matches_the_web_apps_folder() {
        val frontend = System.getProperty("pw.frontend").orEmpty()
        val folder = File(frontend, "public/map-assets")
        assumeTrue("needs the repo's frontend folder", folder.isDirectory)
        val onDisk = folder.walkTopDown().filter { it.isFile }.map { it.relativeTo(folder).path.replace('\\', '/') }.toSortedSet()
        assertEquals(onDisk, MapAssets.FILES.toSortedSet())
        assertEquals(34, MapAssets.FILES.size)
    }

    @Test
    fun area_names_come_from_the_town() {
        val j = JSONObject().put("name", "Caltex").put("address", "Macquarie Street, Dubbo New South Wales 2830")
        assertEquals("Dubbo", OfflineApi.nameFrom(j))
        assertEquals("Mudgee", OfflineApi.nameFrom(JSONObject().put("name", "x").put("address", "Mudgee NSW")))
        assertEquals("Lake Eyre", OfflineApi.nameFrom(JSONObject().put("name", "Lake Eyre").put("address", JSONObject.NULL)))
        assertNull(OfflineApi.nameFrom(JSONObject().put("name", "Dropped pin").put("address", JSONObject.NULL)))
    }

    @Test
    fun sizes_read_plainly() {
        assertEquals("under 1 MB", Sizes.text(10_000))
        assertEquals("1.6 MB", Sizes.text(1_600_000))
        assertEquals("351 MB", Sizes.text(351_000_000))
        assertEquals("4.4 GB", Sizes.text(4_410_000_000))
    }
}
