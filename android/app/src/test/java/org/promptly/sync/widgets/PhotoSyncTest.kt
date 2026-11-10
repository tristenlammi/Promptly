package org.promptly.sync.widgets

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.preferencesOf
import androidx.glance.appwidget.testing.unit.runGlanceAppWidgetUnitTest
import androidx.glance.testing.unit.hasText
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.Refused
import org.promptly.sync.Unlinked
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException

/** The Photo widget's saved photos: filled from the server, kept few, dropped
 *  when they leave the album, the album emptied or deleted, wiped with the
 *  rest when the phone is removed; and the widget's states. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PhotoSyncTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val album = "11111111-2222-3333-4444-555555555555"

    /** A stand-in server with an album of [inAlbum] photos. */
    private class Fake(var inAlbum: List<String>) : WidgetBackend {
        var title = "Biscuit"
        var gone = false
        var asked = mutableListOf<Pair<Int, List<String>>>()
        var downloads = mutableListOf<String>()
        var failDownload: (String) -> Exception? = { null }
        var failAlbum: Exception? = null

        override fun snapshot(want: List<String>, days: Int, someday: Boolean, etags: Map<String, String>, noteIds: List<String>) = JSONObject()
        override fun send(op: Op) = JSONObject()

        override fun albumPhotos(albumId: String, n: Int, have: List<String>): JSONObject {
            failAlbum?.let { throw it }
            if (gone) throw Refused(404, "That album isn't there any more.")
            asked += n to have
            // As the server: new ones first, then ones the phone holds.
            val picked = (inAlbum.filter { it !in have } + inAlbum.filter { it in have }).take(n)
            return JSONObject()
                .put("album", JSONObject().put("id", albumId).put("title", title).put("count", inAlbum.size))
                .put("photos", JSONArray(picked.map { JSONObject().put("id", it).put("url", "/m/$it").put("thumb", "/m/t-$it") }))
                .put("gone", JSONArray(have.filter { it !in inAlbum }))
        }

        override fun download(url: String, max: Long): ByteArray {
            failDownload(url)?.let { throw it }
            downloads += url
            return url.toByteArray()
        }
    }

    private var clock = 1_000_000L

    /** Stands in for shrinking the picture: writes the bytes, each a moment after the last. */
    private val save: (ByteArray, File) -> Boolean = { bytes, file ->
        file.parentFile?.mkdirs()
        file.writeBytes(bytes)
        clock += 1000
        file.setLastModified(clock)
        true
    }

    private fun sync(api: WidgetBackend, now: Long, showing: Set<String> = emptySet(), albums: List<String> = listOf(album)) =
        PhotoSync.run(ctx, api, albums, now, showing, save)

    private fun ids() = PhotoCache.ids(ctx, album).sorted()

    @Before
    fun clean() = runBlocking {
        WidgetStore.wipe(ctx)
        WidgetsOff.set(ctx, false)
    }

    @Test
    fun fills_up_a_few_at_a_time_and_stops_at_the_limit() {
        val api = Fake((1..40).map { "p%02d".format(it) })
        sync(api, 1_000)
        assertEquals(PhotoSync.FILL, ids().size)
        assertEquals(PhotoSync.FILL to emptyList<String>(), api.asked.first())
        val meta = PhotoCache.meta(ctx, album)!!
        assertEquals("Biscuit", meta.title); assertEquals(PhotoCache.OK, meta.state); assertEquals(40, meta.count)
        sync(api, 2_000)
        assertEquals(PhotoCache.KEEP, ids().size)
        assertEquals("told what it holds, so it gets different ones", 12, api.downloads.toSet().size)

        // Full, and not long since: it asks (is the album still there?) but downloads nothing.
        sync(api, 3_000)
        assertEquals(12, api.downloads.size)
        assertEquals(1, api.asked.last().first)

        // Hours later: some new ones come in, the oldest go, the one on the widget stays.
        val oldest = PhotoCache.saved(ctx, album).minBy { it.savedAt }.id
        sync(api, 3_000 + PhotoSync.REFRESH_MS, showing = setOf(oldest))
        assertEquals(12 + PhotoSync.FRESH, api.downloads.size)
        assertEquals(PhotoCache.KEEP, ids().size)
        assertTrue(oldest in ids())
    }

    @Test
    fun a_small_album_is_all_there_and_isnt_downloaded_again() {
        val api = Fake(listOf("a", "b", "c"))
        sync(api, 1_000)
        assertEquals(listOf("a", "b", "c"), ids())
        sync(api, 2_000)
        sync(api, 2_000 + PhotoSync.REFRESH_MS)
        assertEquals(3, api.downloads.size)
        // A new photo is added to it: it arrives.
        api.inAlbum = listOf("a", "b", "c", "d")
        sync(api, 3_000 + PhotoSync.REFRESH_MS)
        assertEquals(listOf("a", "b", "c", "d"), ids())
    }

    @Test
    fun photos_taken_out_of_the_album_leave_the_phone() {
        val api = Fake(listOf("a", "b", "c"))
        sync(api, 1_000)
        api.inAlbum = listOf("a", "c")
        sync(api, 2_000)
        assertEquals(listOf("a", "c"), ids())
    }

    @Test
    fun emptied_then_deleted() {
        val api = Fake(listOf("a", "b"))
        sync(api, 1_000)
        api.inAlbum = emptyList()
        sync(api, 2_000)
        assertEquals(emptyList<String>(), ids())
        assertEquals(PhotoCache.EMPTY, PhotoCache.meta(ctx, album)!!.state)
        // Photos come back: so does the widget.
        api.inAlbum = listOf("c")
        sync(api, 3_000)
        assertEquals(listOf("c"), ids())
        assertEquals(PhotoCache.OK, PhotoCache.meta(ctx, album)!!.state)
        // Deleted (or no longer shared with you): nothing of it stays, and its name is kept for the message.
        api.gone = true
        sync(api, 4_000)
        assertEquals(emptyList<String>(), ids())
        val meta = PhotoCache.meta(ctx, album)!!
        assertEquals(PhotoCache.GONE, meta.state); assertEquals("Biscuit", meta.title)
    }

    @Test
    fun no_signal_keeps_what_it_has() {
        val api = Fake(listOf("a", "b", "c"))
        sync(api, 1_000)
        api.failAlbum = IOException("no signal")
        assertTrue(runCatching { sync(api, 2_000) }.exceptionOrNull() is IOException)
        assertEquals(listOf("a", "b", "c"), ids())
        assertEquals(PhotoCache.OK, PhotoCache.meta(ctx, album)!!.state)
    }

    @Test
    fun one_picture_that_cant_be_had_doesnt_stop_the_rest() {
        val api = Fake(listOf("a", "b", "c"))
        api.failDownload = { if (it.endsWith("/b")) Refused(404, "gone") else null }
        sync(api, 1_000)
        assertEquals(listOf("a", "c"), ids())
        // A picture that isn't one (save says no) is skipped too.
        runBlocking { WidgetStore.wipe(ctx) }
        PhotoSync.run(ctx, Fake(listOf("a")), listOf(album), 1_000, emptySet()) { _, _ -> false }
        assertEquals(emptyList<String>(), ids())
    }

    @Test
    fun albums_no_widget_shows_any_more_are_dropped() {
        val other = "99999999-2222-3333-4444-555555555555"
        val api = Fake(listOf("a", "b"))
        sync(api, 1_000, albums = listOf(album, other))
        assertEquals(2, PhotoCache.ids(ctx, other).size)
        sync(api, 2_000, albums = listOf(album))
        assertEquals(emptyList<String>(), PhotoCache.ids(ctx, other))
        assertNull(PhotoCache.meta(ctx, other))
        assertEquals(2, ids().size)
    }

    @Test
    fun runs_as_part_of_the_widgets_sync_and_is_wiped_with_it() = runBlocking {
        val api = Fake(listOf("a", "b"))
        // Only Photo widgets on the home screen: the photos still come.
        // (The real picture-shrinking can't read these stand-in bytes, so nothing is saved; the album is known.)
        assertEquals(SyncLogic.Outcome.OK, SyncLogic.run(ctx, api, emptyList(), 1_000, albums = listOf(album)))
        assertEquals("Biscuit", PhotoCache.meta(ctx, album)!!.title)
        sync(api, 2_000)
        assertEquals(2, ids().size)

        api.failAlbum = IOException("no signal")
        assertEquals(SyncLogic.Outcome.RETRY, SyncLogic.run(ctx, api, emptyList(), 3_000, albums = listOf(album)))
        assertEquals(2, ids().size)

        // Widgets turned off for this phone: everything they held goes.
        api.failAlbum = Refused(403, "off")
        assertEquals(SyncLogic.Outcome.OFF, SyncLogic.run(ctx, api, emptyList(), 4_000, albums = listOf(album)))
        assertEquals(emptyList<String>(), ids())
        assertNull(PhotoCache.meta(ctx, album))
        assertTrue(WidgetsOff.get(ctx))

        // The phone was removed: the same.
        WidgetsOff.set(ctx, false)
        api.failAlbum = null
        sync(api, 5_000)
        assertEquals(2, ids().size)
        api.failAlbum = Unlinked()
        assertEquals(SyncLogic.Outcome.REMOVED, SyncLogic.run(ctx, api, emptyList(), 6_000, albums = listOf(album)))
        assertEquals(emptyList<String>(), ids())
    }

    @Test
    fun album_page_path_is_safe() {
        assertEquals("/photos/albums/$album", albumPath(album))
        assertEquals("/photos/albums", albumPath(null))
        assertEquals("/photos/albums", albumPath("../../admin"))
        assertEquals("/photos/albums", albumPath("a?b=c"))
    }

    // ------------------------------------------------------------ what the widget shows

    private val size = DpSize(180.dp, 180.dp)

    @Test
    fun says_to_pick_an_album() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(size)
        provideComposable { PhotoContent(PhotoView.Pick, 7) }
        onNode(hasText("Pick an album")).assertExists()
    }

    @Test
    fun says_when_the_album_is_gone() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(size)
        provideComposable { PhotoContent(PhotoView.Gone("Biscuit"), 7) }
        onNode(hasText("This album isn't available")).assertExists()
    }

    @Test
    fun says_when_the_album_is_empty() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(size)
        provideComposable { PhotoContent(PhotoView.Empty("Biscuit", album), 7) }
        onNode(hasText("No photos in Biscuit yet")).assertExists()
    }

    @Test
    fun says_when_photos_are_on_their_way() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(size)
        provideComposable { PhotoContent(PhotoView.Waiting(""), 7) }
        onNode(hasText("Getting your photos…")).assertExists()
    }

    @Test
    fun what_a_widget_shows_comes_from_its_settings_and_the_saved_photos() {
        assertTrue(PhotoWidget.view(ctx, emptyPreferences(), 300, 300) is PhotoView.Pick)
        val prefs = preferencesOf(PhotoWidget.ALBUM_ID to album, PhotoWidget.ALBUM_TITLE to "Biscuit")
        // Chosen, nothing saved yet.
        val waiting = PhotoWidget.view(ctx, prefs, 300, 300)
        assertTrue(waiting is PhotoView.Waiting && waiting.title == "Biscuit")
        PhotoCache.setMeta(ctx, album, PhotoCache.Meta("Biscuit", PhotoCache.EMPTY, 0, 1))
        assertTrue(PhotoWidget.view(ctx, prefs, 300, 300) is PhotoView.Empty)
        PhotoCache.setMeta(ctx, album, PhotoCache.Meta("Biscuit", PhotoCache.GONE, 0, 1))
        assertTrue(PhotoWidget.view(ctx, prefs, 300, 300) is PhotoView.Gone)
    }

    @Test
    fun a_photo_is_cut_to_the_widgets_size_within_the_cap() {
        val src = Bitmap.createBitmap(400, 300, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.RED) }
        for (shape in PhotoShape.entries) {
            val small = PhotoRender.cut(src, shape, 220, 180)
            assertEquals(220 to 180, small.width to small.height)
            val big = PhotoRender.cut(src, shape, 1400, 1400)
            assertTrue(big.width * big.height <= PhotoRender.MAX_PIXELS)
            assertEquals(big.width, big.height)
        }
    }
}
