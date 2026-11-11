package org.promptly.sync.widgets

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * The Photo widget's picture, drawn for real (Robolectric's own graphics):
 * the crop goes to the subject, a whole photo is all there, and the photos
 * chosen from suit the widget. Each picture is also written to
 * build/photo-widget-render/ to look at.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PhotoRenderTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val album = "11111111-2222-3333-4444-555555555555"
    private val out = File("build/photo-widget-render").apply { mkdirs() }

    @Before
    fun clean() = runBlocking { WidgetStore.wipe(ctx) }

    /**
     * A stand-in for the photo that went wrong: wide, a blue-green view, the
     * subject (a red figure with a yellow head) hard against the right edge,
     * and a white frame round the photo's edge.
     */
    private fun hug(w: Int = 1600, h: Int = 1000): Bitmap {
        val b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(b)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        for (x in 0 until w step 40) {
            p.color = Color.rgb(20, 60 + 120 * x / w, 200 - 100 * x / w)
            c.drawRect(x.toFloat(), 0f, x + 40f, h.toFloat(), p)
        }
        p.color = Color.WHITE
        val edge = h / 25f
        c.drawRect(0f, 0f, w.toFloat(), edge, p)
        c.drawRect(0f, h - edge, w.toFloat(), h.toFloat(), p)
        c.drawRect(0f, 0f, edge, h.toFloat(), p)
        c.drawRect(w - edge, 0f, w.toFloat(), h.toFloat(), p)
        p.color = Color.RED
        c.drawRect(w * 0.68f, h * 0.3f, w * 0.94f, h * 0.9f, p)
        p.color = Color.YELLOW
        c.drawCircle(w * 0.81f, h * 0.22f, h * 0.1f, p)
        return b
    }

    /** Where the subject of [hug] is, as the server would say. */
    private val subject = PhotoShapes.Focus.of(0.66, 0.1, 0.30, 0.82)!!

    private fun save(b: Bitmap, name: String) = File(out, "$name.png").outputStream().use { b.compress(Bitmap.CompressFormat.PNG, 100, it) }

    private fun red(c: Int) = Color.alpha(c) > 200 && Color.red(c) > 200 && Color.green(c) < 80 && Color.blue(c) < 80
    private fun yellow(c: Int) = Color.alpha(c) > 200 && Color.red(c) > 200 && Color.green(c) > 200 && Color.blue(c) < 80
    private fun white(c: Int) = Color.alpha(c) > 200 && Color.red(c) > 215 && Color.green(c) > 215 && Color.blue(c) > 215

    private fun count(b: Bitmap, what: (Int) -> Boolean): Int {
        var n = 0
        for (y in 0 until b.height) for (x in 0 until b.width) if (what(b.getPixel(x, y))) n++
        return n
    }

    @Test
    fun the_crop_goes_to_the_subject_and_not_the_middle() {
        val src = hug()
        for (shape in PhotoShape.entries) {
            val before = PhotoRender.cut(src, shape, 400, 440)
            val after = PhotoRender.cut(src, shape, 400, 440, subject)
            save(before, "fill-${shape.key}-middle")
            save(after, "fill-${shape.key}-subject")
            assertTrue("$shape: more of the subject shows", count(after, ::red) > 2 * count(before, ::red))
            assertTrue("$shape: more of the head shows", count(after, ::yellow) > 2 * count(before, ::yellow) && count(after, ::yellow) > 200)
            assertTrue("$shape: the subject is a good part of what's there", count(after, ::red) > after.width * after.height / 10)
        }
        // With no focus, nothing has changed.
        val a = PhotoRender.cut(src, PhotoShape.ARCH, 400, 440)
        val b = PhotoRender.cut(src, PhotoShape.ARCH, 400, 440, null, false)
        assertTrue(a.sameAs(b))
    }

    @Test
    fun a_whole_photo_is_all_there_with_itself_soft_behind() {
        for ((name, src) in listOf("wide" to hug(), "tall" to hug(900, 1500))) for (shape in PhotoShape.entries) {
            val cut = PhotoRender.cut(src, shape, 400, 440, subject, whole = true)
            save(cut, "whole-${shape.key}-$name")
            assertEquals(400 to 440, cut.width to cut.height)
            val at = PhotoShapes.inside(shape, 400f, 440f, src.width, src.height)
            // The photo's own frame shows on all four sides: none of it is cut off.
            // (Looked for at the middle of each side: Rounded takes the tips of the corners.)
            val inset = at.height / 50f
            val midX = ((at.left + at.right) / 2f).toInt()
            val midY = ((at.top + at.bottom) / 2f).toInt()
            val what = "$name in $shape"
            assertTrue("$what: top", white(cut.getPixel(midX, (at.top + inset).toInt())))
            assertTrue("$what: bottom", white(cut.getPixel(midX, (at.bottom - inset).toInt())))
            assertTrue("$what: left", white(cut.getPixel((at.left + inset).toInt(), midY)))
            assertTrue("$what: right", white(cut.getPixel((at.right - inset).toInt(), midY)))
            // The subject, head and all, is in it.
            assertTrue("$what: head", count(cut, ::yellow) > 20)
            // Outside the shape is still see-through; inside it nothing is.
            assertEquals(what, 0, Color.alpha(cut.getPixel(0, 0)))
            val pts = PhotoShapes.outline(shape, 400f, 440f)
            val box = PhotoShapes.box(shape, 400f, 440f)
            val cx = (box.left + box.right) / 2f
            val cy = (box.top + box.bottom) / 2f
            for (i in 0 until pts.size / 2) {
                // A little in from each point of the outline, towards the middle.
                val x = pts[i * 2] + (cx - pts[i * 2]) * 0.12f
                val y = pts[i * 2 + 1] + (cy - pts[i * 2 + 1]) * 0.12f
                if (PhotoShapes.holds(pts, x, y)) assertEquals("$what: a hole at ($x, $y)", 255, Color.alpha(cut.getPixel(x.toInt(), y.toInt())))
            }
        }
    }

    @Test
    fun the_copy_behind_is_dimmer_than_the_photo() {
        // A white photo, wide, in a square: white in the middle, grey above and below.
        val src = Bitmap.createBitmap(800, 300, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }
        val cut = PhotoRender.cut(src, PhotoShape.ROUNDED, 300, 300, whole = true)
        save(cut, "whole-white")
        assertTrue(white(cut.getPixel(150, 150)))
        val behind = cut.getPixel(150, 30)
        assertEquals(255, Color.alpha(behind))
        assertTrue(Color.red(behind) in 100..200)
    }

    private fun keep(id: String, w: Int, h: Int, focus: JSONObject? = null) {
        val f = PhotoCache.file(ctx, album, id)
        f.parentFile?.mkdirs()
        val b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.GRAY) }
        f.outputStream().use { b.compress(Bitmap.CompressFormat.JPEG, 80, it) }
        PhotoCache.setFocus(ctx, album, id, focus)
    }

    @Test
    fun photos_that_suit_the_widgets_shape_are_the_ones_chosen_from() {
        keep("tall1", 600, 900)
        keep("tall2", 700, 900)
        keep("square", 800, 800)
        keep("view1", 960, 320)
        keep("view2", 960, 300)
        keep("person", 960, 320, JSONObject().put("x", 0.6).put("y", 0.1).put("w", 0.15).put("h", 0.8))
        assertEquals(960 to 320, PhotoCache.size(ctx, album, "view1"))
        val ids = PhotoCache.ids(ctx, album).sorted()
        assertEquals(6, ids.size)
        // A tall widget: not the wide views — but the wide one with a person, who fits.
        assertEquals(listOf("person", "square", "tall1", "tall2"), PhotoWidget.suited(ctx, album, ids, 300 to 400))
        // A wide widget: the views, not the tall ones (nor the square: over half of it would go).
        assertEquals(listOf("person", "view1", "view2"), PhotoWidget.suited(ctx, album, ids, 400 to 160))
        // Size unknown, or whole photos: any of them.
        assertEquals(ids, PhotoWidget.suited(ctx, album, ids, null))
    }
}
