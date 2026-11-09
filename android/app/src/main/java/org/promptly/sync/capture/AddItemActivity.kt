package org.promptly.sync.capture

import android.os.Bundle
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
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
import org.promptly.sync.widgets.WidgetStore
import org.promptly.sync.widgets.WidgetSync
import org.promptly.sync.widgets.Widgets

/**
 * The One note widget's **+**: add items to that list, one after another
 * (Enter adds and clears the field for the next). Works with no signal.
 * Back or a tap outside adds what's typed.
 */
class AddItemActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val noteId = intent.getStringExtra(EXTRA_NOTE) ?: return finish()
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
        setContent { CaptureTheme { AddItem(noteId, title, onDone = ::finish) } }
    }

    companion object {
        const val EXTRA_NOTE = "note_id"
        const val EXTRA_TITLE = "title"
    }
}

@Composable
private fun AddItem(noteId: String, title: String, onDone: () -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var added by remember { mutableIntStateOf(0) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    fun add(then: () -> Unit = {}) {
        val t = text.trim().replace(Regex("\\s+"), " ").take(1000)
        if (t.isEmpty()) return then()
        text = ""
        scope.launch {
            WidgetStore.addNoteItem(ctx, noteId, t, System.currentTimeMillis())
            added++
            Widgets.redraw(ctx)
            WidgetSync.now(ctx, delayMs = 1_500) // a few in a row go together
            then()
        }
    }

    BackHandler { add(onDone) }
    Box(
        Modifier.fillMaxSize().background(Color(0x66000000))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { add(onDone) }
            .safeDrawingPadding().imePadding(),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Card(
            Modifier.fillMaxWidth().widthIn(max = 560.dp).padding(12.dp)
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
            shape = RoundedCornerShape(20.dp),
        ) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(if (title.isBlank()) "Add to the list" else "Add to $title", style = MaterialTheme.typography.titleMedium, maxLines = 1)
                OutlinedTextField(
                    value = text,
                    onValueChange = { if (it.length <= 1000) text = it.replace("\n", " ") },
                    placeholder = { Text("List item") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Next),
                    keyboardActions = KeyboardActions(onNext = { add() }),
                    supportingText = { if (added > 0) Text(if (added == 1) "1 item added" else "$added items added") },
                    modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = "List item" },
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.weight(1f))
                    TextButton(onClick = onDone) { Text(if (added > 0) "Done" else "Cancel") }
                    Button(onClick = { add(onDone) }) { Text("Add") }
                }
            }
        }
    }
}
