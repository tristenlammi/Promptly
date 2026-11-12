package org.promptly.sync.widgets

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.state.GlanceStateDefinition
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.Text
import org.json.JSONObject
import org.promptly.sync.R

/**
 * An at-a-glance widget: draws from [HubStore] (the last `/api/widgets/glance`
 * answer) and its own settings, never from the network. [needsAccount]: a
 * widget that shows nothing of yours (Countdown) works on an unlinked phone.
 */
abstract class HubWidget : GlanceAppWidget() {
    override val stateDefinition: GlanceStateDefinition<*> = PreferencesGlanceStateDefinition
    open val needsAccount: Boolean = true

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        HubStore.load(context)
        provideContent {
            // Read before any branch, so every new answer (and bump) redraws.
            val hub = HubStore.state.collectAsState().value
            val prefs = currentState<Preferences>()
            val ctx = LocalContext.current
            val link = Widgets.link(ctx)
            if (needsAccount && link != Link.LINKED) LinkMessage(ctx, link) else Body(hub, prefs, System.currentTimeMillis())
        }
    }

    /** The widget picker's preview (Android 15+): made-up numbers, never yours. */
    override suspend fun providePreview(context: Context, widgetCategory: Int) {
        provideContent { Body(Samples.hub(), emptyPreferences(), Samples.now()) }
    }

    @Composable
    abstract fun Body(hub: HubState, prefs: Preferences, now: Long)
}

/** Every widget's receiver: the first one placed starts the refreshes, the last one stops them. */
abstract class HubReceiver : GlanceAppWidgetReceiver() {
    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        Widgets.onEnabled(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        Widgets.onDisabled(context)
    }
}

/** A tap that opens a page of one of the apps (see [Open]). */
fun openPage(ctx: Context, launcher: String, path: String?): Action =
    actionStartActivity(Open.page(ctx, launcher, path?.takeIf { it.startsWith("/") } ?: "/"))

fun openIntent(intent: Intent): Action = actionStartActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))

/** A widget's title line: its name in the accent colour, optionally a small button on the right. */
@Composable
fun Title(text: String, action: Action? = null, end: @Composable (() -> Unit)? = null) {
    Row(GlanceModifier.padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            text,
            modifier = if (action != null) GlanceModifier.clickable(action) else GlanceModifier,
            style = WText.style(14.sp, WColors.accent, bold = true),
            maxLines = 1,
        )
        Spacer(GlanceModifier.defaultWeight())
        if (end != null) end()
    }
}

/** A filled terracotta pill: "Log food", "Read me my day". */
@Composable
fun Pill(label: String, action: Action, icon: Int? = null, modifier: GlanceModifier = GlanceModifier) {
    Row(
        modifier.background(WColors.fill).cornerRadius(18.dp).padding(horizontal = 12.dp, vertical = 7.dp).clickable(action).semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Image(ImageProvider(icon), contentDescription = null, modifier = GlanceModifier.size(16.dp), colorFilter = ColorFilter.tint(WColors.onFill))
            Spacer(GlanceModifier.width(6.dp))
        }
        Text(label, style = WText.style(13.sp, WColors.onFill, bold = true), maxLines = 1)
    }
}

/** A round icon button in the accent fill. */
@Composable
fun RoundIcon(icon: Int, label: String, action: Action, size: Dp = 48.dp, iconSize: Dp = 24.dp) {
    Box(
        GlanceModifier.size(size).background(WColors.fill).cornerRadius(size / 2).clickable(action).semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Image(ImageProvider(icon), contentDescription = null, modifier = GlanceModifier.size(iconSize), colorFilter = ColorFilter.tint(WColors.onFill))
    }
}

/** The small pencil in a corner that opens a widget's settings. */
@Composable
fun EditButton(action: Action) {
    Box(GlanceModifier.size(28.dp).cornerRadius(14.dp).clickable(action).semantics { contentDescription = "Change this widget" }, contentAlignment = Alignment.Center) {
        Image(ImageProvider(R.drawable.wg_edit), contentDescription = null, modifier = GlanceModifier.size(16.dp), colorFilter = ColorFilter.tint(WColors.muted))
    }
}

@Composable
fun Words(text: String, size: TextUnit = 13.sp, bold: Boolean = false, color: androidx.glance.unit.ColorProvider = WColors.text, max: Int = 1, modifier: GlanceModifier = GlanceModifier) {
    Text(text, modifier = modifier, style = WText.style(size, color, bold = bold), maxLines = max)
}

/** "Updated 10:42 · tap to refresh" once the saved numbers are old. */
@Composable
fun HubFooter(hub: HubState, now: Long) {
    val ctx = LocalContext.current
    Footer(null, staleLabel(hub.fetchedAt, now, clockOf(ctx)))
}

/** Pictures the widgets draw themselves (Glance has no canvas): rings and a trend line. */
object Draw {
    private const val FILL = 0xFFD97757.toInt()
    private const val TRACK = 0x33888888

    /** A ring [fraction] full (over 1 shows full, in a darker shade). */
    fun ring(fraction: Double, px: Int = 168, stroke: Float = px * 0.12f): Bitmap {
        val b = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        val c = Canvas(b)
        val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = stroke; strokeCap = Paint.Cap.ROUND }
        val r = RectF(stroke / 2, stroke / 2, px - stroke / 2, px - stroke / 2)
        p.color = TRACK
        c.drawArc(r, 0f, 360f, false, p)
        val f = fraction.coerceIn(0.0, 1.0)
        if (f > 0) {
            p.color = if (fraction > 1.0) 0xFFC0362C.toInt() else FILL
            c.drawArc(r, -90f, (360 * f).toFloat(), false, p)
        }
        return b
    }

    /** A line through [values] (gaps skipped), with a dot on the last one. */
    fun trend(values: List<Double?>, w: Int = 360, h: Int = 120): Bitmap? {
        val pts = values.mapIndexedNotNull { i, v -> v?.let { i to it } }
        if (pts.size < 2) return null
        val b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(b)
        val lo = pts.minOf { it.second }
        val hi = pts.maxOf { it.second }
        val span = (hi - lo).takeIf { it > 0 } ?: 1.0
        val pad = 10f
        fun x(i: Int) = pad + (w - 2 * pad) * i / (values.size - 1).coerceAtLeast(1)
        fun y(v: Double) = (h - pad) - ((v - lo) / span * (h - 2 * pad)).toFloat()
        val path = Path()
        pts.forEachIndexed { n, (i, v) -> if (n == 0) path.moveTo(x(i), y(v)) else path.lineTo(x(i), y(v)) }
        val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 5f; color = FILL; strokeJoin = Paint.Join.ROUND; strokeCap = Paint.Cap.ROUND }
        c.drawPath(path, p)
        val (li, lv) = pts.last()
        p.style = Paint.Style.FILL
        c.drawCircle(x(li), y(lv), 8f, p)
        return b
    }
}

/** First letters for a person's circle: "Sam Lee" → "SL", "mum" → "M". */
fun initials(name: String): String {
    val words = name.trim().split(Regex("[\\s._-]+")).filter { it.isNotBlank() }
    return when {
        words.isEmpty() -> "?"
        words.size == 1 -> words[0].take(1).uppercase()
        else -> (words[0].take(1) + words[1].take(1)).uppercase()
    }
}

/** A steady colour for a person (the same person, the same colour). */
fun personColor(id: String): Long {
    val palette = listOf(0xFFD97757, 0xFF4F7FE0, 0xFF3E9C6B, 0xFF9B6BD3, 0xFFD9A441, 0xFF2E9AA6, 0xFFC0567E, 0xFF6B7A8F)
    return palette[Math.floorMod(id.hashCode(), palette.size)]
}

/** Whole minutes from [now] to an ISO instant, or null. */
fun minutesUntil(iso: String?, now: Long): Long? = runCatching {
    val t = java.time.OffsetDateTime.parse(iso).toInstant().toEpochMilli()
    maxOf(0L, (t - now + 30_000) / 60_000)
}.getOrNull()

/** "45 min", "1 h 20 min". */
fun minutesLabel(m: Long): String = if (m < 60) "$m min" else "${m / 60} h" + (if (m % 60 != 0L) " ${m % 60} min" else "")

fun JSONObject.intOr(key: String, default: Int = 0): Int = if (!has(key) || isNull(key)) default else optInt(key, default)
