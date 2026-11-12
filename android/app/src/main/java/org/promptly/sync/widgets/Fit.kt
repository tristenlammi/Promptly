package org.promptly.sync.widgets

import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceModifier
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.layout.Row
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.Text
import kotlin.math.ceil
import kotlin.math.max

/**
 * Widget lists don't scroll: a list that scrolls takes the home screen's swipe up
 * (to the app drawer) for itself. Each list shows the rows that fit in the
 * widget's size, whole (never a half-cut row), then "4 more", which opens the app.
 *
 * Heights are estimates in dp, rounded up, so a row that might not fit is left
 * for "more" rather than cut off at the bottom.
 */
object Fit {
    /** A line of text, per sp of text size (Roboto is about 1.17; rounded up). */
    const val LINE = 1.25f
    /** An average character's width, per sp (wide enough for most words). */
    const val CHAR = 0.55f
    /** A home-screen check box with its touch room. */
    const val CHECK = 40f
    /** The "4 more" line: 12sp text and its gap above. */
    const val MORE_SP = 12f
    /** The frame's own padding, top and bottom (see [Frame]). */
    const val FRAME = 20f
    /** Kept spare at the bottom, for rounding. */
    const val SPARE = 4f

    /** One line of [sp] text, in dp, at the phone's text size [scale]. */
    fun line(sp: Float, scale: Float = 1f): Float = sp * scale * LINE

    /** The "4 more" line's height. */
    fun more(scale: Float = 1f): Float = line(MORE_SP, scale) + 6f

    /** How many lines [text] takes at [sp] in [width] dp, between 1 and [max]. */
    fun lines(text: String, sp: Float, width: Float, max: Int, scale: Float = 1f): Int {
        if (max <= 1 || width <= 0f) return 1
        val perLine = max(1, (width / (sp * scale * CHAR)).toInt())
        var n = 0
        for (part in text.split('\n')) n += max(1, ceil(part.length / perLine.toFloat()).toInt())
        return n.coerceIn(1, max)
    }

    /** The footer's height: a notice (two lines), the "updated at" line, or nothing. */
    fun footer(notice: Boolean, stale: Boolean, scale: Float = 1f): Float = when {
        notice -> 4f + 2 * line(11f, scale)
        stale -> 4f + line(11f, scale)
        else -> 0f
    }

    /** How many of the rows ([heights] in dp, in order) fit in [room] dp. When they
     *  don't all fit, [more] dp is kept for the "4 more" line. */
    fun count(heights: List<Float>, room: Float, more: Float): Int {
        if (heights.sum() <= room) return heights.size
        var used = more
        var n = 0
        for (h in heights) {
            if (used + h > room) break
            used += h
            n++
        }
        return n
    }
}

/** "4 more" at the bottom of a list: opens where the rest are. */
@Composable
fun MoreLine(text: String, action: Action) {
    Row(GlanceModifier.fillMaxWidth().padding(top = 4.dp).clickable(action).semantics { contentDescription = text }) {
        Text(text, style = WText.style(Fit.MORE_SP.sp, WColors.accent, bold = true), maxLines = 1)
    }
}
