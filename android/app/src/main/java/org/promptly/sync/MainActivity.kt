package org.promptly.sync

import android.Manifest
import android.app.ActivityManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.format.DateUtils
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    /** A pairing link the app was opened with ("Open PromptlySync" on the site). */
    private val incoming = mutableStateOf<PairLink?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        incoming.value = intent?.data?.let { Api.parseLink(it.toString()) }
        setContent { Theme { App(incoming.value) { incoming.value = null } } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.let { Api.parseLink(it.toString()) }?.let { incoming.value = it }
    }
}

private val Terracotta = Color(0xFFC8613F)

@Composable
private fun Theme(content: @Composable () -> Unit) {
    val scheme = if (isSystemInDarkTheme()) {
        darkColorScheme(primary = Color(0xFFE38B6D), secondary = Color(0xFFE38B6D))
    } else {
        lightColorScheme(primary = Terracotta, secondary = Terracotta)
    }
    MaterialTheme(colorScheme = scheme) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background, content = content)
    }
}

/** The media permissions this Android version asks for. */
private fun mediaPermissions(): Array<String> = buildList {
    if (Build.VERSION.SDK_INT >= 33) {
        add(Manifest.permission.READ_MEDIA_IMAGES)
        add(Manifest.permission.READ_MEDIA_VIDEO)
        add(Manifest.permission.POST_NOTIFICATIONS)
    } else {
        add(Manifest.permission.READ_EXTERNAL_STORAGE)
    }
    if (Build.VERSION.SDK_INT >= 29) add(Manifest.permission.ACCESS_MEDIA_LOCATION)
}.toTypedArray()

private fun granted(ctx: android.content.Context, p: String) =
    ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

/** All photos and videos readable (not just a few picked on Android 14+). */
private fun hasMedia(ctx: android.content.Context): Boolean =
    if (Build.VERSION.SDK_INT >= 33) {
        granted(ctx, Manifest.permission.READ_MEDIA_IMAGES) && granted(ctx, Manifest.permission.READ_MEDIA_VIDEO)
    } else {
        granted(ctx, Manifest.permission.READ_EXTERNAL_STORAGE)
    }

private fun hasSomeMedia(ctx: android.content.Context): Boolean =
    Build.VERSION.SDK_INT >= 34 && granted(ctx, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)

@Composable
private fun App(incoming: PairLink?, consumed: () -> Unit) {
    val ctx = LocalContext.current
    val store = remember { Store(ctx) }
    var account by remember { mutableStateOf(store.account) }
    var buckets by remember { mutableStateOf(store.buckets) }
    var choosing by remember { mutableStateOf(false) }
    var permTick by remember { mutableIntStateOf(0) }
    val media = remember(permTick) { hasMedia(ctx) }

    Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp)) {
        when {
            account == null -> PairScreen(incoming, consumed) {
                store.account = it
                store.unlinked = false
                store.lastError = null
                account = it
            }
            !media -> PermissionScreen(partial = remember(permTick) { hasSomeMedia(ctx) }) { permTick++ }
            buckets == null || choosing -> FolderScreen(initial = buckets) {
                store.buckets = it
                buckets = it
                choosing = false
                Sync.schedule(ctx)
            }
            else -> StatusScreen(
                store = store,
                account = account!!,
                onChooseFolders = { choosing = true },
                onUnlink = {
                    Sync.stop(ctx)
                    Ledger(ctx).reset()
                    store.clear()
                    account = null
                    buckets = null
                },
            )
        }
    }
}

// ------------------------------------------------------------------ pairing

@Composable
private fun PairScreen(incoming: PairLink?, consumed: () -> Unit, onPaired: (Store.Account) -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var link by remember { mutableStateOf(incoming) }
    var typing by remember { mutableStateOf(false) }
    var typed by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(incoming) {
        if (incoming != null) {
            link = incoming
            consumed()
        }
    }

    fun claim(l: PairLink) {
        busy = true
        error = null
        scope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { Api.claim(l, Api.deviceName()) } }
            busy = false
            result.onSuccess(onPaired).onFailure { e ->
                error = e.message ?: "Couldn't link this phone."
                link = null
            }
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Spacer(Modifier.height(24.dp))
        Text("PromptlySync", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
        Text(
            "Back up this phone's photos and videos to Promptly.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))

        val pending = link
        if (pending != null) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Link this phone to", style = MaterialTheme.typography.labelLarge)
                    Text(Uri.parse(pending.server).host ?: pending.server, style = MaterialTheme.typography.titleLarge)
                    Text(
                        "It will be able to add photos to your Photos and see your files. It can never delete anything.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { claim(pending) }, enabled = !busy) { Text(if (busy) "Linking…" else "Link") }
                        TextButton(onClick = { link = null }, enabled = !busy) { Text("Cancel") }
                    }
                }
            }
        } else {
            Text("1. On your computer, open Promptly → Files → Devices → Add device.", style = MaterialTheme.typography.bodyMedium)
            Text("2. Scan the code it shows.", style = MaterialTheme.typography.bodyMedium)
            Button(
                onClick = {
                    error = null
                    val opts = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
                    GmsBarcodeScanning.getClient(ctx, opts).startScan()
                        .addOnSuccessListener { code ->
                            val parsed = code.rawValue?.let { Api.parseLink(it) }
                            if (parsed == null) error = "That isn't a PromptlySync code." else link = parsed
                        }
                        .addOnFailureListener { e -> error = e.message ?: "The scanner didn't start." }
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Scan QR code") }
            if (typing) {
                OutlinedTextField(
                    value = typed,
                    onValueChange = { typed = it },
                    label = { Text("The link under the code") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedButton(onClick = {
                    val parsed = Api.parseLink(typed)
                    if (parsed == null) error = "That link doesn't look right — it ends in /sync?code=…" else link = parsed
                }) { Text("Continue") }
            } else {
                TextButton(onClick = { typing = true }) { Text("Enter the link instead") }
            }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
    }
}

// -------------------------------------------------------------- permissions

@Composable
private fun PermissionScreen(partial: Boolean, onResult: () -> Unit) {
    val ctx = LocalContext.current
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { onResult() }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Spacer(Modifier.height(24.dp))
        Text("Allow photos and videos", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Text(
            "PromptlySync needs to read your photos and videos to back them up, and where they were taken so they show on your map.",
            style = MaterialTheme.typography.bodyMedium,
        )
        if (partial) {
            Text(
                "Right now it can only see the few photos you picked. Choose \"Allow all\" so new photos are backed up too.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
        }
        Button(onClick = { ask.launch(mediaPermissions()) }, modifier = Modifier.fillMaxWidth()) { Text("Allow") }
        TextButton(onClick = {
            ctx.startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))
            )
        }) { Text("Open settings") }
    }
}

// ------------------------------------------------------------------ folders

@Composable
private fun FolderScreen(initial: Set<String>?, onDone: (Set<String>) -> Unit) {
    val ctx = LocalContext.current
    var buckets by remember { mutableStateOf<List<Bucket>?>(null) }
    var chosen by remember { mutableStateOf(initial ?: emptySet()) }
    LaunchedEffect(Unit) {
        val found = withContext(Dispatchers.IO) { Media.buckets(ctx) }
        buckets = found
        if (initial == null) {
            // Camera is the usual choice; start with it ticked.
            chosen = found.filter { it.name.equals("Camera", true) }.map { it.id }.toSet()
        }
    }
    Column(Modifier.fillMaxSize()) {
        Spacer(Modifier.height(24.dp))
        Text("Choose folders to back up", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Text(
            "Everything in them is backed up — what's there now and anything new. Deleting a photo on this phone later keeps the copy in Promptly.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 6.dp, bottom = 12.dp),
        )
        val list = buckets
        if (list == null) {
            CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally).padding(24.dp))
        } else if (list.isEmpty()) {
            Text("No photos or videos found on this phone.", style = MaterialTheme.typography.bodyMedium)
        } else {
            LazyColumn(Modifier.weight(1f)) {
                items(list, key = { it.id }) { b ->
                    Row(
                        Modifier.fillMaxWidth().clickable {
                            chosen = if (b.id in chosen) chosen - b.id else chosen + b.id
                        }.padding(vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked = b.id in chosen, onCheckedChange = null)
                        Column(Modifier.padding(start = 12.dp)) {
                            Text(b.name, style = MaterialTheme.typography.bodyLarge)
                            Text("${b.count} item${if (b.count == 1) "" else "s"}", style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    HorizontalDivider()
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        Button(onClick = { onDone(chosen) }, enabled = chosen.isNotEmpty(), modifier = Modifier.fillMaxWidth()) {
            Text(if (initial == null) "Start backing up" else "Save")
        }
    }
}

// ------------------------------------------------------------------- status

@Composable
private fun StatusScreen(store: Store, account: Store.Account, onChooseFolders: () -> Unit, onUnlink: () -> Unit) {
    val ctx = LocalContext.current
    val infos by remember { WorkManager.getInstance(ctx).getWorkInfosByTagFlow(Sync.TAG) }.collectAsState(initial = emptyList())
    val running = infos.firstOrNull { it.state == WorkInfo.State.RUNNING }
    var counts by remember { mutableStateOf<Pair<Int, Int>?>(null) } // backed up, total
    var refused by remember { mutableIntStateOf(0) }
    var deleted by remember { mutableIntStateOf(0) }
    var update by remember { mutableStateOf<Api.Update?>(null) }
    var wifiOnly by remember { mutableStateOf(store.wifiOnly) }
    var chargingOnly by remember { mutableStateOf(store.chargingOnly) }
    var confirmUnlink by remember { mutableStateOf(false) }
    var tick by remember { mutableIntStateOf(0) }

    // Counted when the screen opens and when a run ends — not while one is
    // going (its own progress shows then), so an open app isn't re-reading
    // every photo on the phone every few seconds.
    LaunchedEffect(running == null, tick) {
        if (running != null) return@LaunchedEffect
        withContext(Dispatchers.IO) {
            val items = Media.items(ctx, store.buckets)
            val ledger = Ledger(ctx)
            val ids = items.map { it.id }
            // Deleted in Promptly: not waiting to be sent — they stay deleted.
            deleted = ledger.count("deleted", ids)
            counts = Pair(ledger.count("done", ids), items.size - deleted)
            refused = ledger.count("refused", ids)
        }
    }
    var battery by remember { mutableStateOf(Power.read(ctx)) }
    LifecycleResumeEffect(Unit) {
        battery = Power.read(ctx) // back from the battery settings
        onPauseOrDispose { }
    }
    LaunchedEffect(Unit) { update = withContext(Dispatchers.IO) { Api.update(account.server) } }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Spacer(Modifier.height(12.dp))
        Text("PromptlySync", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Text(
            "${account.device} → ${Uri.parse(account.server).host}",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        update?.let { u ->
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Version ${u.version} is available.", Modifier.weight(1f))
                    TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u.url))) }) { Text("Update") }
                }
            }
        }

        BatteryCard(battery)

        if (store.unlinked) {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("This phone was removed from your account, so backups have stopped.")
                    Button(onClick = onUnlink) { Text("Link it again") }
                }
            }
        }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val c = counts
                if (running != null) {
                    val p = running.progress
                    val done = p.getInt("done", 0)
                    val total = p.getInt("total", 0)
                    Text("Backing up…", style = MaterialTheme.typography.titleMedium)
                    if (total > 0) {
                        LinearProgressIndicator(progress = { done / total.toFloat() }, modifier = Modifier.fillMaxWidth())
                        Text("$done of $total this run", style = MaterialTheme.typography.bodySmall)
                    } else {
                        LinearProgressIndicator(Modifier.fillMaxWidth())
                    }
                    val name = p.getString("name").orEmpty()
                    val size = p.getLong("size", 0)
                    if (name.isNotEmpty() && size > 0) {
                        Text(
                            "$name — ${p.getLong("sent", 0) * 100 / size}%",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                } else if (c != null && c.first >= c.second) {
                    Text("Everything's backed up", style = MaterialTheme.typography.titleMedium)
                } else {
                    Text("Waiting to back up", style = MaterialTheme.typography.titleMedium)
                    Text(
                        if (wifiOnly) "Backups run on Wi-Fi${if (chargingOnly) ", while charging" else ""}."
                        else if (chargingOnly) "Backups run while charging." else "Backups run when there's a connection.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                if (c != null) Text("${c.first} of ${c.second} photos and videos backed up", style = MaterialTheme.typography.bodyMedium)
                if (deleted > 0) {
                    Text(
                        "$deleted you deleted in Promptly — not sent again.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (refused > 0) {
                    Text("$refused couldn't be backed up (the server refused them).", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error)
                }
                val last = store.lastSync
                Text(
                    if (last > 0) "Last finished ${DateUtils.getRelativeTimeSpanString(last)}" else "Not finished yet",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!store.unlinked) {
                    store.lastError?.let { if (running == null) Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                    OutlinedButton(onClick = { Sync.now(ctx); tick++ }, enabled = running == null) { Text("Back up now") }
                }
            }
        }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                Setting("Only on Wi-Fi", "Don't use mobile data", wifiOnly) {
                    wifiOnly = it; store.wifiOnly = it; Sync.schedule(ctx)
                }
                HorizontalDivider()
                Setting("Only while charging", null, chargingOnly) {
                    chargingOnly = it; store.chargingOnly = it; Sync.schedule(ctx)
                }
                HorizontalDivider()
                Row(
                    Modifier.fillMaxWidth().clickable(onClick = onChooseFolders).padding(vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Folders", style = MaterialTheme.typography.bodyLarge)
                        Text("${store.buckets?.size ?: 0} chosen", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text("Change", color = MaterialTheme.colorScheme.primary)
                }
            }
        }

        if (Build.VERSION.SDK_INT >= 30 && !store.unlinked) FreeUpCard(store, account) { tick++ }

        OutlinedButton(
            onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${account.server}/files/photos"))) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Open Promptly Photos") }

        TextButton(onClick = { confirmUnlink = true }) { Text("Unlink this phone", color = MaterialTheme.colorScheme.error) }
        Text(
            "PromptlySync ${BuildConfig.VERSION_NAME}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }

    if (confirmUnlink) {
        AlertDialog(
            onDismissRequest = { confirmUnlink = false },
            title = { Text("Unlink this phone?") },
            text = { Text("Backups stop. What's already backed up stays in Promptly. Remove it from Files → Devices too.") },
            confirmButton = { TextButton(onClick = { confirmUnlink = false; onUnlink() }) { Text("Unlink") } },
            dismissButton = { TextButton(onClick = { confirmUnlink = false }) { Text("Cancel") } },
        )
    }
}

/** Remove what's safely in Promptly from the phone (Android 11+). */
@RequiresApi(30)
@Composable
private fun FreeUpCard(store: Store, account: Store.Account, onFreed: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var keepRecent by remember { mutableStateOf(true) }
    var checking by remember { mutableStateOf(false) }
    var plan by remember { mutableStateOf<FreeUp.Plan?>(null) }
    var progress by remember { mutableStateOf<Pair<Int, Int>?>(null) }
    var freeing by remember { mutableStateOf(0L) }
    var queue by remember { mutableStateOf<List<IntentSenderRequest>>(emptyList()) }
    var message by remember { mutableStateOf<String?>(null) }
    val gb = { bytes: Long ->
        when {
            bytes >= 1L shl 30 -> "%.1f GB".format(bytes / 1073741824.0)
            bytes >= 10L shl 20 -> "%.0f MB".format(bytes / 1048576.0)
            bytes >= 1L shl 20 -> "%.1f MB".format(bytes / 1048576.0)
            else -> "%.0f KB".format(maxOf(bytes, 1024L) / 1024.0)
        }
    }

    val confirm = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        val rest = queue.drop(1)
        if (result.resultCode == android.app.Activity.RESULT_OK && rest.isNotEmpty()) {
            queue = rest
        } else {
            message = if (result.resultCode == android.app.Activity.RESULT_OK) {
                "Freed ${gb(freeing)} on this phone. They're still in Promptly Photos."
            } else {
                "Nothing more was removed."
            }
            queue = emptyList()
            plan = null
            onFreed()
        }
    }
    LaunchedEffect(queue) { queue.firstOrNull()?.let { confirm.launch(it) } }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Free up space", style = MaterialTheme.typography.titleMedium)
            Text(
                "Remove photos and videos from this phone that are safely in Promptly — the server checks each one " +
                    "first. They stay in Promptly Photos.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            val p = plan
            when {
                checking -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    val pr = progress
                    Text(
                        if (pr != null && pr.second > 0) "Checking ${pr.first} of ${pr.second} with Promptly…" else "Checking with Promptly…",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                p != null && p.items.isEmpty() -> Text(
                    if (keepRecent) "Nothing older than 30 days to remove yet." else "Nothing to remove yet.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                p != null -> {
                    Text(
                        "${p.items.size} photos and videos · ${gb(p.bytes)} can be removed from this phone.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = {
                            // Checked again now: unchanged on the phone, still in Promptly.
                            message = null
                            checking = true
                            progress = null
                            scope.launch {
                                val r = withContext(Dispatchers.IO) {
                                    runCatching { FreeUp.recheck(ctx, account, p, store.buckets ?: emptySet()) }
                                }
                                checking = false
                                r.onSuccess { items ->
                                    if (items.isEmpty()) {
                                        plan = null
                                        message = "Nothing to remove — things changed since the check. Try again."
                                    } else {
                                        freeing = items.sumOf { it.size }
                                        queue = FreeUp.requests(ctx, items)
                                    }
                                }.onFailure { message = it.message ?: "Couldn't check with Promptly — nothing was removed." }
                            }
                        }) { Text("Free up ${gb(p.bytes)}") }
                        TextButton(onClick = { plan = null }) { Text("Cancel") }
                    }
                }
                else -> {
                    Setting("Keep the last 30 days on this phone", null, keepRecent) { keepRecent = it }
                    OutlinedButton(onClick = {
                        message = null
                        checking = true
                        scope.launch {
                            val r = withContext(Dispatchers.IO) {
                                runCatching {
                                    FreeUp.plan(ctx, account, store.buckets ?: emptySet(), if (keepRecent) 30 else 0) { i, n -> progress = i to n }
                                }
                            }
                            checking = false
                            r.onSuccess { plan = it }.onFailure { message = it.message ?: "Couldn't check with Promptly." }
                        }
                    }) { Text("See what can go") }
                }
            }
            message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

/** How Android treats this app's battery use (Pixel: App info → App battery usage). */
private object Power {
    enum class Mode { RESTRICTED, OPTIMIZED, UNRESTRICTED }

    fun read(ctx: android.content.Context): Mode {
        val am = ctx.getSystemService(ActivityManager::class.java)
        if (Build.VERSION.SDK_INT >= 28 && am.isBackgroundRestricted) return Mode.RESTRICTED
        val pm = ctx.getSystemService(PowerManager::class.java)
        return if (pm.isIgnoringBatteryOptimizations(ctx.packageName)) Mode.UNRESTRICTED else Mode.OPTIMIZED
    }
}

@Composable
private fun BatteryCard(mode: Power.Mode) {
    val ctx = LocalContext.current
    val appSettings = {
        ctx.startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))
        )
    }
    when (mode) {
        Power.Mode.RESTRICTED -> Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Battery use is set to Restricted", style = MaterialTheme.typography.titleSmall)
                Text(
                    "Android stops PromptlySync in the background, so photos only back up while it's open. " +
                        "Set App battery usage to Optimized.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Button(onClick = appSettings) { Text("Open app settings") }
            }
        }
        Power.Mode.OPTIMIZED -> Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Battery: Optimized", style = MaterialTheme.typography.titleSmall)
                Text(
                    "Easiest on the battery. Backups run when Android allows — if you rarely open this app, " +
                        "new photos can wait a few hours, sooner on Wi-Fi while charging.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = {
                    @Suppress("BatteryLife") // sideloaded, and only when the person asks
                    val ask = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}"))
                    runCatching { ctx.startActivity(ask) }.onFailure { appSettings() }
                }) { Text("Back up right away instead") }
            }
        }
        Power.Mode.UNRESTRICTED -> Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Battery: Unrestricted", style = MaterialTheme.typography.titleSmall)
                Text(
                    "New photos back up soon after you take them. Uses a little more battery; switch App " +
                        "battery usage back to Optimized to save it.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = appSettings) { Text("Open app settings") }
            }
        }
    }
}

@Composable
private fun Setting(title: String, hint: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable { onChange(!checked) }.padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (hint != null) Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, onCheckedChange = onChange, modifier = Modifier.size(width = 52.dp, height = 32.dp))
    }
}
