package org.promptly.sync.widgets

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.min

/** How the app panel is laid out: sized to fill the widget, or your own columns,
 *  rows and icon size. */
data class PanelLayout(
    val fit: Boolean = true,
    val cols: Int = 5,
    val rows: Int = 3,
    val icon: String = "medium",
    val labels: Boolean = true,
) {
    companion object {
        const val MIN_COLS = 2
        const val MAX_COLS = 7
        const val MIN_ROWS = 1
        const val MAX_ROWS = 6
    }
}

/** The panel's grid for a widget with [w] x [h] dp under its title: [cols] apps a
 *  row, each row [rowHeight] dp tall, icons [tile] dp. The rows always share the
 *  whole height, so nothing is left empty below the last one. */
data class PanelGrid(val cols: Int, val rows: Int, val rowHeight: Float, val tile: Float, val labels: Boolean) {
    companion object {
        /** Room a label takes under an icon (text and gap). */
        const val LABEL = 17f
        /** The smallest and largest icon. */
        const val MIN_TILE = 28f
        const val MAX_TILE = 76f
        /** Room around each icon, so neighbours never touch. */
        const val GAP = 16f
        val SIZES = mapOf("small" to 36f, "medium" to 44f, "large" to 56f)

        fun of(count: Int, w: Float, h: Float, layout: PanelLayout): PanelGrid {
            val n = count.coerceAtLeast(1)
            val width = w.coerceAtLeast(60f)
            val height = h.coerceAtLeast(40f)
            val label = if (layout.labels) LABEL else 0f
            if (!layout.fit) {
                // Your columns and rows: the rows share the height; icons are the
                // size you chose, made smaller only if a cell can't hold them.
                val rowHeight = height / layout.rows
                val want = SIZES[layout.icon] ?: SIZES.getValue("medium")
                val tile = min(want, min(width / layout.cols - GAP, rowHeight - label - GAP)).coerceIn(MIN_TILE, MAX_TILE)
                return PanelGrid(layout.cols, layout.rows, rowHeight, tile, layout.labels)
            }
            // Fit: try each column count and keep the one with the biggest icons
            // that shows every app at once. Ties go to fewer rows.
            var best: PanelGrid? = null
            for (cols in PanelLayout.MIN_COLS..PanelLayout.MAX_COLS) {
                val rows = ceil(n / cols.toFloat()).toInt().coerceAtLeast(1)
                val rowHeight = height / rows
                val tile = min(width / cols - GAP, rowHeight - label - GAP).coerceAtMost(MAX_TILE)
                if (tile < MIN_TILE) continue
                val g = PanelGrid(cols, rows, rowHeight, tile, layout.labels)
                val b = best
                if (b == null || g.tile > b.tile + 0.5f || (abs(g.tile - b.tile) <= 0.5f && g.rows < b.rows)) best = g
            }
            // Too many apps to show at once: the smallest icons, whole rows, the rest scroll.
            return best ?: run {
                val cols = (width / (MIN_TILE + GAP)).toInt().coerceIn(PanelLayout.MIN_COLS, PanelLayout.MAX_COLS)
                val rows = (height / (MIN_TILE + GAP + label)).toInt().coerceAtLeast(1)
                PanelGrid(cols, rows, height / rows, MIN_TILE, layout.labels)
            }
        }
    }
}
