package org.promptly.sync.widgets

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sign
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

/**
 * The Photo widget's shapes, as plain geometry (no Android in here, so it's
 * tested on its own). A shape is an outline — a closed run of points — for a
 * widget of any width and height:
 *  - [fills] shapes (rounded, arch) stretch to the whole widget;
 *  - the others keep their proportions in the biggest square that fits,
 *    in the middle.
 */
enum class PhotoShape(val key: String, val label: String, val fills: Boolean) {
    ROUNDED("rounded", "Rounded", true),
    CIRCLE("circle", "Circle", false),
    SQUIRCLE("squircle", "Soft square", false),
    FLOWER("flower", "Flower", false),
    HEART("heart", "Heart", false),
    ARCH("arch", "Arch", true);

    companion object {
        fun of(key: String?): PhotoShape = entries.firstOrNull { it.key == key } ?: ROUNDED
    }
}

object PhotoShapes {
    /** left, top, right, bottom. */
    class Box(val left: Float, val top: Float, val right: Float, val bottom: Float) {
        val width get() = right - left
        val height get() = bottom - top
    }

    /** Where in a [w]×[h] widget the shape sits. */
    fun box(shape: PhotoShape, w: Float, h: Float): Box {
        if (shape.fills) return Box(0f, 0f, w, h)
        val side = min(w, h)
        val l = (w - side) / 2f
        val t = (h - side) / 2f
        return Box(l, t, l + side, t + side)
    }

    /** The outline as x0, y0, x1, y1, … inside [box]; closed by joining the last point to the first. */
    fun outline(shape: PhotoShape, w: Float, h: Float): FloatArray {
        val b = box(shape, w, h)
        val unit = when (shape) {
            PhotoShape.ROUNDED -> rounded(b.width, b.height, min(b.width, b.height) * 0.16f)
            PhotoShape.ARCH -> arch(b.width, b.height)
            PhotoShape.CIRCLE -> polar(b.width) { 1.0 }
            PhotoShape.SQUIRCLE -> squircle(b.width)
            PhotoShape.FLOWER -> polar(b.width) { a -> (1.0 + FLOWER_DEPTH * cos(FLOWER_PETALS * a)) / (1.0 + FLOWER_DEPTH) }
            PhotoShape.HEART -> heart(b.width)
        }
        for (i in unit.indices step 2) {
            unit[i] = (unit[i] + b.left).coerceIn(0f, w)
            unit[i + 1] = (unit[i + 1] + b.top).coerceIn(0f, h)
        }
        return unit
    }

    private const val STEPS = 180
    private const val FLOWER_PETALS = 8
    private const val FLOWER_DEPTH = 0.07

    /** A closed curve round the middle of a [side] square: radius [r] (0–1 of half the side) at each angle. */
    private fun polar(side: Float, r: (Double) -> Double): FloatArray {
        val out = FloatArray(STEPS * 2)
        val half = side / 2.0
        for (i in 0 until STEPS) {
            val a = 2 * PI * i / STEPS
            val rad = r(a) * half
            out[i * 2] = (half + rad * sin(a)).toFloat()
            out[i * 2 + 1] = (half - rad * cos(a)).toFloat()
        }
        return out
    }

    /** A superellipse (|x|⁴ + |y|⁴ = 1): a square with corners that never quite turn. */
    private fun squircle(side: Float): FloatArray {
        val out = FloatArray(STEPS * 2)
        val half = side / 2.0
        for (i in 0 until STEPS) {
            val a = 2 * PI * i / STEPS
            val c = cos(a)
            val s = sin(a)
            out[i * 2] = (half + half * sign(s) * abs(s).pow(0.5)).toFloat()
            out[i * 2 + 1] = (half - half * sign(c) * abs(c).pow(0.5)).toFloat()
        }
        return out
    }

    /** The classic heart curve, scaled to touch every side of the square. */
    private fun heart(side: Float): FloatArray {
        val xs = DoubleArray(STEPS)
        val ys = DoubleArray(STEPS)
        for (i in 0 until STEPS) {
            val t = 2 * PI * i / STEPS
            xs[i] = 16 * sin(t).pow(3)
            ys[i] = -(13 * cos(t) - 5 * cos(2 * t) - 2 * cos(3 * t) - cos(4 * t))
        }
        val minX = xs.min()
        val maxX = xs.max()
        val minY = ys.min()
        val maxY = ys.max()
        // Keeps its proportions: a touch wider than tall, so it sits in the middle of the square.
        val scale = side / max(maxX - minX, maxY - minY)
        val dx = (side - (maxX - minX) * scale) / 2
        val dy = (side - (maxY - minY) * scale) / 2
        val out = FloatArray(STEPS * 2)
        for (i in 0 until STEPS) {
            out[i * 2] = ((xs[i] - minX) * scale + dx).toFloat()
            out[i * 2 + 1] = ((ys[i] - minY) * scale + dy).toFloat()
        }
        return out
    }

    private const val CORNER = 12

    /** Quarter-turn of points round ([cx], [cy]) from angle [from] (degrees, 0 = right, clockwise on screen). */
    private fun corner(into: MutableList<Float>, cx: Float, cy: Float, rx: Float, ry: Float, from: Double, sweep: Double = 90.0, steps: Int = CORNER) {
        for (i in 0..steps) {
            val a = Math.toRadians(from + sweep * i / steps)
            into += (cx + rx * cos(a)).toFloat()
            into += (cy + ry * sin(a)).toFloat()
        }
    }

    private fun rounded(w: Float, h: Float, radius: Float): FloatArray {
        val r = radius.coerceAtMost(min(w, h) / 2f)
        val p = ArrayList<Float>((CORNER + 1) * 8)
        corner(p, r, r, r, r, 180.0)
        corner(p, w - r, r, r, r, 270.0)
        corner(p, w - r, h - r, r, r, 0.0)
        corner(p, r, h - r, r, r, 90.0)
        return p.toFloatArray()
    }

    /** A doorway: a round top, straight sides, softly rounded feet. */
    private fun arch(w: Float, h: Float): FloatArray {
        val foot = min(w, h) * 0.08f
        val rx = w / 2f
        // A half circle when the widget is tall enough; flatter when it's wide.
        val ry = min(rx, (h - foot) * 0.75f)
        val p = ArrayList<Float>(140)
        corner(p, rx, ry, rx, ry, 180.0, sweep = 180.0, steps = 48)
        corner(p, w - foot, h - foot, foot, foot, 0.0)
        corner(p, foot, h - foot, foot, foot, 90.0)
        return p.toFloatArray()
    }

    /** The area inside an outline (shoelace). */
    fun area(points: FloatArray): Float {
        var sum = 0.0
        val n = points.size / 2
        for (i in 0 until n) {
            val j = (i + 1) % n
            sum += points[i * 2].toDouble() * points[j * 2 + 1] - points[j * 2].toDouble() * points[i * 2 + 1]
        }
        return abs(sum / 2).toFloat()
    }

    /** The part of a [srcW]×[srcH] photo that fills [dstW]×[dstH] with nothing left over (centre crop): left, top, right, bottom. */
    fun cover(srcW: Int, srcH: Int, dstW: Int, dstH: Int): IntArray {
        if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return intArrayOf(0, 0, max(srcW, 0), max(srcH, 0))
        // Compare the two shapes without dividing: src wider than dst → trim the sides.
        return if (srcW.toLong() * dstH > dstW.toLong() * srcH) {
            val cw = (srcH.toLong() * dstW / dstH).toInt().coerceIn(1, srcW)
            val l = (srcW - cw) / 2
            intArrayOf(l, 0, l + cw, srcH)
        } else {
            val ch = (srcW.toLong() * dstH / dstW).toInt().coerceIn(1, srcH)
            // People's faces sit above the middle more often than below: keep a little more of the top.
            val t = ((srcH - ch) * 0.4f).roundToInt()
            intArrayOf(0, t, srcW, t + ch)
        }
    }

    /**
     * The size to draw at for a widget of [w]×[h] pixels: the same shape, with
     * no more than [maxPixels] in it — the picture is handed to the home
     * screen whole, so it has to stay small.
     */
    fun fit(w: Int, h: Int, maxPixels: Int): Pair<Int, Int> {
        val cw = max(w, 1)
        val ch = max(h, 1)
        val total = cw.toLong() * ch
        if (total <= maxPixels) return cw to ch
        val k = sqrt(maxPixels.toDouble() / total)
        return max((cw * k).toInt(), 1) to max((ch * k).toInt(), 1)
    }

    /** How far to shrink a [w]×[h] picture while reading it (a power of two) so its long edge ends near [edge], not under it. */
    fun sample(w: Int, h: Int, edge: Int): Int {
        var s = 1
        while (max(w, h) / (s * 2) >= edge) s *= 2
        return s
    }
}

/** Which photo next, and which saved ones to let go — the Photo widget's choices, apart from Android. */
object PhotoPick {
    /**
     * Another photo at random, never the one showing ([current]) while there's
     * any other. Ones shown lately ([recent], newest last) wait their turn
     * until the rest have been seen. Null when there are none.
     */
    fun next(ids: List<String>, current: String?, recent: List<String> = emptyList(), random: Random = Random.Default): String? {
        if (ids.isEmpty()) return null
        val others = ids.filter { it != current }
        if (others.isEmpty()) return ids.first()
        val fresh = others.filter { it !in recent }
        return (fresh.ifEmpty { others }).random(random)
    }

    /** [recent] with [shown] added, kept shorter than the number of photos so there's always one to go to. */
    fun remember(recent: List<String>, shown: String, photos: Int): List<String> =
        (recent.filter { it != shown } + shown).takeLast((photos - 1).coerceIn(0, MAX_RECENT))

    const val MAX_RECENT = 24

    /** A saved photo: its id and when it was saved. */
    class Saved(val id: String, val savedAt: Long)

    /**
     * The saved photos to delete so no more than [keep] stay: the oldest
     * first, never one that's on a widget right now ([showing]).
     */
    fun trim(saved: List<Saved>, keep: Int, showing: Set<String> = emptySet()): List<String> {
        var over = saved.size - keep
        if (over <= 0) return emptyList()
        val out = ArrayList<String>()
        for (s in saved.sortedBy { it.savedAt }) {
            if (over <= 0) break
            if (s.id in showing) continue
            out += s.id
            over--
        }
        return out
    }

    /** Is it time for the next photo? */
    fun due(shownAt: Long, now: Long, every: Long): Boolean = shownAt <= 0 || now < shownAt || now - shownAt >= every
}
