package org.promptly.sync.capture

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
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
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.promptly.sync.MainActivity
import org.promptly.sync.widgets.Link
import org.promptly.sync.widgets.WidgetStore
import org.promptly.sync.widgets.WidgetSync
import org.promptly.sync.widgets.Widgets

/**
 * Quick note: a title and text, or a list (one row an item), and Save. Opens
 * at once from the Notes widget and P Notes' long-press menu, works with no
 * signal (saved on the phone, on the widget straight away, sent when there's
 * signal). Back or a tap outside keeps what you typed; Cancel throws it away.
 */
class QuickNoteActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val list = intent.getBooleanExtra(EXTRA_LIST, false) || intent.data?.host == "new-list"
        setContent { CaptureTheme { QuickNote(list, onDone = ::finish) } }
    }

    companion object {
        const val EXTRA_LIST = "list"
    }
}

/** What a quick note comes to: the note's kind, title, text and items — or null when there's nothing in it. */
data class QuickNoteDraft(val kind: String, val title: String, val text: String, val items: List<String>) {
    companion object {
        fun of(asList: Boolean, title: String, text: String, rows: List<String>): QuickNoteDraft? {
            val t = title.trim().replace(Regex("\\s+"), " ").take(300)
            return if (asList) {
                val items = rows.map { it.trim().replace(Regex("\\s+"), " ").take(1000) }.filter { it.isNotEmpty() }
                if (t.isEmpty() && items.isEmpty()) null else QuickNoteDraft("list", t, "", items)
            } else {
                val body = text.trimEnd().take(20_000)
                if (t.isEmpty() && body.isBlank()) null else QuickNoteDraft("text", t, body, emptyList())
            }
        }
    }
}

@Composable
private fun QuickNote(startAsList: Boolean, onDone: () -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    val link = remember { Widgets.link(ctx) }
    var asList by remember { mutableStateOf(startAsList) }
    var title by remember { mutableStateOf("") }
    var text by remember { mutableStateOf("") }
    val rows = remember { mutableStateListOf(TextFieldValue("")) }
    val focusers = remember { mutableStateListOf(FocusRequester()) }
    var focusRow by remember { mutableStateOf(-1) }
    var saving by remember { mutableStateOf(false) }
    val bodyFocus = remember { FocusRequester() }

    LaunchedEffect(Unit) {
        if (link == Link.LINKED) runCatching { if (asList) focusers[0].requestFocus() else bodyFocus.requestFocus() }
    }
    LaunchedEffect(focusRow) {
        if (focusRow in focusers.indices) runCatching { focusers[focusRow].requestFocus() }
    }

    fun switch(toList: Boolean) {
        if (toList == asList) return
        if (toList) {
            // The text's lines become items.
            val lines = text.lines().map { it.trim() }.filter { it.isNotEmpty() }
            rows.clear(); focusers.clear()
            (lines.ifEmpty { listOf("") }).forEach { rows += TextFieldValue(it); focusers += FocusRequester() }
            focusRow = rows.lastIndex
        } else {
            text = rows.map { it.text.trim() }.filter { it.isNotEmpty() }.joinToString("\n")
        }
        asList = toList
    }

    fun save() {
        if (saving) return
        val draft = QuickNoteDraft.of(asList, title, text, rows.map { it.text })
        if (draft == null || link != Link.LINKED) {
            onDone()
            return
        }
        saving = true
        scope.launch {
            WidgetStore.addNote(ctx, draft.kind, draft.title, draft.text, draft.items, "android", emptyList(), System.currentTimeMillis())
            Widgets.redraw(ctx)
            WidgetSync.now(ctx)
            Toast.makeText(ctx, if (Online.now(ctx)) "Saved to Notes" else "Saved on this phone — will sync", Toast.LENGTH_SHORT).show()
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
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (link != Link.LINKED) {
                    Text("New note", style = MaterialTheme.typography.titleMedium)
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
                val plain = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                )
                TextField(
                    value = title,
                    onValueChange = { if (it.length <= 300) title = it.replace("\n", " ") },
                    placeholder = { Text("Title") },
                    singleLine = true,
                    textStyle = MaterialTheme.typography.titleMedium,
                    colors = plain,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Next),
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Title" },
                )
                Column(Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState())) {
                    if (!asList) {
                        TextField(
                            value = text,
                            onValueChange = { if (it.length <= 20_000) text = it },
                            placeholder = { Text("Take a note…") },
                            colors = plain,
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                            modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp).focusRequester(bodyFocus).semantics { contentDescription = "Note" },
                        )
                    } else {
                        rows.forEachIndexed { i, row ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(checked = false, onCheckedChange = null, enabled = false, modifier = Modifier.size(32.dp))
                                TextField(
                                    value = row,
                                    onValueChange = { v ->
                                        if ('\n' in v.text) {
                                            // Enter: a new item below (what follows the cursor goes with it).
                                            val (before, after) = v.text.substringBefore('\n') to v.text.substringAfter('\n')
                                            rows[i] = TextFieldValue(before)
                                            rows.add(i + 1, TextFieldValue(after, TextRange(0)))
                                            focusers.add(i + 1, FocusRequester())
                                            focusRow = i + 1
                                        } else if (v.text.length <= 1000) rows[i] = v
                                    },
                                    placeholder = { Text(if (i == 0) "List item" else "") },
                                    colors = plain,
                                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Next),
                                    keyboardActions = KeyboardActions(onNext = {
                                        rows.add(i + 1, TextFieldValue(""))
                                        focusers.add(i + 1, FocusRequester())
                                        focusRow = i + 1
                                    }),
                                    modifier = Modifier.weight(1f).focusRequester(focusers[i]).semantics { contentDescription = "Item ${i + 1}" },
                                )
                                if (rows.size > 1) IconButton(onClick = {
                                    rows.removeAt(i); focusers.removeAt(i)
                                    focusRow = (i - 1).coerceAtLeast(0)
                                }, modifier = Modifier.size(40.dp).semantics { contentDescription = "Remove item ${i + 1}" }) {
                                    Text("✕", style = MaterialTheme.typography.bodyMedium)
                                }
                            }
                        }
                        TextButton(onClick = {
                            rows.add(TextFieldValue("")); focusers.add(FocusRequester()); focusRow = rows.lastIndex
                        }) { Text("+ List item") }
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = asList, onClick = { switch(!asList) }, label = { Text("List") })
                    Box(Modifier.weight(1f))
                    TextButton(onClick = onDone) { Text("Cancel") }
                    Button(onClick = { save() }, enabled = !saving) { Text("Save") }
                }
            }
        }
    }
}
