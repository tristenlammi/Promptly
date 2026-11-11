package org.promptly.sync.maps

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** A sheet up from the bottom of the driving screen. Back, or a tap outside, closes it. */
@Composable
private fun Sheet(onClose: () -> Unit, content: @Composable () -> Unit) {
    BackHandler(onBack = onClose)
    Box(Modifier.fillMaxSize().background(Color(0x66000000)).clickable(onClick = onClose), contentAlignment = Alignment.BottomCenter) {
        Surface(shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp), modifier = Modifier.fillMaxWidth().clickable(enabled = false) {}) {
            Column(Modifier.safeDrawingPadding().imePadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { content() }
        }
    }
}

/** Who can watch this trip: people on your Promptly, nobody else. They see where you
 *  are and when you'll arrive until you get there, end the trip or stop sharing. */
@Composable
internal fun ShareTripSheet(sharedWith: List<Nav.Person>, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var found by remember { mutableStateOf<List<Nav.Person>?>(null) }
    var failed by remember { mutableStateOf(false) }
    // Ticked to begin with: who's watching now, or who you shared your last trip with.
    var ticked by remember { mutableStateOf(sharedWith.ifEmpty { Nav.lastSharedWith() }) }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(query) {
        if (query.isNotEmpty()) delay(300)
        runCatching { Nav.peopleToShareWith(query) }
            .onSuccess {
                found = it
                failed = false
            }
            .onFailure {
                if (it is kotlinx.coroutines.CancellationException) throw it
                found = emptyList()
                failed = true
            }
    }
    Sheet(onClose) {
        Text(if (sharedWith.isEmpty()) "Share this trip" else "Sharing this trip", fontWeight = FontWeight.SemiBold, fontSize = 20.sp, modifier = Modifier.semantics { heading() })
        Text(
            "They'll see where you are and when you'll arrive, until you get there or end the trip. Only people on your Promptly.",
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            singleLine = true,
            placeholder = { Text("Find someone") },
            modifier = Modifier.fillMaxWidth(),
        )
        val rows = (ticked + found.orEmpty()).distinctBy { it.id }
            .filter { query.isBlank() || it.name.contains(query.trim(), ignoreCase = true) || found.orEmpty().any { f -> f.id == it.id } }
        Column(Modifier.heightIn(max = 260.dp).verticalScroll(rememberScrollState())) {
            when {
                found == null && rows.isEmpty() -> CircularProgressIndicator()
                rows.isEmpty() -> Text(
                    when {
                        failed -> "Couldn't get the list. Check your signal and try again."
                        query.isBlank() -> "Nobody else is on your Promptly yet."
                        else -> "Nobody by that name."
                    },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                else -> rows.forEach { person ->
                    val on = ticked.any { it.id == person.id }
                    Row(
                        Modifier.fillMaxWidth()
                            .toggleable(value = on, role = Role.Checkbox) { ticked = if (it) ticked + person else ticked.filterNot { t -> t.id == person.id } }
                            .padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Checkbox(checked = on, onCheckedChange = null)
                        Text(person.name, fontSize = 18.sp)
                    }
                }
            }
        }
        problem?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(
                enabled = ticked.isNotEmpty() && !busy,
                onClick = {
                    busy = true
                    problem = null
                    scope.launch {
                        runCatching { Nav.shareTrip(ticked) }
                            .onSuccess { onClose() }
                            .onFailure {
                                problem = "Couldn't share it just now. Check your signal and try again."
                                // Nothing's being shared that the phone thinks isn't.
                                if (sharedWith.isEmpty()) Nav.endTripShare()
                            }
                        busy = false
                    }
                },
            ) { Text(if (sharedWith.isEmpty()) "Share" else "Update") }
            if (sharedWith.isNotEmpty()) {
                OutlinedButton(onClick = {
                    Nav.endTripShare()
                    onClose()
                }) { Text("Stop sharing") }
            }
            OutlinedButton(onClick = onClose) { Text("Close") }
        }
    }
}

/** What you can change mid-trip without ending it: the map's colours and the speeding beep. */
@Composable
internal fun TripOptionsSheet(onClose: () -> Unit) {
    val theme by Nav.themeNow.collectAsState()
    val speeding by Nav.speedWarningNow.collectAsState()
    Sheet(onClose) {
        Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState())) {
            Text("Map colours", fontWeight = FontWeight.SemiBold, fontSize = 18.sp, modifier = Modifier.padding(bottom = 4.dp).semantics { heading() })
            MapTheme.entries.forEach { choice -> Choice(choice.label, theme == choice) { Nav.setTheme(choice) } }
            Text("Speeding beep", fontWeight = FontWeight.SemiBold, fontSize = 18.sp, modifier = Modifier.padding(top = 14.dp, bottom = 4.dp).semantics { heading() })
            Text("A short beep when you go over the limit, where the map knows it.", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            SpeedWarning.entries.forEach { choice -> Choice(choice.label, speeding == choice) { Nav.setSpeedWarning(choice) } }
        }
        OutlinedButton(onClick = onClose) { Text("Done") }
    }
}

@Composable
private fun Choice(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().selectable(selected = selected, role = Role.RadioButton, onClick = onClick).padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        RadioButton(selected = selected, onClick = null)
        Text(label, fontSize = 18.sp)
    }
}
