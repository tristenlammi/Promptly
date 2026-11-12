package org.promptly.sync.widgets

import android.content.Context
import android.content.Intent
import android.provider.MediaStore
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import org.promptly.sync.R
import org.promptly.sync.assistant.AssistantActivity
import java.text.NumberFormat
import kotlin.math.abs
import kotlin.math.roundToLong

/*
 * The at-a-glance widgets (Android 1.9.0). Each draws from the saved answer of
 * `/api/widgets/glance` ([HubStore]); a tap opens the page in the app it
 * belongs to. Talk and Quick add show nothing of yours and need no refresh.
 */

// ------------------------------------------------------------------ Talk

/** One big microphone: a tap opens the assistant sheet and Talk starts from
 *  there (a tap is the only thing that starts the microphone). */
class TalkWidget : HubWidget() {
    override val sizeMode = SizeMode.Single

    @Composable
    override fun Body(hub: HubState, prefs: Preferences, now: Long) {
        val ctx = LocalContext.current
        val open = openIntent(
            Intent(ctx, AssistantActivity::class.java).putExtra(AssistantActivity.EXTRA_FROM, "widget")
                .setData(android.net.Uri.parse("promptly-widget://talk")),
        )
        Box(
            GlanceModifier.fillMaxSize().widgetBackground(glassChosen()).cornerRadius(20.dp).clickable(open).semantics { contentDescription = "Talk to Promptly" },
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                RoundIcon(R.drawable.wg_mic, "Talk to Promptly", open, size = 56.dp, iconSize = 30.dp)
                if (LocalSize.current.height >= 100.dp) {
                    Spacer(GlanceModifier.height(6.dp))
                    Words("Talk", size = 13.sp, bold = true)
                }
            }
        }
    }
}

class TalkWidgetReceiver : HubReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TalkWidget()
}

// ------------------------------------------------------------------ Quick add

/** New note, new task, a photo (the phone's camera; backup brings it into
 *  Photos) and a voice note, one tap each. */
class QuickAddWidget : HubWidget() {
    override val sizeMode = SizeMode.Single

    @Composable
    override fun Body(hub: HubState, prefs: Preferences, now: Long) {
        val ctx = LocalContext.current
        Frame {
            Row(GlanceModifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically, horizontalAlignment = Alignment.CenterHorizontally) {
                QuickButton(GlanceModifier.defaultWeight(), R.drawable.wg_note, "Note", openIntent(quickNote(ctx, list = false)))
                QuickButton(GlanceModifier.defaultWeight(), R.drawable.wg_task, "Task", openIntent(quickTask(ctx, null)))
                QuickButton(GlanceModifier.defaultWeight(), R.drawable.wg_camera, "Photo", openIntent(Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA)))
                QuickButton(GlanceModifier.defaultWeight(), R.drawable.wg_mic, "Voice note", openIntent(voiceNote(ctx)))
            }
        }
    }

    @Composable
    private fun QuickButton(modifier: GlanceModifier, icon: Int, label: String, action: androidx.glance.action.Action) {
        Column(modifier.clickable(action), horizontalAlignment = Alignment.CenterHorizontally) {
            RoundIcon(icon, label, action, size = 44.dp, iconSize = 22.dp)
            Spacer(GlanceModifier.height(4.dp))
            Text(label, style = WText.style(11.sp).copy(textAlign = TextAlign.Center), maxLines = 1)
        }
    }
}

class QuickAddWidgetReceiver : HubReceiver() {
    override val glanceAppWidget: GlanceAppWidget = QuickAddWidget()
}

// ------------------------------------------------------------------ Today

/** The day at a glance: the weather, what's next and when to leave, tasks
 *  due, birthdays, and "Read me my day". */
class TodayWidget : HubWidget() {
    override val sizeMode = SizeMode.Exact

    @Composable
    override fun Body(hub: HubState, prefs: Preferences, now: Long) {
        val ctx = LocalContext.current
        val t = hub.section("today")
        val tall = LocalSize.current.height >= 170.dp
        Frame {
            Title(t?.text("greeting") ?: "Today", openPage(ctx, Open.PROMPTLY, "/today"))
            if (t == null) {
                Muted(if (hub.fetchedAt == 0L) "Getting your day…" else "Nothing from Today yet.")
            } else {
                Column(GlanceModifier.defaultWeight().fillMaxWidth().clickable(openPage(ctx, Open.PROMPTLY, "/today"))) {
                    t.text("weather")?.let { Words(it, size = 12.sp, color = WColors.muted, max = 2) }
                    val next = t.optJSONObject("next")
                    if (next != null) {
                        Spacer(GlanceModifier.height(4.dp))
                        Words("${next.text("time") ?: ""}  ${next.text("title") ?: "Event"}".trim(), bold = true)
                        next.text("leave_by")?.let { Words("Leave by $it" + (next.num("minutes")?.let { m -> " · ${m.toInt()} min drive" } ?: ""), size = 12.sp, color = WColors.accent) }
                    } else {
                        Words("Nothing else on today", size = 12.sp, color = WColors.muted)
                    }
                    val due = t.intOr("tasks_due")
                    val late = t.intOr("tasks_overdue")
                    if (due + late > 0) {
                        Spacer(GlanceModifier.height(4.dp))
                        Words(
                            listOfNotNull(
                                if (due > 0) "$due task${if (due == 1) "" else "s"} due" else null,
                                if (late > 0) "$late overdue" else null,
                            ).joinToString(" · "),
                            size = 12.sp,
                            color = if (late > 0) WColors.late else WColors.text,
                        )
                    }
                    val bdays = t.optJSONArray("birthdays").strings()
                    if (bdays.isNotEmpty() && tall) {
                        Words("🎂 " + bdays.joinToString(", ") + if (bdays.size == 1) "'s birthday" else "' birthdays", size = 12.sp)
                    }
                }
            }
            Row(GlanceModifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Pill("Read me my day", openIntent(Intent(ctx, ReadDayActivity::class.java)), R.drawable.wg_speaker)
                Spacer(GlanceModifier.defaultWeight())
            }
            HubFooter(hub, now)
        }
    }
}

class TodayWidgetReceiver : HubReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TodayWidget()
}

// ------------------------------------------------------------------ Meals & Macros

/** Calories and protein left today as two rings, and "Log food" into Ask. */
class MacrosWidget : HubWidget() {
    override val sizeMode = SizeMode.Exact

    @Composable
    override fun Body(hub: HubState, prefs: Preferences, now: Long) {
        val ctx = LocalContext.current
        val m = hub.section("macros")
        val url = m?.text("url") ?: "/apps"
        Frame {
            Title("Meals & Macros", openPage(ctx, Open.MEALS, url))
            if (m == null) {
                Column(GlanceModifier.defaultWeight()) {
                    Muted(if (hub.fetchedAt == 0L) "Getting today's numbers…" else "Set your targets in P Macros to see what's left today.")
                }
            } else {
                Row(GlanceModifier.defaultWeight().fillMaxWidth().clickable(openPage(ctx, Open.MEALS, url)), verticalAlignment = Alignment.CenterVertically) {
                    MacroRing(m.num("kcal") ?: 0.0, m.num("kcal_target"), "kcal", GlanceModifier.defaultWeight())
                    MacroRing(m.num("protein") ?: 0.0, m.num("protein_target"), "g protein", GlanceModifier.defaultWeight())
                }
            }
            Row(GlanceModifier.fillMaxWidth().padding(top = 6.dp)) {
                Pill("Log food", openPage(ctx, Open.MEALS, m?.text("ask_url") ?: url), R.drawable.wg_add)
            }
        }
    }

    @Composable
    private fun MacroRing(value: Double, target: Double?, unit: String, modifier: GlanceModifier) {
        val fmt = NumberFormat.getIntegerInstance()
        val left = target?.let { it - value }
        val words = when {
            target == null || target <= 0 -> "${fmt.format(value.roundToLong())} $unit"
            left!! >= 0 -> "${fmt.format(left.roundToLong())} $unit left"
            else -> "${fmt.format(abs(left).roundToLong())} $unit over"
        }
        Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
            Box(contentAlignment = Alignment.Center) {
                Image(ImageProvider(Draw.ring(if (target != null && target > 0) value / target else 0.0)), contentDescription = null, modifier = GlanceModifier.size(64.dp))
                Text(fmt.format(value.roundToLong()), style = WText.style(13.sp, bold = true), maxLines = 1)
            }
            Spacer(GlanceModifier.height(4.dp))
            Text(words, style = WText.style(11.sp, if (left != null && left < 0) WColors.late else WColors.muted).copy(textAlign = TextAlign.Center), maxLines = 2)
        }
    }
}

class MacrosWidgetReceiver : HubReceiver() {
    override val glanceAppWidget: GlanceAppWidget = MacrosWidget()
}

// ------------------------------------------------------------------ Rooms and Porch

/** Unread messages (who from, never what was said) and the newest Porch photo. */
class SocialWidget : HubWidget() {
    override val sizeMode = SizeMode.Exact

    @Composable
    override fun Body(hub: HubState, prefs: Preferences, now: Long) {
        val ctx = LocalContext.current
        val s = hub.section("social")
        val rooms = s?.optJSONObject("rooms")
        val porch = s?.optJSONObject("porch")
        val wide = LocalSize.current.width >= 250.dp
        Frame {
            Row(GlanceModifier.defaultWeight().fillMaxWidth()) {
                Column(GlanceModifier.defaultWeight().fillMaxHeight()) {
                    Title("Rooms", openPage(ctx, Open.ROOMS, "/rooms"))
                    val unread = rooms?.intOr("unread") ?: 0
                    if (rooms == null) Muted(if (hub.fetchedAt == 0L) "Getting your messages…" else "No messages yet.")
                    else if (unread == 0) Muted("You're all caught up")
                    else {
                        for (r in rooms.optJSONArray("items").objects().take(3)) {
                            Row(GlanceModifier.fillMaxWidth().padding(vertical = 2.dp).clickable(openPage(ctx, Open.ROOMS, r.text("url") ?: "/rooms")), verticalAlignment = Alignment.CenterVertically) {
                                Words(r.text("name") ?: "Message", bold = true, modifier = GlanceModifier.defaultWeight())
                                Badge(r.intOr("unread"))
                            }
                        }
                    }
                }
                if (wide || (porch?.intOr("new") ?: 0) > 0) {
                    Spacer(GlanceModifier.width(10.dp))
                    Column(GlanceModifier.defaultWeight().fillMaxHeight().clickable(openPage(ctx, Open.PORCH, porch?.text("url") ?: "/porch"))) {
                        Title("Porch", openPage(ctx, Open.PORCH, "/porch"))
                        val n = porch?.intOr("new") ?: 0
                        val pic = hub.porch
                        if (pic != null && n > 0) {
                            Image(
                                ImageProvider(pic), contentDescription = "Newest Porch post",
                                modifier = GlanceModifier.fillMaxWidth().defaultWeight().cornerRadius(12.dp), contentScale = ContentScale.Crop,
                            )
                        }
                        Words(
                            if (n == 0) "Nothing new" else "$n new" + (porch?.optJSONArray("from").strings().firstOrNull()?.let { " from $it" } ?: ""),
                            size = 12.sp, color = if (n == 0) WColors.muted else WColors.text,
                        )
                    }
                }
            }
            HubFooter(hub, now)
        }
    }
}

@Composable
fun Badge(n: Int) {
    if (n <= 0) return
    Box(GlanceModifier.background(WColors.fill).cornerRadius(10.dp).padding(horizontal = 6.dp, vertical = 1.dp), contentAlignment = Alignment.Center) {
        Text(if (n > 99) "99+" else n.toString(), style = WText.style(11.sp, WColors.onFill, bold = true), maxLines = 1)
    }
}

class SocialWidgetReceiver : HubReceiver() {
    override val glanceAppWidget: GlanceAppWidget = SocialWidget()
}

// ------------------------------------------------------------------ P Maps

/** Home and Work in today's traffic, and when to leave for the next event. */
class MapsWidget : HubWidget() {
    override val sizeMode = SizeMode.Exact

    @Composable
    override fun Body(hub: HubState, prefs: Preferences, now: Long) {
        val ctx = LocalContext.current
        val m = hub.section("maps")
        Frame {
            Title("P Maps", openPage(ctx, Open.MAPS, "/maps"))
            Column(GlanceModifier.defaultWeight().fillMaxWidth()) {
                val places = m?.optJSONArray("places").objects()
                if (m == null) Muted(if (hub.fetchedAt == 0L) "Getting drive times…" else "Nothing from P Maps yet.")
                else if (places.isEmpty()) Muted("Save Home and Work in P Maps to see how long the drive is.")
                for (p in places) {
                    Row(
                        GlanceModifier.fillMaxWidth().padding(vertical = 3.dp).clickable(openPage(ctx, Open.MAPS, p.text("url") ?: "/maps"))
                            .semantics { contentDescription = "Drive to ${p.text("name")}" },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Image(ImageProvider(R.drawable.wg_car), contentDescription = null, modifier = GlanceModifier.size(18.dp), colorFilter = androidx.glance.ColorFilter.tint(WColors.accent))
                        Spacer(GlanceModifier.width(8.dp))
                        Words(p.text("name") ?: "", bold = true, modifier = GlanceModifier.defaultWeight())
                        val mins = p.num("minutes")
                        Words(
                            when {
                                p.optBoolean("here") -> "You're here"
                                mins != null -> minutesLabel(mins.toLong()) + if (p.optBoolean("traffic")) " in traffic" else ""
                                else -> "—"
                            },
                            size = 13.sp, color = WColors.muted,
                        )
                    }
                }
                m?.optJSONObject("next")?.let { n ->
                    Spacer(GlanceModifier.height(4.dp))
                    Column(GlanceModifier.fillMaxWidth().clickable(openPage(ctx, Open.MAPS, n.text("url") ?: "/maps"))) {
                        Words(n.text("title") ?: "Next event", size = 12.sp, bold = true)
                        Words(
                            "Leave by ${n.text("leave_by_label") ?: "—"}" + (n.num("minutes")?.let { " · ${minutesLabel(it.toLong())}" } ?: ""),
                            size = 12.sp, color = if (n.optBoolean("soon")) WColors.late else WColors.accent,
                        )
                    }
                }
            }
            HubFooter(hub, now)
        }
    }
}

class MapsWidgetReceiver : HubReceiver() {
    override val glanceAppWidget: GlanceAppWidget = MapsWidget()
}

// ------------------------------------------------------------------ Who's on their way

/** People sharing a trip with you, and how long until they get there
 *  (worked out on the phone from their arrival time, so it counts down). */
class OnTheWayWidget : HubWidget() {
    override val sizeMode = SizeMode.Exact

    @Composable
    override fun Body(hub: HubState, prefs: Preferences, now: Long) {
        val ctx = LocalContext.current
        val trips = hub.list("trips")
        val clock = clockOf(ctx)
        Frame {
            Title("On their way", openPage(ctx, Open.MAPS, "/maps"))
            Column(GlanceModifier.defaultWeight().fillMaxWidth()) {
                if (trips.isEmpty()) Muted("Nobody's on their way right now. When someone shares a trip with you, it shows here.")
                for (t in trips.take(3)) {
                    val name = t.text("name") ?: "Someone"
                    val left = minutesUntil(t.text("eta"), now)
                    Row(GlanceModifier.fillMaxWidth().padding(vertical = 3.dp).clickable(openPage(ctx, Open.MAPS, "/maps")), verticalAlignment = Alignment.CenterVertically) {
                        PersonCircle(t.text("user_id") ?: name, name, 32)
                        Spacer(GlanceModifier.width(8.dp))
                        Column(GlanceModifier.defaultWeight()) {
                            Words(name + (t.text("destination")?.let { " → $it" } ?: ""), bold = true)
                            Words(
                                when {
                                    left == null -> "On the way"
                                    left <= 1 -> "Arriving now"
                                    else -> "${minutesLabel(left)} away · arrives ${runCatching { clock.time(java.time.OffsetDateTime.parse(t.text("eta")).toInstant().toEpochMilli()) }.getOrDefault("")}"
                                },
                                size = 12.sp, color = WColors.accent,
                            )
                        }
                    }
                }
            }
            HubFooter(hub, now)
        }
    }
}

class OnTheWayWidgetReceiver : HubReceiver() {
    override val glanceAppWidget: GlanceAppWidget = OnTheWayWidget()
}

/** A person as a coloured circle with their initials. */
@Composable
fun PersonCircle(id: String, name: String, sizeDp: Int) {
    val c = WColors.fixed(String.format("#%06X", personColor(id) and 0xFFFFFF))
    Box(GlanceModifier.size(sizeDp.dp).background(c).cornerRadius((sizeDp / 2).dp), contentAlignment = Alignment.Center) {
        Text(initials(name), style = WText.style((sizeDp * 0.38).sp, WColors.onColor, bold = true), maxLines = 1)
    }
}

// ------------------------------------------------------------------ Health

/** Your weight trend with "Log weight", and the next workout. */
class HealthWidget : HubWidget() {
    override val sizeMode = SizeMode.Exact

    @Composable
    override fun Body(hub: HubState, prefs: Preferences, now: Long) {
        val ctx = LocalContext.current
        val h = hub.section("health")
        val url = h?.text("url")
        Frame {
            Title("Health", openPage(ctx, Open.HEALTH, url ?: "/apps"))
            Column(GlanceModifier.defaultWeight().fillMaxWidth()) {
                if (h == null) Muted(if (hub.fetchedAt == 0L) "Getting your numbers…" else "Log your weight in P Health to see the trend here.")
                else {
                    h.text("weight")?.let { w ->
                        Row(verticalAlignment = Alignment.Bottom) {
                            Words(w, size = 20.sp, bold = true)
                            h.text("change")?.let { Spacer(GlanceModifier.width(8.dp)); Words(it, size = 12.sp, color = WColors.muted) }
                        }
                    }
                    val series = h.optJSONArray("series")?.let { a -> (0 until a.length()).map { if (a.isNull(it)) null else a.optDouble(it) } }.orEmpty()
                    Draw.trend(series)?.let { bmp ->
                        Image(ImageProvider(bmp), contentDescription = "Weight over the last weeks", modifier = GlanceModifier.fillMaxWidth().height(44.dp), contentScale = ContentScale.FillBounds)
                    }
                    h.optJSONObject("workout")?.let { w ->
                        Spacer(GlanceModifier.height(4.dp))
                        Words(
                            "Next: ${w.text("name") ?: "Workout"}" + listOfNotNull(dayWord(w.text("date"), now), w.text("time")).joinToString(" ", prefix = " · "),
                            size = 12.sp, color = WColors.accent,
                            modifier = GlanceModifier.clickable(openPage(ctx, Open.WORKOUT, w.text("url") ?: "/apps")),
                        )
                    }
                }
            }
            Row(GlanceModifier.fillMaxWidth().padding(top = 6.dp)) {
                Pill("Log weight", openPage(ctx, Open.HEALTH, url ?: "/apps"), R.drawable.wg_add)
            }
        }
    }

    private fun dayWord(date: String?, now: Long): String? {
        val d = runCatching { java.time.LocalDate.parse(date) }.getOrNull() ?: return null
        val today = java.time.Instant.ofEpochMilli(now).atZone(java.time.ZoneId.systemDefault()).toLocalDate()
        return when (java.time.temporal.ChronoUnit.DAYS.between(today, d)) {
            0L -> "today"
            1L -> "tomorrow"
            else -> d.dayOfWeek.getDisplayName(java.time.format.TextStyle.SHORT, java.util.Locale.getDefault())
        }
    }
}

class HealthWidgetReceiver : HubReceiver() {
    override val glanceAppWidget: GlanceAppWidget = HealthWidget()
}

// ------------------------------------------------------------------ Mail

/** How many unread, and who the latest are from. */
class MailWidget : HubWidget() {
    override val sizeMode = SizeMode.Exact

    @Composable
    override fun Body(hub: HubState, prefs: Preferences, now: Long) {
        val ctx = LocalContext.current
        val m = hub.section("mail")
        Frame {
            Title("Mail", openPage(ctx, Open.MAIL, "/mail")) {
                if (m != null) Badge(m.intOr("unread"))
            }
            Column(GlanceModifier.defaultWeight().fillMaxWidth()) {
                when {
                    m == null -> Muted(if (hub.fetchedAt == 0L) "Getting your mail…" else "Add a mailbox in P Mail to see it here.")
                    m.intOr("unread") == 0 -> Muted("No unread mail")
                    else -> for (it in m.optJSONArray("items").objects().take(if (LocalSize.current.height >= 170.dp) 4 else 2)) {
                        Column(GlanceModifier.fillMaxWidth().padding(vertical = 2.dp).clickable(openPage(ctx, Open.MAIL, it.text("url") ?: "/mail"))) {
                            Words(it.text("from") ?: "Someone", bold = true)
                            Words(it.text("subject") ?: "", size = 12.sp, color = WColors.muted)
                        }
                    }
                }
            }
            HubFooter(hub, now)
        }
    }
}

class MailWidgetReceiver : HubReceiver() {
    override val glanceAppWidget: GlanceAppWidget = MailWidget()
}
