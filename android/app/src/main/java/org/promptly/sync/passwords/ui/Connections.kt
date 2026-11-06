// Where the vault meets the rest of Promptly, on a phone: the activity log, and the web vault's
// Connections screens. What the server hands over is compared with the vault here, and shown as text.
package org.promptly.sync.passwords.ui

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.promptly.sync.Api
import org.promptly.sync.Store
import org.promptly.sync.passwords.ChangeQueue
import org.promptly.sync.passwords.Clip
import org.promptly.sync.passwords.Links
import org.promptly.sync.passwords.Pw
import org.promptly.sync.passwords.core.ActivityLog
import org.promptly.sync.passwords.core.ActivityOut
import org.promptly.sync.passwords.core.ApiError
import org.promptly.sync.passwords.core.DriveFile
import org.promptly.sync.passwords.core.DriveFiles
import org.promptly.sync.passwords.core.Generator
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.PasswordChange
import org.promptly.sync.passwords.core.SecurityEvent
import org.promptly.sync.passwords.core.SecurityEvents
import org.promptly.sync.passwords.core.Totp
import org.promptly.sync.passwords.core.TotpConfig
import org.promptly.sync.passwords.core.VaultApi
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.newBody
import org.promptly.sync.passwords.core.parseInstant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** The server's time, in this phone's zone and format. */
fun localTime(iso: String): String = parseInstant(iso)?.let {
    DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withZone(ZoneId.systemDefault()).format(it)
} ?: ""

/** A request that needs a live vault session: if it's ended while the keys are here, prove again once. */
fun <T> withSession(client: VaultClient, block: () -> T): T = try {
    block()
} catch (e: ApiError) {
    if (e.status != 401) throw e
    client.reprove()
    block()
}

// ---- Activity ---------------------------------------------------------------------------

@Composable
fun ActivityScreen(client: VaultClient, onBack: () -> Unit) {
    var rows by remember { mutableStateOf<List<ActivityOut>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        withContext(Dispatchers.IO) { runCatching { withSession(client) { client.api.activity() } } }
            .onSuccess { rows = it }
            .onFailure { error = errorText(it) }
    }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Header("Activity", onBack)
        Text("Things that happened to your vault. It never records item names.", style = MaterialTheme.typography.bodySmall)
        error?.let { ErrorCard(it) }
        val list = rows
        if (list == null && error == null) CircularProgressIndicator()
        if (list != null && list.isEmpty()) Text("Nothing yet.", Modifier.testTag("activity-empty"))
        LazyColumn(Modifier.weight(1f)) {
            itemsIndexed(list ?: emptyList()) { i, r ->
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp).testTag("activity-$i"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(ActivityLog.text(r.event), Modifier.weight(1f))
                    Text(localTime(r.at), style = MaterialTheme.typography.bodySmall)
                }
                HorizontalDivider()
            }
        }
    }
}

// ---- Mail codes, and adding what a phone needs for them ----------------------------------------

@Composable
fun MailCodesSetting(client: VaultClient) {
    var on by remember { mutableStateOf(Pw.prefs.mailCodes) }
    var needScope by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Text("Email codes", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text("Offer codes and sign-in links from Promptly Mail when a site asks", Modifier.weight(1f))
        Switch(on, { want ->
            error = null
            if (!want) {
                on = false
                Pw.prefs.mailCodes = false
                needScope = false
            } else {
                busy = true
                scope.launch {
                    val r = withContext(Dispatchers.IO) { runCatching { client.api.devices().firstOrNull { it.current }?.scopes } }
                    busy = false
                    r.onSuccess { scopes ->
                        if (scopes != null && "mail_codes" in scopes) {
                            on = true
                            Pw.prefs.mailCodes = true
                        } else {
                            needScope = true
                        }
                    }.onFailure { error = errorText(it) }
                }
            }
        }, enabled = !busy, modifier = Modifier.testTag("mail-codes"))
    }
    Text("Autofill shows a row on a code box, and on a sign-in step that only asks for your email. Pick it and this phone asks your server for your mail from the last ten minutes, then compares the senders with the site itself. Your server isn't told which site. Nothing fills until you tap it, and a sender that isn't the site gets no row.", style = MaterialTheme.typography.bodySmall)
    error?.let { ErrorCard(it) }
    if (needScope) MailScopePanel(client, "This phone was connected before email codes, so it isn't allowed to read them yet. Connecting it again adds that. Your vault and everything on this phone stay as they are.") {
        needScope = false
        on = true
        Pw.prefs.mailCodes = true
    }
}

/** A device token's scopes are fixed when it's made, so this makes a new one and drops the old one:
 *  the app password if this phone has one that's allowed, or a code approved in a browser. */
@Composable
fun MailScopePanel(client: VaultClient, why: String, onDone: () -> Unit) {
    val ctx = LocalContext.current
    var busy by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun finish(token: String, deviceId: String) {
        withContext(Dispatchers.IO) { Pw.replaceDevice(token, deviceId) }
        busy = false
        code = null
        onDone()
    }

    fun start() {
        busy = true
        error = null
        val url = client.api.baseUrl
        val anon = VaultApi(url, { null })
        scope.launch {
            val paired = runCatching { Store(ctx).account }.getOrNull()?.takeIf { it.server.trimEnd('/') == url }
            if (paired != null) {
                val r = withContext(Dispatchers.IO) { runCatching { anon.registerDevice(VaultApi.basic(paired.username, paired.password), Api.deviceName()) } }
                r.getOrNull()?.let {
                    finish(it.token, it.deviceId)
                    return@launch
                }
                val e = r.exceptionOrNull()
                if (e !is ApiError || (e.status != 401 && e.status != 403)) {
                    error = errorText(e ?: IllegalStateException())
                    busy = false
                    return@launch
                }
            }
            val started = withContext(Dispatchers.IO) { runCatching { anon.connectStart(Api.deviceName()) } }.getOrElse {
                error = errorText(it)
                busy = false
                return@launch
            }
            code = started.code
            Links.open(ctx, "$url/passwords/connect?code=${Uri.encode(started.code)}")
            val deadline = System.currentTimeMillis() + 10 * 60_000
            while (System.currentTimeMillis() < deadline) {
                delay(2000)
                val r = withContext(Dispatchers.IO) { runCatching { anon.connectPoll(started.id, started.pollSecret) } }.getOrNull() ?: continue
                if (r.status == "denied") {
                    error = "That was turned down in the browser."
                    break
                }
                if (r.token != null && r.deviceId != null) {
                    finish(r.token, r.deviceId)
                    return@launch
                }
            }
            if (error == null) error = "No answer from the browser. Try again."
            code = null
            busy = false
        }
    }

    Card(Modifier.fillMaxWidth().testTag("mail-scope")) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(why, style = MaterialTheme.typography.bodySmall)
            error?.let { ErrorCard(it) }
            code?.let {
                Text("Approve this in your browser. This phone's code:", style = MaterialTheme.typography.bodySmall)
                Text(it, style = MaterialTheme.typography.titleMedium, fontFamily = FontFamily.Monospace, modifier = Modifier.testTag("mail-scope-code"))
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { start() }, enabled = !busy, modifier = Modifier.testTag("mail-scope-add")) { Text("Connect this phone again") }
                if (busy) CircularProgressIndicator()
            }
        }
    }
}

// ---- Security emails (plan 5.8) ----------------------------------------------------------------

private fun dismissedOf(client: VaultClient): Set<String> =
    (runCatching { client.store.getMeta(SecurityEvents.DISMISSED_META) }.getOrNull() as? JsonArray)?.mapNotNullTo(LinkedHashSet()) { (it as? JsonPrimitive)?.content } ?: emptySet()

/** "Instagram says your password changed. Was that you?" Matched here, against the vault. */
@Composable
fun MailAlertsPanel(client: VaultClient, onChange: (Item) -> Unit, onOpen: (String) -> Unit) {
    val version by Pw.version.collectAsState()
    var events by remember { mutableStateOf<List<SecurityEvent>>(emptyList()) }
    var dismissed by remember { mutableStateOf(dismissedOf(client)) }
    var noScope by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    var again by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(again) {
        withContext(Dispatchers.IO) { runCatching { withSession(client) { client.api.securityEvents() } } }
            .onSuccess {
                events = it
                noScope = false
            }
            // A nice extra, as on the web, and a server with nothing to say isn't a problem to report.
            .onFailure { noScope = it is ApiError && it.status == 403 }
    }
    val alerts = remember(events, version, dismissed) { SecurityEvents.alerts(events, runCatching { client.allItems() }.getOrDefault(emptyList())).filter { it.event.id !in dismissed } }
    if (noScope) {
        if (adding) {
            MailScopePanel(client, "Security emails are read from Promptly Mail, which this phone wasn't connected for. Connecting it again adds that. Your vault and everything on this phone stay as they are.") {
                adding = false
                again++
            }
        } else {
            TextButton(onClick = { adding = true }, Modifier.testTag("mail-alerts-add")) { Text("Watch your email for security alerts too") }
        }
    }
    if (alerts.isEmpty()) return
    Column(Modifier.testTag("mail-alerts"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("From your email", fontWeight = FontWeight.SemiBold)
        for (a in alerts) {
            Card(Modifier.fillMaxWidth().testTag("mail-alert-${a.event.id}"), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(a.text, Modifier.testTag("mail-alert-text"))
                    Text("${localTime(a.event.at)}, ${a.event.subject}", style = MaterialTheme.typography.bodySmall)
                    if (client.canEdit(a.item.vaultId)) OutlinedButton(onClick = { onChange(a.item) }, Modifier.fillMaxWidth().testTag("alert-change")) { Text("Not me: change password") }
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        TextButton(onClick = { onOpen(a.item.id) }, Modifier.testTag("alert-open")) { Text("Open login") }
                        TextButton(onClick = {
                            val next = dismissed + a.event.id
                            dismissed = next
                            scope.launch { withContext(Dispatchers.IO) { runCatching { client.store.setMeta(SecurityEvents.DISMISSED_META, JsonArray(next.toList().takeLast(200).map { JsonPrimitive(it) })) } } }
                        }, Modifier.testTag("alert-dismiss")) { Text("That was me") }
                    }
                }
            }
        }
    }
}

// ---- Changing a password with the site (plan 5.10) -----------------------------------------------

/** One password, with the site, at the person's pace, or a list of them one at a time. It's never a
 *  bot: each step is someone's tap. On a phone the site opens in the browser, where Android's autofill
 *  can offer the current and new password, and where it doesn't the two are here to copy. */
@Composable
fun ChangePasswordScreen(client: VaultClient, onBack: () -> Unit) {
    var at by remember { mutableIntStateOf(ChangeQueue.at) }
    val ids = ChangeQueue.ids
    fun leave() {
        ChangeQueue.clear()
        onBack()
    }
    fun next() {
        at += 1
        ChangeQueue.at = at
        if (ids.size == 1) leave()
    }
    if (at >= ids.size) {
        Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Header("All done") { leave() }
            Text("You've been through the list. Run the Security check again to see what's left.", Modifier.testTag("change-all-done"))
            Button(onClick = { leave() }, Modifier.testTag("change-close")) { Text("Close") }
        }
        return
    }
    key(ids[at]) { ChangeOne(client, ids[at], if (ids.size > 1) "${at + 1} of ${ids.size}" else null, { next() }, { leave() }) }
}

@Composable
private fun ChangeOne(client: VaultClient, id: String, position: String?, onNext: () -> Unit, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val version by Pw.version.collectAsState()
    val item = remember(id, version) { client.get(id) }
    if (item == null || item.deleted || !client.canEdit(item.vaultId)) {
        LaunchedEffect(Unit) { onNext() }
        return
    }
    var passed by remember { mutableStateOf(!item.body.reprompt) }
    if (!passed) {
        ConfirmIdentityPane(ctx as FragmentActivity, "Confirm it's you", item.body.title, true, { passed = true }, onClose)
        return
    }
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val pending = item.body.str("pendingPassword")
    val url = remember(item.body.urls) { PasswordChange.changePageUrl(item.body) }

    fun act(done: () -> Unit = {}, block: () -> Unit) {
        busy = true
        error = null
        scope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    block()
                    // Saved here first. The server catches up when it can.
                    runCatching { client.sync() }
                }
            }
            busy = false
            r.onSuccess { done() }.onFailure { error = errorText(it) }
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp).testTag("change-flow"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Header("Change password", onClose)
        position?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("change-position")) }
        Text(item.body.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("change-title"))
        error?.let { ErrorCard(it) }
        if (pending == null) {
            Text("A new password gets made for this site and saved here first, so a failed change can't lose it. You then change it on the site.")
            Button(onClick = {
                act {
                    val fresh = client.get(id) ?: throw IllegalStateException("That login's gone.")
                    client.update(id, PasswordChange.withPending(fresh.body, Generator.forSite(fresh.body.urls.firstOrNull()?.url?.let { Match.hostOf(it) })))
                }
            }, enabled = !busy, modifier = Modifier.testTag("change-start")) { Text("Make a new password") }
        } else {
            Text("Your new password is saved, waiting on the site.", Modifier.testTag("change-waiting"))
            if (url != null) OutlinedButton(onClick = { Links.open(ctx, url) }, Modifier.fillMaxWidth().testTag("change-open")) { Text("Open the site's change page") }
            Text("If Passwords is your autofill service, tap the password box on that page and pick this login: it fills the current password and the new one. If nothing's offered, copy them from here.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("change-note"))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedButton(onClick = {
                    Clip.copySecret(ctx, "Current password", item.body.password ?: "")
                    toast(ctx, "Current password copied")
                }, Modifier.testTag("change-copy-current")) { Text("Copy current") }
                OutlinedButton(onClick = {
                    Clip.copySecret(ctx, "New password", pending)
                    toast(ctx, "New password copied")
                }, Modifier.testTag("change-copy-new")) { Text("Copy new") }
            }
            Text("Did the site accept it?", fontWeight = FontWeight.Medium)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Button(onClick = {
                    act({
                        toast(ctx, "Password changed. The old one's in its history.")
                        onNext()
                    }) { client.update(id, PasswordChange.commit(client.get(id)!!.body)) }
                }, enabled = !busy, modifier = Modifier.testTag("change-yes")) { Text("Yes, it's changed") }
                OutlinedButton(onClick = {
                    act({
                        toast(ctx, "Kept the old password.")
                        onNext()
                    }) { client.update(id, PasswordChange.drop(client.get(id)!!.body)) }
                }, enabled = !busy, modifier = Modifier.testTag("change-no")) { Text("No, keep the old one") }
            }
        }
        if (position != null) TextButton(onClick = onNext, enabled = !busy, modifier = Modifier.testTag("change-skip")) { Text("Skip this one") }
    }
}

// ---- Plus addresses (plan 5.11) ------------------------------------------------------------------

@Composable
fun PlusAddressPanel(client: VaultClient, email: String, onEmail: (String) -> Unit, tag: String, onTag: (String) -> Unit, address: String) {
    var label by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var noScope by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val valid = email.indexOf('@') >= 1 && tag.isNotBlank()
    fun rule() {
        busy = true
        error = null
        label = null
        scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { withSession(client) { client.api.plusRule(address) } } }
            busy = false
            r.onSuccess { label = it ?: "its own label" }.onFailure {
                if (it is ApiError && it.status == 403) noScope = true else error = errorText(it)
            }
        }
    }
    Text("Or a plus-address", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
    Text("A one-site address that lands in your inbox, so you can see who leaked or sold it. Your email provider has to support plus-addressing.", style = MaterialTheme.typography.bodySmall)
    OutlinedTextField(email, onEmail, label = { Text("Your email") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("plus-email"))
    OutlinedTextField(tag, onTag, label = { Text("This site") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("plus-tag"))
    error?.let { ErrorCard(it) }
    if (noScope) {
        MailScopePanel(client, "Labels are made in Promptly Mail, which this phone wasn't connected for. Connecting it again adds that. Your vault and everything on this phone stay as they are.") {
            noScope = false
            rule()
        }
    } else if (valid) {
        OutlinedButton(onClick = { rule() }, enabled = !busy, modifier = Modifier.testTag("plus-label")) { Text("Label its mail in Promptly Mail") }
    }
    label?.let { Text("Mail to this address will be labelled $it", Modifier.testTag("plus-result")) }
}

// ---- Documents from Files (plan 5.12) ------------------------------------------------------------

/** Move a scan from Files into the vault, then offer to bin the unencrypted original. */
@Composable
fun FromFilesPane(client: VaultClient, item: Item, onClose: () -> Unit) {
    BackHandler(onBack = onClose)
    var query by remember { mutableStateOf("") }
    var files by remember { mutableStateOf<List<DriveFile>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var moved by remember { mutableStateOf<DriveFile?>(null) }
    var trashed by remember { mutableStateOf(false) }
    var reminded by remember { mutableStateOf(false) }
    var remind by remember { mutableStateOf(item.body.str("expiresOn") ?: "") }
    val scope = rememberCoroutineScope()
    fun act(block: () -> Unit, done: () -> Unit) {
        error = null
        scope.launch {
            withContext(Dispatchers.IO) { runCatching { withSession(client) { block() } } }.onSuccess { done() }.onFailure { error = errorText(it) }
        }
    }
    val got = moved
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp).testTag("from-files"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (got != null) {
            Header("It's in the vault", onClose)
            Text("${got.name} is now encrypted here. The original is still in Files, where your server can read it.", Modifier.testTag("files-moved"))
            error?.let { ErrorCard(it) }
            if (trashed) Text("Moved to Files' Trash.", Modifier.testTag("files-trashed"))
            else Button(onClick = { act({ client.api.driveTrash(got.id) }) { trashed = true } }, Modifier.testTag("files-trash")) { Text("Move the original to Trash") }
            HorizontalDivider()
            Text("Calendar isn't end-to-end encrypted, so a reminder just says \"Document expires soon\", and nothing about which one.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("files-remind-why"))
            OutlinedTextField(remind, { remind = it }, label = { Text("Remind me in Calendar on (YYYY-MM-DD)") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("files-remind"))
            val day = DriveFiles.validDay(remind)
            if (reminded) Text("Reminder added.", Modifier.testTag("files-reminded"))
            else OutlinedButton(onClick = { day?.let { d -> act({ client.api.reminder(d) }) { reminded = true } } }, enabled = day != null, modifier = Modifier.testTag("files-remind-add")) { Text("Add the reminder") }
            TextButton(onClick = onClose, Modifier.testTag("files-done")) { Text("Done") }
        } else {
            Header("Add from Files", onClose)
            LaunchedEffect(query) {
                delay(200)
                withContext(Dispatchers.IO) { runCatching { withSession(client) { client.api.driveFiles(query) } } }
                    .onSuccess {
                        files = it
                        loaded = true
                    }
                    .onFailure { error = errorText(it) }
            }
            OutlinedTextField(query, { query = it }, label = { Text("Search your files") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("files-search"))
            error?.let { ErrorCard(it) }
            for (f in files) {
                Column(Modifier.fillMaxWidth().clickable(enabled = busy == null) {
                    busy = "Encrypting ${f.name}"
                    error = null
                    scope.launch {
                        val r = withContext(Dispatchers.IO) { runCatching { withSession(client) { client.addFromFiles(item.id, f) { d, t -> busy = "Encrypting ${f.name}: $d of $t MB" } } } }
                        busy = null
                        r.onSuccess { moved = f }.onFailure { error = errorText(it) }
                    }
                }.padding(vertical = 8.dp).testTag("files-row-${f.name}")) {
                    Text(f.name)
                    Text("%.1f MB".format(f.sizeBytes / 1048576.0), style = MaterialTheme.typography.bodySmall)
                }
                HorizontalDivider()
            }
            if (loaded && files.isEmpty()) Text("Nothing found.", Modifier.testTag("files-empty"))
            busy?.let {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator()
                    Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("files-busy"))
                }
            }
        }
    }
}

/** On a document with a date. Its words are the server's, and the same for everything. */
@Composable
fun ExpiryReminderRow(client: VaultClient, item: Item, canEdit: Boolean) {
    val day = remember(item.body) { item.body.str("expiresOn")?.let { DriveFiles.validDay(it) } } ?: return
    if (item.body.bool("remindExpiry")) {
        Text("A reminder is on your Calendar for $day.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("reminder-set"))
        return
    }
    if (!canEdit) return
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    OutlinedButton(onClick = {
        busy = true
        error = null
        scope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    withSession(client) { client.api.reminder(day) }
                    client.update(item.id, client.get(item.id)!!.body.withFlag("remindExpiry", true))
                    runCatching { client.sync() }
                }
            }
            busy = false
            r.onFailure { error = errorText(it) }
        }
    }, enabled = !busy, modifier = Modifier.testTag("reminder-add")) { Text("Remind me in Calendar") }
    Text("It'll just say \"Document expires soon\", since Calendar isn't end-to-end encrypted.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("reminder-why"))
    error?.let { ErrorCard(it) }
}

// ---- Promptly's own login (plan 5.14) ------------------------------------------------------------

/** Your Promptly login is the one you'd most hate to lose, and a good first thing to save. Offered
 *  once, when a vault's made here. Nothing's taken from this phone's stored app password. */
@Composable
fun SavePromptlyStep(client: VaultClient, onDone: () -> Unit) {
    val ctx = LocalContext.current
    var username by remember { mutableStateOf(runCatching { Store(ctx).account }.getOrNull()?.takeIf { it.server.trimEnd('/') == client.api.baseUrl }?.username ?: "") }
    var password by remember { mutableStateOf("") }
    var otp by remember { mutableStateOf("") }
    var saved by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    if (saved) {
        Text("Saved your Promptly login. Your master password is the one thing it can't hold for you.", Modifier.testTag("promptly-saved"))
        Button(onClick = onDone, Modifier.testTag("promptly-continue")) { Text("Open my vault") }
        return
    }
    Text("Save your Promptly login here", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("promptly-offer"))
    OutlinedTextField(username, { username = it }, label = { Text("Username or email") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("promptly-username"))
    SecretField(password, { password = it }, "Promptly password", "promptly-password")
    VisibleSecretField(otp, { otp = it }, "Promptly 2FA setup key, if you have one", "promptly-otp")
    Text("An otpauth link, or the key your authenticator shows.", style = MaterialTheme.typography.bodySmall)
    Card(Modifier.fillMaxWidth().testTag("promptly-warning"), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)) {
        Text("This is the one login you need to reach your server. If it's only in here and you lose your kit too, keep in mind you'd have neither. Keep your kit, and keep your Promptly password somewhere else as well.", Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall)
    }
    error?.let { ErrorCard(it) }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Button(onClick = {
            busy = true
            error = null
            val name = username
            val pw = password
            val key = otp.trim()
            scope.launch {
                val r = withContext(Dispatchers.IO) {
                    runCatching {
                        val totp = when {
                            key.isEmpty() -> null
                            key.startsWith("otpauth://") -> Totp.parseOtpauth(key)
                            else -> key.replace(" ", "").uppercase().let {
                                Totp.base32Decode(it)
                                TotpConfig(it)
                            }
                        }
                        client.saveNew(client.personalVaultId(), newBody("login", "Promptly").withText("username", name).withText("password", pw).withUrls(listOf(LoginUrl(client.api.baseUrl))).withTotp(totp))
                        runCatching { client.sync() }
                    }
                }
                busy = false
                r.onSuccess {
                    password = ""
                    saved = true
                }.onFailure { error = errorText(it) }
            }
        }, enabled = !busy && username.isNotBlank() && password.isNotEmpty(), modifier = Modifier.testTag("promptly-save")) { Text("Save it") }
        TextButton(onClick = onDone, enabled = !busy, modifier = Modifier.testTag("promptly-skip")) { Text("Not now") }
        if (busy) CircularProgressIndicator()
    }
}
