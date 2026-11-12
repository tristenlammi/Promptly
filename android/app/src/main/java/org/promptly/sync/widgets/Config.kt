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

internal fun widgetId(a: Activity): Int = a.intent?.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    ?: AppWidgetManager.INVALID_APPWIDGET_ID

/** Back keeps the widget with what it has: the result is OK from the start. */
internal fun ready(a: Activity, id: Int) {
    a.setResult(Activity.RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id))
}

internal suspend fun prefsOf(ctx: Context, id: Int): Preferences? = runCatching {
    val gid = GlanceAppWidgetManager(ctx).getGlanceIdBy(id)
    getAppWidgetState(ctx, PreferencesGlanceStateDefinition, gid)
}.getOrNull()

internal suspend fun save(ctx: Context, id: Int, change: (androidx.datastore.preferences.core.MutablePreferences) -> Unit, redraw: suspend (androidx.glance.GlanceId) -> Unit) {
    val gid = GlanceAppWidgetManager(ctx).getGlanceIdBy(id)
    updateAppWidgetState(ctx, PreferencesGlanceStateDefinition, gid) { p -> p.toMutablePreferences().apply(change) }
    redraw(gid)
}

@Composable
internal fun Screen(title: String, onSave: () -> Unit, look: Int? = null, content: @Composable () -> Unit) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp)) {
            Text(title, style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.height(12.dp))
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                content()
                if (look != null) BackgroundChoice(look)
            }
            Button(onClick = onSave, modifier = Modifier.fillMaxWidth()) { Text("Done") }
        }
    }
}

/** "Background: Solid / See-through" for widget [id], saved and shown as soon as it's picked. */
@Composable
internal fun BackgroundChoice(id: Int) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var glass by remember { mutableStateOf(false) }
    LaunchedEffect(id) { glass = prefsOf(ctx, id)?.get(BACKGROUND) == "glass" }
    fun pick(g: Boolean) {
        glass = g
        scope.launch {
            save(ctx, id, { p -> p[BACKGROUND] = if (g) "glass" else "solid" }) { Widgets.redrawId(ctx, id) }
        }
    }
    Spacer(Modifier.height(8.dp))
    Text("Background", style = MaterialTheme.typography.titleSmall)
    Choice("Solid", !glass, { pick(false) })
    Choice("See-through: your wallpaper shows behind it", glass, { pick(true) })
}

@Composable
internal fun Choice(label: String, selected: Boolean, onClick: () -> Unit, dot: Color? = null) {
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
internal fun Tick(label: String, checked: Boolean, onChange: (Boolean) -> Unit, dot: Color? = null) {
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
internal fun Toggle(label: String, hint: String, checked: Boolean, onChange: (Boolean) -> Unit) {
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
internal fun Section(text: String) {
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
                Screen("Agenda widget", look = id, onSave = {
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
                Screen("Tasks widget", look = id, onSave = {
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
                Screen("Notes widget", look = id, onSave = {
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
                Screen("One note widget", look = id, onSave = {
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

@Composable
private fun ShapeTile(shape: PhotoShape, selected: Boolean, onClick: () -> Unit, modifier: Modifier) {
    val color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant
    Column(
        modifier.selectable(selected = selected, onClick = onClick, role = Role.RadioButton).padding(vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        androidx.compose.foundation.Canvas(Modifier.size(width = 64.dp, height = 56.dp)) {
            // The same outline the widget cuts the photo to.
            val pts = PhotoShapes.outline(shape, size.width, size.height)
            val path = androidx.compose.ui.graphics.Path()
            path.moveTo(pts[0], pts[1])
            for (i in 2 until pts.size step 2) path.lineTo(pts[i], pts[i + 1])
            path.close()
            drawPath(path, color)
        }
        Spacer(Modifier.height(4.dp))
        Text(shape.label, style = MaterialTheme.typography.labelMedium, color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Photo: which album, which shape, and what a tap does. */
class PhotoConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val id = widgetId(this)
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()
        ready(this, id)
        setContent {
            CaptureTheme {
                val scope = rememberCoroutineScope()
                var albums by remember { mutableStateOf<List<PhotoAlbum>?>(null) }
                var offline by remember { mutableStateOf(false) }
                var picked by remember { mutableStateOf<String?>(null) }
                var was by remember { mutableStateOf<String?>(null) }
                var savedTitle by remember { mutableStateOf("") }
                var shape by remember { mutableStateOf(PhotoShape.ROUNDED) }
                var tap by remember { mutableStateOf(PhotoWidget.TAP_NEXT) }
                var fit by remember { mutableStateOf(PhotoWidget.FIT_FILL) }
                val linked = remember { Widgets.link(this@PhotoConfigActivity) == Link.LINKED }
                LaunchedEffect(Unit) {
                    prefsOf(this@PhotoConfigActivity, id)?.let { p ->
                        picked = p[PhotoWidget.ALBUM_ID]?.ifBlank { null }
                        was = picked
                        savedTitle = p[PhotoWidget.ALBUM_TITLE].orEmpty()
                        shape = PhotoShape.of(p[PhotoWidget.SHAPE])
                        tap = if (p[PhotoWidget.TAP] == PhotoWidget.TAP_OPEN) PhotoWidget.TAP_OPEN else PhotoWidget.TAP_NEXT
                        fit = if (p[PhotoWidget.FIT] == PhotoWidget.FIT_WHOLE) PhotoWidget.FIT_WHOLE else PhotoWidget.FIT_FILL
                    }
                    val account = if (linked) Store(this@PhotoConfigActivity).account else null
                    val got = if (account == null) null else withContext(Dispatchers.IO) { runCatching { WidgetApi(account).albums() }.getOrNull() }
                    offline = got == null
                    albums = got ?: emptyList()
                }
                Screen("Photo widget", onSave = {
                    val chosen = albums.orEmpty().firstOrNull { it.id == picked }
                    scope.launch {
                        save(this@PhotoConfigActivity, id, { p ->
                            picked?.let { album ->
                                p[PhotoWidget.ALBUM_ID] = album
                                if (chosen != null) p[PhotoWidget.ALBUM_TITLE] = chosen.title
                                if (album != was) {
                                    // A different album: start from its own photos.
                                    p.remove(PhotoWidget.CURRENT)
                                    p.remove(PhotoWidget.RECENT)
                                    p.remove(PhotoWidget.SHOWN_AT)
                                }
                            }
                            p[PhotoWidget.SHAPE] = shape.key
                            p[PhotoWidget.TAP] = tap
                            p[PhotoWidget.FIT] = fit
                        }) { PhotoWidget().update(this@PhotoConfigActivity, it) }
                        if (picked != null) WidgetSync.now(this@PhotoConfigActivity)
                        finish()
                    }
                }) {
                    Section("Album")
                    val list = albums
                    val quiet = MaterialTheme.colorScheme.onSurfaceVariant
                    when {
                        !linked -> Text("Link this phone to Promptly first, then choose an album here.", style = MaterialTheme.typography.bodyMedium, color = quiet)
                        list == null -> Text("Looking…", style = MaterialTheme.typography.bodyMedium, color = quiet)
                        list.isEmpty() -> {
                            // No signal: the album already chosen stays chosen.
                            if (offline && picked != null && savedTitle.isNotBlank()) Choice(savedTitle, true, {})
                            Text(
                                if (offline) "Your albums show here when there's signal." else "No albums yet. Make one in P Photos, then pick it here.",
                                style = MaterialTheme.typography.bodyMedium, color = quiet,
                            )
                        }
                        else -> for (a in list) {
                            val photos = when (a.count) {
                                0 -> "no photos yet"
                                1 -> "1 photo"
                                else -> "${a.count} photos"
                            }
                            Choice("${a.title} — $photos" + (if (a.shared) ", shared with you" else ""), picked == a.id, { picked = a.id })
                        }
                    }
                    Section("Shape")
                    for (row in PhotoShape.entries.chunked(3)) {
                        Row(Modifier.fillMaxWidth()) {
                            for (s in row) ShapeTile(s, shape == s, { shape = s }, Modifier.weight(1f))
                        }
                    }
                    Section("How the photo fits")
                    Choice("Fill the shape — cropped round the people and pets in it", fit == PhotoWidget.FIT_FILL, { fit = PhotoWidget.FIT_FILL })
                    Choice("Whole photo — all of it, with a soft blur behind", fit == PhotoWidget.FIT_WHOLE, { fit = PhotoWidget.FIT_WHOLE })
                    Section("When you tap the photo")
                    Choice("Show another photo", tap == PhotoWidget.TAP_NEXT, { tap = PhotoWidget.TAP_NEXT })
                    Choice("Open the album in P Photos", tap == PhotoWidget.TAP_OPEN, { tap = PhotoWidget.TAP_OPEN })
                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    Text(
                        "A new photo shows every half hour. A few are kept on this phone, so it works with no signal. Anyone holding your unlocked phone can see the widget.",
                        style = MaterialTheme.typography.bodySmall, color = quiet,
                    )
                }
            }
        }
    }
}
