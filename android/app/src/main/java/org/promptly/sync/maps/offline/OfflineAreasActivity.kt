package org.promptly.sync.maps.offline

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.work.WorkInfo
import androidx.work.WorkManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.promptly.sync.maps.Maps
import org.promptly.sync.maps.offline.Offline.autoUpdate
import org.promptly.sync.maps.offline.Offline.wifiOnly
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** P Maps → Offline areas: what's kept on this phone for when there's no signal.
 *
 *  `promptlymaps://offline?server=…&code=…[&area=<id>]`: the web's hand-off (signs
 *  this phone in to P Maps with the one-time code, then opens the area and starts
 *  its download). Also opened from Photo backup and from the download notification. */
class OfflineAreasActivity : ComponentActivity() {
    private val link = mutableStateOf<Link?>(null)

    data class Link(val server: String?, val code: String?, val area: String?)

    private fun parse(intent: Intent?): Link? {
        val uri: Uri = intent?.data ?: return null
        if (uri.scheme != "promptlymaps" || uri.host != "offline") return null
        return Link(uri.getQueryParameter("server"), uri.getQueryParameter("code"), uri.getQueryParameter("area"))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        link.value = parse(intent)
        setContent {
            OfflineTheme {
                val l by link
                OfflineScreens(l, onClose = { finish() })
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        parse(intent)?.let { link.value = it }
    }
}

@Composable
fun OfflineTheme(content: @Composable () -> Unit) {
    val scheme = if (isSystemInDarkTheme()) {
        darkColorScheme(primary = Color(0xFFE38B6D), secondary = Color(0xFFE38B6D), onPrimary = Color(0xFF3A1A0E))
    } else {
        lightColorScheme(primary = Color(0xFFC8613F), secondary = Color(0xFFC8613F), onPrimary = Color.White)
    }
    MaterialTheme(colorScheme = scheme) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background, content = content)
    }
}

private sealed class Screen {
    data object List : Screen()
    data class Area(val id: String) : Screen()
    data object Choose : Screen()
}

@Composable
private fun OfflineScreens(link: OfflineAreasActivity.Link?, onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var screen by remember { mutableStateOf<Screen>(Screen.List) }
    var signedIn by remember { mutableStateOf(Maps.server(context) != null && link?.code == null) }
    var signInProblem by remember { mutableStateOf<String?>(null) }
    var overview by remember { mutableStateOf(Offline.saved(context)) }
    var loadProblem by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var style by remember { mutableStateOf<String?>(null) }
    var home by remember { mutableStateOf<Pair<Double, Double>?>(null) }
    val changed by Offline.changed.collectAsState()
    var tick by remember { mutableIntStateOf(0) }

    LaunchedEffect(link) {
        if (link?.code != null || (Maps.server(context) == null && link != null)) {
            runCatching { Maps.signIn(context, link.server, link.code) }
                .onSuccess { signedIn = true; signInProblem = null }
                .onFailure { signInProblem = it.message ?: "Couldn't sign in." }
        } else signedIn = Maps.server(context) != null
        if (link?.area != null && signedIn) {
            screen = Screen.Area(link.area)
            Offline.download(context)
        }
    }

    // The server's list, each time the screen opens.
    LifecycleResumeEffect(signedIn) {
        val job = scope.launch {
            if (!signedIn) return@launch
            loading = true
            Offline.daily(context)
            runCatching { withContext(Dispatchers.IO) { Offline.refresh(context) } }
                .onSuccess { ov ->
                    overview = ov
                    loadProblem = null
                    val store = Offline.store(context)
                    val areas = ov.areas.filter { it.id !in store.state.deleted }
                    // Deleted (or house numbers left out) on the web: free the space now.
                    withContext(Dispatchers.IO) { Offline.tidy(context, ov) }
                    // Something to fetch (an area saved on the web, say): start, or wait for Wi-Fi.
                    if (ov.enabled && ov.ready && areas.any { !store.has(it.cells, it.withAddresses) }) Offline.download(context)
                    // Tell the web which areas have an update waiting on this phone.
                    if (ov.build != null && store.state.syncedBuild != null && store.state.syncedBuild != ov.build) {
                        withContext(Dispatchers.IO) {
                            val api = Offline.api(context)
                            areas.filter { store.has(it.cells, it.withAddresses) }.forEach { a ->
                                runCatching { api?.report(a.id, Offline.deviceId(context), Offline.deviceName(context), "update", store.state.syncedBuild, store.cellBytes(a.cells)) }
                            }
                        }
                    }
                }
                .onFailure { loadProblem = it.message ?: "Couldn't reach your server." }
            loading = false
            style = runCatching { Maps.styleFile(context) }.getOrNull()
            home = runCatching { Maps.myPlaces(context).firstOrNull { it.kind == "home" }?.let { it.lat to it.lon } }.getOrNull()
        }
        onPauseOrDispose { job.cancel() }
    }
    // Sizes and free space move while downloading.
    LaunchedEffect(Unit) {
        while (true) {
            delay(2000)
            tick++
        }
    }

    BackHandler(enabled = screen != Screen.List) { screen = Screen.List }

    when {
        signInProblem != null -> Message("Offline areas", signInProblem!!, onClose)
        !signedIn -> Message(
            "Offline areas",
            "Sign in to P Maps on this phone first: open P Maps on the web and start a trip, or open Offline areas from P Maps there.",
            onClose,
        )
        else -> when (val s = screen) {
            Screen.List -> AreaList(overview, loading, loadProblem, home, changed + tick, onOpen = { screen = Screen.Area(it) }, onChoose = { screen = Screen.Choose }, onClose = onClose) {
                overview = Offline.saved(context)
            }
            is Screen.Area -> {
                val area = overview?.areas?.firstOrNull { it.id == s.id }
                if (area == null) {
                    if (loading) Centre { CircularProgressIndicator() } else Message("Offline area", "That area isn't on your list any more.") { screen = Screen.List }
                } else {
                    AreaPage(area, overview!!, style, changed + tick, onBack = { screen = Screen.List }) {
                        overview = Offline.saved(context)
                    }
                }
            }
            Screen.Choose -> {
                val st = style
                if (st == null) {
                    Message("Choose an area", loadProblem ?: "The map needs a connection to your server. Try again when you have signal.") { screen = Screen.List }
                } else {
                    ChooseArea(st, home, onBack = { screen = Screen.List }) { area ->
                        overview = Offline.saved(context)
                        screen = Screen.List
                        if (overview?.areas?.none { it.id == area.id } == true) overview = overview?.copy(areas = listOf(area) + overview!!.areas)
                    }
                }
            }
        }
    }
}

// ---- What each area is doing ------------------------------------------------------

internal data class AreaStatus(val text: String, val progress: Float? = null, val ready: Boolean = false, val update: Boolean = false, val waitingForWifi: Boolean = false)

@Composable
private fun downloadWork(): WorkInfo? {
    val context = LocalContext.current
    val infos by WorkManager.getInstance(context).getWorkInfosForUniqueWorkFlow(Offline.DOWNLOAD).collectAsState(initial = emptyList())
    return infos.firstOrNull { !it.state.isFinished }
}

private fun status(context: android.content.Context, area: OfflineApi.Area, overview: OfflineApi.Overview, run: OfflineEngine.Progress?, work: WorkInfo?): AreaStatus {
    val store = Offline.store(context)
    val s = store.state
    val has = store.has(area.cells, area.withAddresses)
    if (run != null) {
        val (have, total) = run.forCells(area.cells)
        if (total > 0 && have < total) {
            val pct = OfflineDownloadWorker.percent(have, total)
            val verb = if (has || run.updating) "Updating" else "Downloading"
            return AreaStatus("$verb $pct% · ${Sizes.text(have)} of ${Sizes.text(total)}", have.toFloat() / total)
        }
    }
    if (has) {
        val date = s.syncedBuild?.let { s.builds[it] }?.let(::shortDate)
        return if (overview.build != null && s.syncedBuild != overview.build) {
            AreaStatus(if (run != null) "Updating…" else "Update ready" + (date?.let { " · map from $it" } ?: ""), ready = true, update = true)
        } else AreaStatus("Ready" + (date?.let { " · map from $it" } ?: ""), ready = true)
    }
    if (run != null) return AreaStatus("Downloading…", 0f)
    if (s.problem == "no_space" || s.noSpace != null) return AreaStatus("Not enough space")
    val waiting = work?.state == WorkInfo.State.ENQUEUED || work?.state == WorkInfo.State.BLOCKED
    with(Offline) {
        if (waiting && context.wifiOnly && !Offline.onWifi(context)) return AreaStatus("Waiting for Wi-Fi", waitingForWifi = true)
    }
    if (s.problem != null) return AreaStatus("Download stopped")
    if (!overview.ready) return AreaStatus(if (overview.building) "Waiting for your server's maps" else "Not downloaded")
    return AreaStatus(if (waiting || work?.state == WorkInfo.State.RUNNING) "Waiting to download" else "Not downloaded")
}

private fun shortDate(iso: String): String? = runCatching {
    OffsetDateTime.parse(iso.replace("Z", "+00:00")).atZoneSameInstant(ZoneId.systemDefault())
        .format(DateTimeFormatter.ofPattern("d MMM", Locale.getDefault()))
}.getOrNull()

// ---- The list --------------------------------------------------------------------

@Composable
private fun AreaList(
    overview: OfflineApi.Overview?,
    loading: Boolean,
    problem: String?,
    home: Pair<Double, Double>?,
    @Suppress("UNUSED_PARAMETER") refresh: Int,
    onOpen: (String) -> Unit,
    onChoose: () -> Unit,
    onClose: () -> Unit,
    onChanged: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val run by Offline.run.collectAsState()
    val work = downloadWork()
    val store = Offline.store(context)
    val s = store.state
    val areas = overview?.areas.orEmpty().filter { it.id !in s.deleted }
    var askMobile by remember { mutableStateOf(false) }
    var askDrop by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf<String?>(null) }
    var actionProblem by remember { mutableStateOf<String?>(null) }

    Column(
        Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Offline areas", Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            TextButton(onClick = onClose) { Text("Close") }
        }
        StorageBar(store.diskBytes(), Offline.freeSpace(context))

        // Plain words for what's wrong.
        val serverProblem = when {
            overview != null && !overview.enabled -> OffOnServer().message
            overview != null && !overview.ready && overview.building -> StillBuilding().message
            overview != null && !overview.ready -> "Your server doesn't have offline maps yet. They're made with its next map update."
            else -> null
        }
        serverProblem?.let { Notice(it) }
        if (problem != null && overview == null) Notice(problem)
        else if (problem != null) Text("Couldn't reach your server, so this is the list from last time.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

        val incomplete = areas.any { !store.has(it.cells, it.withAddresses) }
        if (s.noSpace != null && (incomplete || s.syncedBuild != overview?.build)) {
            val need = s.noSpace ?: 0
            val free = s.noSpaceFree ?: Offline.freeSpace(context)
            Notice(
                if (s.noSpaceCanDrop) "Updating needs ${Sizes.text(need - free)} more space. Update by removing the old copy first? Offline directions are off until it's done."
                else "Not enough space: this needs ${Sizes.text(need)} and your phone has ${Sizes.text(free)} free. Delete an area or free up space, then try again.",
                error = true,
            ) {
                if (s.noSpaceCanDrop) Button(onClick = { askDrop = true }) { Text("Remove old copy and update") }
                OutlinedButton(onClick = { s.noSpace = null; s.problem = null; store.save(); Offline.download(context); onChanged() }) { Text("Try again") }
            }
        } else if (s.problem != null && s.problem != "no_space" && incomplete && run == null &&
            areas.none { status(context, it, overview!!, null, work).waitingForWifi }
        ) {
            Notice(s.problem!!)
        }

        if (overview == null && loading) {
            Centre(Modifier.fillMaxWidth().height(160.dp)) { CircularProgressIndicator() }
        } else if (areas.isEmpty() && overview != null && overview.enabled) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("No offline areas yet", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(
                        "Save an area to keep the map, search and directions when there's no signal.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (home != null) {
                        Button(
                            onClick = {
                                busy = "home"
                                actionProblem = null
                                scope.launch {
                                    runCatching {
                                        withContext(Dispatchers.IO) {
                                            val api = Offline.api(context) ?: throw SignedOut()
                                            val area = api.createAround("Around Home", home.first, home.second, 30.0, true)
                                            Offline.refresh(context)
                                            runCatching { api.report(area.id, Offline.deviceId(context), Offline.deviceName(context), "waiting", null, 0) }
                                        }
                                    }.onSuccess { Offline.download(context); onChanged() }
                                        .onFailure { actionProblem = it.message ?: "Couldn't save the area." }
                                    busy = null
                                }
                            },
                            enabled = busy == null && overview.ready,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(if (busy == "home") "Saving…" else "Save the area around Home") }
                    }
                    OutlinedButton(onClick = onChoose, enabled = overview.ready, modifier = Modifier.fillMaxWidth()) { Text("Choose an area") }
                    actionProblem?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                }
            }
        } else if (areas.isNotEmpty()) {
            Card(Modifier.fillMaxWidth()) {
                Column {
                    areas.forEachIndexed { i, a ->
                        if (i > 0) HorizontalDivider()
                        AreaRow(a, status(context, a, overview!!, run, work)) { onOpen(a.id) }
                    }
                }
            }
            val statuses = areas.map { status(context, it, overview!!, run, work) }
            if (statuses.any { it.update } && run == null) {
                Button(
                    onClick = { s.noSpace = null; s.problem = null; store.save(); Offline.download(context); onChanged() },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Update now") }
            }
            val waitingForWifi = statuses.any { it.waitingForWifi }
            if (waitingForWifi) {
                OutlinedButton(onClick = { askMobile = true }, modifier = Modifier.fillMaxWidth()) { Text("Download now on mobile data") }
            }
            if (overview != null && overview.ready && areas.size < overview.maxAreas) {
                OutlinedButton(onClick = onChoose, modifier = Modifier.fillMaxWidth()) { Text("Choose another area") }
            } else if (overview != null && areas.size >= overview.maxAreas) {
                Text("You have ${overview.maxAreas} areas, the most there can be. Delete one to add another.", style = MaterialTheme.typography.bodySmall)
            }
        }

        if (overview != null) Settings(onChanged)
        overview?.attribution?.takeIf { it.isNotBlank() }?.let {
            Text(
                "Map data: $it. Offline areas are kept on this phone; trips and searches made offline stay on it.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    if (askMobile) {
        val left = areas.filter { !store.has(it.cells, it.withAddresses) }.sumOf { it.bytes ?: 0 }
        AlertDialog(
            onDismissRequest = { askMobile = false },
            title = { Text("Download on mobile data?") },
            text = { Text("This uses up to ${Sizes.text(left)} of your mobile data, this once. Wi-Fi only stays on for next time.") },
            confirmButton = { TextButton(onClick = { askMobile = false; Offline.download(context, mobileData = true) }) { Text("Use mobile data") } },
            dismissButton = { TextButton(onClick = { askMobile = false }) { Text("Wait for Wi-Fi") } },
        )
    }
    if (askDrop) {
        AlertDialog(
            onDismissRequest = { askDrop = false },
            title = { Text("Remove the old copy first?") },
            text = { Text("The old routing comes off this phone now, so offline directions are off until the update finishes. The map and search keep working.") },
            confirmButton = {
                TextButton(onClick = {
                    askDrop = false
                    s.dropOld = true
                    s.noSpace = null
                    s.problem = null
                    store.save()
                    Offline.download(context)
                    onChanged()
                }) { Text("Remove and update") }
            },
            dismissButton = { TextButton(onClick = { askDrop = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun StorageBar(used: Long, free: Long) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            "Offline maps use ${if (used == 0L) "no space" else Sizes.text(used)} · ${Sizes.text(free)} free on this phone",
            style = MaterialTheme.typography.bodyMedium,
        )
        val share = if (used + free > 0) used.toFloat() / (used + free) else 0f
        LinearProgressIndicator(
            progress = { if (used > 0) share.coerceAtLeast(0.01f) else 0f },
            modifier = Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)),
        )
    }
}

@Composable
private fun AreaRow(area: OfflineApi.Area, status: AreaStatus, onClick: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = "Open ${area.name}", onClick = onClick).padding(horizontal = 16.dp, vertical = 14.dp)
            .semantics { stateDescription = status.text },
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(area.name, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            area.bytes?.let { Text(Sizes.text(it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        Text(
            status.text,
            style = MaterialTheme.typography.bodySmall,
            color = when {
                status.text.startsWith("Not enough") -> MaterialTheme.colorScheme.error
                status.update -> MaterialTheme.colorScheme.primary
                else -> MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
        status.progress?.let { p ->
            LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth().padding(top = 2.dp))
        }
    }
}

@Composable
private fun Settings(onChanged: () -> Unit) {
    val context = LocalContext.current
    var wifi by remember { mutableStateOf(with(Offline) { context.wifiOnly }) }
    var auto by remember { mutableStateOf(with(Offline) { context.autoUpdate }) }
    Text("Settings", style = MaterialTheme.typography.titleSmall, modifier = Modifier.semantics { heading() })
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            SettingRow("Download on Wi-Fi only", "Areas wait for Wi-Fi. You can still download one now on mobile data.", wifi) {
                wifi = it
                with(Offline) { context.wifiOnly = it }
                Offline.reschedule(context)
                onChanged()
            }
            HorizontalDivider()
            SettingRow("Update automatically", "When your server's maps are updated, on Wi-Fi while charging.", auto) {
                auto = it
                with(Offline) { context.autoUpdate = it }
                Offline.daily(context)
                onChanged()
            }
        }
    }
}

@Composable
private fun SettingRow(title: String, detail: String, value: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Switch) { onChange(!value) }.padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = value, onCheckedChange = null)
    }
}

// ---- One area ----------------------------------------------------------------------

@Composable
private fun AreaPage(area: OfflineApi.Area, overview: OfflineApi.Overview, style: String?, @Suppress("UNUSED_PARAMETER") refresh: Int, onBack: () -> Unit, onChanged: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val run by Offline.run.collectAsState()
    val work = downloadWork()
    val store = Offline.store(context)
    val st = status(context, area, overview, run, work)
    val others = overview.areas.filter { it.id != area.id && it.id !in store.state.deleted }
    val shared = others.filter { o -> o.cells.any { it in area.cells } }
    var renaming by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    var askMobile by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val accent = MaterialTheme.colorScheme.primary

    Column(Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState())) {
        Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("Back") }
            Text(area.name, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        }
        Box(Modifier.fillMaxWidth().height(220.dp).padding(horizontal = 20.dp).clip(RoundedCornerShape(12.dp))) {
            AreaMap(style, area.box, area.cells, accent, Modifier.fillMaxSize())
        }
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(st.text, style = MaterialTheme.typography.titleMedium, color = if (st.update) accent else MaterialTheme.colorScheme.onSurface)
            st.progress?.let { LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth()) }
            val squares = "${area.cells.size} square${if (area.cells.size == 1) "" else "s"}"
            val onPhone = store.cellBytes(area.cells)
            Text(
                listOfNotNull(
                    area.bytes?.takeIf { !st.ready }?.let { "${Sizes.text(it)} to download" },
                    squares,
                    if (onPhone > 0) "${Sizes.text(onPhone)} on this phone" else null,
                ).joinToString(" · "),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (shared.isNotEmpty()) {
                Text(
                    "Shares squares with ${shared.joinToString(", ") { it.name }}, so they stay when this is deleted.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (st.waitingForWifi) {
                OutlinedButton(onClick = { askMobile = true }, modifier = Modifier.fillMaxWidth()) { Text("Download now on mobile data") }
            }
            Button(
                onClick = { store.state.noSpace = null; store.state.problem = null; store.save(); Offline.download(context); onChanged() },
                enabled = overview.ready && run == null && (!st.ready || st.update),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (st.ready && !st.update) "Up to date" else if (st.update) "Update now" else "Download now") }
            if (st.update) {
                Text(
                    "All your areas update together, so directions always use one version of the map. Only what changed is downloaded.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                    val saves = area.addressesBytes?.takeIf { it >= 1_000_000 }?.let { " (saves ${Sizes.text(it)})" } ?: ""
                    SettingRow("Leave out house numbers$saves", "Streets and places are still found offline.", !area.withAddresses) { leave ->
                        busy = true
                        problem = null
                        scope.launch {
                            runCatching { withContext(Dispatchers.IO) { Offline.setAddresses(context, area, !leave) } }
                                .onFailure { problem = it.message ?: "Couldn't change that. Check your connection." }
                            onChanged()
                            busy = false
                        }
                    }
                    HorizontalDivider()
                    Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { renaming = true }.padding(vertical = 14.dp)) {
                        Text("Rename", Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                    }
                    HorizontalDivider()
                    Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { deleting = true }.padding(vertical = 14.dp)) {
                        Text("Delete", Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.error)
                    }
                }
            }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            problem?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            val phones = area.devices.filter { it.id != Offline.deviceId(context) }
            if (phones.isNotEmpty()) {
                Text(
                    "Also on " + phones.joinToString(", ") { "${it.name} (${deviceState(it.state)})" },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }

    if (renaming) {
        var name by remember { mutableStateOf(area.name) }
        AlertDialog(
            onDismissRequest = { renaming = false },
            title = { Text("Rename") },
            text = { OutlinedTextField(name, { name = it.take(80) }, singleLine = true, label = { Text("Name") }) },
            confirmButton = {
                TextButton(enabled = name.isNotBlank(), onClick = {
                    renaming = false
                    scope.launch {
                        runCatching {
                            withContext(Dispatchers.IO) {
                                Offline.api(context)!!.edit(area.id, name = name.trim())
                                Offline.refresh(context)
                            }
                        }.onFailure { problem = it.message ?: "Couldn't rename it. Check your connection." }
                        onChanged()
                    }
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { renaming = false }) { Text("Cancel") } },
        )
    }
    if (deleting) {
        val frees = store.freedBy(area.cells, others.flatMap { it.cells })
        AlertDialog(
            onDismissRequest = { deleting = false },
            title = { Text("Delete ${area.name}?") },
            text = {
                Text(
                    "You can download it again." + if (frees > 0) " This frees ${Sizes.text(frees)} on this phone." else if (shared.isNotEmpty()) " Its squares stay for your other areas." else "",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    deleting = false
                    scope.launch {
                        withContext(Dispatchers.IO) { Offline.delete(context, area) }
                        onChanged()
                        onBack()
                    }
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { deleting = false }) { Text("Cancel") } },
        )
    }
    if (askMobile) {
        AlertDialog(
            onDismissRequest = { askMobile = false },
            title = { Text("Download on mobile data?") },
            text = { Text("This uses up to ${Sizes.text(area.bytes ?: 0)} of your mobile data, this once. Wi-Fi only stays on for next time.") },
            confirmButton = { TextButton(onClick = { askMobile = false; Offline.download(context, mobileData = true) }) { Text("Use mobile data") } },
            dismissButton = { TextButton(onClick = { askMobile = false }) { Text("Wait for Wi-Fi") } },
        )
    }
}

private fun deviceState(state: String) = when (state) {
    "ready" -> "ready"
    "downloading" -> "downloading"
    "waiting" -> "waiting"
    "update" -> "update ready"
    "no_space" -> "not enough space"
    else -> "not downloaded"
}

// ---- Bits --------------------------------------------------------------------------

@Composable
private fun Notice(text: String, error: Boolean = false, actions: (@Composable () -> Unit)? = null) {
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(text, style = MaterialTheme.typography.bodyMedium)
            actions?.let { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { it() } }
        }
    }
}

@Composable
private fun Message(title: String, text: String, onClose: () -> Unit) {
    Column(Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
        Text(text, style = MaterialTheme.typography.bodyLarge)
        OutlinedButton(onClick = onClose) { Text("Back") }
    }
}

@Composable
private fun Centre(modifier: Modifier = Modifier.fillMaxSize(), content: @Composable () -> Unit) {
    Box(modifier, contentAlignment = Alignment.Center) { content() }
}
