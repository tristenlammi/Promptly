package org.promptly.sync.widgets

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Widget lists show the rows that fit, whole, then "N more", and never scroll. */
class FitTest {
    @Test fun `everything fits so no room is kept for more`() {
        assertEquals(3, Fit.count(listOf(30f, 30f, 30f), 90f, 20f))
    }

    @Test fun `when they don't all fit room is kept for the more line`() {
        // 100 dp: four 25 dp rows would fill it, but a fifth exists, so "more" takes 20.
        assertEquals(3, Fit.count(listOf(25f, 25f, 25f, 25f, 25f), 100f, 20f))
    }

    @Test fun `a row that would be cut off is left out, never squeezed`() {
        assertEquals(1, Fit.count(listOf(40f, 41f, 10f), 80f, 0f))
    }

    @Test fun `no room shows no rows`() {
        assertEquals(0, Fit.count(listOf(40f, 40f), 30f, 20f))
    }

    @Test fun `long words take more lines in a narrow widget, up to the cap`() {
        val text = "Buy milk, eggs, bread and the good coffee from the market"
        assertEquals(1, Fit.lines(text, 13f, 1000f, 2))
        assertEquals(2, Fit.lines(text, 13f, 120f, 2))
        assertEquals(1, Fit.lines(text, 13f, 120f, 1))
    }

    @Test fun `bigger phone text makes taller lines`() {
        assertTrue(Fit.line(13f, 1.3f) > Fit.line(13f, 1f))
    }

    @Test fun `a taller widget shows more tasks and a short one says how many more`() {
        val rows = List(10) { Fit.CHECK + 2f }
        val short = Fit.count(rows, 150f, Fit.more())
        val tall = Fit.count(rows, 400f, Fit.more())
        assertTrue(tall > short)
        assertTrue(short < rows.size)
        assertTrue(short * (Fit.CHECK + 2f) + Fit.more() <= 150f)
    }

    @Test fun `no widget uses a scrolling list`() {
        val dir = File("src/main/java/org/promptly/sync/widgets")
        assertTrue(dir.isDirectory)
        for (f in dir.listFiles { x -> x.name.endsWith(".kt") }!!) {
            val text = f.readText()
            assertFalse("${f.name} scrolls: a scrolling widget takes the home screen's swipe up", text.contains("LazyColumn") || text.contains("LazyVerticalGrid"))
        }
    }
}
