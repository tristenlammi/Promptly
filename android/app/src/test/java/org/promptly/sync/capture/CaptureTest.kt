package org.promptly.sync.capture

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** Quick capture's rules: the recorder's clock, pauses, levels and waveform;
 *  what a share from another app becomes; what a quick note saves. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CaptureTest {
    private val f = File("rec.m4a")

    // ------------------------------------------------------------ recorder

    @Test
    fun pauses_are_not_counted() {
        var s = RecorderLogic.start(f, now = 1_000, wall = 0)
        assertEquals(Phase.RECORDING, s.phase)
        assertEquals(4_000, s.elapsed(5_000))
        s = RecorderLogic.pause(s, 5_000)
        assertEquals(Phase.PAUSED, s.phase)
        assertEquals(4_000, s.elapsed(60_000)) // paused: the clock stands still
        s = RecorderLogic.resume(s, 60_000)
        assertEquals(6_500, s.elapsed(62_500))
        // Pausing twice, resuming twice: no change.
        assertEquals(s, RecorderLogic.resume(s, 63_000))
        s = RecorderLogic.stop(s, 63_000)
        assertEquals(Phase.SAVING, s.phase)
        assertEquals(7_000, s.recordedBefore)
        assertEquals(7_000, s.elapsed(99_000))
    }

    @Test
    fun levels_and_samples() {
        assertEquals(0f, RecorderLogic.level(0))
        assertEquals(1f, RecorderLogic.level(32_767))
        assertTrue(RecorderLogic.level(3_000) in 0.3f..0.9f)
        var s = RecorderLogic.start(f, 0, 0)
        s = RecorderLogic.sample(s, 32_767)
        assertEquals(listOf(1f), s.samples)
        // Paused: nothing sampled.
        val paused = RecorderLogic.pause(s, 10)
        assertEquals(paused, RecorderLogic.sample(paused, 999))
        // A long recording keeps a bounded number of samples.
        repeat(10_000) { s = RecorderLogic.sample(s, it % 30_000) }
        assertTrue(s.samples.size <= 4_000)
    }

    @Test
    fun the_waveform_is_at_most_200_levels() {
        assertEquals(emptyList<Float>(), RecorderLogic.peaks(emptyList()))
        assertEquals(listOf(0.1f, 0.5f), RecorderLogic.peaks(listOf(0.1f, 0.5f)))
        val many = (0 until 1_234).map { if (it == 617) 1f else 0.2f }
        val p = RecorderLogic.peaks(many)
        assertEquals(200, p.size)
        assertEquals(1f, p.max()) // the loudest moment survives
    }

    @Test
    fun clock_and_limit() {
        assertEquals("0:07", RecorderLogic.clock(7_400))
        assertEquals("12:45", RecorderLogic.clock(765_000))
        assertEquals("1:02:03", RecorderLogic.clock(3_723_000))
        val s = RecorderLogic.start(f, 0, 0)
        assertTrue(!RecorderLogic.full(s, RecorderLogic.MAX_MS - 1))
        assertTrue(RecorderLogic.full(s, RecorderLogic.MAX_MS))
    }

    // ------------------------------------------------------------ share

    private val image = Uri.parse("content://media/external/images/1")
    private val image2 = Uri.parse("content://media/external/images/2")
    private val pdf = Uri.parse("content://downloads/3")
    private val types = mapOf(image to "image/jpeg", image2 to "image/png", pdf to "application/pdf")
    private fun typeOf(u: Uri) = types[u]

    @Test
    fun chrome_shares_a_link_with_the_page_title() {
        val i = Intent(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, "https://example.com/pavlova")
            .putExtra(Intent.EXTRA_SUBJECT, "Pavlova, the easy way")
        val s = Shared.from(i, ::typeOf)!!
        assertEquals("https://example.com/pavlova", s.text)
        assertEquals("Pavlova, the easy way", s.title)
        assertTrue(s.files.isEmpty())
        // Chrome puts a preview picture of the page in the ClipData: not part of the note.
        val withPreview = Intent(i).apply { clipData = ClipData.newRawUri("", image) }
        assertTrue(Shared.from(withPreview, ::typeOf)!!.files.isEmpty())
        // A subject that's only the text again isn't a title.
        val same = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "hello").putExtra(Intent.EXTRA_SUBJECT, "hello")
        assertEquals("", Shared.from(same, ::typeOf)!!.title)
    }

    @Test
    fun photos_shares_pictures() {
        val one = Intent(Intent.ACTION_SEND).setType("image/jpeg").putExtra(Intent.EXTRA_STREAM, image)
        val s = Shared.from(one, ::typeOf)!!
        assertEquals(listOf(image to "image/jpeg"), s.files)
        assertEquals(1, s.pictures)

        val many = Intent(Intent.ACTION_SEND_MULTIPLE).setType("*/*")
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(image, image2, pdf, Uri.parse("file:///sdcard/x.jpg")))
        val m = Shared.from(many, ::typeOf)!!
        assertEquals(listOf(image, image2), m.files.map { it.first })
        assertEquals(2, m.skipped) // the PDF, and a raw file path
    }

    @Test
    fun clip_data_and_the_limit() {
        val uris = (0 until 14).map { Uri.parse("content://media/a/$it") }
        val i = Intent(Intent.ACTION_SEND_MULTIPLE).setType("audio/mp4")
        i.clipData = ClipData.newRawUri("", uris[0]).apply { uris.drop(1).forEach { addItem(ClipData.Item(it)) } }
        val s = Shared.from(i) { null }!!
        assertEquals(Shared.MAX_FILES, s.files.size)
        assertEquals(4, s.skipped)
        assertTrue(s.files.all { it.second == "audio/mp4" })
        assertEquals(10, s.recordings)
    }

    @Test
    fun not_a_share() {
        assertNull(Shared.from(Intent(Intent.ACTION_VIEW), ::typeOf))
        assertTrue(Shared.from(Intent(Intent.ACTION_SEND).setType("text/plain"), ::typeOf)!!.isEmpty)
    }

    // ------------------------------------------------------------ quick note

    @Test
    fun what_a_quick_note_saves() {
        assertNull(QuickNoteDraft.of(false, "  ", "\n ", emptyList()))
        assertNull(QuickNoteDraft.of(true, "", "", listOf(" ", "")))
        assertEquals(QuickNoteDraft("text", "Gate", "4471", emptyList()), QuickNoteDraft.of(false, " Gate ", "4471\n\n", emptyList()))
        assertEquals(QuickNoteDraft("list", "", "", listOf("Eggs", "Oat milk")), QuickNoteDraft.of(true, "", "ignored", listOf(" Eggs", "", "Oat   milk")))
    }
}
