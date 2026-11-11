package org.promptly.sync.widgets

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.random.Random

/** The Photo widget's plain parts: the shapes at any size, the crop, the size
 *  cap, which photo next (never the same twice running), and which saved
 *  photos to let go. */
class PhotoLogicTest {
    private val sizes = listOf(120f to 120f, 300f to 300f, 400f to 150f, 150f to 400f, 61f to 733f, 48f to 48f)

    private fun xs(p: FloatArray) = p.filterIndexed { i, _ -> i % 2 == 0 }
    private fun ys(p: FloatArray) = p.filterIndexed { i, _ -> i % 2 == 1 }

    @Test
    fun every_shape_stays_inside_the_widget_at_any_size() {
        for (shape in PhotoShape.entries) for ((w, h) in sizes) {
            val p = PhotoShapes.outline(shape, w, h)
            assertTrue("$shape has an outline", p.size >= 40 && p.size % 2 == 0)
            assertTrue("$shape $w x $h x", xs(p).all { it in 0f..w })
            assertTrue("$shape $w x $h y", ys(p).all { it in 0f..h })
            assertTrue("$shape $w x $h is not a sliver", PhotoShapes.area(p) > 0.45f * minOf(w, h) * minOf(w, h))
        }
    }

    @Test
    fun filling_shapes_use_the_whole_widget_and_the_others_a_square_in_the_middle() {
        for ((w, h) in sizes) {
            for (shape in PhotoShape.entries) {
                val p = PhotoShapes.outline(shape, w, h)
                val side = minOf(w, h)
                val (bw, bh) = if (shape.fills) w to h else side to side
                // Touches each side of its box (the heart is a touch shorter than it is wide).
                val slack = if (shape == PhotoShape.HEART) side * 0.06f else 0.6f
                assertEquals("$shape $w x $h left", (w - bw) / 2, xs(p).min(), slack)
                assertEquals("$shape $w x $h right", (w + bw) / 2, xs(p).max(), slack)
                assertEquals("$shape $w x $h top", (h - bh) / 2, ys(p).min(), slack)
                assertEquals("$shape $w x $h bottom", (h + bh) / 2, ys(p).max(), slack)
            }
        }
        assertTrue(PhotoShape.ROUNDED.fills && PhotoShape.ARCH.fills)
        assertFalse(PhotoShape.CIRCLE.fills || PhotoShape.HEART.fills || PhotoShape.SQUIRCLE.fills || PhotoShape.FLOWER.fills)
    }

    @Test
    fun shapes_are_the_shapes_they_say() {
        val s = 200f
        val square = s * s
        val circle = PhotoShapes.area(PhotoShapes.outline(PhotoShape.CIRCLE, s, s))
        assertEquals(PI.toFloat() / 4f, circle / square, 0.005f)
        // A circle in a wide widget is still a circle, not an oval.
        assertEquals(circle, PhotoShapes.area(PhotoShapes.outline(PhotoShape.CIRCLE, 500f, s)), 1f)
        val squircle = PhotoShapes.area(PhotoShapes.outline(PhotoShape.SQUIRCLE, s, s))
        val rounded = PhotoShapes.area(PhotoShapes.outline(PhotoShape.ROUNDED, s, s))
        val flower = PhotoShapes.area(PhotoShapes.outline(PhotoShape.FLOWER, s, s))
        val heart = PhotoShapes.area(PhotoShapes.outline(PhotoShape.HEART, s, s))
        val arch = PhotoShapes.area(PhotoShapes.outline(PhotoShape.ARCH, s, s))
        assertTrue("soft square sits between a circle and a square", squircle > circle && squircle < square)
        assertTrue("rounded keeps nearly everything", rounded > 0.95f * square && rounded < square)
        assertTrue("flower is a scalloped circle", flower < circle && flower > 0.8f * circle)
        assertTrue("heart", heart > 0.45f * square && heart < circle)
        assertTrue("arch loses only its top corners", arch > circle && arch < rounded)
        // A rounded widget twice as wide has twice the middle, the same corners.
        val wide = PhotoShapes.area(PhotoShapes.outline(PhotoShape.ROUNDED, 2 * s, s))
        assertEquals(rounded + square, wide, 2f)
    }

    @Test
    fun shapes_are_even_left_to_right() {
        for (shape in PhotoShape.entries) {
            val w = 240f
            val h = 180f
            val p = PhotoShapes.outline(shape, w, h)
            // For every point there is one mirrored across the middle.
            for (i in p.indices step 2) {
                val mx = w - p[i]
                val y = p[i + 1]
                assertTrue("$shape mirrored at ${p[i]},$y", (p.indices step 2).any { abs(p[it] - mx) < 0.75f && abs(p[it + 1] - y) < 0.75f })
            }
        }
    }

    @Test
    fun the_heart_has_a_dip_at_the_top_and_a_point_at_the_bottom() {
        val p = PhotoShapes.outline(PhotoShape.HEART, 200f, 200f)
        val top = ys(p).min()
        val bottom = ys(p).max()
        val midTop = (p.indices step 2).filter { abs(p[it] - 100f) < 1.5f }.minOf { p[it + 1] }
        assertTrue("the middle of the top is lower than the lobes", midTop > top + 10f)
        val atBottom = (p.indices step 2).filter { p[it + 1] > bottom - 1f }.map { p[it] }
        assertTrue("one point at the bottom, in the middle", atBottom.all { abs(it - 100f) < 6f })
    }

    @Test
    fun unknown_shape_is_rounded() {
        assertEquals(PhotoShape.ROUNDED, PhotoShape.of(null))
        assertEquals(PhotoShape.ROUNDED, PhotoShape.of("triangle"))
        for (s in PhotoShape.entries) assertEquals(s, PhotoShape.of(s.key))
        assertEquals(PhotoShape.entries.size, PhotoShape.entries.map { it.key }.toSet().size)
        assertTrue(PhotoShape.entries.size in 4..6)
    }

    @Test
    fun crop_fills_the_shape_with_nothing_left_over() {
        // A wide photo into a square: the sides go, evenly.
        assertArrayEquals(intArrayOf(500, 0, 1500, 1000), PhotoShapes.cover(2000, 1000, 300, 300))
        // A tall photo into a square: top and bottom go, a little more from the bottom.
        val c = PhotoShapes.cover(1000, 2000, 300, 300)
        assertEquals(0, c[0]); assertEquals(1000, c[2]); assertEquals(1000, c[3] - c[1])
        assertEquals(400, c[1])
        // Same shape: all of it.
        assertArrayEquals(intArrayOf(0, 0, 800, 600), PhotoShapes.cover(800, 600, 400, 300))
        // Always inside the photo, one side used whole.
        val r = Random(7)
        repeat(300) {
            val sw = r.nextInt(1, 4000); val sh = r.nextInt(1, 4000); val dw = r.nextInt(1, 1200); val dh = r.nextInt(1, 1200)
            val k = PhotoShapes.cover(sw, sh, dw, dh)
            assertTrue(k[0] >= 0 && k[1] >= 0 && k[2] <= sw && k[3] <= sh && k[2] > k[0] && k[3] > k[1])
            assertTrue("one side is used whole", k[2] - k[0] == sw || k[3] - k[1] == sh)
        }
        assertArrayEquals(intArrayOf(0, 0, 0, 0), PhotoShapes.cover(0, 0, 10, 10))
    }

    private fun focus(l: Double, t: Double, r: Double, b: Double) = PhotoShapes.Focus.of(l, t, r - l, b - t)!!

    @Test
    fun with_no_focus_the_crop_is_the_one_it_always_was() {
        val r = Random(11)
        repeat(300) {
            val sw = r.nextInt(1, 4000); val sh = r.nextInt(1, 4000); val dw = r.nextInt(1, 1200); val dh = r.nextInt(1, 1200)
            assertArrayEquals(PhotoShapes.cover(sw, sh, dw, dh), PhotoShapes.cover(sw, sh, dw, dh, null))
        }
        // The middle across; a little above the middle up and down.
        assertArrayEquals(intArrayOf(500, 0, 1500, 1000), PhotoShapes.cover(2000, 1000, 300, 300, null))
        assertArrayEquals(intArrayOf(0, 400, 1000, 1400), PhotoShapes.cover(1000, 2000, 300, 300, null))
    }

    @Test
    fun the_crop_goes_to_the_subject_at_any_edge() {
        // A wide photo in a square: the window is 1000 of 2000 across.
        // Subject hard on the right: the window goes right, as far as the photo does.
        assertArrayEquals(intArrayOf(1000, 0, 2000, 1000), PhotoShapes.cover(2000, 1000, 300, 300, focus(0.7, 0.1, 1.0, 0.9)))
        // Hard on the left.
        assertArrayEquals(intArrayOf(0, 0, 1000, 1000), PhotoShapes.cover(2000, 1000, 300, 300, focus(0.0, 0.1, 0.3, 0.9)))
        // Off-centre but not at the edge: it sits in the middle of the window.
        assertArrayEquals(intArrayOf(700, 0, 1700, 1000), PhotoShapes.cover(2000, 1000, 300, 300, focus(0.5, 0.2, 0.7, 0.8)))
        // A tall photo in a square: the window is 1000 of 2000 down.
        assertArrayEquals(intArrayOf(0, 0, 1000, 1000), PhotoShapes.cover(1000, 2000, 300, 300, focus(0.2, 0.0, 0.8, 0.2)))
        assertArrayEquals(intArrayOf(0, 1000, 1000, 2000), PhotoShapes.cover(1000, 2000, 300, 300, focus(0.2, 0.8, 0.8, 1.0)))
        assertArrayEquals(intArrayOf(0, 800, 1000, 1800), PhotoShapes.cover(1000, 2000, 300, 300, focus(0.2, 0.6, 0.8, 0.7)))
        // Up and down doesn't matter when only the sides are cut, nor across when only top and bottom are.
        assertArrayEquals(
            PhotoShapes.cover(2000, 1000, 300, 300, focus(0.7, 0.0, 1.0, 0.1)),
            PhotoShapes.cover(2000, 1000, 300, 300, focus(0.7, 0.9, 1.0, 1.0)),
        )
    }

    @Test
    fun a_subject_that_fits_is_all_in_and_one_that_doesnt_is_centred() {
        val r = Random(5)
        repeat(500) {
            val sw = r.nextInt(50, 4000); val sh = r.nextInt(50, 4000); val dw = r.nextInt(1, 1200); val dh = r.nextInt(1, 1200)
            val l = r.nextDouble(0.0, 0.9); val t = r.nextDouble(0.0, 0.9)
            val f = focus(l, t, r.nextDouble(l + 0.02, 1.0), r.nextDouble(t + 0.02, 1.0))
            val k = PhotoShapes.cover(sw, sh, dw, dh, f)
            val plain = PhotoShapes.cover(sw, sh, dw, dh)
            // Same size as ever, and inside the photo: only where it sits changes.
            assertEquals(plain[2] - plain[0], k[2] - k[0])
            assertEquals(plain[3] - plain[1], k[3] - k[1])
            assertTrue(k[0] >= 0 && k[1] >= 0 && k[2] <= sw && k[3] <= sh)
            for ((lo, hi, from, to, full) in listOf(
                listOf(k[0].toFloat(), k[2].toFloat(), f.left * sw, f.right * sw, sw.toFloat()),
                listOf(k[1].toFloat(), k[3].toFloat(), f.top * sh, f.bottom * sh, sh.toFloat()),
            )) {
                if (to - from <= hi - lo - 2f) {
                    assertTrue("a subject that fits is all in", from >= lo - 1f && to <= hi + 1f)
                } else if (hi - lo < full) {
                    // Bigger than the window: the window sits on its middle (or at the photo's edge).
                    val mid = (from + to) / 2f
                    assertTrue("centred on a subject too big to fit", abs((lo + hi) / 2f - mid) <= 1f || lo == 0f || hi == full)
                    assertTrue(lo >= from - 1f && hi <= to + 1f || lo == 0f || hi == full)
                }
            }
        }
        // Bigger than the crop: centred on it.
        assertArrayEquals(intArrayOf(600, 0, 1600, 1000), PhotoShapes.cover(2000, 1000, 300, 300, focus(0.2, 0.0, 0.9, 1.0)))
    }

    @Test
    fun wide_in_tall_and_tall_in_wide() {
        // A wide photo in a tall widget (2:3): 400 of 1600 across, on the person at the right.
        assertArrayEquals(intArrayOf(1080, 0, 1480, 600), PhotoShapes.cover(1600, 600, 200, 300, focus(0.75, 0.2, 0.85, 0.9)))
        // ... and against the right edge when they're at it.
        assertArrayEquals(intArrayOf(1200, 0, 1600, 600), PhotoShapes.cover(1600, 600, 200, 300, focus(0.9, 0.2, 1.0, 0.9)))
        // A tall photo in a wide widget (2:1): 300 of 1600 down, on the face near the top.
        assertArrayEquals(intArrayOf(0, 170, 600, 470), PhotoShapes.cover(600, 1600, 400, 200, focus(0.3, 0.1, 0.7, 0.3)))
        // ... and the dog at their feet.
        assertArrayEquals(intArrayOf(0, 1300, 600, 1600), PhotoShapes.cover(600, 1600, 400, 200, focus(0.3, 0.85, 0.7, 1.0)))
    }

    @Test
    fun a_focus_is_a_box_inside_the_photo_or_nothing() {
        val f = PhotoShapes.Focus.of(0.55, 0.1, 0.45, 0.85)!!
        assertEquals(0.55f, f.left, 1e-6f); assertEquals(0.1f, f.top, 1e-6f); assertEquals(1f, f.right, 1e-6f); assertEquals(0.95f, f.bottom, 1e-6f)
        // Spilling over the edge: kept to the photo.
        val g = PhotoShapes.Focus.of(-0.2, 0.9, 0.5, 0.5)!!
        assertEquals(0f, g.left, 1e-6f); assertEquals(0.3f, g.right, 1e-6f); assertEquals(1f, g.bottom, 1e-6f)
        assertNull(PhotoShapes.Focus.of(0.5, 0.5, 0.0, 0.2))
        assertNull(PhotoShapes.Focus.of(0.5, 0.5, 0.2, -0.1))
        assertNull(PhotoShapes.Focus.of(1.2, 0.5, 0.2, 0.2))
        assertNull(PhotoShapes.Focus.of(Double.NaN, 0.5, 0.2, 0.2))
        assertNull(PhotoShapes.Focus.of(0.1, 0.5, Double.POSITIVE_INFINITY, 0.2))
    }

    @Test
    fun a_photo_suits_a_box_that_keeps_most_of_it_or_all_of_its_subject() {
        assertEquals(1f, PhotoShapes.suits(800, 600, 400, 300), 1e-3f)
        assertEquals(0.5f, PhotoShapes.suits(2000, 1000, 300, 300), 1e-3f)
        // A wide view in a tall widget: most of it goes.
        assertTrue(PhotoShapes.suits(3000, 1000, 300, 400) < PhotoPick.SUITS)
        // The same with one person in it, who's all in the crop: fine.
        assertTrue(PhotoShapes.suits(3000, 1000, 300, 400, focus(0.6, 0.1, 0.75, 0.9)) >= PhotoPick.SUITS)
        // A row of people right across it: half of them would go.
        assertTrue(PhotoShapes.suits(3000, 1000, 300, 400, focus(0.05, 0.2, 0.95, 0.9)) < PhotoPick.SUITS)
        // Knowing the subject never makes a photo suit less.
        val r = Random(3)
        repeat(200) {
            val sw = r.nextInt(50, 4000); val sh = r.nextInt(50, 4000); val dw = r.nextInt(1, 1200); val dh = r.nextInt(1, 1200)
            val l = r.nextDouble(0.0, 0.9); val t = r.nextDouble(0.0, 0.9)
            val s = PhotoShapes.suits(sw, sh, dw, dh, focus(l, t, r.nextDouble(l + 0.02, 1.0), r.nextDouble(t + 0.02, 1.0)))
            assertTrue(s in 0f..1f && s >= PhotoShapes.suits(sw, sh, dw, dh) - 0.02f)
        }
        assertEquals(1f, PhotoShapes.suits(0, 0, 10, 10), 0f)
    }

    @Test
    fun photos_that_suit_the_shape_are_chosen_from_while_there_are_enough() {
        val score = mapOf("a" to 1f, "b" to 0.9f, "c" to 0.2f, "d" to 0.6f, "e" to 0.3f, "f" to 0.55f)
        assertEquals(listOf("a", "b", "d", "f"), PhotoPick.suited(score.keys.toList()) { score.getValue(it) })
        // Too few that suit: the best three, in their own order, so it still changes.
        val few = mapOf("a" to 0.1f, "b" to 0.9f, "c" to 0.2f, "d" to 0.3f, "e" to 0.25f)
        assertEquals(listOf("b", "d", "e"), PhotoPick.suited(few.keys.toList()) { few.getValue(it) })
        // A handful of photos: all of them, whatever their shape.
        assertEquals(listOf("a", "b", "c"), PhotoPick.suited(listOf("a", "b", "c")) { 0f })
        assertEquals(emptyList<String>(), PhotoPick.suited(emptyList()) { 0f })
        // All the same: all of them.
        assertEquals(listOf("a", "b", "c", "d", "e"), PhotoPick.suited(listOf("a", "b", "c", "d", "e")) { 1f })
        // The turn-taking still holds over the ones that suit.
        val pool = PhotoPick.suited(score.keys.toList()) { score.getValue(it) }
        var current: String? = null
        var recent = emptyList<String>()
        val seen = mutableListOf<String>()
        repeat(pool.size) {
            val next = PhotoPick.next(pool, current, recent, Random(it))!!
            recent = PhotoPick.remember(recent, next, pool.size)
            current = next
            seen += next
        }
        assertEquals(pool.toSet(), seen.toSet())
    }

    @Test
    fun a_whole_photo_fits_inside_every_shape() {
        val sizes = listOf(300f to 300f, 400f to 220f, 220f to 400f)
        val photos = listOf(1600 to 900, 900 to 1600, 1000 to 1000, 3000 to 1000)
        for (shape in PhotoShape.entries) for ((w, h) in sizes) for ((pw, ph) in photos) {
            val b = PhotoShapes.box(shape, w, h)
            val at = PhotoShapes.inside(shape, w, h, pw, ph)
            val what = "$shape $w×$h $pw×$ph"
            // The photo's own proportions, inside the shape's box.
            assertEquals(what, pw.toFloat() / ph, at.width / at.height, 0.02f)
            assertTrue(what, at.left >= b.left - 0.5f && at.top >= b.top - 0.5f && at.right <= b.right + 0.5f && at.bottom <= b.bottom + 0.5f)
            assertEquals("$what: in the middle across", (b.left + b.right) / 2f, (at.left + at.right) / 2f, 0.5f)
            if (shape == PhotoShape.ROUNDED) {
                // As big as the box lets it be.
                assertTrue(what, abs(at.width - b.width) < 0.5f || abs(at.height - b.height) < 0.5f)
                continue
            }
            // All of it inside the outline (a hair in from its own edge), and a fair size.
            val pts = PhotoShapes.outline(shape, w, h)
            val l = at.left + 1f; val t = at.top + 1f; val r = at.right - 1f; val bt = at.bottom - 1f
            for (i in 0..20) {
                val f = i / 20f
                for ((x, y) in listOf(l + (r - l) * f to t, l + (r - l) * f to bt, l to t + (bt - t) * f, r to t + (bt - t) * f)) {
                    assertTrue("$what: ($x, $y) is outside the shape", PhotoShapes.holds(pts, x, y))
                }
            }
            assertTrue("$what: too small (${at.width}×${at.height})", at.width * at.height >= 0.12f * b.width * b.height)
        }
        // A picture sits whole in a box, in its middle.
        val c = PhotoShapes.contain(200, 100, PhotoShapes.Box(0f, 0f, 100f, 100f))
        assertEquals(0f, c.left, 1e-3f); assertEquals(25f, c.top, 1e-3f); assertEquals(100f, c.right, 1e-3f); assertEquals(75f, c.bottom, 1e-3f)
    }

    @Test
    fun the_picture_handed_to_the_home_screen_stays_small() {
        assertEquals(300 to 200, PhotoShapes.fit(300, 200, PhotoRender.MAX_PIXELS))
        for ((w, h) in listOf(1080 to 1080, 1440 to 3000, 2000 to 400, 4000 to 4000, 1 to 100_000)) {
            val (fw, fh) = PhotoShapes.fit(w, h, PhotoRender.MAX_PIXELS)
            assertTrue("$w x $h -> $fw x $fh", fw.toLong() * fh <= PhotoRender.MAX_PIXELS && fw >= 1 && fh >= 1)
            if (w > 100 && h > 100) assertEquals("keeps its proportions", w.toFloat() / h, fw.toFloat() / fh, 0.02f)
        }
        // 4 bytes a pixel: well under 2 MB, whatever the widget's size.
        assertTrue(PhotoRender.MAX_PIXELS * 4 < 2 * 1024 * 1024)
        assertEquals(1 to 1, PhotoShapes.fit(0, 0, 100))
    }

    @Test
    fun reading_a_picture_at_a_fraction_never_goes_under_the_size_wanted() {
        assertEquals(1, PhotoShapes.sample(1440, 1080, 960))
        assertEquals(4, PhotoShapes.sample(4000, 3000, 960))
        assertEquals(4, PhotoShapes.sample(4000, 3000, 600))
        assertEquals(1, PhotoShapes.sample(100, 100, 960))
        for (edge in listOf(200, 600, 960)) for (w in listOf(320, 1440, 2048, 6000)) {
            val s = PhotoShapes.sample(w, w * 3 / 4, edge)
            assertTrue(s == 1 || w / s >= edge)
        }
    }

    @Test
    fun the_next_photo_is_never_the_one_showing() {
        val ids = listOf("a", "b", "c", "d")
        val r = Random(1)
        var current: String? = null
        repeat(500) {
            val next = PhotoPick.next(ids, current, random = r)
            assertNotEquals(current, next)
            assertTrue(next in ids)
            current = next
        }
        // Two photos: they take turns.
        assertEquals("b", PhotoPick.next(listOf("a", "b"), "a", random = r))
        assertEquals("a", PhotoPick.next(listOf("a", "b"), "b", random = r))
        // One photo: that one. None: nothing.
        assertEquals("a", PhotoPick.next(listOf("a"), "a"))
        assertNull(PhotoPick.next(emptyList(), "a"))
        // The one showing was deleted: any of the others.
        assertTrue(PhotoPick.next(ids, "zz", random = r) in ids)
    }

    @Test
    fun every_photo_gets_a_turn_before_any_comes_round_again() {
        val ids = (1..8).map { "p$it" }
        val r = Random(3)
        var current: String? = null
        var recent = emptyList<String>()
        val seen = ArrayList<String>()
        repeat(ids.size) {
            val next = PhotoPick.next(ids, current, recent, r)!!
            recent = PhotoPick.remember(recent, next, ids.size)
            current = next
            seen += next
        }
        assertEquals("all eight, once each", ids.toSet(), seen.toSet())
        // And it carries on after that, still never twice running.
        repeat(50) {
            val next = PhotoPick.next(ids, current, recent, r)!!
            assertNotEquals(current, next)
            recent = PhotoPick.remember(recent, next, ids.size)
            current = next
        }
        assertTrue(recent.size < ids.size)
        assertEquals(emptyList<String>(), PhotoPick.remember(listOf("a"), "a", 1))
        assertEquals(PhotoPick.MAX_RECENT, PhotoPick.remember((1..40).map { "x$it" }, "new", 100).size)
    }

    @Test
    fun saved_photos_are_trimmed_oldest_first_and_never_the_one_showing() {
        val saved = (1..15).map { PhotoPick.Saved("p$it", it * 1000L) }
        assertEquals(emptyList<String>(), PhotoPick.trim(saved.take(12), 12))
        assertEquals(listOf("p1", "p2", "p3"), PhotoPick.trim(saved, 12))
        // The oldest is on a widget right now: it stays, the next oldest goes.
        assertEquals(listOf("p2", "p3", "p4"), PhotoPick.trim(saved, 12, showing = setOf("p1")))
        // Order on disk doesn't matter.
        assertEquals(listOf("p1", "p2", "p3"), PhotoPick.trim(saved.shuffled(Random(2)), 12))
        // Everything is showing: nothing to delete.
        assertEquals(emptyList<String>(), PhotoPick.trim(saved.take(3), 1, showing = setOf("p1", "p2", "p3")))
        assertEquals(15, PhotoPick.trim(saved, 0).size)
    }

    @Test
    fun a_new_photo_is_due_every_half_hour() {
        val every = PhotoWidget.EVERY_MS
        assertTrue(PhotoPick.due(0, 1_000_000, every))
        assertFalse(PhotoPick.due(1_000_000, 1_000_000 + every - 1, every))
        assertTrue(PhotoPick.due(1_000_000, 1_000_000 + every, every))
        // The clock was put back: don't wait for it to catch up.
        assertTrue(PhotoPick.due(5_000_000, 1_000_000, every))
        assertEquals(30 * 60 * 1000L, every)
    }
}
