package org.promptly.sync.maps

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import uniffi.ferrostar.DrivingSide
import uniffi.ferrostar.LaneInfo
import kotlin.math.cos
import kotlin.math.sin

/** The lanes picture for the car's turn card: one arrow per way each lane goes, the
 *  ones to be in bright and the rest dimmed, left to right as you see them. Android
 *  Auto only shows lane guidance it's given a picture of. */
internal object LaneImage {
    private const val CELL = 72
    private const val MAX_LANES = 10
    private val ON = Color.WHITE
    private val OFF = Color.argb(110, 255, 255, 255)

    fun draw(lanes: List<LaneInfo>, side: DrivingSide): Bitmap {
        val shown = lanes.take(MAX_LANES)
        val bitmap = Bitmap.createBitmap(CELL * shown.size.coerceAtLeast(1), CELL, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        shown.forEachIndexed { i, lane ->
            // Draw the dim arrows first, so the one to follow sits on top.
            val ways = lane.directions.ifEmpty { listOf("straight") }
            val chosen = if (lane.active) lane.activeDirection ?: ways.first() else null
            ways.filter { it != chosen }.forEach { arrow(canvas, i * CELL.toFloat(), it, OFF, side) }
            chosen?.let { arrow(canvas, i * CELL.toFloat(), it, ON, side) }
        }
        return bitmap
    }

    /** Degrees from straight ahead, right positive; null for a U-turn. */
    internal fun angleOf(direction: String): Float? = when (direction.lowercase()) {
        "uturn", "u-turn" -> null
        "sharp left" -> -135f
        "left" -> -90f
        "slight left", "merge to left" -> -40f
        "slight right", "merge to right" -> 40f
        "right" -> 90f
        "sharp right" -> 135f
        else -> 0f
    }

    private fun arrow(canvas: Canvas, left: Float, direction: String, colour: Int, side: DrivingSide) {
        val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = colour
            style = Paint.Style.STROKE
            strokeWidth = CELL * 0.09f
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = colour
            style = Paint.Style.FILL
        }
        val cx = left + CELL / 2f
        val bottom = CELL * 0.92f
        val bend = CELL * 0.52f
        val angle = angleOf(direction)
        val path = Path().apply { moveTo(cx, bottom) }
        val tipX: Float
        val tipY: Float
        val heading: Float
        if (angle == null) {
            // Up, over and back down: towards the middle of the road.
            val turnRight = side == DrivingSide.LEFT
            val r = CELL * 0.17f
            val top = CELL * 0.28f
            path.lineTo(cx, top + r)
            val oval = if (turnRight) RectF(cx, top, cx + 2 * r, top + 2 * r) else RectF(cx - 2 * r, top, cx, top + 2 * r)
            path.arcTo(oval, if (turnRight) 180f else 0f, if (turnRight) 180f else -180f)
            tipX = if (turnRight) cx + 2 * r else cx - 2 * r
            tipY = CELL * 0.62f
            path.lineTo(tipX, tipY)
            heading = 180f
        } else {
            path.lineTo(cx, bend)
            val length = CELL * if (angle == 0f) 0.36f else 0.3f
            val rad = Math.toRadians(angle.toDouble())
            tipX = cx + (length * sin(rad)).toFloat()
            tipY = bend - (length * cos(rad)).toFloat()
            path.lineTo(tipX, tipY)
            heading = angle
        }
        canvas.drawPath(path, stroke)
        // The head: a triangle pointing the way the line ends.
        val size = CELL * 0.16f
        val rad = Math.toRadians(heading.toDouble())
        val dx = sin(rad).toFloat()
        val dy = -cos(rad).toFloat()
        val head = Path().apply {
            moveTo(tipX + dx * size, tipY + dy * size)
            lineTo(tipX - dy * size * 0.8f, tipY + dx * size * 0.8f)
            lineTo(tipX + dy * size * 0.8f, tipY - dx * size * 0.8f)
            close()
        }
        canvas.drawPath(head, fill)
    }
}
