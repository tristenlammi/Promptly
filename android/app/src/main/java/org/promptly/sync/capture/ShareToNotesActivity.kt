package org.promptly.sync.capture

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Parcelable
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import org.promptly.sync.MainActivity
import org.promptly.sync.Store
import org.promptly.sync.widgets.Link
import org.promptly.sync.widgets.NoteCard
import org.promptly.sync.widgets.Open
import org.promptly.sync.widgets.WidgetApi
import org.promptly.sync.widgets.WidgetStore
import org.promptly.sync.widgets.WidgetSync
import org.promptly.sync.widgets.Widgets
import org.promptly.sync.widgets.notePath

/**
 * What another app shared, as Notes takes it: text (a link, a page's title
 * as its subject), and pictures and recordings. Anything else is counted, so
 * the screen can say it was left out.
 */
data class Shared(val text: String, val subject: String, val files: List<Pair<Uri, String>>, val skipped: Int) {
    val isEmpty: Boolean get() = text.isBlank() && files.isEmpty()

    /** The note's title: the app's subject (Chrome sends the page's title), unless it's just the text again. */
    val title: String get() = subject.trim().takeIf { it.isNotEmpty() && it != text.trim() }?.take(300) ?: ""

    val pictures: Int get() = files.count { it.second.startsWith("image/") }
    val recordings: Int get() = files.count { it.second.startsWith("audio/") }

    companion object {
        const val MAX_FILES = 10

        fun accepts(mime: String?): Boolean = mime != null && (mime.startsWith("image/") || mime.startsWith("audio/")) && !mime.endsWith("/*")

        /** Read a SEND / SEND_MULTIPLE intent. [typeOf] asks the content resolver for a file's type. Null: not a share. */
        fun from(intent: Intent, typeOf: (Uri) -> String?): Shared? {
            val action = intent.action
            if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null
            val text = (intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: "").trim().take(20_000)
            val subject = (intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString() ?: intent.getStringExtra(Intent.EXTRA_TITLE) ?: "").trim()
            val uris = LinkedHashSet<Uri>()
            if (action == Intent.ACTION_SEND) streamOf(intent)?.let { uris += it }
            else streamsOf(intent).forEach { uris += it }
            val declared = intent.type?.lowercase()
            // Text shared with a picture in its ClipData (Chrome does this) is the share
            // sheet's preview of the link, not something to keep.
            val preview = action == Intent.ACTION_SEND && declared?.startsWith("text/") == true && uris.isEmpty()
            if (!preview) intent.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris += it } }
            val files = mutableListOf<Pair<Uri, String>>()
            var skipped = 0
            for (u in uris) {
                if (u.scheme != "content" && u.scheme != "file") { skipped++; continue }
                if (u.scheme == "file") { skipped++; continue } // another app's private path: never read
                val mime = (runCatching { typeOf(u) }.getOrNull() ?: declared)?.lowercase()
                if (accepts(mime) && files.size < MAX_FILES) files += u to mime!! else skipped++
            }
            return Shared(text, subject, files, skipped)
        }

        @Suppress("DEPRECATION")
        private fun streamOf(intent: Intent): Uri? =
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else intent.getParcelableExtra<Parcelable>(Intent.EXTRA_STREAM) as? Uri

        @Suppress("DEPRECATION")
        private fun streamsOf(intent: Intent): List<Uri> =
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else intent.getParcelableArrayListExtra<Parcelable>(Intent.EXTRA_STREAM).orEmpty().mapNotNull { it as? Uri }
    }
}

/**
 * Share to Notes: from Chrome, Photos, a recorder app… "New note" or "Add
 * to…" one of your recent notes, then Save. Pictures and recordings are
 * copied onto the phone first (the share's permission ends with this screen)
 * and go up with the note when there's signal. Confirms with "Saved to
 * Notes — Open".
 */
class ShareToNotesActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val shared = Shared.from(intent) { contentResolver.getType(it) }
        if (shared == null || shared.isEmpty) {
            android.widget.Toast.makeText(
                this,
                if ((shared?.skipped ?: 0) > 0) "Only text, pictures and recordings can go in a note." else "There was nothing to save.",
                android.widget.Toast.LENGTH_SHORT,
            ).show()
            return finish()
        }
        setContent { CaptureTheme { ShareSheet(shared, onDone = ::finish) } }
    }
}

private sealed interface Stage {
    data object Choosing : Stage
    data object Saving : Stage
    data class Saved(val noteId: String, val online: Boolean) : Stage
    data class Failed(val message: String) : Stage
}

@Composable
private fun ShareSheet(shared: Shared, onDone: () -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    val link = remember { Widgets.link(ctx) }
    var title by remember { mutableStateOf(shared.title) }
    var addTo by remember { mutableStateOf(false) }
    var picked by remember { mutableStateOf<NoteCard?>(null) }
    var recent by remember { mutableStateOf<List<NoteCard>>(emptyList()) }
    var stage by remember { mutableStateOf<Stage>(Stage.Choosing) }
    var opening by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        if (link != Link.LINKED) return@LaunchedEffect
        recent = WidgetStore.load(ctx).snapshot.notesSection?.cards.orEmpty().filter { !it.pending && !it.gone }
        // Fresher from the server when there's signal (and the only list there is without a Notes widget).
        val account = Store(ctx).account ?: return@LaunchedEffect
        val fetched = withContext(Dispatchers.IO) { runCatching { WidgetApi(account).pick("") }.getOrNull() }
        if (!fetched.isNullOrEmpty()) recent = fetched
    }
    LaunchedEffect(stage) {
        if (stage is Stage.Saved) {
            delay(6_000)
            if (!opening) onDone()
        }
    }

    fun save() {
        if (stage != Stage.Choosing) return
        stage = Stage.Saving
        scope.launch {
            val files = mutableListOf<JSONObject>()
            try {
                withContext(Dispatchers.IO) {
                    for ((uri, mime) in shared.files) Capture.copyIn(ctx, uri, mime)?.let { files += it }
                }
            } catch (e: Capture.TooBig) {
                files.forEach { java.io.File(it.optString("path")).delete() }
                stage = Stage.Failed("One of those files is too big to put in a note (512 MB at most).")
                return@launch
            }
            if (files.isEmpty() && shared.text.isBlank()) {
                stage = Stage.Failed("Couldn't read what was shared. Try sharing it again.")
                return@launch
            }
            val now = System.currentTimeMillis()
            val target = picked
            val noteId = if (addTo && target != null) {
                WidgetStore.addToNote(ctx, target.id, target.title, shared.text, files, now)
                target.id
            } else {
                WidgetStore.addNote(ctx, "text", title.trim(), shared.text, emptyList(), "share", files, now).id
            }
            Widgets.redraw(ctx)
            WidgetSync.now(ctx)
            stage = Stage.Saved(noteId, Online.now(ctx))
        }
    }

    fun open(noteId: String) {
        opening = true
        scope.launch {
            // Wait (a little) for it to reach the server, so the page has it.
            withTimeoutOrNull(15_000) {
                while (WidgetStore.state.value.ops.any { it.id == noteId || it.body.optString("note_id") == noteId }) delay(250)
            }
            Open.go(ctx, Open.NOTES, notePath(noteId))
            onDone()
        }
    }

    BackHandler { onDone() }
    Box(Modifier.fillMaxSize().background(Color(0x66000000)).safeDrawingPadding().imePadding(), contentAlignment = Alignment.BottomCenter) {
        Card(Modifier.fillMaxWidth().widthIn(max = 560.dp).padding(12.dp), shape = RoundedCornerShape(20.dp)) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Save to Notes", style = MaterialTheme.typography.titleMedium)
                if (link != Link.LINKED) {
                    Text(
                        if (link == Link.OFF) "Widgets are off for this phone, and Share to Notes with them. Turn them on in Promptly → Account → Devices."
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
                when (val st = stage) {
                    is Stage.Saved -> {
                        Text(
                            if (st.online) "Saved to Notes." else "Saved on this phone — it goes to Notes when there's signal.",
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.semantics { contentDescription = if (st.online) "Saved to Notes" else "Saved on this phone, will sync" },
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Spacer(Modifier.weight(1f))
                            TextButton(onClick = onDone) { Text("Done") }
                            if (st.online) Button(onClick = { open(st.noteId) }, enabled = !opening) { Text(if (opening) "Opening…" else "Open") }
                        }
                        return@Column
                    }
                    is Stage.Failed -> {
                        Text(st.message, style = MaterialTheme.typography.bodyMedium)
                        Row { Spacer(Modifier.weight(1f)); TextButton(onClick = onDone) { Text("Close") } }
                        return@Column
                    }
                    else -> Unit
                }
                Preview(shared)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = !addTo, onClick = { addTo = false }, label = { Text("New note") })
                    FilterChip(selected = addTo, onClick = { addTo = true }, label = { Text("Add to…") })
                }
                if (!addTo) {
                    OutlinedTextField(
                        value = title,
                        onValueChange = { if (it.length <= 300) title = it.replace("\n", " ") },
                        placeholder = { Text(if (shared.text.contains("http")) "Title (the page's own if you leave it)" else "Title") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Title" },
                    )
                } else {
                    Column(Modifier.heightIn(max = 260.dp).verticalScroll(rememberScrollState())) {
                        if (recent.isEmpty()) Text(
                            "Your notes show here when there's signal. Or save it as a new note.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        for (n in recent) NoteChoice(n, picked?.id == n.id) { picked = n }
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (stage == Stage.Saving) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.weight(1f))
                    TextButton(onClick = onDone) { Text("Cancel") }
                    Button(onClick = { save() }, enabled = stage == Stage.Choosing && (!addTo || picked != null)) { Text("Save") }
                }
            }
        }
    }
}

@Composable
private fun Preview(shared: Shared) {
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerHighest, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (shared.text.isNotBlank()) Text(shared.text, style = MaterialTheme.typography.bodyMedium, maxLines = 4, overflow = TextOverflow.Ellipsis)
            val bits = listOfNotNull(
                shared.pictures.takeIf { it > 0 }?.let { if (it == 1) "1 picture" else "$it pictures" },
                shared.recordings.takeIf { it > 0 }?.let { if (it == 1) "1 recording" else "$it recordings" },
            )
            if (bits.isNotEmpty()) Text(bits.joinToString(" · "), style = MaterialTheme.typography.bodyMedium)
            if (shared.skipped > 0) Text(
                if (shared.skipped == 1) "1 file was left out: only pictures and recordings go in a note."
                else "${shared.skipped} files were left out: only pictures and recordings go in a note.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun NoteChoice(n: NoteCard, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().selectable(selected = selected, onClick = onClick, role = Role.RadioButton).padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Spacer(Modifier.size(8.dp))
        Box(Modifier.size(10.dp).clip(CircleShape).background(NoteColors.swatch(n.color)))
        Spacer(Modifier.size(8.dp))
        Column(Modifier.weight(1f)) {
            Text(n.title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (n.isList) Text(if (n.left == 1) "1 item left" else "${n.left} items left", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** A note colour's swatch in the app's screens (the widget has its own light/dark pairs). */
object NoteColors {
    fun swatch(name: String): Color = when (name) {
        "coral" -> Color(0xFFFAAFA8)
        "peach" -> Color(0xFFF39F76)
        "sand" -> Color(0xFFFFF8B8)
        "mint" -> Color(0xFFE2F6D3)
        "sage" -> Color(0xFFB4DDD3)
        "fog" -> Color(0xFFD4E4ED)
        "storm" -> Color(0xFFAECCDC)
        "dusk" -> Color(0xFFD3BFDB)
        "blossom" -> Color(0xFFF6E2DD)
        "clay" -> Color(0xFFE9E3D4)
        "chalk" -> Color(0xFFEFEFF1)
        else -> Color(0xFFD6D3D1)
    }
}
