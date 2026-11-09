package org.promptly.sync.capture

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.delay
import org.promptly.sync.MainActivity
import org.promptly.sync.widgets.Link
import org.promptly.sync.widgets.Widgets

/**
 * Voice note: starts recording the moment it opens (asking for the
 * microphone the first time), with a timer and level, Pause, **Stop & save**
 * and Discard. "Keep recording in the background" (or Back) leaves the
 * recording going in its notification, so the screen can lock. Saved notes
 * wait on the phone until there's signal; the server transcribes them.
 */
class VoiceNoteActivity : ComponentActivity() {
    private var denied by mutableStateOf(false)
    private var askedOnce = false

    private val ask = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) begin() else denied = true
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Recorder.saved.value = null
        val link = Widgets.link(this)
        setContent { CaptureTheme { VoiceNote(link, denied, onDone = ::finish, onRetry = ::askAgain) } }
        if (link == Link.LINKED && savedInstanceState == null) startOrAsk()
    }

    private fun startOrAsk() {
        if (Recorder.state.value.phase != Phase.IDLE) return // already recording: just show it
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) begin()
        else {
            askedOnce = true
            ask.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun begin() {
        denied = false
        RecorderService.send(this, RecorderService.ACTION_START)
    }

    private fun askAgain() {
        if (askedOnce && !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)) {
            // "Don't ask again": only Settings can turn it on.
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        } else startOrAsk()
    }

    override fun onResume() {
        super.onResume()
        if (denied && ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) begin()
    }
}

@Composable
private fun VoiceNote(link: Link, denied: Boolean, onDone: () -> Unit, onRetry: () -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val s by Recorder.state.collectAsState()
    val saved by Recorder.saved.collectAsState()
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    var confirmDiscard by remember { mutableStateOf(false) }
    var started by remember { mutableStateOf(false) }

    LaunchedEffect(s.phase) {
        if (s.phase != Phase.IDLE) started = true
        while (s.phase == Phase.RECORDING || s.phase == Phase.PAUSED) {
            now = SystemClock.elapsedRealtime()
            delay(200)
        }
    }
    // Saved (or discarded) after it started: this screen's job is done.
    LaunchedEffect(saved, s.phase, started) {
        if (started && s.phase == Phase.IDLE && s.error == null) onDone()
    }

    fun background() {
        if (s.phase == Phase.RECORDING || s.phase == Phase.PAUSED) {
            Toast.makeText(ctx, "Still recording — it's in your notifications.", Toast.LENGTH_SHORT).show()
        }
        onDone()
    }

    BackHandler { background() }
    Box(
        Modifier.fillMaxSize().background(Color(0x66000000)).safeDrawingPadding(),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Card(Modifier.fillMaxWidth().widthIn(max = 560.dp).padding(12.dp), shape = RoundedCornerShape(20.dp)) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Voice note", style = MaterialTheme.typography.titleMedium)
                when {
                    link != Link.LINKED -> {
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
                    }
                    denied -> {
                        Text("To record a voice note, Promptly needs your microphone. It only listens while you record.", style = MaterialTheme.typography.bodyMedium)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = onDone) { Text("Not now") }
                            Button(onClick = onRetry) { Text("Allow microphone") }
                        }
                    }
                    s.error != null -> {
                        Text(s.error!!, style = MaterialTheme.typography.bodyMedium)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = { Recorder.set(RecState()); onDone() }) { Text("Close") }
                            Button(onClick = { Recorder.set(RecState()); onRetry() }) { Text("Try again") }
                        }
                    }
                    else -> Recording(s, now, onPause = {
                        RecorderService.send(ctx, if (s.phase == Phase.PAUSED) RecorderService.ACTION_RESUME else RecorderService.ACTION_PAUSE)
                    }, onSave = {
                        RecorderService.send(ctx, RecorderService.ACTION_SAVE)
                    }, onDiscard = {
                        if (s.elapsed(now) > 5_000) confirmDiscard = true else RecorderService.send(ctx, RecorderService.ACTION_DISCARD)
                    }, onBackground = ::background)
                }
            }
        }
    }
    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            title = { Text("Discard this recording?") },
            text = { Text("It hasn't been saved anywhere.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDiscard = false
                    RecorderService.send(ctx, RecorderService.ACTION_DISCARD)
                }) { Text("Discard") }
            },
            dismissButton = { TextButton(onClick = { confirmDiscard = false }) { Text("Keep recording") } },
        )
    }
}

@Composable
private fun Recording(s: RecState, now: Long, onPause: () -> Unit, onSave: () -> Unit, onDiscard: () -> Unit, onBackground: () -> Unit) {
    val recording = s.phase == Phase.RECORDING
    val saving = s.phase == Phase.SAVING || s.phase == Phase.IDLE
    val red = Color(0xFFD93025)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(10.dp).clip(CircleShape).background(if (recording) red else MaterialTheme.colorScheme.outline))
        Spacer(Modifier.size(8.dp))
        Text(
            when (s.phase) {
                Phase.RECORDING -> "Recording"
                Phase.PAUSED -> "Paused"
                else -> "Starting…"
            },
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
    Text(
        RecorderLogic.clock(s.elapsed(now)),
        style = MaterialTheme.typography.displaySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 44.sp),
        modifier = Modifier.semantics { contentDescription = "Length " + RecorderLogic.clock(s.elapsed(now)) },
    )
    Levels(s.samples, MaterialTheme.colorScheme.primary, Modifier.fillMaxWidth().height(48.dp))
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = onDiscard, enabled = !saving) { Text("Discard") }
        Spacer(Modifier.weight(1f))
        OutlinedButton(onClick = onPause, enabled = !saving) { Text(if (s.phase == Phase.PAUSED) "Resume" else "Pause") }
        Button(onClick = onSave, enabled = !saving, colors = ButtonDefaults.buttonColors()) { Text("Stop & save") }
    }
    TextButton(onClick = onBackground, enabled = !saving, modifier = Modifier.fillMaxWidth()) { Text("Keep recording in the background") }
}

/** The last few seconds of level, as bars (newest on the right). */
@Composable
private fun Levels(samples: List<Float>, color: Color, modifier: Modifier) {
    Canvas(modifier.semantics { contentDescription = "Sound level" }) {
        val bars = 60
        val w = size.width / bars
        val shown = samples.takeLast(bars)
        val offset = bars - shown.size
        for (i in 0 until bars) {
            val v = if (i < offset) 0f else shown[i - offset]
            val h = maxOf(2.dp.toPx(), v * size.height)
            drawRoundRect(
                color = if (i < offset) color.copy(alpha = 0.2f) else color,
                topLeft = Offset(i * w + w * 0.2f, (size.height - h) / 2),
                size = Size(w * 0.6f, h),
                cornerRadius = CornerRadius(w * 0.3f, w * 0.3f),
            )
        }
    }
}
