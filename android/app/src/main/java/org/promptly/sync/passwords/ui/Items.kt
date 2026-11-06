// The vault's main screens: the list with search, an item's view, and the editor for
// every kind. The field table is the web vault's (ItemEditor.tsx), so both show the same.
package org.promptly.sync.passwords.ui

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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import org.promptly.sync.passwords.Clip
import org.promptly.sync.passwords.Pw
import org.promptly.sync.passwords.SiteIconCache
import org.promptly.sync.passwords.core.AttachmentRef
import org.promptly.sync.passwords.core.Attachments
import org.promptly.sync.passwords.core.CustomField
import org.promptly.sync.passwords.core.Generator
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.ItemBody
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.SiteIcons
import org.promptly.sync.passwords.core.StrengthCheck
import org.promptly.sync.passwords.core.wifiQrText
import org.promptly.sync.passwords.core.Totp
import org.promptly.sync.passwords.core.TotpConfig
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.newBody

val KIND_LABEL = linkedMapOf(
    "login" to "Login", "note" to "Secure note", "card" to "Card", "identity" to "Identity", "totp" to "2FA code", "passkey" to "Passkey",
    "apikey" to "API key", "wifi" to "Wi-Fi", "ssh" to "SSH key", "bank" to "Bank account", "document" to "Licence or ID",
)
val CREATABLE = listOf("login", "note", "card", "identity", "totp", "apikey", "wifi", "ssh", "bank", "document")

data class FieldDef(val key: String, val label: String, val secret: Boolean = false, val area: Boolean = false)

val FIELDS = mapOf(
    "card" to listOf(FieldDef("cardholder", "Name on card"), FieldDef("cardNumber", "Card number", true), FieldDef("cardBrand", "Brand"), FieldDef("cardExpMonth", "Expiry month"), FieldDef("cardExpYear", "Expiry year"), FieldDef("cardCvv", "Security code", true)),
    "identity" to listOf(FieldDef("firstName", "First name"), FieldDef("middleName", "Middle name"), FieldDef("lastName", "Last name"), FieldDef("email", "Email"), FieldDef("phone", "Phone"), FieldDef("company", "Company"), FieldDef("address1", "Address"), FieldDef("address2", "Address line 2"), FieldDef("city", "City"), FieldDef("state", "State"), FieldDef("postcode", "Postcode"), FieldDef("country", "Country")),
    "apikey" to listOf(FieldDef("apiKey", "Key", true), FieldDef("apiSecret", "Secret", true)),
    "wifi" to listOf(FieldDef("ssid", "Network name"), FieldDef("wifiPassword", "Password", true)),
    "ssh" to listOf(FieldDef("sshPublic", "Public key", area = true), FieldDef("sshPrivate", "Private key", secret = true, area = true), FieldDef("sshFingerprint", "Fingerprint")),
    "bank" to listOf(FieldDef("bankName", "Bank"), FieldDef("accountName", "Account name"), FieldDef("accountNumber", "Account number", true), FieldDef("routingNumber", "BSB or routing number"), FieldDef("iban", "IBAN", true), FieldDef("swift", "SWIFT")),
    "document" to listOf(FieldDef("documentType", "Type"), FieldDef("documentNumber", "Number", true), FieldDef("expiresOn", "Expires (YYYY-MM-DD)")),
)

private val MATCHES = listOf(null to "This site and its subdomains", "host" to "Exact host", "exact" to "Exact URL", "prefix" to "Starts with", "regex" to "Pattern", "never" to "Never")

@Composable
fun ItemListScreen(client: VaultClient, onOpen: (String) -> Unit, onNew: () -> Unit, onSync: () -> Unit, syncing: Boolean, banner: String?) {
    var query by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf("all") }
    var folder by remember { mutableStateOf<String?>(null) }
    var tag by remember { mutableStateOf<String?>(null) }
    val version by Pw.version.collectAsState()
    val everything = remember(version) { runCatching { client.allItems(includeSystem = true) }.getOrDefault(emptyList()) }
    val folders = remember(everything) { everything.filter { it.body.kind == "folder" } }
    val tags = remember(everything) { everything.filter { !it.body.isSystem }.flatMap { it.body.tags }.toSortedSet().toList() }
    val iconVaults = remember(everything) { SiteIcons.iconVaults(everything) }
    // What was picked can go: a rename elsewhere, or the last item with that tag.
    if (tag != null && tag !in tags) tag = null
    if (folder != null && folders.none { it.id == folder }) folder = null
    val shown = remember(query, filter, folder, tag, version) {
        // Locking can land between two frames: an empty list for that one is fine.
        val base = runCatching { if (query.isBlank()) client.allItems() else client.search(query) }.getOrDefault(emptyList())
        base.filter { i ->
            val b = i.body
            val fits = when (filter) {
                "fav" -> b.favorite
                "archive" -> b.archived
                "all" -> !b.archived
                else -> b.kind == filter && !b.archived
            }
            fits && (folder == null || b.str("folderId") == folder) && (tag == null || tag in b.tags)
        }
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(8.dp))
        if (client.preview) PreviewNote()
        banner?.let {
            Spacer(Modifier.height(6.dp))
            ErrorCard(it)
        }
        if (client.rollbackWarnings.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            ErrorCard("The server showed an older copy of your vault than this phone has seen. This phone kept its own copy. Tell your server's admin: it may have been restored from a backup, or tampered with.")
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(query, { query = it }, label = { Text("Search") }, singleLine = true, modifier = Modifier.weight(1f).testTag("search"))
            TextButton(onClick = onSync, enabled = !syncing, modifier = Modifier.testTag("sync")) { Text(if (syncing) "Syncing" else "Sync") }
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("all" to "All", "fav" to "Favourites", "login" to "Logins", "card" to "Cards", "identity" to "Identities", "note" to "Notes", "totp" to "2FA", "passkey" to "Passkeys", "archive" to "Archive").forEach { (k, l) ->
                FilterChip(filter == k, { filter = k }, { Text(l) })
            }
        }
        if (folders.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()).testTag("folder-row"), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                folders.forEach { f -> FilterChip(folder == f.id, { folder = if (folder == f.id) null else f.id }, { Text(f.body.title) }, Modifier.testTag("folder-${f.body.title}")) }
            }
        }
        if (tags.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()).testTag("tag-row"), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                tags.forEach { t -> FilterChip(tag == t, { tag = if (tag == t) null else t }, { Text("#$t") }, Modifier.testTag("tag-$t")) }
            }
        }
        folders.firstOrNull { it.id == folder }?.let { FolderTools(client, it) }
        Button(onClick = onNew, modifier = Modifier.fillMaxWidth().testTag("new-item")) { Text("New item") }
        LazyColumn(Modifier.weight(1f).testTag("item-list")) {
            items(shown, key = { it.id }) { item ->
                Row(Modifier.fillMaxWidth().clickable { onOpen(item.id) }.padding(vertical = 10.dp).testTag("item-${item.body.title}"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (SiteIcons.show(item, iconVaults)) SiteIcon(client, item.body.urls.firstOrNull()?.url)
                    Column {
                        Text(item.body.title.ifEmpty { "Untitled" }, fontWeight = FontWeight.Medium)
                        val sub = item.body.username ?: item.body.str("cardholder") ?: item.body.str("ssid") ?: KIND_LABEL[item.body.kind]
                        if (sub != null) Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                HorizontalDivider()
            }
        }
        if (shown.isEmpty()) Text(if (query.isBlank()) "Nothing here yet." else "No matches.", Modifier.padding(16.dp).testTag("empty"))
    }
}

/** Fetched through your server, only for a vault that's said yes. Nothing shows until it's here. */
@Composable
private fun SiteIcon(client: VaultClient, url: String?) {
    val domain = remember(url) { SiteIcons.domainOf(url) } ?: return
    var image by remember(domain) { mutableStateOf(SiteIconCache.peek(domain)) }
    LaunchedEffect(domain) {
        if (!SiteIconCache.has(domain)) image = withContext(Dispatchers.IO) { SiteIconCache.load(client, domain) }
    }
    image?.let { androidx.compose.foundation.Image(it.asImageBitmap(), null, Modifier.size(24.dp).testTag("site-icon-$domain")) }
}

/** Rename or delete a folder. The items in it stay, just out of the folder. */
@Composable
private fun FolderTools(client: VaultClient, folder: Item) {
    if (!client.canEdit(folder.vaultId)) return
    val scope = rememberCoroutineScope()
    var renaming by remember(folder.id) { mutableStateOf(false) }
    var deleting by remember(folder.id) { mutableStateOf(false) }
    var name by remember(folder.id, renaming) { mutableStateOf(folder.body.title) }
    var error by remember(folder.id) { mutableStateOf<String?>(null) }
    fun act(block: () -> Unit) {
        scope.launch {
            withContext(Dispatchers.IO) {
                runCatching {
                    block()
                    runCatching { client.sync() }
                }
            }.onFailure { error = errorText(it) }
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Folder: ${folder.body.title}", Modifier.weight(1f).testTag("folder-now"), style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = { renaming = true }, Modifier.testTag("folder-rename")) { Text("Rename") }
        TextButton(onClick = { deleting = true }, Modifier.testTag("folder-delete")) { Text("Delete folder") }
    }
    error?.let { ErrorCard(it) }
    if (renaming) {
        AlertDialog(
            onDismissRequest = { renaming = false },
            modifier = Modifier.exposeTags(),
            title = { Text("Rename folder") },
            text = { OutlinedTextField(name, { name = it.take(80) }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("folder-name")) },
            confirmButton = {
                TextButton(onClick = {
                    val n = name
                    renaming = false
                    act { client.renameFolder(folder.id, n) }
                }, enabled = name.isNotBlank(), modifier = Modifier.testTag("folder-name-save")) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { renaming = false }) { Text("Cancel") } },
        )
    }
    if (deleting) {
        AlertDialog(
            onDismissRequest = { deleting = false },
            modifier = Modifier.exposeTags(),
            title = { Text("Delete the folder ${folder.body.title}?") },
            text = { Text("What's in it stays, out of the folder.") },
            confirmButton = {
                TextButton(onClick = {
                    deleting = false
                    act { client.deleteFolder(folder.id) }
                }, Modifier.testTag("folder-delete-confirm")) { Text("Delete folder") }
            },
            dismissButton = { TextButton(onClick = { deleting = false }) { Text("Keep it") } },
        )
    }
}

@Composable
fun KindPicker(onPick: (String) -> Unit, onCancel: () -> Unit) {
    BackHandler(onBack = onCancel)
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("New item", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        (CREATABLE + "folder").forEach { k ->
            OutlinedButton(onClick = { onPick(k) }, Modifier.fillMaxWidth().testTag("kind-$k")) { Text(KIND_LABEL[k] ?: "Folder") }
        }
        TextButton(onClick = onCancel) { Text("Cancel") }
    }
}

// ---- Viewing ------------------------------------------------------------------

/** Local only: the password never leaves the phone. */
@Composable
fun StrengthLine(password: String, inputs: List<String> = emptyList()) {
    val s = remember(password, inputs) { StrengthCheck.check(password, inputs) }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        LinearProgressIndicator(progress = { (s.score + 1) / 5f }, modifier = Modifier.weight(1f))
        Text(s.label, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("strength"))
    }
}

@Composable
private fun SecretRow(label: String, value: String, tag: String) {
    val ctx = LocalContext.current
    var shown by remember { mutableStateOf(false) }
    SensitiveWhile(shown)
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (shown) value else "•".repeat(minOf(12, value.length)), Modifier.weight(1f).testTag(tag), fontFamily = FontFamily.Monospace)
            TextButton(onClick = { shown = !shown }, Modifier.testTag("$tag-show")) { Text(if (shown) "Hide" else "Show") }
            TextButton(onClick = {
                Clip.copySecret(ctx, label, value)
                toast(ctx, "$label copied")
            }, Modifier.testTag("$tag-copy")) { Text("Copy") }
        }
    }
}

@Composable
private fun PlainRow(label: String, value: String, tag: String, secretCopy: Boolean = false) {
    val ctx = LocalContext.current
    SensitiveWhile(secretCopy)
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(value, Modifier.weight(1f).testTag(tag))
            TextButton(onClick = {
                if (secretCopy) Clip.copySecret(ctx, label, value) else Clip.copyPlain(ctx, label, value)
                toast(ctx, "$label copied")
            }, Modifier.testTag("$tag-copy")) { Text("Copy") }
        }
    }
}

@Composable
fun TotpRow(cfg: TotpConfig, tag: String) {
    val ctx = LocalContext.current
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000)
            now = System.currentTimeMillis()
        }
    }
    val offset = Pw.client()?.serverTimeOffsetMs ?: 0L
    val code = runCatching { Totp.code(cfg, now) }.getOrElse { "invalid" }
    val left = Totp.secondsLeft(cfg, now)
    SensitiveWhile(true)
    Column(Modifier.fillMaxWidth().clickable {
        Clip.copySecret(ctx, "2FA code", code)
        toast(ctx, "2FA code copied")
    }.padding(vertical = 4.dp)) {
        Text("2FA code", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(code, style = MaterialTheme.typography.titleLarge, fontFamily = FontFamily.Monospace, modifier = Modifier.testTag(tag))
            Text("${left}s", style = MaterialTheme.typography.bodySmall)
        }
        LinearProgressIndicator(progress = { left.toFloat() / Totp.periodOf(cfg) }, modifier = Modifier.fillMaxWidth())
        if (kotlin.math.abs(offset) > 30_000) Text("This phone's clock is ${kotlin.math.abs(offset) / 1000} seconds off the server's. Codes may not work.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
fun ItemDetailScreen(activity: FragmentActivity, client: VaultClient, id: String, onBack: () -> Unit, onEdit: () -> Unit) {
    val ctx = LocalContext.current
    val version by Pw.version.collectAsState()
    val item = remember(id, version) { client.get(id) }
    BackHandler(onBack = onBack)
    if (item == null) {
        LaunchedEffect(Unit) { onBack() }
        return
    }
    var passed by remember(id) { mutableStateOf(!item.body.reprompt) }
    if (!passed) {
        ConfirmIdentityPane(activity, "Confirm it's you", item.body.title, true, { passed = true }, onBack)
        return
    }
    val b = item.body
    val scope = rememberCoroutineScope()
    var message by remember { mutableStateOf<String?>(null) }
    var showHistory by remember { mutableStateOf(false) }
    var versions by remember { mutableStateOf<List<VaultClient.Version>?>(null) }
    var showWifiQr by remember { mutableStateOf(false) }
    // Fill only: nothing on screen that reveals a secret or copies one. It fills, nothing else.
    val canReveal = client.canReveal(item.vaultId)
    val canEdit = client.canEdit(item.vaultId)
    fun act(block: () -> Unit) {
        scope.launch {
            withContext(Dispatchers.IO) {
                runCatching {
                    block()
                    runCatching { client.sync() }
                }.onFailure { message = errorText(it) }
            }
        }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp).testTag("item-detail")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack, Modifier.testTag("back")) { Text("Back") }
            Spacer(Modifier.weight(1f))
            if (!item.deleted && canEdit) TextButton(onClick = onEdit, Modifier.testTag("edit")) { Text("Edit") }
        }
        Text(b.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("detail-title"))
        Text(KIND_LABEL[b.kind] ?: b.kind, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        message?.let { ErrorCard(it) }
        if (!canReveal) Text("This vault lets you fill passwords but not see them. It isn't secure against a determined member: their device holds the key.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("fill-only-note"))
        ConflictPanel(client, item)
        b.username?.let { PlainRow("Username", it, "detail-username") }
        if (canReveal) b.password?.let { SecretRow("Password", it, "detail-password") }
        if (canReveal) b.totp?.let { TotpRow(it, "detail-totp") }
        for (u in b.urls) {
            val app = Match.parseAppUrl(u.url)
            PlainRow(if (app != null) "App" else "Website", app?.pkg ?: u.url, "detail-url")
        }
        for (f in FIELDS[b.kind] ?: emptyList()) {
            val v = b.str(f.key) ?: continue
            if (f.secret) {
                if (canReveal) SecretRow(f.label, v, "detail-${f.key}")
            } else {
                PlainRow(f.label, v, "detail-${f.key}", secretCopy = true)
            }
        }
        for (f in b.customFields) {
            if (f.type != "hidden") PlainRow(f.name, f.value, "detail-field-${f.name}", secretCopy = true) else if (canReveal) SecretRow(f.name, f.value, "detail-field-${f.name}")
        }
        if (b.kind == "wifi" && !b.str("ssid").isNullOrEmpty() && canReveal) {
            TextButton(onClick = { showWifiQr = !showWifiQr }, Modifier.testTag("wifi-qr-toggle")) { Text(if (showWifiQr) "Hide the join QR" else "Show a QR to join this network") }
            if (showWifiQr) QrImage(wifiQrText(b), Modifier.testTag("wifi-qr"))
        }
        for (p in b.passkeys) {
            Card(Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("detail-passkey")) {
                Column(Modifier.padding(12.dp)) {
                    Text("Passkey for ${p.rpName ?: p.rpId}", fontWeight = FontWeight.Medium)
                    Text("${p.userName} on ${p.rpId}", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        b.notes?.let { PlainRow("Notes", it, "detail-notes", secretCopy = true) }
        if (b.tags.isNotEmpty()) PlainRow("Tags", b.tags.joinToString(", "), "detail-tags")
        if (b.kind != "folder") AttachmentsPanel(client, item, canEdit)
        Spacer(Modifier.height(10.dp))
        if (item.deleted) {
            OutlinedButton(onClick = { act { client.restoreItem(id) } }, Modifier.fillMaxWidth().testTag("restore")) { Text("Restore") }
        } else if (canEdit) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedButton(onClick = { act { client.update(id, b.withFlag("favorite", !b.favorite)) } }, Modifier.testTag("favorite")) { Text(if (b.favorite) "Unfavourite" else "Favourite") }
                OutlinedButton(onClick = { act { client.update(id, b.withFlag("archived", !b.archived)) } }, Modifier.testTag("archive")) { Text(if (b.archived) "Unarchive" else "Archive") }
                OutlinedButton(onClick = {
                    act { client.trashItem(id) }
                    onBack()
                }, Modifier.testTag("trash")) { Text("Trash") }
            }
        }
        if (canReveal) TextButton(onClick = {
            showHistory = !showHistory
            if (showHistory && versions == null) {
                scope.launch { versions = withContext(Dispatchers.IO) { runCatching { client.versions(id) }.getOrDefault(emptyList()) } }
            }
        }, Modifier.testTag("history")) { Text("History") }
        if (showHistory && canReveal) {
            for ((pw, at) in b.passwordHistory) SecretRow("Old password, $at", pw, "history-password")
            versions?.forEach { v ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(v.createdAt, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = { act { client.update(id, v.body) } }) { Text("Restore") }
                }
            }
        }
    }
}

/** Files on an item. Opened here in memory: images and text show on this secure screen, and
 *  nothing decrypted is written anywhere unless you pick where to save a copy. */
@Composable
private fun AttachmentsPanel(client: VaultClient, item: Item, canEdit: Boolean) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val list = item.body.attachments
    var busy by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var preview by remember { mutableStateOf<Pair<AttachmentRef, ByteArray>?>(null) }
    var saving by remember { mutableStateOf<AttachmentRef?>(null) }
    val maxPreview = 20L * 1024 * 1024

    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val ref = saving
        saving = null
        if (uri != null && ref != null) {
            busy = "Saving ${ref.name}"
            scope.launch {
                val r = withContext(Dispatchers.IO) {
                    runCatching {
                        ctx.contentResolver.openOutputStream(uri, "wt")!!.use { out ->
                            Attachments.download(client.api, item.vaultId, item.id, ref, { out.write(it) }) { d, t -> busy = "Saving ${ref.name}: $d of $t MB" }
                        }
                    }
                }
                busy = null
                r.onSuccess { toast(ctx, "Saved") }.onFailure { error = errorText(it) }
            }
        }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            val name = displayName(ctx, uri)
            val mime = ctx.contentResolver.getType(uri)
            error = null
            busy = "Uploading $name"
            scope.launch {
                val r = withContext(Dispatchers.IO) {
                    runCatching {
                        val size = ctx.contentResolver.openAssetFileDescriptor(uri, "r")!!.use { it.length }.takeIf { it >= 0 } ?: throw IllegalStateException("That file's size can't be read.")
                        ctx.contentResolver.openInputStream(uri)!!.use { input ->
                            client.addAttachment(item.id, name, mime, size, Attachments.streamReader(input, size)) { d, t -> busy = "Uploading $name: $d of $t MB" }
                        }
                    }
                }
                busy = null
                r.onFailure { error = errorText(it) }
            }
        }
    }

    if (list.isEmpty() && !canEdit) return
    Text("Attachments", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    error?.let { ErrorCard(it) }
    for (a in list) {
        Row(Modifier.fillMaxWidth().testTag("attachment-${a.name}"), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(a.name)
                Text("${a.size / 1024} KB", style = MaterialTheme.typography.bodySmall)
            }
            TextButton(onClick = {
                error = null
                if (a.size > maxPreview) {
                    error = "That's too big to show here. Save a copy instead."
                    return@TextButton
                }
                busy = "Opening ${a.name}"
                scope.launch {
                    val r = withContext(Dispatchers.IO) {
                        runCatching {
                            val out = java.io.ByteArrayOutputStream()
                            Attachments.download(client.api, item.vaultId, item.id, a, { out.write(it) }) { d, t -> busy = "Opening ${a.name}: $d of $t MB" }
                            out.toByteArray()
                        }
                    }
                    busy = null
                    r.onSuccess { preview = a to it }.onFailure { error = errorText(it) }
                }
            }, Modifier.testTag("attachment-open")) { Text("Open") }
            TextButton(onClick = {
                saving = a
                saver.launch(a.name)
            }, Modifier.testTag("attachment-save")) { Text("Save") }
            if (canEdit) TextButton(onClick = {
                error = null
                busy = "Removing ${a.name}"
                scope.launch {
                    withContext(Dispatchers.IO) { runCatching { client.removeAttachment(item.id, a) } }.onFailure { error = errorText(it) }
                    busy = null
                }
            }, Modifier.testTag("attachment-delete")) { Text("Delete") }
        }
    }
    busy?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("attachment-busy")) }
    if (canEdit) OutlinedButton(onClick = { picker.launch(arrayOf("*/*")) }, enabled = busy == null, modifier = Modifier.testTag("attachment-add")) { Text("Attach a file") }
    preview?.let { (ref, bytes) ->
        Card(Modifier.fillMaxWidth().padding(vertical = 6.dp).testTag("attachment-preview")) {
            Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(ref.name, Modifier.weight(1f), fontWeight = FontWeight.Medium)
                    TextButton(onClick = { preview = null }, Modifier.testTag("attachment-close")) { Text("Close") }
                }
                val image = remember(bytes) { if (ref.mime?.startsWith("image/") == true) runCatching { android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }.getOrNull() else null }
                val asText = remember(bytes) { if (image == null && bytes.size <= 256 * 1024) runCatching { org.promptly.sync.passwords.core.fromUtf8(bytes) }.getOrNull() else null }
                when {
                    image != null -> androidx.compose.foundation.Image(image, ref.name, Modifier.fillMaxWidth())
                    asText != null -> Text(asText, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("attachment-text"))
                    else -> Text("This kind of file can't be shown here. Save a copy to open it in another app.", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

/** "Conflict: pick one." The vault kept both sides of a merge it couldn't decide. */
@Composable
private fun ConflictPanel(client: VaultClient, item: Item) {
    val scope = rememberCoroutineScope()
    val conflicts = item.body.conflicts
    if (conflicts.isEmpty()) return
    Card(Modifier.fillMaxWidth().padding(vertical = 6.dp).testTag("conflict")) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Conflict: pick one", fontWeight = FontWeight.SemiBold)
            Text("This was changed in two places at once. What's shown below is the server's version. Nothing has been lost.")
            for (c in conflicts) {
                val other = c["body"] as? JsonObject ?: continue
                val diff = other.keys.filter { k -> JsonPrimitiveSafe(other[k]) != JsonPrimitiveSafe(item.body[k]) }.mapNotNull { FIELD_NAMES[it] ?: it.takeIf { k -> k != "v" } }
                Text("Other version, changed: ${diff.joinToString(", ").ifEmpty { "nothing visible" }}", style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedButton(onClick = {
                        scope.launch {
                            withContext(Dispatchers.IO) {
                                runCatching {
                                    val keep = ItemBody(LinkedHashMap(other)).with("conflicts" to null, "updatedAt" to item.body["updatedAt"])
                                    client.update(item.id, keep)
                                    client.sync()
                                }
                            }
                        }
                    }, Modifier.testTag("conflict-use-other")) { Text("Use that one") }
                    OutlinedButton(onClick = {
                        scope.launch {
                            withContext(Dispatchers.IO) {
                                runCatching {
                                    client.update(item.id, item.body.with("conflicts" to null))
                                    client.sync()
                                }
                            }
                        }
                    }, Modifier.testTag("conflict-keep")) { Text("Keep this one") }
                }
            }
        }
    }
}

private fun JsonPrimitiveSafe(e: kotlinx.serialization.json.JsonElement?) = org.promptly.sync.passwords.core.stable(e)

private val FIELD_NAMES = mapOf("password" to "password", "username" to "username", "title" to "name", "notes" to "notes", "urls" to "websites", "totp" to "2FA code")

// ---- Editing ------------------------------------------------------------------

@Composable
fun ItemEditorScreen(client: VaultClient, id: String?, kind: String, prefillUrl: String?, onDone: (String?) -> Unit) {
    val existing = id?.let { client.get(it) }
    val start = remember(id) { existing?.body ?: newBody(kind, "") }
    val k = start.kind
    val ctx = LocalContext.current
    BackHandler { onDone(null) }
    var title by remember { mutableStateOf(start.title) }
    var username by remember { mutableStateOf(start.username ?: "") }
    var password by remember { mutableStateOf(start.password ?: "") }
    var notes by remember { mutableStateOf(start.notes ?: "") }
    var tags by remember { mutableStateOf(start.tags.joinToString(", ")) }
    var totpText by remember { mutableStateOf(start.totp?.let { Totp.toOtpauth(it) } ?: "") }
    var favorite by remember { mutableStateOf(start.favorite) }
    var reprompt by remember { mutableStateOf(start.reprompt) }
    var folderId by remember { mutableStateOf(start.str("folderId")) }
    var folderMenu by remember { mutableStateOf(false) }
    val urls = remember { mutableStateListOf<LoginUrl>().apply { addAll(start.urls); if (id == null && prefillUrl != null) add(LoginUrl(prefillUrl)) } }
    val custom = remember { mutableStateListOf<CustomField>().apply { addAll(start.customFields) } }
    val extra = remember { mutableStateOf(FIELDS[k]?.associate { it.key to (start.str(it.key) ?: "") } ?: emptyMap()) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val folders = remember { runCatching { client.allItems(includeSystem = true) }.getOrDefault(emptyList()).filter { it.body.kind == "folder" } }
    // Where a new item goes: any vault you can write to, your own by default.
    val writable = remember { runCatching { client.vaults() }.getOrDefault(emptyList()).filter { client.chosen(it.vault) && it.vault.role in setOf("manage", "edit") && it.vault.id !in client.keyChanges } }
    var targetVault by remember { mutableStateOf(runCatching { client.personalVaultId() }.getOrNull()) }
    var vaultMenu by remember { mutableStateOf(false) }

    fun save() {
        var body = start.withText("username", username.takeIf { k == "login" || k == "passkey" || k == "totp" } ?: start.username)
            .with("title" to JsonPrimitive(title.ifBlank { KIND_LABEL[k] ?: "Untitled" }))
            .withText("notes", notes)
            .withFlag("favorite", favorite)
            .withFlag("reprompt", reprompt)
            .with("folderId" to folderId?.let { JsonPrimitive(it) })
            .with("tags" to tags.split(',').map { it.trim() }.filter { it.isNotEmpty() }.let { list -> if (list.isEmpty()) null else buildJsonArray { list.forEach { add(JsonPrimitive(it)) } } })
        if (k == "login") body = body.withText("password", password).withUrls(urls.filter { it.url.isNotBlank() })
        if (k == "login" || k == "totp") {
            val cfg = try {
                val t = totpText.trim()
                when {
                    t.isEmpty() -> null
                    t.startsWith("otpauth") || t.startsWith("steam") -> Totp.parseOtpauth(t)
                    else -> {
                        Totp.base32Decode(t)
                        TotpConfig(t.uppercase().replace(" ", ""))
                    }
                }
            } catch (e: Exception) {
                error = e.message
                return
            }
            body = body.withTotp(cfg)
        }
        for ((key, v) in extra.value) body = body.withText(key, v)
        body = body.withCustomFields(custom.filter { it.name.isNotBlank() })
        val finalBody = body
        scope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    val saved = if (existing != null) client.update(existing.id, finalBody) else client.saveNew(targetVault ?: client.personalVaultId(), finalBody)
                    runCatching { client.sync() }
                    saved.id
                }
            }
            r.onSuccess { onDone(it) }.onFailure { error = errorText(it) }
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(if (existing != null) "Edit ${KIND_LABEL[k] ?: k}" else "New ${KIND_LABEL[k] ?: "folder"}", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        if (existing == null && writable.size > 1) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Vault: ${writable.firstOrNull { it.vault.id == targetVault }?.displayName ?: "Personal"}", Modifier.weight(1f))
                TextButton(onClick = { vaultMenu = true }, Modifier.testTag("edit-vault")) { Text("Change") }
                DropdownMenu(vaultMenu, { vaultMenu = false }) {
                    writable.forEach { v ->
                        DropdownMenuItem({ Text(v.displayName) }, {
                            targetVault = v.vault.id
                            vaultMenu = false
                        }, Modifier.testTag("edit-vault-${v.displayName}"))
                    }
                }
            }
        }
        OutlinedTextField(title, { title = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("edit-title"))
        if (k == "login" || k == "passkey" || k == "totp") OutlinedTextField(username, { username = it }, label = { Text("Username") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("edit-username"))
        if (k == "login") {
            var showPw by remember { mutableStateOf(false) }
            SecretField(password, { password = it }, "Password", "edit-password", visible = showPw)
            if (password.isNotEmpty()) StrengthLine(password, listOf(username, title))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedButton(onClick = {
                    val host = urls.firstOrNull()?.url?.let { Match.hostOf(it) }
                    password = Generator.forSite(host)
                    showPw = true
                }, Modifier.testTag("edit-generate")) { Text("Generate") }
                TextButton(onClick = { showPw = !showPw }) { Text(if (showPw) "Hide" else "Show") }
            }
            Text("Websites and apps", style = MaterialTheme.typography.labelLarge)
            urls.forEachIndexed { i, u ->
                val app = Match.parseAppUrl(u.url)
                if (app != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("App: ${app.pkg}", Modifier.weight(1f))
                        TextButton(onClick = { urls.removeAt(i) }) { Text("Remove") }
                    }
                } else {
                    var menu by remember { mutableStateOf(false) }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(u.url, { urls[i] = u.copy(url = it) }, singleLine = true, modifier = Modifier.weight(1f).testTag("edit-url-$i"))
                        TextButton(onClick = { menu = true }) { Text("Match") }
                        DropdownMenu(menu, { menu = false }) {
                            MATCHES.forEach { (m, l) -> DropdownMenuItem({ Text(l + if (u.match == m) " (now)" else "") }, { urls[i] = u.copy(match = m); menu = false }) }
                        }
                        TextButton(onClick = { urls.removeAt(i) }) { Text("Remove") }
                    }
                }
            }
            TextButton(onClick = { urls.add(LoginUrl("")) }, Modifier.testTag("edit-add-url")) { Text("Add a website") }
        }
        if (k == "login" || k == "totp") {
            VisibleSecretField(totpText, { totpText = it }, "2FA secret or otpauth link", "edit-totp")
            OutlinedButton(onClick = { scanQr(ctx, { totpText = it }, { error = it }) }, Modifier.testTag("edit-scan-totp")) { Text("Scan a 2FA QR") }
        }
        for (f in FIELDS[k] ?: emptyList()) {
            val v = extra.value[f.key] ?: ""
            val set: (String) -> Unit = { extra.value = extra.value + (f.key to it) }
            if (f.secret && !f.area) {
                var show by remember { mutableStateOf(false) }
                SecretField(v, set, f.label, "edit-${f.key}", visible = show)
                TextButton(onClick = { show = !show }) { Text(if (show) "Hide" else "Show") }
            } else if (f.secret) {
                VisibleSecretField(v, set, f.label, "edit-${f.key}", singleLine = !f.area, minLines = if (f.area) 3 else 1)
            } else {
                OutlinedTextField(v, set, label = { Text(f.label) }, singleLine = !f.area, minLines = if (f.area) 3 else 1, modifier = Modifier.fillMaxWidth().testTag("edit-${f.key}"))
            }
        }
        OutlinedTextField(notes, { notes = it }, label = { Text("Notes") }, minLines = if (k == "note") 6 else 2, modifier = Modifier.fillMaxWidth().testTag("edit-notes"))
        if (k != "folder") {
            OutlinedTextField(tags, { tags = it }, label = { Text("Tags, separated by commas") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            if (folders.isNotEmpty()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Folder: ${folders.firstOrNull { it.id == folderId }?.body?.title ?: "none"}", Modifier.weight(1f))
                    TextButton(onClick = { folderMenu = true }) { Text("Change") }
                    DropdownMenu(folderMenu, { folderMenu = false }) {
                        DropdownMenuItem({ Text("None") }, { folderId = null; folderMenu = false })
                        folders.forEach { f -> DropdownMenuItem({ Text(f.body.title) }, { folderId = f.id; folderMenu = false }) }
                    }
                }
            }
            Text("Custom fields", style = MaterialTheme.typography.labelLarge)
            custom.forEachIndexed { i, f ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    OutlinedTextField(f.name, { custom[i] = f.copy(name = it) }, label = { Text("Name") }, singleLine = true, modifier = Modifier.weight(1f))
                    if (f.type == "hidden") SecretField(f.value, { custom[i] = f.copy(value = it) }, "Value", "edit-custom-$i", Modifier.weight(1f))
                    else OutlinedTextField(f.value, { custom[i] = f.copy(value = it) }, label = { Text("Value") }, singleLine = true, modifier = Modifier.weight(1f))
                    TextButton(onClick = { custom.removeAt(i) }) { Text("X") }
                }
            }
            Row {
                TextButton(onClick = { custom.add(CustomField("", "", "text")) }) { Text("Add field") }
                TextButton(onClick = { custom.add(CustomField("", "", "hidden")) }) { Text("Add hidden field") }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(favorite, { favorite = it })
                Text("Favourite")
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(reprompt, { reprompt = it }, Modifier.testTag("edit-reprompt"))
                Text("Ask again before showing or filling this")
            }
        }
        error?.let { ErrorCard(it) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { save() }, Modifier.testTag("save")) { Text("Save") }
            TextButton(onClick = { onDone(null) }, Modifier.testTag("cancel")) { Text("Cancel") }
        }
    }
}
