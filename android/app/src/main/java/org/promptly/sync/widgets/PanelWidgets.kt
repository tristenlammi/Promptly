package org.promptly.sync.widgets

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.itemsIndexed
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

// ------------------------------------------------------------------ the app panel

/** One of Promptly's apps as the panel shows it. [path]: the page its own icon opens. */
data class PanelApp(val key: String, val label: String, val launcher: String, val path: String, val icon: Int)

object PanelApps {
    /** What a new panel shows: the everyday apps, in this order. */
    val DEFAULT = listOf("rooms", "calendar", "tasks", "notes", "photos", "maps", "porch", "mail")

    /** Never offered for hiding (its icon is the vault's way in, and Promptly is always there). */
    val KEEP_ICON = setOf("promptly", "passwords")

    private var cache: List<PanelApp>? = null

    /** Promptly, then every app the icon picker knows (android/gen_suite.py). */
    fun all(ctx: Context): List<PanelApp> {
        cache?.let { return it }
        val rows = listOf(arrayOf("promptly", "Promptly", Open.PROMPTLY)) + org.promptly.app.Apps.ALL.map { arrayOf(it[0], it[1], it[2]) }
        val out = rows.map { (key, label, launcher) ->
            PanelApp(key, label.removePrefix("P ").trim(), launcher, pathOf(ctx, launcher), iconOf(ctx, key))
        }
        cache = out
        return out
    }

    fun byKey(ctx: Context): Map<String, PanelApp> = all(ctx).associateBy { it.key }

    private fun pathOf(ctx: Context, launcher: String): String = runCatching {
        @Suppress("WrongConstant")
        val info = ctx.packageManager.getActivityInfo(ComponentName(ctx.packageName, launcher), PackageManager.GET_META_DATA or PackageManager.MATCH_DISABLED_COMPONENTS)
        info.metaData?.getString("org.promptly.app.PATH")
    }.getOrNull() ?: "/"

    /** The icon's white mark (its tile colour is the brand terracotta, drawn by the widget). */
    private fun iconOf(ctx: Context, key: String): Int {
        val res = ctx.resources
        val id = res.getIdentifier("fg_$key", "drawable", ctx.packageName)
        return if (id != 0) id else res.getIdentifier("fg_promptly", "drawable", ctx.packageName)
    }

    fun keys(prefs: Preferences): List<String> =
        prefs[AppsWidget.APPS]?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() } ?: DEFAULT

    /** Whether an app's own icon is on the home screen (the icon picker's switch). */
    fun iconOn(ctx: Context, launcher: String): Boolean {
        val pm = ctx.packageManager
        val name = ComponentName(ctx.packageName, launcher)
        return when (pm.getComponentEnabledSetting(name)) {
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
            PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> runCatching {
                @Suppress("WrongConstant")
                pm.getActivityInfo(name, PackageManager.MATCH_DISABLED_COMPONENTS).enabled
            }.getOrDefault(false)
            else -> false
        }
    }

    /** Take these apps' own icons off the home screen, the same switch "Choose apps" uses. */
    fun hideIcons(ctx: Context, apps: List<PanelApp>) {
        val pm = ctx.packageManager
        for (a in apps) {
            if (a.key in KEEP_ICON) continue
            runCatching {
                pm.setComponentEnabledSetting(ComponentName(ctx.packageName, a.launcher), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
            }
        }
    }
}

/** A grid of Promptly's apps you choose, each with its count (unread, due). */
class AppsWidget : HubWidget() {
    override val sizeMode = SizeMode.Exact

    @Composable
    override fun Body(hub: HubState, prefs: Preferences, now: Long) {
        val ctx = LocalContext.current
        val known = PanelApps.byKey(ctx)
        val apps = PanelApps.keys(prefs).mapNotNull { known[it] }
        val counts = hub.section("counts")
        val size = LocalSize.current
        val cols = ((size.width.value - 16) / 72).toInt().coerceIn(2, 6)
        val edit = openIntent(
            Intent(ctx, AppsConfigActivity::class.java)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetIdOf(ctx))
                .setData(Uri.parse("promptly-widget://apps-config")),
        )
        Frame {
            Title("Promptly", openPage(ctx, Open.PROMPTLY, "/")) { EditButton(edit) }
            if (apps.isEmpty()) {
                Muted("Tap the pencil to choose apps.")
            } else {
                // More apps than fit: the rows scroll (most launchers allow it).
                val rows = apps.chunked(cols)
                LazyColumn(GlanceModifier.defaultWeight().fillMaxWidth()) {
                    itemsIndexed(rows, itemId = { i, _ -> i.toLong() }) { _, row ->
                        Row(GlanceModifier.fillMaxWidth().padding(bottom = 6.dp)) {
                            for (a in row) AppCell(a, counts?.intOr(a.key) ?: 0, GlanceModifier.defaultWeight())
                            repeat(cols - row.size) { Spacer(GlanceModifier.defaultWeight()) }
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun AppCell(a: PanelApp, count: Int, modifier: GlanceModifier) {
        val ctx = LocalContext.current
        val go = openPage(ctx, a.launcher, a.path)
        Column(
            modifier.clickable(go).semantics { contentDescription = a.label + if (count > 0) ", $count new" else "" },
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(GlanceModifier.size(52.dp), contentAlignment = Alignment.TopEnd) {
                Box(GlanceModifier.fillMaxSize().padding(4.dp), contentAlignment = Alignment.Center) {
                    Box(GlanceModifier.fillMaxSize().background(WColors.fill).cornerRadius(14.dp), contentAlignment = Alignment.Center) {
                        Image(ImageProvider(a.icon), contentDescription = null, modifier = GlanceModifier.size(40.dp))
                    }
                }
                Badge(count)
            }
            Spacer(GlanceModifier.height(2.dp))
            Text(a.label, style = WText.style(11.sp).copy(textAlign = TextAlign.Center), maxLines = 1)
        }
    }

    companion object {
        val APPS = stringPreferencesKey("panel_apps")
    }
}

/** The widget's own id, for its pencil (Glance knows it as a GlanceId only). */
@Composable
private fun appWidgetIdOf(ctx: Context): Int {
    val id = androidx.glance.LocalGlanceId.current
    return runCatching { androidx.glance.appwidget.GlanceAppWidgetManager(ctx).getAppWidgetId(id) }.getOrDefault(AppWidgetManager.INVALID_APPWIDGET_ID)
}

class AppsWidgetReceiver : HubReceiver() {
    override val glanceAppWidget: GlanceAppWidget = AppsWidget()
}

// ------------------------------------------------------------------ favourite people

/** The people you chose, as big circles: a tap opens them in Promptly, where
 *  Message and Call are one more tap. */
class PeopleWidget : HubWidget() {
    override val sizeMode = SizeMode.Exact

    @Composable
    override fun Body(hub: HubState, prefs: Preferences, now: Long) {
        val ctx = LocalContext.current
        val people = peopleOf(prefs)
        val size = LocalSize.current
        val cols = ((size.width.value - 16) / 76).toInt().coerceIn(2, 5)
        val edit = openIntent(
            Intent(ctx, PeopleConfigActivity::class.java)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetIdOf(ctx))
                .setData(Uri.parse("promptly-widget://people-config")),
        )
        Frame {
            Title("Favourite people", null) { EditButton(edit) }
            if (people.isEmpty()) {
                Column(GlanceModifier.defaultWeight().fillMaxWidth().clickable(edit)) { Muted("Tap the pencil to choose who's here.") }
            } else {
                Column(GlanceModifier.defaultWeight().fillMaxWidth()) {
                    for (row in people.chunked(cols)) {
                        Row(GlanceModifier.fillMaxWidth().padding(bottom = 8.dp)) {
                            for (p in row) {
                                val id = p.optString("user_id")
                                val name = p.optString("name")
                                Column(
                                    GlanceModifier.defaultWeight().clickable(openPage(ctx, Open.PROMPTLY, "/people/u/$id")).semantics { contentDescription = "$name: message or call" },
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                ) {
                                    PersonCircle(id, name, 52)
                                    Spacer(GlanceModifier.height(3.dp))
                                    Text(name.substringBefore(' '), style = WText.style(12.sp).copy(textAlign = TextAlign.Center), maxLines = 1)
                                }
                            }
                            repeat(cols - row.size) { Spacer(GlanceModifier.defaultWeight()) }
                        }
                    }
                }
            }
        }
    }

    companion object {
        val PEOPLE = stringPreferencesKey("people")
        const val MAX = 8

        /** Only ids that look like ids: they go into a page address. */
        fun peopleOf(prefs: Preferences): List<JSONObject> = runCatching { JSONArray(prefs[PEOPLE] ?: "[]").objects() }.getOrDefault(emptyList())
            .filter { it.optString("user_id").matches(Regex("[0-9a-fA-F-]{36}")) }
            .take(MAX)
    }
}

class PeopleWidgetReceiver : HubReceiver() {
    override val glanceAppWidget: GlanceAppWidget = PeopleWidget()
}

// ------------------------------------------------------------------ countdown

/** Days until a day you choose (a holiday, a birthday every year). Kept on the
 *  phone only; nothing from the server. */
class CountdownWidget : HubWidget() {
    override val sizeMode = SizeMode.Exact
    override val needsAccount = false

    @Composable
    override fun Body(hub: HubState, prefs: Preferences, now: Long) {
        val ctx = LocalContext.current
        val cfg = configOf(prefs)
        val edit = openIntent(
            Intent(ctx, CountdownConfigActivity::class.java)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetIdOf(ctx))
                .setData(Uri.parse("promptly-widget://countdown-config")),
        )
        Frame {
            Box(GlanceModifier.fillMaxSize().clickable(edit), contentAlignment = Alignment.Center) {
                if (cfg == null) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Words("Countdown", bold = true, color = WColors.accent)
                        Muted("Tap to choose a day")
                    }
                } else {
                    val today = Instant.ofEpochMilli(now).atZone(ZoneId.systemDefault()).toLocalDate()
                    val n = daysUntil(cfg, today)
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            if (n == 0L) "Today!" else kotlin.math.abs(n).toString(),
                            style = WText.style(if (n == 0L) 26.sp else 38.sp, WColors.accent, bold = true).copy(textAlign = TextAlign.Center),
                            maxLines = 1,
                        )
                        Text(
                            when {
                                n == 0L -> cfg.title
                                n == 1L -> "day until ${cfg.title}"
                                n < 0 -> "days since ${cfg.title}"
                                else -> "days until ${cfg.title}"
                            },
                            style = WText.style(13.sp).copy(textAlign = TextAlign.Center),
                            maxLines = 2,
                        )
                    }
                }
            }
        }
    }

    data class Config(val title: String, val date: LocalDate, val yearly: Boolean)

    companion object {
        val TITLE = stringPreferencesKey("cd_title")
        val DATE = stringPreferencesKey("cd_date")
        val YEARLY = booleanPreferencesKey("cd_yearly")

        fun configOf(p: Preferences): Config? {
            val d = runCatching { LocalDate.parse(p[DATE]) }.getOrNull() ?: return null
            return Config(p[TITLE]?.ifBlank { null } ?: "the day", d, p[YEARLY] ?: false)
        }

        /** Days from [today] to the day; a yearly one counts to its next time round. */
        fun daysUntil(c: Config, today: LocalDate): Long {
            if (!c.yearly) return ChronoUnit.DAYS.between(today, c.date)
            var next = runCatching { c.date.withYear(today.year) }.getOrElse { LocalDate.of(today.year, 2, 28) }
            if (next.isBefore(today)) next = runCatching { c.date.withYear(today.year + 1) }.getOrElse { LocalDate.of(today.year + 1, 2, 28) }
            return ChronoUnit.DAYS.between(today, next)
        }
    }
}

class CountdownWidgetReceiver : HubReceiver() {
    override val glanceAppWidget: GlanceAppWidget = CountdownWidget()
}
