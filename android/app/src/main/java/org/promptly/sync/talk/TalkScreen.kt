package org.promptly.sync.talk

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/** What the Talk screen can ask for. */
interface TalkActions {
    fun close()
    fun end()
    fun stop()
    fun toggleMute()
    fun orb()
    fun confirm(yes: Boolean)
    fun text(words: String)
    fun captions(on: Boolean)
    fun openCard(card: TalkCard)
    fun oneAtATime()
    fun clearNotice()
    fun settings()
}

private val EXAMPLES = listOf("What's on today?", "Add milk to my shopping list", "Remind me to call Mum at six", "Set a timer for ten minutes")

/** The Talk screen on the phone: same layout and states as the web's phone screen.
 *  Captions, the orb, one status phrase, the yes/no card, things to look at, and
 *  Mute · Stop · Type · End. */
@Composable
fun TalkScreen(ui: TalkUi, actions: TalkActions, modifier: Modifier = Modifier) {
    var typing by rememberSaveable { mutableStateOf(false) }
    val accent = MaterialTheme.colorScheme.primary
    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        // Header: what this is, its state, captions, close.
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(10.dp).background(dotColor(ui, accent), CircleShape))
            Text("Promptly", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { actions.captions(!ui.captions) }, modifier = Modifier.semantics { contentDescription = if (ui.captions) "Hide captions" else "Show captions" }) {
                Text(if (ui.captions) "CC on" else "CC off")
            }
            TextButton(onClick = actions::close) { Text("Close") }
        }

        if (ui.weak) {
            Callout("Weak connection. Answers may lag.", "One question at a time", actions::oneAtATime)
        }
        ui.notice?.let { Callout(it, "OK", actions::clearNotice) }

        // Captions, or how to start.
        if (ui.captions) {
            if (ui.exchanges.isEmpty()) EmptyState(ui, actions) else Captions(ui)
        } else {
            Spacer(Modifier.height(8.dp))
        }

        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { Orb(ui, accent, actions::orb) }
        Text(
            status(ui),
            Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )

        ui.ask?.let { AskCard(it, actions) }

        if (ui.cards.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ui.cards.takeLast(3).forEach { card ->
                    Surface(
                        Modifier.clickable(enabled = card.url != null, role = Role.Button) { actions.openCard(card) },
                        shape = RoundedCornerShape(12.dp),
                        tonalElevation = 2.dp,
                    ) {
                        Text(card.title, Modifier.padding(horizontal = 12.dp, vertical = 8.dp), style = MaterialTheme.typography.labelLarge, maxLines = 1)
                    }
                }
            }
        }

        if (typing) TypeBox(onSend = { actions.text(it); typing = false }, onCancel = { typing = false })

        // Mute · Stop · Type instead · End.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            val live = ui.phase == Phase.LIVE || ui.phase == Phase.RECONNECTING
            val pad = PaddingValues(horizontal = 14.dp, vertical = 8.dp)
            OutlinedButton(onClick = actions::toggleMute, enabled = live, contentPadding = pad) { Text(if (ui.muted || ui.paused) "Unmute" else "Mute") }
            OutlinedButton(onClick = actions::stop, enabled = live, contentPadding = pad) { Text("Stop") }
            OutlinedButton(onClick = { typing = !typing }, enabled = live, contentPadding = pad) { Text("Type") }
            Button(onClick = actions::end, contentPadding = pad) { Text("End") }
        }
    }
}

private fun dotColor(ui: TalkUi, accent: Color): Color = when {
    ui.phase == Phase.RECONNECTING || ui.phase == Phase.STARTING -> Color(0xFFE0A030)
    ui.phase == Phase.ENDED -> Color.Gray
    ui.muted || ui.paused -> Color.Gray
    else -> accent
}

/** One short phrase for where things are. */
fun status(ui: TalkUi): String = when {
    ui.phase == Phase.STARTING -> "Starting…"
    ui.phase == Phase.RECONNECTING -> "Reconnecting…"
    ui.phase == Phase.ENDED -> "Finished"
    ui.paused -> "Paused while another app uses the audio. Tap Unmute to carry on."
    ui.muted -> "Muted. Tap to unmute."
    ui.ask != null && ui.state == "listening" -> "Say yes or no, or tap one."
    ui.turnMode == "tap" && ui.talking -> "Listening. Tap when you're done."
    ui.turnMode == "tap" && ui.state == "listening" -> "Tap the circle to talk."
    ui.state == "thinking" -> ui.tool?.let { "$it…" } ?: "Thinking"
    ui.state == "speaking" -> if (ui.interruptMode == "talk" && ui.turnMode == "hands_free") "Speaking. Talk to interrupt." else "Speaking. Tap Stop to interrupt."
    else -> "Listening"
}

@Composable
private fun Callout(words: String, button: String, onClick: () -> Unit) {
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.secondaryContainer) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(words, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
            TextButton(onClick = onClick) { Text(button) }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EmptyState(ui: TalkUi, actions: TalkActions) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            if (ui.turnMode == "tap") "Tap the circle and talk, then tap again when you're done. Say \"that's all\" to finish."
            else "Just start talking. Talk over me any time to interrupt. Say \"that's all\" to finish.",
            style = MaterialTheme.typography.bodyLarge,
        )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            EXAMPLES.forEach { example ->
                Surface(
                    Modifier.clickable(enabled = ui.phase == Phase.LIVE, role = Role.Button) { actions.text(example) },
                    shape = RoundedCornerShape(16.dp),
                    tonalElevation = 2.dp,
                ) {
                    Text(example, Modifier.padding(horizontal = 12.dp, vertical = 8.dp), style = MaterialTheme.typography.labelLarge)
                }
            }
        }
        TextButton(onClick = actions::settings) { Text("Voice settings") }
    }
}

@Composable
private fun Captions(ui: TalkUi) {
    val list = rememberLazyListState()
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val strong = MaterialTheme.colorScheme.onSurface
    LaunchedEffect(ui.exchanges.size, ui.exchanges.lastOrNull()?.reply?.length) {
        if (ui.exchanges.isNotEmpty()) list.animateScrollToItem(ui.exchanges.size - 1)
    }
    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 300.dp), state = list, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        items(ui.exchanges, key = { it.key }) { x ->
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (x.you.isNotEmpty()) {
                    Text(x.you, style = MaterialTheme.typography.bodyMedium, color = muted, modifier = Modifier.alpha(if (x.youFinal) 1f else 0.7f))
                }
                if (x.reply.isNotEmpty()) {
                    // The part already said in full colour; the rest dimmed.
                    val said = x.spoken.coerceIn(0, x.reply.length).let { if (x.replyDone && !x.interrupted && it == 0) x.reply.length else it }
                    Text(
                        buildAnnotatedString {
                            withStyle(SpanStyle(color = strong)) { append(x.reply.substring(0, said)) }
                            withStyle(SpanStyle(color = strong.copy(alpha = 0.45f))) { append(x.reply.substring(said)) }
                            if (x.interrupted) withStyle(SpanStyle(color = muted)) { append(" …") }
                        },
                        style = MaterialTheme.typography.titleMedium,
                    )
                }
            }
        }
    }
}

@Composable
private fun Orb(ui: TalkUi, accent: Color, onTap: () -> Unit) {
    val motion = rememberInfiniteTransition(label = "orb")
    val breathe by motion.animateFloat(0.92f, 1.04f, infiniteRepeatable(tween(1600), RepeatMode.Reverse), label = "breathe")
    val shimmer by motion.animateFloat(0.45f, 1f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "shimmer")
    val ring by motion.animateFloat(0f, 1f, infiniteRepeatable(tween(1400, easing = LinearEasing)), label = "ring")
    val quiet = ui.muted || ui.paused || ui.phase == Phase.ENDED
    val grey = MaterialTheme.colorScheme.outline
    val label = when {
        ui.turnMode == "tap" && ui.talking -> "Done talking"
        ui.turnMode == "tap" -> "Talk"
        quiet -> "Unmute"
        ui.state == "speaking" -> "Stop speaking"
        else -> "Listening"
    }
    Canvas(
        Modifier.size(150.dp)
            .clickable(role = Role.Button, onClickLabel = label, onClick = onTap)
            .semantics { contentDescription = label },
    ) {
        val c = Offset(size.width / 2, size.height / 2)
        val base = size.minDimension * 0.28f
        when {
            quiet -> {
                drawCircle(grey.copy(alpha = 0.25f), base, c)
                drawCircle(grey, base, c, style = Stroke(4.dp.toPx()))
                // A line through it: not listening.
                drawLine(grey, Offset(c.x - base * 0.6f, c.y - base * 0.6f), Offset(c.x + base * 0.6f, c.y + base * 0.6f), 4.dp.toPx(), StrokeCap.Round)
            }
            ui.phase != Phase.LIVE -> drawCircle(Color(0xFFE0A030).copy(alpha = 0.5f + 0.4f * shimmer), base, c)
            ui.state == "thinking" -> drawCircle(accent.copy(alpha = shimmer), base, c)
            ui.state == "speaking" -> {
                for (k in 0..1) {
                    val t = (ring + k * 0.5f) % 1f
                    drawCircle(accent.copy(alpha = (1f - t) * 0.5f), base * (1f + t * 0.75f), c, style = Stroke(3.dp.toPx()))
                }
                drawCircle(accent, base, c)
            }
            else -> {
                // Listening: a breathing ring, bigger while it hears you.
                val halo = if (ui.hearing) 1.45f else 1.15f * breathe
                drawCircle(accent.copy(alpha = 0.18f), base * halo, c)
                drawCircle(accent, base * breathe, c)
            }
        }
    }
}

@Composable
private fun AskCard(ask: PendingAsk, actions: TalkActions) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(ask.approvalId) {
        while (true) {
            now = System.currentTimeMillis()
            delay(250)
        }
    }
    val left = ((ask.expiresAt - now).coerceAtLeast(0).toFloat() / (ask.ttlMs + 3000).coerceAtLeast(1))
    Surface(shape = RoundedCornerShape(16.dp), tonalElevation = 3.dp, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(ask.question, style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { actions.confirm(true) }) { Text("Yes") }
                OutlinedButton(onClick = { actions.confirm(false) }) { Text("No") }
            }
            LinearProgressIndicator(progress = { left }, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun TypeBox(onSend: (String) -> Unit, onCancel: () -> Unit) {
    var words by rememberSaveable { mutableStateOf("") }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            words,
            { words = it },
            Modifier.weight(1f),
            placeholder = { Text("Type instead") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { if (words.isNotBlank()) onSend(words) }),
        )
        TextButton(onClick = { if (words.isNotBlank()) onSend(words) else onCancel() }) { Text(if (words.isBlank()) "Cancel" else "Send") }
    }
}
