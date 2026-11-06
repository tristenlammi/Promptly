// The rest of the vault: bottom bar, generator, 2FA codes, trash, devices and settings.
package org.promptly.sync.passwords.ui

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.autofill.AutofillManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
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
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.LifecycleResumeEffect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.promptly.sync.BuildConfig
import org.promptly.sync.passwords.AlertsCheck
import org.promptly.sync.passwords.Biometrics
import org.promptly.sync.passwords.ChromeSetup
import org.promptly.sync.passwords.Clip
import org.promptly.sync.passwords.Pw
import org.promptly.sync.passwords.SmsCode
import org.promptly.sync.passwords.core.ApiError
import org.promptly.sync.passwords.core.DeviceOut
import org.promptly.sync.passwords.core.DeviceQr
import org.promptly.sync.passwords.core.DeviceRequestOut
import org.promptly.sync.passwords.core.Generator
import org.promptly.sync.passwords.core.SecretKeys
import org.promptly.sync.passwords.core.Totp
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.newBody

private enum class Tab(val label: String) { ITEMS("Items"), CODES("2FA"), GENERATOR("Generator"), MORE("More") }

private sealed class Screen {
    data object Home : Screen()
    data class Detail(val id: String) : Screen()
    data class Edit(val id: String?, val kind: String, val url: String? = null) : Screen()
    data object PickKind : Screen()
    data object Trash : Screen()
    data object Devices : Screen()
    data object Settings : Screen()
    data object Security : Screen()
    data object Shared : Screen()
    data object Transfer : Screen()
    data object Sends : Screen()
    data object Emergency : Screen()
}

@Composable
fun MainScreen(activity: PasswordsActivity) {
    val client = Pw.client()!!
    var tab by remember { mutableStateOf(Tab.ITEMS) }
    var screen by remember { mutableStateOf<Screen>(Screen.Home) }
    var syncing by remember { mutableStateOf(false) }
    var banner by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val sharedText = activity.shared.value

    LaunchedEffect(sharedText) {
        if (sharedText != null) {
            val url = Regex("https?://\\S+").find(sharedText)?.value
            activity.shared.value = null
            screen = Screen.Edit(null, "login", url)
        }
    }

    fun sync() {
        syncing = true
        banner = null
        scope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    runCatching { client.sync() }.recoverCatching { e ->
                        // The session ended while the keys are still here: prove again and retry.
                        if (e is ApiError && e.status == 401) {
                            client.reprove()
                            client.sync()
                        } else {
                            throw e
                        }
                    }.getOrThrow()
                }
            }
            syncing = false
            r.onSuccess { if (it.offline) banner = "Working offline. Your changes will sync when the server's back." }
                .onFailure { banner = errorText(it) }
        }
    }
    LaunchedEffect(Unit) { sync() }
    LaunchedEffect(Unit) { runCatching { AlertsCheck.schedule(activity) } }
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        // For new-device, invitation and emergency alerts. Asked once.
        if (Build.VERSION.SDK_INT >= 33 && !Pw.prefs.prefs.getBoolean("asked_notifications", false)) {
            Pw.prefs.prefs.edit().putBoolean("asked_notifications", true).apply()
            askNotifications.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    Column(Modifier.fillMaxSize().safeDrawingPadding()) {
        Column(Modifier.weight(1f)) {
            when (val s = screen) {
                Screen.Home -> when (tab) {
                    Tab.ITEMS -> ItemListScreen(client, { screen = Screen.Detail(it) }, { screen = Screen.PickKind }, { sync() }, syncing, banner)
                    Tab.CODES -> CodesScreen(client)
                    Tab.GENERATOR -> GeneratorScreen()
                    Tab.MORE -> MoreScreen(client, { screen = it }, { Pw.lock("user") })
                }
                is Screen.Detail -> ItemDetailScreen(activity, client, s.id, { screen = Screen.Home }, { screen = Screen.Edit(s.id, "") })
                is Screen.Edit -> ItemEditorScreen(client, s.id, s.kind, s.url) { saved -> screen = if (saved != null) Screen.Detail(saved) else if (s.id != null) Screen.Detail(s.id) else Screen.Home }
                Screen.PickKind -> KindPicker({ screen = Screen.Edit(null, it) }, { screen = Screen.Home })
                Screen.Trash -> TrashScreen(client) { screen = Screen.Home }
                Screen.Devices -> DevicesScreen(client) { screen = Screen.Home }
                Screen.Settings -> SettingsScreen(activity, client) { screen = Screen.Home }
                Screen.Security -> SecurityCheckScreen(client, { screen = Screen.Detail(it) }) { screen = Screen.Home }
                Screen.Shared -> SharedVaultsScreen(client) { screen = Screen.Home }
                Screen.Transfer -> TransferScreen(client) { screen = Screen.Home }
                Screen.Sends -> SendsScreen(client) { screen = Screen.Home }
                Screen.Emergency -> EmergencyScreen(client) { screen = Screen.Home }
            }
        }
        if (screen == Screen.Home) {
            NavigationBar {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = { Text(t.label.take(1), fontWeight = FontWeight.Bold) },
                        label = { Text(t.label) },
                        modifier = Modifier.testTag("tab-${t.name.lowercase()}"),
                    )
                }
            }
        }
    }
}

@Composable
private fun MoreScreen(client: VaultClient, go: (Screen) -> Unit, lock: () -> Unit) {
    val version by Pw.version.collectAsState()
    val invites = remember(version) { client.store.getVaults().count { !it.accepted && it.kind != "personal" } }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("More", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        OutlinedButton(onClick = { go(Screen.Security) }, Modifier.fillMaxWidth().testTag("open-security")) { Text("Security check") }
        OutlinedButton(onClick = { go(Screen.Shared) }, Modifier.fillMaxWidth().testTag("open-shared")) { Text(if (invites > 0) "Shared vaults ($invites waiting)" else "Shared vaults") }
        OutlinedButton(onClick = { go(Screen.Sends) }, Modifier.fillMaxWidth().testTag("open-sends")) { Text("Secure Send") }
        OutlinedButton(onClick = { go(Screen.Emergency) }, Modifier.fillMaxWidth().testTag("open-emergency")) { Text("Emergency access") }
        OutlinedButton(onClick = { go(Screen.Transfer) }, Modifier.fillMaxWidth().testTag("open-transfer")) { Text("Import and export") }
        OutlinedButton(onClick = { go(Screen.Trash) }, Modifier.fillMaxWidth().testTag("open-trash")) { Text("Trash") }
        OutlinedButton(onClick = { go(Screen.Devices) }, Modifier.fillMaxWidth().testTag("open-devices")) { Text("Devices") }
        OutlinedButton(onClick = { go(Screen.Settings) }, Modifier.fillMaxWidth().testTag("open-settings")) { Text("Settings") }
        Button(onClick = lock, Modifier.fillMaxWidth().testTag("lock-now")) { Text("Lock now") }
    }
}

// ---- 2FA codes ------------------------------------------------------------------

@Composable
private fun CodesScreen(client: VaultClient) {
    val ctx = LocalContext.current
    val activity = ctx as FragmentActivity
    val version by Pw.version.collectAsState()
    val items = remember(version) { runCatching { client.allItems() }.getOrDefault(emptyList()).filter { it.body.totp != null && client.canReveal(it.vaultId) } }
    var error by remember { mutableStateOf<String?>(null) }
    var smsCode by remember { mutableStateOf<String?>(null) }
    var waiting by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    // "Ask again before showing": a code is showing it.
    var passed by remember { mutableStateOf(setOf<String>()) }
    var asking by remember { mutableStateOf<Item?>(null) }
    asking?.let { i ->
        BackHandler { asking = null }
        ConfirmIdentityPane(activity, "Confirm it's you", i.body.title, true, {
            passed = passed + i.id
            asking = null
        }, { asking = null })
        return
    }

    fun addFromQr(text: String) {
        scope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    val vault = client.personalVaultId()
                    if (text.startsWith("otpauth-migration:")) {
                        val m = Totp.parseMigration(text)
                        for (c in m.codes) client.saveNew(vault, newBody("totp", c.issuer ?: c.label ?: "2FA code").withTotp(c).withText("username", c.label))
                    } else {
                        val c = Totp.parseOtpauth(text)
                        client.saveNew(vault, newBody("totp", c.issuer ?: c.label ?: "2FA code").withTotp(c).withText("username", c.label))
                    }
                    runCatching { client.sync() }
                }
            }
            r.onFailure { error = errorText(it) }
        }
    }

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("2FA codes", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedButton(onClick = { scanQr(ctx, { addFromQr(it) }, { error = it }) }, Modifier.testTag("codes-scan")) { Text("Scan a QR") }
            OutlinedButton(onClick = {
                waiting = true
                smsCode = null
                SmsCode.start(activity) { result ->
                    waiting = false
                    result.onSuccess { code ->
                        smsCode = code
                        Clip.copySecret(ctx, "SMS code", code)
                    }.onFailure { error = it.message }
                }
            }, enabled = !waiting, modifier = Modifier.testTag("codes-sms")) { Text(if (waiting) "Waiting for SMS" else "Get code from SMS") }
        }
        smsCode?.let { Text("From SMS, copied: $it", fontFamily = FontFamily.Monospace, modifier = Modifier.testTag("sms-code")) }
        error?.let { ErrorCard(it) }
        if (items.isEmpty()) Text("No 2FA codes yet. Scan one, or add one to a login.", Modifier.testTag("codes-empty"))
        LazyColumn(Modifier.weight(1f)) {
            items(items, key = { it.id }) { item ->
                Column(Modifier.padding(vertical = 6.dp)) {
                    Text(item.body.title, fontWeight = FontWeight.Medium)
                    if (item.body.reprompt && item.id !in passed) {
                        OutlinedButton(onClick = { asking = item }, Modifier.testTag("code-reveal-${item.body.title}")) { Text("Show code") }
                    } else {
                        item.body.totp?.let { TotpRow(it, "code-${item.body.title}") }
                    }
                }
                HorizontalDivider()
            }
        }
    }
}

// ---- Generator --------------------------------------------------------------------

@Composable
private fun GeneratorScreen() {
    val ctx = LocalContext.current
    var mode by remember { mutableIntStateOf(0) }
    var length by remember { mutableFloatStateOf(20f) }
    var words by remember { mutableFloatStateOf(5f) }
    var digitsLen by remember { mutableFloatStateOf(6f) }
    var lower by remember { mutableStateOf(true) }
    var upper by remember { mutableStateOf(true) }
    var digits by remember { mutableStateOf(true) }
    var symbols by remember { mutableStateOf(true) }
    var ambiguous by remember { mutableStateOf(true) }
    var capitalize by remember { mutableStateOf(false) }
    var site by remember { mutableStateOf("") }
    var output by remember { mutableStateOf("") }
    var bump by remember { mutableIntStateOf(0) }
    val opts = Generator.PasswordOptions(length.toInt(), lower, upper, digits, symbols, ambiguous)
    LaunchedEffect(mode, length, words, digitsLen, lower, upper, digits, symbols, ambiguous, capitalize, site, bump) {
        output = runCatching {
            when (mode) {
                0 -> Generator.forSite(site.trim().ifEmpty { null }, opts)
                1 -> Generator.passphrase(words.toInt(), "-", capitalize, false)
                2 -> Generator.pin(digitsLen.toInt())
                else -> Generator.username(false)
            }
        }.getOrElse { it.message ?: "" }
    }
    @Composable
    fun Toggle(label: String, value: Boolean, set: (Boolean) -> Unit) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(value, set)
            Text(label)
        }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Generator", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        TabRow(mode) {
            listOf("Password", "Passphrase", "PIN", "Username").forEachIndexed { i, l -> Tab(mode == i, { mode = i }, text = { Text(l) }, modifier = Modifier.testTag("gen-mode-$i")) }
        }
        Card(Modifier.fillMaxWidth()) {
            Text(output, Modifier.padding(14.dp).testTag("gen-output"), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.titleMedium)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Button(onClick = {
                Clip.copySecret(ctx, "Generated password", output)
                toast(ctx, "Copied")
            }, Modifier.testTag("gen-copy")) { Text("Copy") }
            OutlinedButton(onClick = { bump++ }, Modifier.testTag("gen-again")) { Text("Generate again") }
        }
        when (mode) {
            0 -> {
                Text("Length: ${length.toInt()}. About ${Generator.entropyBits(opts)} bits.")
                Slider(length, { length = it }, valueRange = 8f..64f, modifier = Modifier.testTag("gen-length"))
                Toggle("Lower case", lower) { lower = it }
                Toggle("Upper case", upper) { upper = it }
                Toggle("Digits", digits) { digits = it }
                Toggle("Symbols", symbols) { symbols = it }
                Toggle("Avoid look-alikes", ambiguous) { ambiguous = it }
                OutlinedTextField(site, { site = it }, label = { Text("For a site (uses its known rules)") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("gen-site"))
            }
            1 -> {
                Text("Words: ${words.toInt()}")
                Slider(words, { words = it }, valueRange = 3f..12f)
                Toggle("Capitalize", capitalize) { capitalize = it }
            }
            2 -> {
                Text("Digits: ${digitsLen.toInt()}")
                Slider(digitsLen, { digitsLen = it }, valueRange = 4f..12f)
            }
        }
    }
}

// ---- Trash --------------------------------------------------------------------------

@Composable
private fun TrashScreen(client: VaultClient, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val version by Pw.version.collectAsState()
    val items = remember(version) { runCatching { client.trash() }.getOrDefault(emptyList()) }
    val scope = rememberCoroutineScope()
    var confirm by remember { mutableStateOf<String?>(null) }
    var bump by remember { mutableIntStateOf(0) }
    bump.let { }
    fun act(block: () -> Unit) {
        scope.launch {
            withContext(Dispatchers.IO) {
                runCatching {
                    block()
                    runCatching { client.sync() }
                }
            }
            bump++
        }
    }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack, Modifier.testTag("back")) { Text("Back") }
            Text("Trash", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        }
        Text("Items here go for good after 30 days.", style = MaterialTheme.typography.bodySmall)
        if (items.isEmpty()) Text("The trash is empty.", Modifier.testTag("trash-empty"))
        LazyColumn(Modifier.weight(1f)) {
            items(items, key = { it.id }) { item ->
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("trash-${item.body.title}"), verticalAlignment = Alignment.CenterVertically) {
                    Text(item.body.title, Modifier.weight(1f))
                    TextButton(onClick = { act { client.restoreItem(item.id) } }, Modifier.testTag("trash-restore")) { Text("Restore") }
                    TextButton(onClick = { confirm = item.id }, Modifier.testTag("trash-purge")) { Text("Delete") }
                }
                HorizontalDivider()
            }
        }
    }
    confirm?.let { id ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("Delete for good?") },
            text = { Text("This can't be undone, on any device.") },
            confirmButton = {
                TextButton(onClick = {
                    confirm = null
                    act { client.purgeItem(id) }
                }, Modifier.testTag("trash-purge-confirm")) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Keep") } },
        )
    }
}

// ---- Devices: approving a new one with safety words ----------------------------------

@Composable
private fun DevicesScreen(client: VaultClient, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    var devices by remember { mutableStateOf<List<DeviceOut>>(emptyList()) }
    var requests by remember { mutableStateOf<List<DeviceRequestOut>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var bump by remember { mutableIntStateOf(0) }
    // An approval holds the key its words were worked out from. It's never swapped for a newer
    // copy of the list: if the list stops agreeing with it, the answer is thrown away.
    var approvals by remember { mutableStateOf<Map<String, VaultClient.Approval>>(emptyMap()) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(bump) {
        while (true) {
            val r = withContext(Dispatchers.IO) { runCatching { client.api.devices() to client.api.deviceRequests() } }
            r.onSuccess {
                devices = it.first
                requests = it.second
                error = null
                val kept = approvals.filterValues { a -> a.stillMatches(it.second) }
                if (kept.size != approvals.size) {
                    approvals = kept
                    error = "A request changed or went away while you were checking it, so that check was thrown away. If it's still yours, start again."
                }
            }.onFailure { error = errorText(it) }
            delay(5000)
        }
    }
    fun act(block: () -> Unit) {
        scope.launch {
            withContext(Dispatchers.IO) { runCatching { block() } }.onFailure { error = errorText(it) }
            bump++
        }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack, Modifier.testTag("back")) { Text("Back") }
            Text("Devices", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        }
        error?.let { ErrorCard(it) }
        val ctx = LocalContext.current
        OutlinedButton(onClick = {
            scanQr(ctx, { text ->
                scope.launch {
                    error = null
                    val r = withContext(Dispatchers.IO) {
                        runCatching {
                            // The QR carries the request and the key, so what's approved is
                            // what's on that screen. A mismatch or an unknown request is refused.
                            val found = client.requestForQr(text)
                            found to client.beginApproval(found.id, found.devicePub)
                        }
                    }
                    r.onSuccess { (found, approval) ->
                        requests = listOf(found) + requests.filter { it.id != found.id }
                        approvals = approvals + (found.id to approval)
                    }.onFailure { error = if (it is DeviceQr.Refused) it.message else errorText(it) }
                }
            }, { error = it })
        }, Modifier.fillMaxWidth().testTag("devices-scan")) { Text("Scan a new device's QR") }
        for (r in requests.filter { it.status == "pending" || it.status == "answered" }) {
            val approval = approvals[r.id]
            Card(Modifier.fillMaxWidth().testTag("request-${r.code}"), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("${r.name} wants your vault", fontWeight = FontWeight.SemiBold)
                    Text("Its code: ${r.code}", fontFamily = FontFamily.Monospace)
                    if (approval == null) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Button(onClick = {
                                scope.launch {
                                    withContext(Dispatchers.IO) { runCatching { client.beginApproval(r.id, r.devicePub) } }
                                        .onSuccess { approvals = approvals + (r.id to it) }
                                        .onFailure { error = errorText(it) }
                                }
                            }, Modifier.testTag("request-begin")) { Text("Check it's mine") }
                            TextButton(onClick = { act { client.api.deviceRequestDeny(r.id) } }, Modifier.testTag("request-deny")) { Text("Not mine") }
                        }
                    } else {
                        Text("Do these words match the new device exactly?")
                        Text(approval.words.joinToString(" "), style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("approve-words"))
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Button(onClick = { act { client.finishApproval(approval) } }, Modifier.testTag("request-approve")) { Text("They match") }
                            TextButton(onClick = { act { client.api.deviceRequestDeny(r.id) } }, Modifier.testTag("request-deny")) { Text("They don't") }
                        }
                    }
                }
            }
        }
        for (d in devices) {
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("device-${d.name}"), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(d.name + if (d.current) " (this one)" else "", fontWeight = FontWeight.Medium)
                    Text("${d.platform}, last seen ${d.lastSeenAt ?: "never"}", style = MaterialTheme.typography.bodySmall)
                }
                if (!d.current) TextButton(onClick = { act { client.api.revokeDevice(d.id) } }, Modifier.testTag("device-revoke")) { Text("Remove") }
            }
            HorizontalDivider()
        }
    }
}

// ---- Settings ------------------------------------------------------------------------

@Composable
private fun SettingRow(label: String, value: Boolean, tag: String, set: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f))
        Switch(value, set, Modifier.testTag(tag))
    }
}

@Composable
private fun SettingsScreen(activity: FragmentActivity, client: VaultClient, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val ctx = LocalContext.current
    val p = Pw.prefs
    var autoLock by remember { mutableIntStateOf(p.autoLockMinutes) }
    var screenOff by remember { mutableStateOf(p.lockOnScreenOff) }
    var clip by remember { mutableIntStateOf(p.clipboardSeconds) }
    var names by remember { mutableStateOf(p.namesWhileLocked) }
    var copyTotp by remember { mutableStateOf(p.copyTotpAfterFill) }
    var bio by remember { mutableStateOf(Biometrics.enrolled) }
    var askBio by remember { mutableStateOf(false) }
    var autofillOn by remember { mutableStateOf(false) }
    var chrome by remember { mutableStateOf<Map<String, Boolean?>>(emptyMap()) }
    var credOn by remember { mutableStateOf<Boolean?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var changing by remember { mutableStateOf(false) }
    var forget by remember { mutableStateOf(false) }

    fun refresh() {
        autofillOn = runCatching { ctx.getSystemService(AutofillManager::class.java).hasEnabledAutofillServices() }.getOrDefault(false)
        chrome = ChromeSetup.installedChannels(ctx).associateWith { ChromeSetup.state(ctx, it) }
        credOn = ChromeSetup.credentialProviderEnabled(ctx)
    }
    LifecycleResumeEffect(Unit) {
        refresh()
        onPauseOrDispose { }
    }

    if (askBio) {
        ConfirmIdentityPane(activity, "Turn on biometric unlock", "Your master password first.", false, {
            askBio = false
            val secret = client.currentUnlockSecret()
            Biometrics.enroll(activity, secret) { r ->
                secret.fill(0)
                r.onSuccess { bio = true }.onFailure { e ->
                    if (!(e is Biometrics.Failed && e.cancelled)) message = e.message
                }
            }
        }, { askBio = false })
        return
    }
    if (changing) {
        ChangePassword(client) { changing = false }
        return
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack, Modifier.testTag("back")) { Text("Back") }
            Text("Settings", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        }
        message?.let { ErrorCard(it) }

        Text("Autofill", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(if (autofillOn) "Passwords is your autofill service." else "Turn on autofill so apps and browsers can use your logins.", Modifier.testTag("autofill-state"))
                if (!autofillOn) Button(onClick = {
                    runCatching { ctx.startActivity(Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE, Uri.parse("package:${ctx.packageName}"))) }
                }, Modifier.testTag("autofill-enable")) { Text("Turn on") }
                for ((pkg, on) in chrome) {
                    HorizontalDivider()
                    Text(ChromeSetup.label(pkg), fontWeight = FontWeight.Medium)
                    Text(
                        when (on) {
                            true -> "Using this autofill service."
                            false -> "Chrome only fills from Google unless you pick \"Autofill using another service\" in its settings, then restart Chrome. Turn on autofill above first, or the option is greyed out."
                            null -> "This version of Chrome doesn't report its setting. Update it, or check Chrome's Settings, Autofill Services."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.testTag("chrome-state-$pkg"),
                    )
                    if (on != true) OutlinedButton(onClick = { ChromeSetup.open(ctx, pkg) }, Modifier.testTag("chrome-open-$pkg")) { Text("Open its settings") }
                }
                HorizontalDivider()
                Text("Edge, Samsung Internet, Firefox, Brave and others: pick Passwords above, and check their own autofill settings if nothing shows.", style = MaterialTheme.typography.bodySmall)
            }
        }
        SettingRow("Show account names in autofill while locked", names, "names-locked") {
            names = it
            p.namesWhileLocked = it
            if (client.unlocked) org.promptly.sync.passwords.autofill.AutofillIndex.rebuild(ctx, client)
        }
        SettingRow("Copy the 2FA code after filling a login", copyTotp, "copy-totp") {
            copyTotp = it
            p.copyTotpAfterFill = it
        }

        if (Build.VERSION.SDK_INT >= 34) {
            Text("Passkeys", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(if (credOn == true) "Passwords can answer passkey and password requests." else "Turn Passwords on as a provider to use passkeys in apps and browsers.", Modifier.testTag("credential-state"))
                    if (credOn != true) Button(onClick = { ChromeSetup.openCredentialSettings(ctx) }, Modifier.testTag("credential-enable")) { Text("Open settings") }
                }
            }
        }

        Text("Unlocking", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        if (Biometrics.available(ctx)) {
            SettingRow("Biometric unlock", bio, "biometric") { on ->
                if (on) askBio = true else {
                    Biometrics.forget()
                    bio = false
                }
            }
        } else {
            Text("Biometric unlock needs a fingerprint or face set up on this phone.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("biometric-unavailable"))
        }
        SettingRow("Lock when the screen goes off", screenOff, "lock-screen-off") {
            screenOff = it
            p.lockOnScreenOff = it
        }
        Text("Lock after")
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            listOf(0 to "Leaving", 1 to "1 min", 5 to "5 min", 15 to "15 min", 60 to "1 hour").forEach { (m, l) ->
                FilterChip(autoLock == m, {
                    autoLock = m
                    p.autoLockMinutes = m
                    Pw.touch()
                }, { Text(l) }, Modifier.testTag("lock-$m"))
            }
        }
        Text("Clear copied secrets after")
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            listOf(15 to "15 s", 30 to "30 s", 60 to "1 min", 0 to "Never").forEach { (s, l) ->
                FilterChip(clip == s, {
                    clip = s
                    p.clipboardSeconds = s
                }, { Text(l) }, Modifier.testTag("clip-$s"))
            }
        }

        Text("Security", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        OutlinedButton(onClick = { changing = true }, Modifier.fillMaxWidth().testTag("change-password")) { Text("Change master password") }
        KdfAndKeyPanel(client)
        TravelPanel(client)
        Text("Your identity words: ${runCatching { client.myIdentityWords().joinToString(" ") }.getOrDefault("")}", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("identity-words"))
        Text("Server: ${client.api.baseUrl}", style = MaterialTheme.typography.bodySmall)
        Text("Promptly for Android ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall)
        OutlinedButton(onClick = { forget = true }, Modifier.fillMaxWidth().testTag("forget-device")) { Text("Forget this device") }
    }
    if (forget) {
        AlertDialog(
            onDismissRequest = { forget = false },
            title = { Text("Forget this device?") },
            text = { Text("This removes the Secret Key and the offline copy from this phone. Your vault stays on the server. You'll need your recovery kit or another device to come back.") },
            confirmButton = {
                TextButton(onClick = {
                    forget = false
                    Pw.forgetDevice()
                }, Modifier.testTag("forget-confirm")) { Text("Forget") }
            },
            dismissButton = { TextButton(onClick = { forget = false }) { Text("Keep") } },
        )
    }
}

/** Stronger stretching, and a new Secret Key. Both need the master password. */
@Composable
private fun KdfAndKeyPanel(client: VaultClient) {
    var password by remember { mutableStateOf("") }
    var open by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var fresh by remember { mutableStateOf<String?>(null) }
    var typed by remember { mutableStateOf("") }
    var kdf by remember { mutableStateOf(client.currentKdf()) }
    val below = remember(kdf) { client.kdfBelowMinimum() }
    val scope = rememberCoroutineScope()
    fun run(block: () -> Unit) {
        busy = true
        error = null
        scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { block() } }
            busy = false
            r.onSuccess {
                kdf = client.currentKdf()
                password = ""
                Biometrics.forget()
            }.onFailure { error = if (it is ApiError && it.status == 401) "That master password isn't right." else errorText(it) }
        }
    }
    Text("Key stretching: ${kdf?.let { "${it.m / 1024} MiB, ${it.t} passes" } ?: "unknown"}", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("kdf-now"))
    if (below) ErrorCard("Your server now asks for stronger settings than this vault uses.")
    fresh?.let { key ->
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Your new Secret Key", fontWeight = FontWeight.SemiBold)
                Text("Your old recovery kit no longer works, and your other devices have to join again. Write this down, away from this phone.")
                Text(key, fontFamily = FontFamily.Monospace, modifier = Modifier.testTag("rotated-key"))
                OutlinedTextField(typed, { typed = it }, label = { Text("To prove you saved it, type its last group") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("rotated-last-group"))
                Button(onClick = {
                    fresh = null
                    scope.launch { withContext(Dispatchers.IO) { runCatching { client.api.confirmKit() } } }
                }, enabled = typed.trim().equals(SecretKeys.lastGroup(key), true), modifier = Modifier.testTag("rotated-done")) { Text("I've saved it") }
            }
        }
    }
    if (!open) {
        OutlinedButton(onClick = { open = true }, Modifier.fillMaxWidth().testTag("key-settings")) { Text("Stronger stretching or a new Secret Key") }
    } else {
        SecretField(password, { password = it }, "Master password", "keys-password")
        error?.let { ErrorCard(it) }
        OutlinedButton(onClick = {
            val pw = password
            val now = client.currentKdf()
            run { client.upgradeKdf(pw, now?.copy(m = minOf(now.m * 2, 1048576))) }
        }, enabled = !busy && password.isNotEmpty(), modifier = Modifier.fillMaxWidth().testTag("kdf-upgrade")) { Text("Use more memory") }
        OutlinedButton(onClick = {
            val pw = password
            run { fresh = SecretKeys.encode(client.rotateSecretKey(pw)) }
        }, enabled = !busy && password.isNotEmpty(), modifier = Modifier.fillMaxWidth().testTag("rotate-key")) { Text("Make a new Secret Key") }
        if (busy) CircularProgressIndicator()
    }
}

/** Travel mode: take chosen vaults off this phone until you're back. */
@Composable
private fun TravelPanel(client: VaultClient) {
    val version by Pw.version.collectAsState()
    var vaults by remember { mutableStateOf<List<VaultClient.VaultInfo>>(emptyList()) }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(version) { vaults = withContext(Dispatchers.IO) { runCatching { client.vaults() }.getOrDefault(emptyList()) } }
    val hidden = vaults.filter { it.vault.hidden }
    fun run(block: () -> Unit) {
        busy = true
        error = null
        scope.launch {
            withContext(Dispatchers.IO) { runCatching { block() } }.onFailure { error = errorText(it) }
            busy = false
            password = ""
        }
    }
    Text("Travel mode", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
    Text("Takes a vault off this phone until you turn it back on. It stays on your server. It helps at a border as long as you don't unlock it while someone's watching.", style = MaterialTheme.typography.bodySmall)
    error?.let { ErrorCard(it) }
    if (hidden.isEmpty()) {
        for (v in vaults) {
            OutlinedButton(onClick = { run { client.setTravelHidden(listOf(v.vault.id)) } }, enabled = !busy, modifier = Modifier.fillMaxWidth().testTag("travel-hide-${v.displayName}")) { Text("Hide ${v.displayName} from this phone") }
        }
    } else {
        Text("Hidden: ${hidden.joinToString(", ") { it.displayName }}", Modifier.testTag("travel-hidden"))
        SecretField(password, { password = it }, "Master password", "travel-password")
        Button(onClick = {
            val pw = password
            run { client.endTravel(pw) }
        }, enabled = !busy && password.isNotEmpty(), modifier = Modifier.testTag("travel-end")) { Text("I'm back: bring them back") }
    }
}

@Composable
private fun ChangePassword(client: VaultClient, onDone: () -> Unit) {
    BackHandler(onBack = onDone)
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var again by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Change master password", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        SecretField(current, { current = it }, "Current master password", "current-master")
        SecretField(next, { next = it }, "New master password", "next-master")
        SecretField(again, { again = it }, "Type it again", "next-master-again")
        error?.let { ErrorCard(it) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = {
                busy = true
                error = null
                scope.launch {
                    val r = withContext(Dispatchers.IO) { runCatching { client.changePassword(current, next) } }
                    busy = false
                    r.onSuccess {
                        // The biometric wrap holds the old keys, so it has to be set up again.
                        Biometrics.forget()
                        onDone()
                    }.onFailure { error = if (it is ApiError && it.status == 401) "That current password isn't right." else errorText(it) }
                }
            }, enabled = !busy && next.length >= 8 && next == again && current.isNotEmpty(), modifier = Modifier.testTag("change-submit")) { Text("Change it") }
            TextButton(onClick = onDone) { Text("Cancel") }
            if (busy) CircularProgressIndicator()
        }
        Spacer(Modifier.height(4.dp))
        Text("Your Secret Key stays the same.", style = MaterialTheme.typography.bodySmall)
    }
}

