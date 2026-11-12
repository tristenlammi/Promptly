package org.promptly.sync.widgets

import android.content.Context
import android.text.format.DateFormat
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.action.Action
import androidx.glance.action.ActionParameters
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.color.ColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ColumnScope
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextDecoration
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider as GlanceColor
import org.promptly.sync.R
import java.time.ZoneId

/**
 * Promptly's look on the home screen: warm stone neutrals and the terracotta
 * accent, light and dark (the launcher picks with the phone's theme). The
 * same palette on every Android version, so a widget looks like Promptly and
 * not like the wallpaper.
 */
object WColors {
    val background: GlanceColor = ColorProvider(day = Color(0xFFFFFFFF), night = Color(0xFF1C1917))
    val surface: GlanceColor = ColorProvider(day = Color(0xFFF5F2EE), night = Color(0xFF292524))
    val text: GlanceColor = ColorProvider(day = Color(0xFF1C1917), night = Color(0xFFF5F5F4))
    val muted: GlanceColor = ColorProvider(day = Color(0xFF6B635C), night = Color(0xFFA8A29E))
    val accent: GlanceColor = ColorProvider(day = Color(0xFFB85A3C), night = Color(0xFFE38B6D))
    val onAccent: GlanceColor = ColorProvider(day = Color(0xFFFFFFFF), night = Color(0xFF1C1917))
    /** Filled buttons and tiles: the brand terracotta, light and dark alike (owner's choice, v0.38.1). */
    val fill: GlanceColor = ColorProvider(day = Color(0xFFD97757), night = Color(0xFFD97757))
    val onFill: GlanceColor = ColorProvider(day = Color(0xFFFFFFFF), night = Color(0xFFFFFFFF))
    val late: GlanceColor = ColorProvider(day = Color(0xFFC0362C), night = Color(0xFFF28B82))
    val line: GlanceColor = ColorProvider(day = Color(0xFFE7E1DA), night = Color(0xFF3A3431))
    /** Text on an event's own colour (all-day chips). */
    val onColor: GlanceColor = ColorProvider(day = Color(0xFFFFFFFF), night = Color(0xFFFFFFFF))

    fun fixed(hex: String?, fallback: Long = 0xFF4F7FE0): GlanceColor {
        val c = parse(hex) ?: Color(fallback)
        return ColorProvider(day = c, night = c)
    }

    fun parse(hex: String?): Color? = runCatching {
        val h = hex?.trim()?.removePrefix("#") ?: return null
        when (h.length) {
            6 -> Color(("FF$h").toLong(16))
            8 -> Color(h.toLong(16))
            3 -> Color(("FF" + h.map { "$it$it" }.joinToString("")).toLong(16))
            else -> null
        }
    }.getOrNull()
}

object WText {
    fun style(size: TextUnit = 13.sp, color: GlanceColor = WColors.text, bold: Boolean = false, struck: Boolean = false) = TextStyle(
        color = color,
        fontSize = size,
        fontWeight = if (bold) FontWeight.Medium else FontWeight.Normal,
        textDecoration = if (struck) TextDecoration.LineThrough else TextDecoration.None,
    )
}

/** The phone's clock for drawing (12/24-hour from its settings). */
fun clockOf(ctx: Context): Clock = Clock(ZoneId.systemDefault(), DateFormat.is24HourFormat(ctx))

/** A widget's frame: rounded, its background (solid or glass), edge padding. */
@Composable
fun Frame(content: @Composable ColumnScope.() -> Unit) {
    Column(
        GlanceModifier.fillMaxSize().widgetBackground(glassChosen()).cornerRadius(20.dp).padding(horizontal = 12.dp, vertical = 10.dp),
    ) { content() }
}

/** Each widget's own "Background" setting: "solid" (default) or "glass". */
val BACKGROUND = androidx.datastore.preferences.core.stringPreferencesKey("wg_background")

/** Whether this widget chose glass. Every widget keeps its settings as
 *  Preferences; the cast is only a guard. */
@Composable
fun glassChosen(): Boolean =
    (androidx.glance.currentState<Any?>() as? androidx.datastore.preferences.core.Preferences)?.get(BACKGROUND) == "glass"

/** Solid Promptly background, or see-through: an even tint (light in day,
 *  dark at night) the wallpaper shows through, with no rim or shine. */
fun GlanceModifier.widgetBackground(glass: Boolean): GlanceModifier =
    if (glass) background(ImageProvider(R.drawable.wg_glass)) else background(WColors.background)

/** The round "+" in a widget's top corner. */
@Composable
fun AddButton(label: String, action: Action) {
    Box(
        GlanceModifier.size(32.dp).background(WColors.accent).cornerRadius(16.dp).clickable(action).semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Image(ImageProvider(R.drawable.wg_add), contentDescription = null, modifier = GlanceModifier.size(18.dp), colorFilter = ColorFilter.tint(WColors.onAccent))
    }
}

@Composable
fun Dot(color: GlanceColor, size: Dp = 8.dp) {
    Box(GlanceModifier.size(size).background(color).cornerRadius(size / 2)) {}
}

@Composable
fun Muted(text: String, modifier: GlanceModifier = GlanceModifier, size: TextUnit = 12.sp) {
    Text(text, modifier = modifier, style = WText.style(size, WColors.muted), maxLines = 2)
}

/** Not linked / removed / turned off: one plain message, and a tap to fix it. */
@Composable
fun LinkMessage(ctx: Context, link: Link) {
    val (title, hint) = when (link) {
        Link.NOT_LINKED -> "Link this phone to Promptly" to "Tap to link it — the same as photo backup."
        Link.REMOVED -> "This phone was removed" to "Tap to link it again."
        Link.OFF -> "Widgets are off for this phone" to "Turn them on in Promptly → Account → Devices, then tap here."
        Link.LINKED -> "" to ""
    }
    // Off: a tap checks again (after turning them back on); otherwise it opens linking.
    val tap = if (link == Link.OFF) GlanceModifier.clickable(androidx.glance.appwidget.action.actionRunCallback<RefreshNow>())
    else GlanceModifier.clickable(actionStartActivity(Open.link(ctx)))
    Frame {
        Column(GlanceModifier.fillMaxSize().then(tap), verticalAlignment = Alignment.CenterVertically, horizontalAlignment = Alignment.CenterHorizontally) {
            Image(ImageProvider(R.drawable.wg_link), contentDescription = null, modifier = GlanceModifier.size(28.dp), colorFilter = ColorFilter.tint(WColors.accent))
            Spacer(GlanceModifier.height(6.dp))
            Text(title, style = WText.style(14.sp, bold = true).copy(textAlign = androidx.glance.text.TextAlign.Center), maxLines = 2)
            Spacer(GlanceModifier.height(2.dp))
            Text(hint, style = WText.style(12.sp, WColors.muted).copy(textAlign = androidx.glance.text.TextAlign.Center), maxLines = 3)
        }
    }
}

/** A quiet line at the bottom: a notice (tap to clear) or "Updated 10:42" (tap to refresh). */
@Composable
fun Footer(notice: Notice?, stale: String?) {
    if (notice != null) {
        Row(
            GlanceModifier.fillMaxWidth().padding(top = 4.dp).clickable(
                androidx.glance.appwidget.action.actionRunCallback<DismissNotice>(androidx.glance.action.actionParametersOf(DismissNotice.ID to notice.id)),
            ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(notice.text, style = WText.style(11.sp, WColors.late), maxLines = 2)
        }
    } else if (stale != null) {
        Row(
            GlanceModifier.fillMaxWidth().padding(top = 4.dp).clickable(androidx.glance.appwidget.action.actionRunCallback<RefreshNow>()),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Muted("$stale · tap to refresh", size = 11.sp)
        }
    }
}

@Composable
fun Divider() {
    Spacer(GlanceModifier.fillMaxWidth().height(1.dp).background(WColors.line))
}

@Composable
fun Gap(w: Dp) = Spacer(GlanceModifier.width(w))

class DismissNotice : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        parameters[ID]?.let { WidgetStore.dismiss(context, it) }
        Widgets.redraw(context)
    }

    companion object {
        val ID = ActionParameters.Key<String>("notice")
    }
}

class RefreshNow : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        WidgetSync.now(context)
    }
}
