package org.promptly.sync.widgets

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.state.GlanceStateDefinition
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.Text
import java.time.Instant

/**
 * Agenda: today and the next days. A date header with **+** (a new event in
 * P Calendar); Today / Tomorrow / "Wed 12" groups; all-day events as chips;
 * time, title, place and the calendar's colour; "Nothing else today".
 * 2×2 shows the next two things; bigger shows what fits of the week, then "3 more"
 * (it never scrolls: a scrolling widget takes the home screen's swipe up).
 * Tap an event → it opens in P Calendar.
 */
class AgendaWidget : GlanceAppWidget() {
    // Exact: the list shows the rows that fit this widget's real size.
    override val sizeMode = SizeMode.Exact
    override val stateDefinition: GlanceStateDefinition<*> = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        WidgetStore.load(context)
        provideContent {
            // Read here, before any branch: every change (and every bump) redraws,
            // including from the not-linked message once the phone is linked.
            val state = WidgetStore.state.collectAsState().value
            val prefs = currentState<Preferences>()
            val ctx = LocalContext.current
            val link = Widgets.link(ctx)
            if (link != Link.LINKED) LinkMessage(ctx, link)
            else AgendaContent(state, configOf(prefs), System.currentTimeMillis(), clockOf(ctx), LocalSize.current.width < WIDE.width, LocalSize.current)
        }
    }

    /** The widget picker's preview (Android 15+): made-up events and tasks. */
    override suspend fun providePreview(context: Context, widgetCategory: Int) {
        provideContent { AgendaContent(Samples.calendarAndTasks(), AgendaConfig(), Samples.now(), clockOf(context), small = false, size = TALL) }
    }

    companion object {
        val SMALL = DpSize(110.dp, 110.dp)
        val WIDE = DpSize(250.dp, 110.dp)
        val TALL = DpSize(250.dp, 250.dp)

        val MODE = stringPreferencesKey("cal_mode")
        val PICKED = stringSetPreferencesKey("cal_picked")
        val TITLES_ONLY = booleanPreferencesKey("titles_only")

        fun configOf(p: Preferences) = AgendaConfig(p[MODE] ?: AgendaConfig.WEB, p[PICKED] ?: emptySet(), p[TITLES_ONLY] ?: false)
    }
}

class AgendaWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = AgendaWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        Widgets.onEnabled(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        Widgets.onDisabled(context)
    }
}

/** One line in the list. */
internal sealed class Line(val key: Long) {
    class Day(val d: AgendaDay) : Line(-d.date.toEpochDay())
    /** [prefix]: the day, when a small widget shows something after today. */
    class AllDay(val e: Occurrence, k: Long, val prefix: String? = null) : Line(k)
    class Timed(val r: AgendaRow, k: Long, val prefix: String? = null) : Line(k)
    class Empty(val text: String, k: Long) : Line(k)
}

internal fun lines(days: List<AgendaDay>, small: Boolean): List<Line> {
    var n = 0L
    if (small) {
        val picks = mutableListOf<Line>()
        days.forEachIndexed { i, d ->
            val pre = if (i == 0) null else d.label
            d.allDay.forEach { picks += Line.AllDay(it, ++n, pre) }
            d.timed.forEach { picks += Line.Timed(it, ++n, pre) }
        }
        return picks.take(2).ifEmpty { listOf(Line.Empty("Nothing coming up", 1_000_000)) }
    }
    val today = days.firstOrNull()
    if (today == null || (days.size == 1 && today.allDay.isEmpty() && today.timed.isEmpty())) {
        return listOf(Line.Empty("Nothing on this week", 1_000_001))
    }
    val out = mutableListOf<Line>()
    days.forEachIndexed { i, d ->
        if (i > 0) out += Line.Day(d)
        d.allDay.forEach { out += Line.AllDay(it, ++n) }
        d.timed.forEach { out += Line.Timed(it, ++n) }
        if (i == 0 && d.allDay.isEmpty() && d.timed.isEmpty()) out += Line.Empty("Nothing else today", 1_000_002)
    }
    return out
}

@Composable
fun AgendaContent(state: WidgetState, cfg: AgendaConfig, now: Long, clock: Clock, small: Boolean, size: DpSize = AgendaWidget.TALL) {
    val ctx = LocalContext.current
    val cal = state.snapshot.calendar
    val days = Agenda.days(cal, cfg, now, clock)
    val today = Instant.ofEpochMilli(now).atZone(clock.zone).toLocalDate()
    val all = lines(days, small)
    val stale = if (cal == null && state.snapshot.fetchedAt == 0L) null else staleLabel(state.snapshot.fetchedAt, now, clock)
    val notice = state.notices.lastOrNull { it.area == "tasks" }
    Frame {
        Row(GlanceModifier.fillMaxWidth().padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(
                GlanceModifier.defaultWeight().clickable(actionStartActivity(Open.page(ctx, Open.CALENDAR, "/calendar"))).semantics { contentDescription = "Open P Calendar" },
            ) {
                Text(if (small) clock.day(today, today) else "Today", style = WText.style(15.sp, WColors.accent, bold = true), maxLines = 1)
                Muted(if (small) today.dayOfMonth.toString() + " " + today.month.getDisplayName(java.time.format.TextStyle.SHORT, clock.locale) else clock.longDay(today), size = 12.sp)
            }
            AddButton("New event", actionStartActivity(Open.page(ctx, Open.CALENDAR, "/calendar?new=1&date=$today")))
        }
        if (cal == null) {
            Muted(if (state.snapshot.fetchedAt == 0L) "Getting your calendar…" else "Your calendar isn't here yet.")
        } else {
            // What fits, whole, then "3 more" (no scrolling: see Fit).
            val scale = ctx.resources.configuration.fontScale
            val head = Fit.line(15f, scale) + Fit.line(12f, scale) + 6f
            val room = size.height.value - Fit.FRAME - Fit.SPARE - head - Fit.footer(notice != null, stale != null, scale)
            var n = Fit.count(all.map { agendaLineHeight(it, cfg, small, scale) }, room, Fit.more(scale))
            // A day's name with nothing under it goes too.
            while (n > 0 && all[n - 1] is Line.Day) n--
            val hidden = all.drop(n).count { it is Line.AllDay || it is Line.Timed }
            Column(GlanceModifier.defaultWeight().fillMaxWidth()) {
                for (line in all.take(n)) AgendaLine(line, cfg, small)
                if (hidden > 0) MoreLine("$hidden more", actionStartActivity(Open.page(ctx, Open.CALENDAR, "/calendar")))
            }
        }
        Footer(notice, stale)
    }
}

/** How tall one line of the agenda is drawn (dp, rounded up): see [AgendaLine]. */
internal fun agendaLineHeight(line: Line, cfg: AgendaConfig, small: Boolean, scale: Float = 1f): Float = when (line) {
    is Line.Day -> Fit.line(12f, scale) + 10f
    is Line.Empty -> Fit.line(12f, scale) + 8f
    is Line.AllDay -> Fit.line(12f, scale) + 10f
    is Line.Timed -> {
        val place = !small && !cfg.titlesOnly && line.r.occ.location.isNotBlank()
        val words = Fit.line(13f, scale) + if (small || place) Fit.line(11f, scale) else 0f
        maxOf(if (place) 32f else 18f, words) + 6f
    }
}

@Composable
private fun AgendaLine(line: Line, cfg: AgendaConfig, small: Boolean) {
    val ctx = LocalContext.current
    when (line) {
        is Line.Day -> Text(
            line.d.label,
            modifier = GlanceModifier.fillMaxWidth().padding(top = 8.dp, bottom = 2.dp),
            style = WText.style(12.sp, WColors.accent, bold = true),
            maxLines = 1,
        )
        is Line.Empty -> Muted(line.text, GlanceModifier.fillMaxWidth().padding(vertical = 4.dp))
        is Line.AllDay -> {
            val e = line.e
            Row(GlanceModifier.fillMaxWidth().padding(vertical = 2.dp)) {
                Box(
                    GlanceModifier.fillMaxWidth().background(WColors.fixed(e.color)).cornerRadius(6.dp).padding(horizontal = 8.dp, vertical = 3.dp)
                        .clickable(actionStartActivity(Open.page(ctx, Open.CALENDAR, "/calendar?event=${e.eventId}"))),
                ) {
                    Text((line.prefix?.let { "$it · " } ?: "") + e.title, style = WText.style(12.sp, WColors.onColor, bold = true), maxLines = 1)
                }
            }
        }
        is Line.Timed -> {
            val r = line.r
            val e = r.occ
            Row(
                GlanceModifier.fillMaxWidth().padding(vertical = 3.dp)
                    .clickable(actionStartActivity(Open.page(ctx, Open.CALENDAR, "/calendar?event=${e.eventId}")))
                    .semantics { contentDescription = "${r.label}, ${e.title}" + if (e.location.isNotBlank() && !cfg.titlesOnly) ", ${e.location}" else "" },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(GlanceModifier.width(3.dp).height(if (small || cfg.titlesOnly || e.location.isBlank()) 18.dp else 32.dp).background(WColors.fixed(e.color)).cornerRadius(2.dp)) {}
                Spacer(GlanceModifier.width(8.dp))
                Column(GlanceModifier.defaultWeight()) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (!small) {
                            Text(r.label, modifier = GlanceModifier.width(64.dp), style = WText.style(12.sp, if (r.happening) WColors.accent else WColors.muted, bold = r.happening), maxLines = 1)
                        }
                        Text(e.title, style = WText.style(13.sp, bold = r.happening), maxLines = 1)
                    }
                    if (small) Muted((line.prefix?.let { "$it · " } ?: "") + r.label, size = 11.sp)
                    else if (!cfg.titlesOnly && e.location.isNotBlank()) {
                        Row {
                            Spacer(GlanceModifier.width(64.dp))
                            Muted(e.location, size = 11.sp)
                        }
                    }
                }
            }
        }
    }
}
