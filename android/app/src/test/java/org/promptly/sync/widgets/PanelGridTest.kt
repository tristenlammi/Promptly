package org.promptly.sync.widgets

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The app panel's grid: the rows always fill the widget, and Fit shows every app. */
class PanelGridTest {
    private val fit = PanelLayout()

    @Test fun `fit shows all thirteen apps with no room left below`() {
        val g = PanelGrid.of(13, 360f, 330f, fit)
        assertTrue(g.cols * g.rows >= 13)
        assertEquals(330f, g.rowHeight * g.rows, 0.01f)
        assertTrue("icons ${g.tile}", g.tile >= 44f)
    }

    @Test fun `fit makes icons bigger when there are fewer apps`() {
        val few = PanelGrid.of(4, 360f, 330f, fit)
        val many = PanelGrid.of(13, 360f, 330f, fit)
        assertTrue(few.tile > many.tile)
    }

    @Test fun `fit never makes icons bigger than the largest size`() {
        assertTrue(PanelGrid.of(1, 400f, 400f, fit).tile <= PanelGrid.MAX_TILE)
    }

    @Test fun `too many apps for a small widget scroll at the smallest size`() {
        val g = PanelGrid.of(40, 200f, 100f, fit)
        assertEquals(PanelGrid.MIN_TILE, g.tile, 0.01f)
        assertEquals(100f, g.rowHeight * g.rows, 0.01f)
    }

    @Test fun `chosen columns rows and size are kept when they fit`() {
        val g = PanelGrid.of(13, 360f, 330f, PanelLayout(fit = false, cols = 4, rows = 3, icon = "small"))
        assertEquals(4, g.cols)
        assertEquals(3, g.rows)
        assertEquals(110f, g.rowHeight, 0.01f)
        assertEquals(36f, g.tile, 0.01f)
    }

    @Test fun `a chosen size too big for its cell is made smaller`() {
        val g = PanelGrid.of(13, 300f, 120f, PanelLayout(fit = false, cols = 6, rows = 2, icon = "large"))
        assertTrue(g.tile < 56f)
        assertTrue(g.tile <= 300f / 6 - PanelGrid.GAP + 0.01f)
    }

    @Test fun `no names gives the icons more room`() {
        val named = PanelGrid.of(13, 360f, 200f, fit)
        val bare = PanelGrid.of(13, 360f, 200f, fit.copy(labels = false))
        assertTrue(bare.tile >= named.tile)
    }
}
