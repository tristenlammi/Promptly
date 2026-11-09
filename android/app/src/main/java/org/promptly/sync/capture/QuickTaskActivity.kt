package org.promptly.sync.capture

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.promptly.sync.MainActivity
import org.promptly.sync.widgets.Link
import org.promptly.sync.widgets.TaskList
import org.promptly.sync.widgets.WidgetStore
import org.promptly.sync.widgets.WidgetSync
import org.promptly.sync.widgets.Widgets
import java.time.LocalDate

/**
 * Quick task: a title, Today / Tomorrow / No date, and a list. Opens at once
 * from the Tasks widget's +, works with no signal (it's saved on the phone,
 * shown on the widget straight away, and sent when there's signal). Back or
 * a tap outside keeps what you typed; Cancel throws it away.
 */
class QuickTaskActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val list = intent.getStringExtra(EXTRA_LIST)
        setContent { CaptureTheme { QuickTask(list, onDone = ::finish) } }
    }

    companion object {
        const val EXTRA_LIST = "list_id"
    }
}

private val Terracotta = Color(0xFFC8613F)

@Composable
fun CaptureTheme(content: @Composable () -> Unit) {
    // Promptly's warm neutrals and terracotta, not Material's default lavender.
    val scheme = if (isSystemInDarkTheme()) darkColorScheme(
        primary = Color(0xFFE38B6D), secondary = Color(0xFFE38B6D),
        secondaryContainer = Color(0xFF5A3426), onSecondaryContainer = Color(0xFFF8DED4),
        background = Color(0xFF1C1917), surface = Color(0xFF1C1917),
        surfaceContainerHighest = Color(0xFF2E2926), surfaceContainerHigh = Color(0xFF292524), surfaceContainer = Color(0xFF292524),
    )
    else lightColorScheme(
        primary = Terracotta, secondary = Terracotta,
        secondaryContainer = Color(0xFFF6DDD3), onSecondaryContainer = Color(0xFF4A2316),
        background = Color(0xFFFFFFFF), surface = Color(0xFFFFFFFF),
        surfaceContainerHighest = Color(0xFFF5F2EE), surfaceContainerHigh = Color(0xFFF8F5F2), surfaceContainer = Color(0xFFFAF8F5),
    )
    MaterialTheme(colorScheme = scheme, content = content)
}

private fun online(ctx: Context): Boolean = runCatching {
    val cm = ctx.getSystemService(ConnectivityManager::class.java)
    val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
}.getOrDefault(false)

@Composable
private fun QuickTask(initialList: String?, onDone: () -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    val link = remember { Widgets.link(ctx) }
    var title by remember { mutableStateOf("") }
    var due by remember { mutableStateOf("today") }
    var lists by remember { mutableStateOf<List<TaskList>>(emptyList()) }
    var listId by remember { mutableStateOf(initialList ?: "inbox") }
    var picking by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }

    LaunchedEffect(Unit) {
        lists = WidgetStore.load(ctx).snapshot.tasks?.lists.orEmpty().ifEmpty { listOf(TaskList("inbox", "Inbox", null)) }
        if (lists.none { it.id == listId }) listId = "inbox"
        if (link == Link.LINKED) runCatching { focus.requestFocus() }
    }

    fun save() {
        val text = title.trim().replace(Regex("\\s+"), " ")
        if (text.isEmpty() || saving) {
            onDone()
            return
        }
        saving = true
        val day = when (due) {
            "today" -> LocalDate.now().toString()
            "tomorrow" -> LocalDate.now().plusDays(1).toString()
            else -> null
        }
        scope.launch {
            WidgetStore.addTask(ctx, text.take(500), day, listId.takeIf { it != "inbox" }, System.currentTimeMillis())
            Widgets.redraw(ctx)
            WidgetSync.now(ctx)
            Toast.makeText(ctx, if (online(ctx)) "Added to Tasks" else "Saved on this phone — will sync", Toast.LENGTH_SHORT).show()
            onDone()
        }
    }

    BackHandler { save() }
    Box(
        Modifier.fillMaxSize().background(Color(0x66000000))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { save() }
            .safeDrawingPadding().imePadding(),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Card(
            Modifier.fillMaxWidth().widthIn(max = 560.dp).padding(12.dp)
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
            shape = RoundedCornerShape(20.dp),
        ) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("New task", style = MaterialTheme.typography.titleMedium)
                if (link != Link.LINKED) {
                    Text(
                        if (link == Link.OFF) "Widgets are off for this phone. Turn them on in Promptly → Account → Devices."
                        else "Link this phone to Promptly first — the same as photo backup.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = onDone) { Text("Close") }
                        if (link != Link.OFF) Button(onClick = {
                            ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                            onDone()
                        }) { Text("Link this phone") }
                    }
                    return@Column
                }
                OutlinedTextField(
                    value = title,
                    onValueChange = { if (it.length <= 500) title = it.replace("\n", " ") },
                    placeholder = { Text("What needs doing?") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { save() }),
                    modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = "Task" },
                )
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for ((key, label) in listOf("today" to "Today", "tomorrow" to "Tomorrow", "none" to "No date")) {
                        FilterChip(selected = due == key, onClick = { due = key }, label = { Text(label) })
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box {
                        TextButton(onClick = { picking = true }) {
                            Text("List: " + (lists.firstOrNull { it.id == listId }?.name ?: "Inbox"))
                        }
                        DropdownMenu(expanded = picking, onDismissRequest = { picking = false }) {
                            for (l in lists) DropdownMenuItem(text = { Text(l.name) }, onClick = { listId = l.id; picking = false })
                        }
                    }
                    Box(Modifier.weight(1f))
                    TextButton(onClick = onDone) { Text("Cancel") }
                    Button(onClick = { save() }, enabled = title.isNotBlank() && !saving) { Text("Add") }
                }
            }
        }
    }
}
