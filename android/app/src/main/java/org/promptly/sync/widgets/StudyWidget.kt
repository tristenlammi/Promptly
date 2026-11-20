package org.promptly.sync.widgets

import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import org.json.JSONObject

/*
 * Study at a glance: what's due for review today and the lesson that comes
 * next, a tap from either. Drawn from the `study` section of
 * `/api/widgets/glance` ([HubStore]) like the other at-a-glance widgets; its
 * taps open pages of P Study. Its own class by its own name (see the R8 note
 * in proguard-rules.pro): Glance tells widgets apart by class name.
 */

/** The words and the one button, worked out from the saved answer (pure, tested). */
object StudyWords {
    fun due(n: Int): String = when {
        n <= 0 -> "Nothing to review today"
        n == 1 -> "1 idea to review"
        else -> "$n ideas to review"
    }

    /** An honest line about the run of days, or nothing: no nagging about a broken one. */
    fun streak(days: Int, today: Boolean): String? = when {
        days >= 2 -> "$days days in a row"
        today -> "Studied today"
        else -> null
    }

    /** The one button: reviews first when any are due, else the next lesson, else Study itself. */
    fun action(s: JSONObject): Pair<String, String> {
        val review = s.text("review_url")
        val next = s.text("next_url")
        return when {
            s.intOr("due") > 0 && review != null -> "Review" to review
            next != null -> "Next lesson" to next
            else -> "Open Study" to (s.text("url") ?: "/study")
        }
    }
}

class StudyWidget : HubWidget() {
    override val sizeMode = SizeMode.Exact

    @Composable
    override fun Body(hub: HubState, prefs: Preferences, now: Long) {
        val ctx = LocalContext.current
        val s = hub.section("study")
        val tall = LocalSize.current.height >= 150.dp
        Frame {
            Title("Study", openPage(ctx, Open.STUDY, "/study")) {
                if (s != null) Badge(s.intOr("due"))
            }
            Column(GlanceModifier.defaultWeight().fillMaxWidth()) {
                if (s == null) {
                    Muted(if (hub.fetchedAt == 0L) "Getting your subjects…" else "Start a subject in P Study and what's due shows here.")
                } else {
                    Words(
                        StudyWords.due(s.intOr("due")), size = 15.sp, bold = true,
                        modifier = GlanceModifier.clickable(openPage(ctx, Open.STUDY, s.text("review_url") ?: s.text("url") ?: "/study")),
                    )
                    val subject = s.text("subject")
                    if (subject != null) {
                        Spacer(GlanceModifier.height(4.dp))
                        Column(GlanceModifier.fillMaxWidth().clickable(openPage(ctx, Open.STUDY, s.text("next_url") ?: "/study"))) {
                            Words(subject, size = 12.sp, color = WColors.muted)
                            s.text("next")?.let { Words("Next: $it", size = 12.sp, color = WColors.accent, max = if (tall) 2 else 1) }
                        }
                    }
                    if (tall) StudyWords.streak(s.intOr("streak"), s.optBoolean("today"))?.let {
                        Spacer(GlanceModifier.height(4.dp))
                        Muted(it)
                    }
                }
            }
            if (s != null) {
                val (label, path) = StudyWords.action(s)
                Row(GlanceModifier.fillMaxWidth().padding(top = 6.dp)) {
                    Pill(label, openPage(ctx, Open.STUDY, path))
                }
            }
            if (tall) HubFooter(hub, now)
        }
    }
}

class StudyWidgetReceiver : HubReceiver() {
    override val glanceAppWidget: GlanceAppWidget = StudyWidget()
}
