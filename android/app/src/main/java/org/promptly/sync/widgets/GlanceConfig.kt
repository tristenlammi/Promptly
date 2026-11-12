package org.promptly.sync.widgets

import android.app.DatePickerDialog
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.promptly.sync.Store
import org.promptly.sync.capture.CaptureTheme
import java.time.LocalDate
import java.util.Locale

// ------------------------------------------------------------------ app panel settings

/** The app panel: which apps, in what order, and whether to take their own
 *  icons off the home screen (the same switch as long-press Promptly → Choose apps). */
class AppsConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val id = widgetId(this)
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()
        ready(this, id)
        val all = PanelApps.all(this)
        setContent {
            CaptureTheme {
                val scope = rememberCoroutineScope()
                var chosen by remember { mutableStateOf(PanelApps.DEFAULT) }
                var hide by remember { mutableStateOf(false) }
                var layout by remember { mutableStateOf(PanelLayout()) }
                LaunchedEffect(Unit) {
                    prefsOf(this@AppsConfigActivity, id)?.let {
                        chosen = PanelApps.keys(it)
                        layout = AppsWidget.layoutOf(it)
                    }
                }
                Screen("App panel", look = id, onSave = {
                    scope.launch {
                        val picked = all.filter { it.key in chosen }
                        save(this@AppsConfigActivity, id, { p ->
                            p[AppsWidget.APPS] = chosen.joinToString(",")
                            p[AppsWidget.LAYOUT] = if (layout.fit) "fit" else "choose"
                            p[AppsWidget.COLS] = layout.cols
                            p[AppsWidget.ROWS] = layout.rows
                            p[AppsWidget.ICON] = layout.icon
                            p[AppsWidget.LABELS] = layout.labels
                        }) { AppsWidget().update(this@AppsConfigActivity, it) }
                        if (hide) PanelApps.hideIcons(this@AppsConfigActivity, picked)
                        finish()
                    }
                }) {
                    Text(
                        "Tick the apps you want on the panel. They show in the order you tick them; counts (unread, due today) appear on Rooms, Porch, Tasks, Mail and Calendar.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Section("Apps")
                    for (a in all) {
                        Tick(a.label, a.key in chosen, { on -> chosen = if (on) chosen + a.key else chosen - a.key })
                    }
                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    Section("Layout")
                    Choice("Fit to the widget: icons sized so your apps fill it", layout.fit, { layout = layout.copy(fit = true) })
                    Choice("Choose columns, rows and icon size", !layout.fit, { layout = layout.copy(fit = false) })
                    if (!layout.fit) {
                        Stepper("Apps in a row", layout.cols, PanelLayout.MIN_COLS, PanelLayout.MAX_COLS) { layout = layout.copy(cols = it) }
                        Stepper("Rows showing", layout.rows, PanelLayout.MIN_ROWS, PanelLayout.MAX_ROWS) { layout = layout.copy(rows = it) }
                        Text("More apps than fit scroll.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Section("Icon size")
                        for ((key, label) in listOf("small" to "Small", "medium" to "Medium", "large" to "Large")) {
                            Choice(label, layout.icon == key, { layout = layout.copy(icon = key) })
                        }
                    }
                    Toggle("Show app names", "Names under the icons. Off gives the icons more room.", layout.labels) { layout = layout.copy(labels = it) }
                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    val canHide = all.filter { it.key in chosen && it.key !in PanelApps.KEEP_ICON && PanelApps.iconOn(this@AppsConfigActivity, it.launcher) }
                    if (canHide.isNotEmpty() || hide) {
                        Toggle(
                            "Hide these apps' own icons",
                            "Fewer icons on your home screen: ${canHide.joinToString(", ") { it.label }} then open from this panel, inside Promptly. " +
                                "Put them back any time: long-press Promptly → Choose apps.",
                            hide,
                        ) { hide = it }
                    }
                }
            }
        }
    }
}

// ------------------------------------------------------------------ favourite people settings

/** Favourite people: search your Promptly and tick up to eight. */
class PeopleConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val id = widgetId(this)
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()
        ready(this, id)
        val store = Store(this)
        val account = if (store.hasAccount && !store.unlinked) store.account else null
        setContent {
            CaptureTheme {
                val scope = rememberCoroutineScope()
                var picked by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
                var q by remember { mutableStateOf("") }
                var found by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
                var problem by remember { mutableStateOf<String?>(null) }
                LaunchedEffect(Unit) { prefsOf(this@PeopleConfigActivity, id)?.let { picked = PeopleWidget.peopleOf(it) } }
                LaunchedEffect(q) {
                    if (account == null) {
                        problem = "Link this phone to Promptly first."
                        return@LaunchedEffect
                    }
                    delay(300)
                    problem = null
                    found = runCatching { withContext(Dispatchers.IO) { WidgetApi(account).people(q.trim()) } }
                        .onFailure { problem = "Couldn't search just now. Check the connection and try again." }
                        .getOrDefault(emptyList())
                }
                Screen("Favourite people", look = id, onSave = {
                    scope.launch {
                        val arr = JSONArray()
                        picked.forEach { arr.put(JSONObject().put("user_id", it.optString("user_id")).put("name", it.optString("name"))) }
                        save(this@PeopleConfigActivity, id, { p -> p[PeopleWidget.PEOPLE] = arr.toString() }) { PeopleWidget().update(this@PeopleConfigActivity, it) }
                        finish()
                    }
                }) {
                    Text(
                        "Up to ${PeopleWidget.MAX} people. A tap on someone opens them in Promptly, with Message and Call.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (picked.isNotEmpty()) {
                        Section("On the widget")
                        for (p in picked) {
                            Tick(p.optString("name"), true, { picked = picked.filterNot { it.optString("user_id") == p.optString("user_id") } })
                        }
                    }
                    Section("Add someone")
                    OutlinedTextField(q, { q = it }, Modifier.fillMaxWidth(), label = { Text("Search by name") }, singleLine = true)
                    problem?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    val have = picked.map { it.optString("user_id") }.toSet()
                    for (p in found.filter { it.optString("user_id") !in have }) {
                        Tick(p.optString("name"), false, {
                            if (picked.size < PeopleWidget.MAX) picked = picked + p
                        })
                    }
                }
            }
        }
    }
}

// ------------------------------------------------------------------ countdown settings

class CountdownConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val id = widgetId(this)
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()
        ready(this, id)
        setContent {
            CaptureTheme {
                val scope = rememberCoroutineScope()
                var title by remember { mutableStateOf("") }
                var date by remember { mutableStateOf(LocalDate.now().plusDays(7)) }
                var yearly by remember { mutableStateOf(false) }
                LaunchedEffect(Unit) {
                    prefsOf(this@CountdownConfigActivity, id)?.let { CountdownWidget.configOf(it) }?.let {
                        title = if (it.title == "the day") "" else it.title; date = it.date; yearly = it.yearly
                    }
                }
                Screen("Countdown", look = id, onSave = {
                    scope.launch {
                        save(this@CountdownConfigActivity, id, { p ->
                            p[CountdownWidget.TITLE] = title.trim().take(60)
                            p[CountdownWidget.DATE] = date.toString()
                            p[CountdownWidget.YEARLY] = yearly
                        }) { CountdownWidget().update(this@CountdownConfigActivity, it) }
                        finish()
                    }
                }) {
                    OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth(), label = { Text("Counting down to") }, placeholder = { Text("Holiday, Sam's birthday…") }, singleLine = true)
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(onClick = {
                        DatePickerDialog(this@CountdownConfigActivity, { _, y, m, d -> date = LocalDate.of(y, m + 1, d) }, date.year, date.monthValue - 1, date.dayOfMonth).show()
                    }, modifier = Modifier.fillMaxWidth()) {
                        Text(date.format(java.time.format.DateTimeFormatter.ofLocalizedDate(java.time.format.FormatStyle.LONG).withLocale(Locale.getDefault())))
                    }
                    Toggle("Every year", "For a birthday or an anniversary: counts to the next one.", yearly) { yearly = it }
                }
            }
        }
    }
}

// ------------------------------------------------------------------ read me my day

/**
 * "Read me my day" from the Today widget: the same words Today reads out
 * (`/api/widgets/briefing`), spoken by the phone's own voice, with the words
 * on screen and a Stop button. Only speaks; never listens.
 */
class ReadDayActivity : ComponentActivity() {
    private var tts: TextToSpeech? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val store = Store(this)
        val account = if (store.hasAccount && !store.unlinked) store.account else null
        setContent {
            CaptureTheme {
                var words by remember { mutableStateOf<String?>(null) }
                var problem by remember { mutableStateOf<String?>(null) }
                var speaking by remember { mutableStateOf(false) }
                LaunchedEffect(Unit) {
                    if (account == null) {
                        problem = "Link this phone to Promptly first."
                        return@LaunchedEffect
                    }
                    val script = runCatching { withContext(Dispatchers.IO) { WidgetApi(account).briefing().optString("script") } }.getOrNull()
                    if (script.isNullOrBlank()) {
                        problem = "Couldn't get your day just now. Check the connection and try again."
                        return@LaunchedEffect
                    }
                    words = script
                    speak(script) { speaking = it }
                }
                DisposableEffect(Unit) { onDispose { tts?.stop(); tts?.shutdown(); tts = null } }
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Column(Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        Text("Your day", style = MaterialTheme.typography.headlineSmall)
                        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                            when {
                                problem != null -> Text(problem!!, color = MaterialTheme.colorScheme.error)
                                words == null -> Text("Getting your day…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                else -> Text(words!!, style = MaterialTheme.typography.bodyLarge)
                            }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            if (words != null) {
                                Button(onClick = {
                                    if (speaking) { tts?.stop(); speaking = false } else speak(words!!) { speaking = it }
                                }) { Text(if (speaking) "Stop" else "Read it again") }
                            }
                            TextButton(onClick = { finish() }) { Text("Close") }
                        }
                    }
                }
            }
        }
    }

    private fun speak(text: String, onSpeaking: (Boolean) -> Unit) {
        val go = { t: TextToSpeech ->
            t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) = runOnUiThread { onSpeaking(true) }
                override fun onDone(utteranceId: String?) = runOnUiThread { onSpeaking(false) }
                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) = runOnUiThread { onSpeaking(false) }
            })
            t.speak(text, TextToSpeech.QUEUE_FLUSH, null, "day")
        }
        val ready = tts
        if (ready != null) {
            go(ready)
            return
        }
        var made: TextToSpeech? = null
        made = TextToSpeech(applicationContext) { status ->
            if (status == TextToSpeech.SUCCESS) made?.let { go(it) }
        }
        tts = made
    }

    override fun onDestroy() {
        tts?.stop()
        tts?.shutdown()
        tts = null
        super.onDestroy()
    }
}

// ------------------------------------------------------------------ add to home screen

/** Every widget with an "Add to home screen" button (Android puts it there
 *  with one confirm, where the launcher allows it). Opened from the app. */
class WidgetsActivity : ComponentActivity() {
    data class Entry(val name: String, val about: String, val receiver: Class<*>)

    private val entries = listOf(
        Entry("App panel", "Your Promptly apps in one place, with unread and due counts.", AppsWidgetReceiver::class.java),
        Entry("Talk", "One big microphone: tap to talk to Promptly.", TalkWidgetReceiver::class.java),
        Entry("Quick add", "A note, a task, a photo or a voice note, one tap each.", QuickAddWidgetReceiver::class.java),
        Entry("Today", "Weather, what's next and when to leave, tasks and birthdays. Read me my day.", TodayWidgetReceiver::class.java),
        Entry("Meals & Macros", "Calories and protein left today, and Log food.", MacrosWidgetReceiver::class.java),
        Entry("Rooms and Porch", "Unread messages and the newest Porch photo.", SocialWidgetReceiver::class.java),
        Entry("Favourite people", "The people you choose, a tap from a message or call.", PeopleWidgetReceiver::class.java),
        Entry("P Maps", "Home and Work in today's traffic, and when to leave.", MapsWidgetReceiver::class.java),
        Entry("On their way", "Who's sharing a trip with you, and when they'll get there.", OnTheWayWidgetReceiver::class.java),
        Entry("Countdown", "Days until a day you choose.", CountdownWidgetReceiver::class.java),
        Entry("Health", "Your weight trend and next workout.", HealthWidgetReceiver::class.java),
        Entry("Mail", "Unread mail and who it's from.", MailWidgetReceiver::class.java),
        Entry("Agenda", "Today and the week ahead.", AgendaWidgetReceiver::class.java),
        Entry("Tasks", "Today's tasks, ticked off right there.", TasksWidgetReceiver::class.java),
        Entry("Notes", "Your pinned and latest notes.", NotesWidgetReceiver::class.java),
        Entry("One note", "A note or list you choose (a shopping list).", OneNoteWidgetReceiver::class.java),
        Entry("Photo", "A photo from an album you choose.", PhotoWidgetReceiver::class.java),
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val mgr = AppWidgetManager.getInstance(this)
        val canPin = Build.VERSION.SDK_INT >= 26 && mgr.isRequestPinAppWidgetSupported
        setContent {
            CaptureTheme {
                var said by remember { mutableStateOf<String?>(null) }
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Home-screen widgets", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
                            TextButton(onClick = { finish() }) { Text("Done") }
                        }
                        Text(
                            if (canPin) "Tap Add and your phone asks where to put it." else
                                "Your home screen doesn't let apps add widgets. Long-press an empty spot on it, choose Widgets, then find Promptly.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 6.dp)) }
                        Spacer(Modifier.height(8.dp))
                        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                            for (e in entries) {
                                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(1f)) {
                                        Text(e.name, style = MaterialTheme.typography.titleMedium)
                                        Text(e.about, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    if (canPin) {
                                        Spacer(Modifier.size(8.dp))
                                        Button(onClick = {
                                            val ok = runCatching { mgr.requestPinAppWidget(ComponentName(this@WidgetsActivity, e.receiver), null, null) }.getOrDefault(false)
                                            said = if (ok) "Choose where ${e.name} goes on your home screen." else "Your phone didn't add it. Long-press the home screen → Widgets → Promptly."
                                        }) { Text("Add") }
                                    }
                                }
                                HorizontalDivider()
                            }
                        }
                    }
                }
            }
        }
    }

    companion object {
        fun open(ctx: Context) = ctx.startActivity(android.content.Intent(ctx, WidgetsActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

// ------------------------------------------------------------------ look only

/** Settings for a widget with nothing else to set (Talk, Today, Macros…):
 *  just its background. Opened from the launcher's long-press "Settings";
 *  never forced when the widget is added. */
class LookConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val id = widgetId(this)
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()
        ready(this, id)
        val name = runCatching { AppWidgetManager.getInstance(this).getAppWidgetInfo(id)?.loadLabel(packageManager) }.getOrNull() ?: "Widget"
        setContent {
            CaptureTheme {
                Screen(name, look = id, onSave = { finish() }) {}
            }
        }
    }
}
