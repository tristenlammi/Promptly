package org.promptly.sync.widgets

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.datastore.preferences.core.Preferences
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.getAppWidgetState
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.state.PreferencesGlanceStateDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.promptly.sync.Store
import org.promptly.sync.capture.CaptureTheme

/*
 * The widgets' settings screens: shown when a widget is added (Android 11 and
 * older) and from its "Settings" in the launcher's long-press menu. A widget
 * works without them: every setting has a sensible default.
 */

private fun widgetId(a: Activity): Int = a.intent?.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    ?: AppWidgetManager.INVALID_APPWIDGET_ID

/** Back keeps the widget with what it has: the result is OK from the start. */
private fun ready(a: Activity, id: Int) {
    a.setResult(Activity.RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id))
}

private suspend fun prefsOf(ctx: Context, id: Int): Preferences? = runCatching {
    val gid = GlanceAppWidgetManager(ctx).getGlanceIdBy(id)
    getAppWidgetState(ctx, PreferencesGlanceStateDefinition, gid)
}.getOrNull()

private suspend fun save(ctx: Context, id: Int, change: (androidx.datastore.preferences.core.MutablePreferences) -> Unit, redraw: suspend (androidx.glance.GlanceId) -> Unit) {
    val gid = GlanceAppWidgetManager(ctx).getGlanceIdBy(id)
    updateAppWidgetState(ctx, PreferencesGlanceStateDefinition, gid) { p -> p.toMutablePreferences().apply(change) }
    redraw(gid)
}

@Composable
private fun Screen(title: String, onSave: () -> Unit, content: @Composable () -> Unit) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp)) {
            Text(title, style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.height(12.dp))
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) { content() }
            Button(onClick = onSave, modifier = Modifier.fillMaxWidth()) { Text("Done") }
        }
    }
}

@Composable
private fun Choice(label: String, selected: Boolean, onClick: () -> Unit, dot: Color? = null) {
    Row(
        Modifier.fillMaxWidth().selectable(selected = selected, onClick = onClick, role = Role.RadioButton).padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Spacer(Modifier.size(8.dp))
        if (dot != null) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(dot))
            Spacer(Modifier.size(8.dp))
        }
        Text(label, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun Tick(label: String, checked: Boolean, onChange: (Boolean) -> Unit, dot: Color? = null) {
    Row(
        Modifier.fillMaxWidth().toggleable(value = checked, onValueChange = onChange, role = Role.Checkbox).padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = checked, onCheckedChange = null)
        Spacer(Modifier.size(8.dp))
        if (dot != null) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(dot))
            Spacer(Modifier.size(8.dp))
        }
        Text(label, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun Toggle(label: String, hint: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().toggleable(value = checked, onValueChange = onChange, role = Role.Switch).padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, onCheckedChange = null)
    }
}

@Composable
private fun Section(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 12.dp, bottom = 2.dp))
}

/** Agenda: which calendars, and whether to show places. */
class AgendaConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val id = widgetId(this)
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()
        ready(this, id)
        setContent {
            CaptureTheme {
                val scope = rememberCoroutineScope()
                var calendars by remember { mutableStateOf<List<CalendarInfo>>(emptyList()) }
                var mode by remember { mutableStateOf(AgendaConfig.WEB) }
                var picked by remember { mutableStateOf(setOf<String>()) }
                var titlesOnly by remember { mutableStateOf(false) }
                LaunchedEffect(Unit) {
                    calendars = WidgetStore.load(this@AgendaConfigActivity).snapshot.calendar?.calendars.orEmpty()
                    prefsOf(this@AgendaConfigActivity, id)?.let { AgendaWidget.configOf(it) }?.let {
                        mode = it.mode; picked = it.picked; titlesOnly = it.titlesOnly
                    }
                    if (mode == AgendaConfig.PICK && picked.isEmpty()) picked = calendars.filter { !it.hidden }.map { it.id }.toSet() + AgendaConfig.INVITED
                }
                Screen("Agenda widget", onSave = {
                    scope.launch {
                        save(this@AgendaConfigActivity, id, { p ->
                            p[AgendaWidget.MODE] = mode
                            p[AgendaWidget.PICKED] = picked
                            p[AgendaWidget.TITLES_ONLY] = titlesOnly
                        }) { AgendaWidget().update(this@AgendaConfigActivity, it) }
                        finish()
                    }
                }) {
                    Section("Calendars")
                    Choice("The ones shown in Promptly", mode == AgendaConfig.WEB, { mode = AgendaConfig.WEB })
                    Choice("Choose calendars", mode == AgendaConfig.PICK, {
                        mode = AgendaConfig.PICK
                        if (picked.isEmpty()) picked = calendars.filter { !it.hidden }.map { it.id }.toSet() + AgendaConfig.INVITED
                    })
                    if (mode == AgendaConfig.PICK) {
                        if (calendars.isEmpty()) {
                            Text(
                                "Your calendars show here once the widget has synced. Add the widget, wait a moment, then open its settings again.",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        for (c in calendars) {
                            Tick(c.name, c.id in picked, { on -> picked = if (on) picked + c.id else picked - c.id }, WColors.parse(c.color))
                        }
                        Tick("Events you're invited to", AgendaConfig.INVITED in picked, { on ->
                            picked = if (on) picked + AgendaConfig.INVITED else picked - AgendaConfig.INVITED
                        })
                    }
                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    Toggle("Titles only", "Hide where events are. Anyone holding your unlocked phone can see the widget.", titlesOnly) { titlesOnly = it }
                }
            }
        }
    }
}

/** Tasks: every list or one, and tasks with no date. */
class TasksConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val id = widgetId(this)
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()
        ready(this, id)
        setContent {
            CaptureTheme {
                val scope = rememberCoroutineScope()
                var lists by remember { mutableStateOf<List<TaskList>>(emptyList()) }
                var listId by remember { mutableStateOf<String?>(null) }
                var someday by remember { mutableStateOf(false) }
                LaunchedEffect(Unit) {
                    lists = WidgetStore.load(this@TasksConfigActivity).snapshot.tasks?.lists.orEmpty().ifEmpty { listOf(TaskList("inbox", "Inbox", null)) }
                    prefsOf(this@TasksConfigActivity, id)?.let { TasksWidget.configOf(it) }?.let { listId = it.listId; someday = it.someday }
                }
                Screen("Tasks widget", onSave = {
                    scope.launch {
                        save(this@TasksConfigActivity, id, { p ->
                            p[TasksWidget.LIST] = listId ?: ""
                            p[TasksWidget.SOMEDAY] = someday
                        }) { TasksWidget().update(this@TasksConfigActivity, it) }
                        finish()
                    }
                }) {
                    Section("Show")
                    Choice("All lists", listId == null, { listId = null })
                    for (l in lists) Choice(l.name, listId == l.id, { listId = l.id }, WColors.parse(l.color))
                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    Toggle("Tasks with no date", "Show them under today's.", someday) { someday = it }
                }
            }
        }
    }
}

/** Notes: titles only (no text or items on the home screen). */
class NotesConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val id = widgetId(this)
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()
        ready(this, id)
        setContent {
            CaptureTheme {
                val scope = rememberCoroutineScope()
                var titlesOnly by remember { mutableStateOf(false) }
                LaunchedEffect(Unit) {
                    prefsOf(this@NotesConfigActivity, id)?.let { NotesWidget.configOf(it) }?.let { titlesOnly = it.titlesOnly }
                }
                Screen("Notes widget", onSave = {
                    scope.launch {
                        save(this@NotesConfigActivity, id, { p -> p[NotesWidget.TITLES_ONLY] = titlesOnly }) { NotesWidget().update(this@NotesConfigActivity, it) }
                        finish()
                    }
                }) {
                    Text(
                        "Shows your pinned notes, then the latest. Tap the mic for a voice note — it records with no signal and is sent later.",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    Toggle("Titles only", "Hide what's in your notes. Anyone holding your unlocked phone can see the widget.", titlesOnly) { titlesOnly = it }
                }
            }
        }
    }
}

/** One note: which note or list (search as you type). */
class OneNoteConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val id = widgetId(this)
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()
        ready(this, id)
        setContent {
            CaptureTheme {
                val scope = rememberCoroutineScope()
                var q by remember { mutableStateOf("") }
                var notes by remember { mutableStateOf<List<NoteCard>>(emptyList()) }
                var picked by remember { mutableStateOf<String?>(null) }
                var loading by remember { mutableStateOf(true) }
                var offline by remember { mutableStateOf(false) }
                LaunchedEffect(Unit) {
                    prefsOf(this@OneNoteConfigActivity, id)?.get(OneNoteWidget.NOTE_ID)?.takeIf { it.isNotBlank() }?.let { picked = it }
                }
                LaunchedEffect(q) {
                    if (q.isNotEmpty()) delay(300)
                    loading = true
                    val cached = WidgetStore.load(this@OneNoteConfigActivity).snapshot.notesSection?.cards.orEmpty()
                        .filter { !it.pending && (q.isBlank() || it.title.contains(q, ignoreCase = true) || it.text.contains(q, ignoreCase = true)) }
                    if (notes.isEmpty() || q.isNotBlank()) notes = cached
                    val account = Store(this@OneNoteConfigActivity).account
                    val fetched = if (account == null) null else withContext(Dispatchers.IO) { runCatching { WidgetApi(account).pick(q) }.getOrNull() }
                    offline = fetched == null
                    if (fetched != null) notes = fetched
                    loading = false
                }
                Screen("One note widget", onSave = {
                    val chosen = notes.firstOrNull { it.id == picked }
                    scope.launch {
                        if (picked != null) {
                            save(this@OneNoteConfigActivity, id, { p ->
                                p[OneNoteWidget.NOTE_ID] = picked!!
                                if (chosen != null) p[OneNoteWidget.NOTE_TITLE] = chosen.title
                            }) { OneNoteWidget().update(this@OneNoteConfigActivity, it) }
                            WidgetSync.now(this@OneNoteConfigActivity)
                        }
                        finish()
                    }
                }) {
                    OutlinedTextField(
                        value = q, onValueChange = { q = it.take(200) }, singleLine = true,
                        placeholder = { Text("Search your notes") },
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Search your notes" },
                    )
                    Spacer(Modifier.height(8.dp))
                    when {
                        loading && notes.isEmpty() -> Text("Looking…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        notes.isEmpty() -> Text(
                            when {
                                q.isNotBlank() -> "No notes match “$q”."
                                offline -> "Your notes show here when there's signal."
                                else -> "No notes yet. Make one in P Notes, then pick it here."
                            },
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        else -> for (n in notes) {
                            val sub = when {
                                n.isList -> if (n.left == 1) "List · 1 left" else "List · ${n.left} left"
                                n.shared -> "Shared with you"
                                else -> null
                            }
                            Choice(n.title + (sub?.let { " — $it" } ?: ""), picked == n.id, { picked = n.id }, org.promptly.sync.capture.NoteColors.swatch(n.color))
                        }
                    }
                }
            }
        }
    }
}
