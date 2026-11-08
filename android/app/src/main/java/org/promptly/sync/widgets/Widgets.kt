package org.promptly.sync.widgets

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.state.getAppWidgetState
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.appwidget.updateAll
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.promptly.sync.Store
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime

/** Is this phone linked to Promptly, as the widgets see it. */
enum class Link { LINKED, NOT_LINKED, REMOVED, OFF }

/** The widgets this app has, and what each needs from the snapshot. */
object Widgets {
    class Kind(val receiver: Class<out GlanceAppWidgetReceiver>, val widget: () -> GlanceAppWidget, val needs: List<String>)

    val ALL: List<Kind> = listOf(
        Kind(AgendaWidgetReceiver::class.java, { AgendaWidget() }, listOf("calendar")),
        Kind(TasksWidgetReceiver::class.java, { TasksWidget() }, listOf("tasks")),
        // Notes (W1.3).
        Kind(NotesWidgetReceiver::class.java, { NotesWidget() }, listOf("notes")),
        Kind(OneNoteWidgetReceiver::class.java, { OneNoteWidget() }, listOf("notes")),
    )

    /** For work that outlives a widget action (the redraw after a tick's moment). */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private fun ids(ctx: Context, k: Kind): IntArray =
        runCatching { AppWidgetManager.getInstance(ctx).getAppWidgetIds(ComponentName(ctx, k.receiver)) }.getOrNull() ?: IntArray(0)

    fun placed(ctx: Context): Boolean = ALL.any { ids(ctx, it).isNotEmpty() }

    /** The snapshot sections the widgets on the home screen need. */
    fun wanted(ctx: Context): List<String> = ALL.filter { ids(ctx, it).isNotEmpty() }.flatMap { it.needs }.distinct()

    /** The notes the One note widgets show (the snapshot sends them whole). */
    suspend fun noteIds(ctx: Context): List<String> = runCatching {
        val mgr = GlanceAppWidgetManager(ctx)
        mgr.getGlanceIds(OneNoteWidget::class.java).mapNotNull { id ->
            getAppWidgetState(ctx, PreferencesGlanceStateDefinition, id)[OneNoteWidget.NOTE_ID]?.takeIf { it.isNotBlank() }
        }.distinct()
    }.getOrDefault(emptyList())

    /**
     * The widget picker's previews, drawn from sample notes and events (never
     * your own): Android 15+ shows them instead of a plain icon. Set once per
     * app version — Android rate-limits it, so a refused try is made again at
     * the next start.
     */
    fun publishPreviews(ctx: Context) {
        if (android.os.Build.VERSION.SDK_INT < 35) return
        val app = ctx.applicationContext
        val prefs = app.getSharedPreferences("widgets", Context.MODE_PRIVATE)
        val version = org.promptly.sync.BuildConfig.VERSION_CODE
        if (prefs.getInt("previews_for", 0) == version) return
        scope.launch {
            val mgr = GlanceAppWidgetManager(app)
            val ok = ALL.all { k ->
                runCatching { mgr.setWidgetPreviews(k.receiver.kotlin) == GlanceAppWidgetManager.SET_WIDGET_PREVIEWS_RESULT_SUCCESS }.getOrDefault(false)
            }
            if (ok) prefs.edit().putInt("previews_for", version).apply()
        }
    }

    fun link(ctx: Context): Link {
        val store = Store(ctx)
        return when {
            !store.hasAccount -> Link.NOT_LINKED
            store.unlinked -> Link.REMOVED
            WidgetsOff.get(ctx) -> Link.OFF
            else -> Link.LINKED
        }
    }

    /** Draw every widget again from the saved copy (no network). */
    suspend fun redraw(ctx: Context) {
        WidgetStore.bump()
        for (k in ALL) if (ids(ctx, k).isNotEmpty()) runCatching { k.widget().updateAll(ctx) }
        Boundaries.schedule(ctx)
    }

    /** Redraw [ms] from now (a ticked task's moment of being struck through). */
    fun redrawLater(ctx: Context, ms: Long) {
        val app = ctx.applicationContext
        scope.launch {
            delay(ms)
            redraw(app)
        }
    }

    /** The phone was just linked again (MainActivity): start fresh. */
    fun linked(ctx: Context) {
        val app = ctx.applicationContext
        WidgetsOff.set(app, false)
        scope.launch {
            WidgetStore.wipe(app)
            redraw(app)
        }
        if (placed(app)) {
            WidgetSync.periodic(app)
            WidgetSync.now(app)
        }
    }

    /** The phone was unlinked by hand: nothing of the account stays in the widgets. */
    fun unlinked(ctx: Context) {
        val app = ctx.applicationContext
        scope.launch {
            WidgetStore.wipe(app)
            redraw(app)
        }
    }

    /** First widget added / last one removed. */
    fun onEnabled(ctx: Context) {
        WidgetSync.periodic(ctx)
        WidgetSync.now(ctx)
    }

    fun onDisabled(ctx: Context) {
        if (!placed(ctx)) {
            WidgetSync.cancel(ctx)
            Boundaries.cancel(ctx)
        }
    }

    /** After an app update: keep the schedule if there are widgets (WorkManager
     *  keeps it anyway; this covers a cleared app). */
    fun upgrade(ctx: Context) {
        publishPreviews(ctx)
        if (placed(ctx)) {
            WidgetSync.periodic(ctx)
            val app = ctx.applicationContext
            scope.launch {
                WidgetStore.load(app) // the next redraw moment comes from the saved copy
                Boundaries.schedule(app)
            }
        }
    }
}

/**
 * Redraws with no network at the moments a widget's content changes on its
 * own: an event starting or ending, a timed task becoming overdue, and local
 * midnight (today becomes tomorrow). An inexact, non-waking alarm: it's
 * delivered when the phone is next awake, which is when anyone can see it.
 */
object Boundaries {
    private const val MIN_GAP = 60_000L
    private const val WINDOW = 10 * 60_000L

    /** The next moment after [now] worth a redraw. */
    fun next(snap: Snapshot, now: Long, zone: ZoneId): Long {
        val midnight = LocalDate.ofInstant(Instant.ofEpochMilli(now), zone).plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        var best = midnight
        snap.calendar?.events?.forEach { e ->
            if (e.allDay) return@forEach
            for (s in listOf(e.start, e.end)) {
                val t = Agenda.instant(s) ?: continue
                if (t > now + 1000 && t < best) best = t
            }
        }
        val today = LocalDate.ofInstant(Instant.ofEpochMilli(now), zone).toString()
        snap.tasks?.tasks?.forEach { t ->
            if (t.due != today || t.time == null) return@forEach
            val at = runCatching { ZonedDateTime.of(LocalDate.parse(today), java.time.LocalTime.parse(t.time), zone).toInstant().toEpochMilli() }.getOrNull() ?: return@forEach
            if (at > now + 1000 && at < best) best = at
        }
        return maxOf(best, now + MIN_GAP)
    }

    private fun intent(ctx: Context): PendingIntent = PendingIntent.getBroadcast(
        ctx, 7301,
        Intent(ctx, WidgetEvents::class.java).setAction(WidgetEvents.ACTION_TICK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    fun schedule(ctx: Context) {
        if (!Widgets.placed(ctx)) return
        val at = next(WidgetStore.state.value.snapshot, System.currentTimeMillis(), ZoneId.systemDefault())
        // A plain set() may be put off by 20 minutes or more; a 10-minute window (the
        // shortest Android allows without the exact-alarm permission) keeps it close.
        ctx.getSystemService(AlarmManager::class.java)?.setWindow(AlarmManager.RTC, at, WINDOW, intent(ctx))
    }

    fun cancel(ctx: Context) {
        ctx.getSystemService(AlarmManager::class.java)?.cancel(intent(ctx))
    }
}

/**
 * Boot, the clock or time zone changing, our own boundary alarm, and a
 * Promptly app being opened (SuiteLauncher sends [ACTION_LAUNCHED]).
 */
class WidgetEvents : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val ctx = context.applicationContext
        if (!Widgets.placed(ctx)) return
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED -> {
                WidgetSync.periodic(ctx)
                WidgetSync.now(ctx)
            }
            ACTION_LAUNCHED -> WidgetSync.soon(ctx)
        }
        val pending = goAsync()
        Widgets.scope.launch {
            try {
                WidgetStore.load(ctx)
                Widgets.redraw(ctx)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_TICK = "org.promptly.sync.widgets.TICK"
        const val ACTION_LAUNCHED = "org.promptly.app.action.LAUNCHED"
    }
}
