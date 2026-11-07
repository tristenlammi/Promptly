// What a first run leads you through, and what could lose you this vault: guided autofill setup,
// the Family offer, the survival warnings, the recovery kit gate, the export reminder and the
// lookalike warning. The web vault's Onboarding and SurvivalPanel, KitGate and MainNotices.
package org.promptly.sync.passwords.ui

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.autofill.AutofillManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.promptly.sync.passwords.ChromeSetup
import org.promptly.sync.passwords.Pw
import org.promptly.sync.passwords.core.ExportReminder
import org.promptly.sync.passwords.core.Exporter
import org.promptly.sync.passwords.core.SecretKeys
import org.promptly.sync.passwords.core.Survival
import org.promptly.sync.passwords.core.SurvivalOut
import org.promptly.sync.passwords.core.VaultClient

// ---- Guided autofill setup (plan 5.2) ---------------------------------------------------

object SetupGuide {
    /** Is there anything left to lead someone through? Chrome only counts if it's installed. */
    fun allOn(ctx: android.content.Context): Boolean {
        val autofill = runCatching { ctx.getSystemService(AutofillManager::class.java).hasEnabledAutofillServices() }.getOrDefault(false)
        val credential = Build.VERSION.SDK_INT < 34 || ChromeSetup.credentialProviderEnabled(ctx) == true
        val chrome = ChromeSetup.installedChannels(ctx).all { ChromeSetup.state(ctx, it) == true }
        return autofill && credential && chrome
    }
}

@Composable
private fun GuideStep(number: Int, title: String, explain: String, done: Boolean?, tag: String, action: String?, onAction: () -> Unit) {
    Card(Modifier.fillMaxWidth().testTag("setup-$tag")) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("$number. $title", fontWeight = FontWeight.SemiBold)
            Text(if (done == true) "Done." else explain, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("setup-$tag-state"))
            if (done != true && action != null) OutlinedButton(onClick = onAction, Modifier.testTag("setup-$tag-open")) { Text(action) }
        }
    }
}

/** Once, after a vault's first opened here. Finishing and skipping both end it for good: it's all
 *  in Settings after that. Nothing here changes a setting by itself, it opens the page that does. */
@Composable
fun SetupGuideScreen(onDone: () -> Unit) {
    val ctx = LocalContext.current
    var autofillOn by remember { mutableStateOf(false) }
    var credOn by remember { mutableStateOf<Boolean?>(null) }
    var chrome by remember { mutableStateOf<Map<String, Boolean?>>(emptyMap()) }
    fun finish() {
        Pw.prefs.setupGuideDone = true
        onDone()
    }
    LifecycleResumeEffect(Unit) {
        autofillOn = runCatching { ctx.getSystemService(AutofillManager::class.java).hasEnabledAutofillServices() }.getOrDefault(false)
        credOn = ChromeSetup.credentialProviderEnabled(ctx)
        chrome = ChromeSetup.installedChannels(ctx).associateWith { ChromeSetup.state(ctx, it) }
        onPauseOrDispose { }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Fill passwords on this phone", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("setup-guide"))
        Text("A few switches and Passwords can fill sign-ins in your apps and browsers. Each button opens the right screen, and you come back here after. You can leave any of this for later, from Settings.", style = MaterialTheme.typography.bodyMedium)
        var n = 1
        GuideStep(n++, "Turn on autofill", "Pick Passwords as this phone's autofill service, so apps and browsers can use your logins.", autofillOn, "autofill", "Turn on") {
            runCatching { ctx.startActivity(Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE, Uri.parse("package:${ctx.packageName}"))) }
        }
        if (Build.VERSION.SDK_INT >= 34) {
            GuideStep(n++, "Passkeys and sign-in prompts", "Turn Passwords on as a provider under Passwords and accounts, so passkeys and sign-in prompts can use it.", credOn, "credential", "Open settings") {
                ChromeSetup.openCredentialSettings(ctx)
            }
        }
        for ((pkg, on) in chrome) {
            GuideStep(
                n++, "Tell ${ChromeSetup.label(pkg)}",
                when (on) {
                    null -> "This version doesn't report its setting. Update it, or check its Settings, Autofill Services."
                    else -> "It only fills from Google unless you pick \"Autofill using another service\" in its settings, then restart it. Turn on autofill first, or the option is greyed out."
                },
                on, "chrome-$pkg", "Open its settings",
            ) { ChromeSetup.open(ctx, pkg) }
        }
        Text("Edge, Samsung Internet, Firefox, Brave and others: once autofill's on, check their own autofill settings if nothing shows.", style = MaterialTheme.typography.bodySmall)
        HorizontalDivider()
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = { finish() }, Modifier.testTag("setup-finish")) { Text("I'm done") }
            TextButton(onClick = { finish() }, Modifier.testTag("setup-skip")) { Text("Skip for now") }
        }
    }
}

// ---- Family (plan 5.3) ----------------------------------------------------------------------

/** Offered once when a vault's made and there's someone to share with. If there's nobody, or the
 *  list can't be had right now, this moves straight along. */
@Composable
fun FamilyStep(client: VaultClient, onDone: () -> Unit) {
    var others by remember { mutableStateOf<Int?>(null) }
    var made by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        val n = withContext(Dispatchers.IO) { runCatching { client.api.people().size }.getOrDefault(0) }
        if (n == 0) onDone() else others = n
    }
    val n = others
    if (n == null) {
        CircularProgressIndicator()
        return
    }
    Text("Your vault is ready", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("family-offer"))
    if (made) {
        Text("Made a Family vault. Add people from Shared vaults.", Modifier.testTag("family-made"))
        Button(onClick = onDone, Modifier.testTag("family-continue")) { Text("Open my vault") }
        return
    }
    Text("There ${if (n == 1) "is 1 other person" else "are $n other people"} on this Promptly. A Family vault is an easy place for logins you share, like streaming or the Wi-Fi.", Modifier.testTag("family-text"))
    error?.let { ErrorCard(it) }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Button(onClick = {
            busy = true
            error = null
            scope.launch {
                val r = withContext(Dispatchers.IO) { runCatching { client.createSharedVault("Family") } }
                busy = false
                r.onSuccess { made = true }.onFailure { error = errorText(it) }
            }
        }, enabled = !busy, modifier = Modifier.testTag("family-make")) { Text("Make a Family vault") }
        TextButton(onClick = onDone, enabled = !busy, modifier = Modifier.testTag("family-skip")) { Text("Not now") }
        if (busy) CircularProgressIndicator()
    }
}

// ---- Survival (plan 5.6) --------------------------------------------------------------------

@Composable
private fun NoteCard(text: String, tag: String, danger: Boolean = false, content: @Composable () -> Unit = {}) {
    val colors = if (danger) CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer) else CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)
    Card(Modifier.fillMaxWidth().testTag(tag), colors = colors) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(text, style = MaterialTheme.typography.bodyMedium)
            content()
        }
    }
}

/** What could lose you this vault, in plain words, with the fix beside it. */
@Composable
fun SurvivalPanel(client: VaultClient, onExport: () -> Unit) {
    var data by remember { mutableStateOf<SurvivalOut?>(null) }
    var checking by remember { mutableStateOf(false) }
    var refresh by remember { mutableIntStateOf(0) }
    val lastSync = remember { runCatching { client.lastSync() }.getOrNull() }
    LaunchedEffect(Unit) { data = withContext(Dispatchers.IO) { runCatching { client.api.survival() }.getOrNull() } }
    val warnings = remember(data) { Survival.warnings(data, lastSync) }
    val due = remember(data, refresh) { Survival.recoveryDue(data?.kitConfirmedAt, runCatching { client.recoveryChecked() }.getOrNull()) }
    if (warnings.isEmpty() && !due) return
    Column(Modifier.testTag("survival"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Keeping this vault safe", fontWeight = FontWeight.SemiBold)
        for (w in warnings) {
            NoteCard(w.text, "survival-${w.key}", w.danger) {
                if (w.export) OutlinedButton(onClick = onExport, Modifier.testTag("survival-export")) { Text("Export") }
            }
        }
        if (due) NoteCard("Do you still have your recovery kit, and do you still know your master password?", "survival-recovery") {
            OutlinedButton(onClick = { checking = true }, Modifier.testTag("survival-check-kit")) { Text("Check my kit") }
        }
    }
    if (checking) RecoveryCheckDialog(client, { checking = false }) {
        checking = false
        refresh++
    }
}

@Composable
private fun RecoveryCheckDialog(client: VaultClient, onCancel: () -> Unit, onPassed: () -> Unit) {
    val ctx = LocalContext.current
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onCancel,
        modifier = Modifier.exposeTags(),
        title = { Text("Recovery check") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Find your kit and make sure you can still read it. Then type your master password. It stays on this device.")
                SecretField(password, { password = it }, "Master password", "recovery-password")
                error?.let { ErrorCard(it) }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                busy = true
                error = null
                val pw = password
                scope.launch {
                    val ok = withContext(Dispatchers.IO) { client.checkPassword(pw) }
                    busy = false
                    if (ok) {
                        withContext(Dispatchers.IO) { client.noteRecoveryChecked() }
                        toast(ctx, "Noted. We'll ask again in six months.")
                        onPassed()
                    } else {
                        error = "That master password isn't right. If you've forgotten it, now's the time to find your kit."
                    }
                }
            }, enabled = !busy && password.isNotEmpty(), modifier = Modifier.testTag("recovery-confirm")) { Text("I have the kit, and this is my password") }
        },
        dismissButton = { TextButton(onClick = onCancel) { Text("Not now") } },
    )
}

/** The way past this is saving the kit: forgetting the password without it loses the vault. It's
 *  the server that keeps count, though, so one that can't or won't take the answer doesn't get to
 *  shut anyone out of what's on this phone. */
@Composable
fun KitGate(client: VaultClient, onDone: () -> Unit) {
    var typed by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var refused by remember { mutableStateOf(false) }
    val key = remember { runCatching { client.encodedSecretKey() }.getOrNull() }
    val scope = rememberCoroutineScope()
    // This phone can't read its own copy of the key, so there's nothing to show. No locking anyone out over it.
    if (key == null) {
        LaunchedEffect(Unit) { onDone() }
        return
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp).testTag("kit-gate"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Save your recovery kit", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        ErrorCard("You haven't confirmed saving your kit yet. If you forget your master password and don't have this, your vault is gone for good. Nobody can get it back for you.")
        Text("Screenshots are blocked here, so write it down, away from this phone, or get the printable kit from the web vault.")
        SensitiveWhile(true)
        Text(key, style = MaterialTheme.typography.titleMedium, fontFamily = FontFamily.Monospace, modifier = Modifier.testTag("kit-gate-key"))
        VisibleSecretField(typed, { typed = it }, "Last group of your Secret Key", "kit-gate-typed")
        error?.let { ErrorCard(it) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = {
                if (!typed.trim().equals(SecretKeys.lastGroup(key), true)) {
                    error = "That's not the last group. Look at your kit again."
                    return@Button
                }
                busy = true
                error = null
                scope.launch {
                    val r = withContext(Dispatchers.IO) { runCatching { client.api.confirmKit() } }
                    busy = false
                    r.onSuccess { onDone() }.onFailure {
                        error = errorText(it)
                        refused = true
                    }
                }
            }, enabled = !busy && typed.isNotBlank(), modifier = Modifier.testTag("kit-gate-done")) { Text("I've saved it") }
            if (busy) CircularProgressIndicator()
        }
        if (refused) {
            Text("Your server didn't take that, so it'll ask again next time you unlock. You can carry on in the meantime.", style = MaterialTheme.typography.bodySmall)
            OutlinedButton(onClick = onDone, enabled = !busy, modifier = Modifier.testTag("kit-gate-later")) { Text("Carry on for now") }
        }
    }
}

/** Things that need a look, on any screen. `here` is which of them this screen already deals with. */
data class NoticeState(val requests: Int = 0, val recoveryDue: Boolean = false)

@Composable
fun MainNotices(
    client: VaultClient,
    onHereDevices: Boolean,
    onHereShared: Boolean,
    onHereSecurity: Boolean,
    onHereExport: Boolean,
    onDevices: () -> Unit,
    onShared: () -> Unit,
    onSecurity: () -> Unit,
    onExport: () -> Unit,
    onNeedKit: () -> Unit,
) {
    var state by remember { mutableStateOf(NoticeState()) }
    var snoozed by remember { mutableIntStateOf(0) }
    val version by Pw.version.collectAsState()
    val p = Pw.prefs
    LaunchedEffect(Unit) {
        if (p.exportSince == 0L) p.exportSince = System.currentTimeMillis()
        while (true) {
            // Offline: the Security check says what it can.
            val s = withContext(Dispatchers.IO) {
                runCatching {
                    val survival = client.api.survival()
                    val checked = client.recoveryChecked()
                    Triple(survival, Survival.recoveryDue(survival?.kitConfirmedAt, checked), client.api.deviceRequests().size)
                }.getOrNull()
            }
            if (s != null) {
                if (s.first?.kitConfirmed == false) onNeedKit()
                state = NoticeState(s.third, s.second)
            }
            delay(60_000)
        }
    }
    val changed = remember(version) { client.keyChanges.isNotEmpty() }
    val exportDue = remember(snoozed, p.exportLast) { ExportReminder.due(p.exportLast, p.exportSince, p.exportSnoozedUntil) }
    val show = (state.requests > 0 && !onHereDevices) || (changed && !onHereShared) || (state.recoveryDue && !onHereSecurity) || (exportDue && !onHereExport)
    if (!show) return
    Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (state.requests > 0 && !onHereDevices) NoteCard("A new device wants to join your vault.", "notice-request") {
            OutlinedButton(onClick = onDevices, Modifier.testTag("notice-request-review")) { Text("Review") }
        }
        if (changed && !onHereShared) NoteCard("A shared vault can't open, because someone's keys changed.", "notice-keys") {
            OutlinedButton(onClick = onShared, Modifier.testTag("notice-keys-look")) { Text("Look at it") }
        }
        if (state.recoveryDue && !onHereSecurity) NoteCard("Time to check you still have your recovery kit.", "notice-recovery") {
            OutlinedButton(onClick = onSecurity, Modifier.testTag("notice-recovery-check")) { Text("Check") }
        }
        if (exportDue && !onHereExport) NoteCard(ExportReminder.text(p.exportLast), "notice-export") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onExport, Modifier.testTag("notice-export-now")) { Text("Export now") }
                TextButton(onClick = {
                    p.exportSnoozedUntil = ExportReminder.snoozeUntil()
                    snoozed++
                }, Modifier.testTag("notice-export-later")) { Text("Later") }
            }
        }
    }
}

// ---- The export reminder's way to do it right there ----------------------------------------

/** One job: an encrypted file, through the system's picker. Same format as Import and export. */
@Composable
fun ExportNowScreen(client: VaultClient, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var master by remember { mutableStateOf("") }
    var filePassword by remember { mutableStateOf("") }
    var again by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf<String?>(null) }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val text = pending
        pending = null
        if (uri != null && text != null) {
            scope.launch {
                val r = withContext(Dispatchers.IO) {
                    runCatching {
                        ctx.contentResolver.openOutputStream(uri, "wt")!!.use { it.write(text.toByteArray()) }
                        runCatching { client.api.noteExport() }
                    }
                }
                r.onSuccess {
                    Pw.prefs.exportLast = System.currentTimeMillis()
                    toast(ctx, "Saved. Keep it off this phone.")
                    onBack()
                }.onFailure { error = "That file couldn't be saved." }
            }
        }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack, Modifier.testTag("back")) { Text("Back") }
            Text("Encrypted export", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("export-now"))
        }
        Text("This saves a file of your vault that opens only with the password you choose here. Save it somewhere that isn't this phone or your server, like a drive you keep at home.", style = MaterialTheme.typography.bodyMedium)
        SecretField(master, { master = it }, "Your master password", "reminder-master")
        SecretField(filePassword, { filePassword = it }, "Password for the file", "reminder-password")
        SecretField(again, { again = it }, "Type it again", "reminder-again")
        error?.let { ErrorCard(it) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = {
                busy = true
                error = null
                val m = master
                val pw = filePassword
                scope.launch {
                    val r = withContext(Dispatchers.IO) {
                        runCatching {
                            if (!client.checkPassword(m)) throw IllegalStateException("That master password isn't right.")
                            Exporter.encrypted(client.exportable(), pw)
                        }
                    }
                    busy = false
                    r.onSuccess {
                        pending = it
                        master = ""
                        filePassword = ""
                        again = ""
                        saver.launch("promptly-passwords-export.json")
                    }.onFailure { error = errorText(it) }
                }
            }, enabled = !busy && master.isNotEmpty() && filePassword.length >= 8 && filePassword == again, modifier = Modifier.testTag("reminder-save")) { Text("Save encrypted export") }
            if (busy) CircularProgressIndicator()
        }
    }
}

// ---- Lookalike warning (plan 5.13) ----------------------------------------------------------

/** The safe choice is on top and is the one that stands out. The other ignores presses for 600 ms,
 *  so a tap meant for whatever was on screen before this can't land on it (D45). */
@Composable
fun LookalikeWarning(page: String, looksLike: String, fills: List<String>, proceed: String, onNo: () -> Unit, onYes: () -> Unit) {
    var armed by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(600)
        armed = true
    }
    Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp).testTag("lookalike"), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("This could be phishing", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        ErrorCard("$page looks like $looksLike, but it's a different site.")
        Text("Look at the address again. If you meant to go to $looksLike, close this and go there yourself.", style = MaterialTheme.typography.bodyMedium)
        if (fills.isNotEmpty()) Text("It will fill: ${fills.joinToString(", ")}.", style = MaterialTheme.typography.bodyMedium)
        Button(onClick = onNo, Modifier.fillMaxWidth().testTag("lookalike-no")) { Text("Don't fill") }
        OutlinedButton(onClick = onYes, enabled = armed, modifier = Modifier.fillMaxWidth().testTag("lookalike-yes")) { Text(proceed) }
    }
}
