package org.promptly.sync.widgets

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.CheckBox
import androidx.glance.appwidget.CheckboxDefaults
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.provideContent
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.state.GlanceStateDefinition
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.Text
import org.promptly.sync.R
import org.promptly.sync.capture.QuickTaskActivity

/**
 * Tasks: today's and overdue tasks from your Tasks app. "Today · 3" with
 * **+** (Quick task); overdue in red; a tick works with no signal — struck
 * through for a moment (tap again to undo), then gone, and sent when there's
 * signal. Tap a task → it opens in P Tasks.
 */
class TasksWidget : GlanceAppWidget() {
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
            else TasksContent(state, configOf(prefs), System.currentTimeMillis(), clockOf(ctx), LocalSize.current.width < WIDE.width, LocalSize.current)
        }
    }

    /** The widget picker's preview (Android 15+): made-up events and tasks. */
    override suspend fun providePreview(context: Context, widgetCategory: Int) {
        provideContent { TasksContent(Samples.calendarAndTasks(), TasksConfig(), Samples.now(), clockOf(context), small = false, size = TALL) }
    }

    companion object {
        val SMALL = DpSize(110.dp, 110.dp)
        val WIDE = DpSize(250.dp, 110.dp)
        val TALL = DpSize(250.dp, 250.dp)

        val LIST = stringPreferencesKey("list_id")
        val SOMEDAY = booleanPreferencesKey("someday")

        fun configOf(p: Preferences) = TasksConfig(p[LIST]?.takeIf { it.isNotBlank() }, p[SOMEDAY] ?: false)
    }
}

class TasksWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TasksWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        Widgets.onEnabled(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        Widgets.onDisabled(context)
    }
}

/** The link that opens one task in P Tasks (or the app, for one not on the server yet). */
fun taskPath(fileId: String?, taskId: String): String =
    if (fileId == null || taskId.startsWith("local:")) "/app/open/tasks" else "/apps/tasks/$fileId?task=$taskId"

@Composable
fun TasksContent(state: WidgetState, cfg: TasksConfig, now: Long, clock: Clock, small: Boolean, size: DpSize = TasksWidget.TALL) {
    val ctx = LocalContext.current
    val view = Tasks.view(state, cfg, now, clock)
    val sec = state.snapshot.tasks
    val count = view.rows.count { !it.struck }
    val stale = staleLabel(state.snapshot.fetchedAt, now, clock)
    val notice = state.notices.lastOrNull { it.area == "tasks" }
    val list = actionStartActivity(Open.page(ctx, Open.TASKS, sec?.fileId?.let { "/apps/tasks/$it" } ?: "/app/open/tasks"))
    Frame {
        Row(GlanceModifier.fillMaxWidth().padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(
                GlanceModifier.defaultWeight().clickable(actionStartActivity(Open.page(ctx, Open.TASKS, sec?.fileId?.let { "/apps/tasks/$it" } ?: "/app/open/tasks")))
                    .semantics { contentDescription = "Open P Tasks" },
            ) {
                Text(
                    (view.listName ?: "Today") + if (count > 0) " · $count" else "",
                    style = WText.style(15.sp, WColors.accent, bold = true),
                    maxLines = 1,
                )
                if (!small && view.overdue > 0) Text("${view.overdue} overdue", style = WText.style(12.sp, WColors.late), maxLines = 1)
                else if (!small && view.listName != null) Muted("Today and overdue", size = 12.sp)
            }
            AddButton("Quick task", actionStartActivity(quickTask(ctx, cfg.listId)))
        }
        when {
            sec == null && state.snapshot.fetchedAt == 0L && state.ops.isEmpty() -> Muted("Getting your tasks…")
            view.rows.isEmpty() -> Column(GlanceModifier.defaultWeight().fillMaxWidth()) {
                Text(if (state.snapshot.tasks?.tasks.isNullOrEmpty()) "Nothing to do" else "All done for today", style = WText.style(13.sp, bold = true), maxLines = 1)
                Muted("Tap + to add a task.", size = 12.sp)
            }
            // What fits, whole, then "3 more" (no scrolling: see Fit). Ticking
            // off the rows shown works as before.
            else -> {
                val scale = ctx.resources.configuration.fontScale
                val sub = !small && (view.overdue > 0 || view.listName != null)
                val head = maxOf(32f, Fit.line(15f, scale) + if (sub) Fit.line(12f, scale) else 0f) + 6f
                val room = size.height.value - Fit.FRAME - Fit.SPARE - head - Fit.footer(notice != null, stale != null, scale)
                val width = size.width.value - 24f - 32f
                val n = Fit.count(view.rows.map { taskLineHeight(it, small, width, scale) }, room, Fit.more(scale))
                Column(GlanceModifier.defaultWeight().fillMaxWidth()) {
                    for (row in view.rows.take(n)) TaskLine(row, small)
                    val left = view.rows.size - n
                    if (left > 0) MoreLine("$left more", list)
                }
            }
        }
        Footer(notice, stale)
    }
}

fun quickTask(ctx: Context, listId: String?): Intent =
    Intent(ctx, QuickTaskActivity::class.java)
        .putExtra(QuickTaskActivity.EXTRA_LIST, listId)
        .setData(android.net.Uri.parse("promptly-widget://quick-task/${listId ?: ""}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

/** How tall one task is drawn (dp, rounded up): see [TaskLine]. [width] is the
 *  room for its words, beside the check box. */
internal fun taskLineHeight(row: TaskRow, small: Boolean, width: Float, scale: Float = 1f): Float {
    val title = Fit.lines(row.title, 13f, width, if (small) 1 else 2, scale) * Fit.line(13f, scale)
    val bits = !row.struck && (row.label.isNotBlank() || (row.listId != "inbox" && !small))
    return maxOf(Fit.CHECK, title + if (bits) Fit.line(11f, scale) else 0f) + 2f
}

@Composable
private fun TaskLine(row: TaskRow, small: Boolean) {
    val ctx = LocalContext.current
    Row(GlanceModifier.fillMaxWidth().padding(vertical = 1.dp), verticalAlignment = Alignment.CenterVertically) {
        if (row.pending) {
            // Not on the server yet: nothing to tick until it is.
            // The width of a checkbox, so titles line up.
            Box(GlanceModifier.width(32.dp), contentAlignment = Alignment.Center) {
                Image(
                    ImageProvider(R.drawable.ic_sync), contentDescription = "Saved on this phone — will sync",
                    modifier = GlanceModifier.size(18.dp), colorFilter = ColorFilter.tint(WColors.muted),
                )
            }
        } else {
            CheckBox(
                checked = row.struck,
                onCheckedChange = actionRunCallback<TickTask>(
                    actionParametersOf(
                        TickTask.FILE to (row.fileId ?: ""), TickTask.TASK to row.id, TickTask.DUE to (row.due ?: ""),
                        TickTask.TITLE to row.title, TickTask.LIST to row.listId, TickTask.TIME to (row.time ?: ""),
                    ),
                ),
                colors = CheckboxDefaults.colors(checkedColor = WColors.accent, uncheckedColor = if (row.overdue) WColors.late else WColors.muted),
                modifier = GlanceModifier.semantics { contentDescription = (if (row.struck) "Undo: " else "Tick off ") + row.title },
            )
        }
        Column(
            GlanceModifier.defaultWeight().clickable(actionStartActivity(Open.page(ctx, Open.TASKS, taskPath(row.fileId, row.id)))),
        ) {
            Text(row.title, style = WText.style(13.sp, if (row.struck) WColors.muted else WColors.text, struck = row.struck), maxLines = if (small) 1 else 2)
            val bits = listOfNotNull(row.label.takeIf { it.isNotBlank() }, row.listName.takeIf { row.listId != "inbox" && !small })
            if (bits.isNotEmpty() && !row.struck) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (row.listId != "inbox" && !small) {
                        Dot(WColors.fixed(row.listColor, 0xFF8A817A), 6.dp)
                        Spacer(GlanceModifier.width(4.dp))
                    }
                    Text(bits.joinToString(" · "), style = WText.style(11.sp, if (row.overdue) WColors.late else WColors.muted), maxLines = 1)
                }
            }
        }
    }
}

/** A tick on the widget: saved here at once, sent once the moment to undo has passed. */
class TickTask : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val file = parameters[FILE].orEmpty()
        val task = parameters[TASK] ?: return
        if (file.isBlank()) return
        val ticked = WidgetStore.toggleTick(
            context, file, task, parameters[DUE]?.ifBlank { null }, parameters[TITLE].orEmpty(),
            parameters[LIST] ?: "inbox", parameters[TIME]?.ifBlank { null }, System.currentTimeMillis(),
        )
        Widgets.redraw(context)
        if (ticked) {
            Widgets.redrawLater(context, WidgetStore.STRUCK_MS + 150)
            WidgetSync.now(context, delayMs = WidgetStore.STRUCK_MS + 1_000)
        } else {
            WidgetSync.now(context)
        }
    }

    companion object {
        val FILE = ActionParameters.Key<String>("file")
        val TASK = ActionParameters.Key<String>("task")
        val DUE = ActionParameters.Key<String>("due")
        val TITLE = ActionParameters.Key<String>("title")
        val LIST = ActionParameters.Key<String>("list")
        val TIME = ActionParameters.Key<String>("time")
    }
}
