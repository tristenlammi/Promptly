// The vault's main screens: the list with search, an item's view, and the editor for
// every kind. The field table is the web vault's (ItemEditor.tsx), so both show the same.
package org.promptly.sync.passwords.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
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
import org.promptly.sync.passwords.core.CustomField
import org.promptly.sync.passwords.core.Generator
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.ItemBody
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
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
    val version by Pw.version.collectAsState()
    val folders = remember(version) { runCatching { client.allItems(includeSystem = true) }.getOrDefault(emptyList()).filter { it.body.kind == "folder" } }
    val shown = remember(query, filter, folder, version) {
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
            fits && (folder == null || b.str("folderId") == folder)
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
            folders.forEach { f -> FilterChip(folder == f.id, { folder = if (folder == f.id) null else f.id }, { Text(f.body.title) }) }
        }
        Button(onClick = onNew, modifier = Modifier.fillMaxWidth().testTag("new-item")) { Text("New item") }
        LazyColumn(Modifier.weight(1f).testTag("item-list")) {
            items(shown, key = { it.id }) { item ->
                Column(Modifier.fillMaxWidth().clickable { onOpen(item.id) }.padding(vertical = 10.dp).testTag("item-${item.body.title}")) {
                    Text(item.body.title.ifEmpty { "Untitled" }, fontWeight = FontWeight.Medium)
                    val sub = item.body.username ?: item.body.str("cardholder") ?: item.body.str("ssid") ?: KIND_LABEL[item.body.kind]
                    if (sub != null) Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                HorizontalDivider()
            }
        }
        if (shown.isEmpty()) Text(if (query.isBlank()) "Nothing here yet." else "No matches.", Modifier.padding(16.dp).testTag("empty"))
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

@Composable
private fun SecretRow(label: String, value: String, tag: String) {
    val ctx = LocalContext.current
    var shown by remember { mutableStateOf(false) }
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
private fun PlainRow(label: String, value: String, tag: String) {
    val ctx = LocalContext.current
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(value, Modifier.weight(1f).testTag(tag))
            TextButton(onClick = {
                Clip.copyPlain(ctx, label, value)
                toast(ctx, "$label copied")
            }) { Text("Copy") }
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
            if (!item.deleted) TextButton(onClick = onEdit, Modifier.testTag("edit")) { Text("Edit") }
        }
        Text(b.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("detail-title"))
        Text(KIND_LABEL[b.kind] ?: b.kind, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        message?.let { ErrorCard(it) }
        ConflictPanel(client, item)
        b.username?.let { PlainRow("Username", it, "detail-username") }
        b.password?.let { SecretRow("Password", it, "detail-password") }
        b.totp?.let { TotpRow(it, "detail-totp") }
        for (u in b.urls) {
            val app = Match.parseAppUrl(u.url)
            PlainRow(if (app != null) "App" else "Website", app?.pkg ?: u.url, "detail-url")
        }
        for (f in FIELDS[b.kind] ?: emptyList()) {
            val v = b.str(f.key) ?: continue
            if (f.secret) SecretRow(f.label, v, "detail-${f.key}") else PlainRow(f.label, v, "detail-${f.key}")
        }
        for (f in b.customFields) if (f.type == "hidden") SecretRow(f.name, f.value, "detail-field-${f.name}") else PlainRow(f.name, f.value, "detail-field-${f.name}")
        for (p in b.passkeys) {
            Card(Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("detail-passkey")) {
                Column(Modifier.padding(12.dp)) {
                    Text("Passkey for ${p.rpName ?: p.rpId}", fontWeight = FontWeight.Medium)
                    Text("${p.userName} on ${p.rpId}", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        b.notes?.let { PlainRow("Notes", it, "detail-notes") }
        if (b.tags.isNotEmpty()) PlainRow("Tags", b.tags.joinToString(", "), "detail-tags")
        val attachments = (b["attachments"] as? kotlinx.serialization.json.JsonArray)?.size ?: 0
        if (attachments > 0) Text("$attachments attachment${if (attachments == 1) "" else "s"}: open these from the web vault.", style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(10.dp))
        if (item.deleted) {
            OutlinedButton(onClick = { act { client.restoreItem(id) } }, Modifier.fillMaxWidth().testTag("restore")) { Text("Restore") }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedButton(onClick = { act { client.update(id, b.withFlag("favorite", !b.favorite)) } }, Modifier.testTag("favorite")) { Text(if (b.favorite) "Unfavourite" else "Favourite") }
                OutlinedButton(onClick = { act { client.update(id, b.withFlag("archived", !b.archived)) } }, Modifier.testTag("archive")) { Text(if (b.archived) "Unarchive" else "Archive") }
                OutlinedButton(onClick = {
                    act { client.trashItem(id) }
                    onBack()
                }, Modifier.testTag("trash")) { Text("Trash") }
            }
        }
        TextButton(onClick = {
            showHistory = !showHistory
            if (showHistory && versions == null) {
                scope.launch { versions = withContext(Dispatchers.IO) { runCatching { client.versions(id) }.getOrDefault(emptyList()) } }
            }
        }, Modifier.testTag("history")) { Text("History") }
        if (showHistory) {
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
                    val saved = if (existing != null) client.update(existing.id, finalBody) else client.saveNew(client.personalVaultId(), finalBody)
                    runCatching { client.sync() }
                    saved.id
                }
            }
            r.onSuccess { onDone(it) }.onFailure { error = errorText(it) }
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(if (existing != null) "Edit ${KIND_LABEL[k] ?: k}" else "New ${KIND_LABEL[k] ?: "folder"}", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        OutlinedTextField(title, { title = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("edit-title"))
        if (k == "login" || k == "passkey" || k == "totp") OutlinedTextField(username, { username = it }, label = { Text("Username") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("edit-username"))
        if (k == "login") {
            var showPw by remember { mutableStateOf(false) }
            SecretField(password, { password = it }, "Password", "edit-password", visible = showPw)
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
            OutlinedTextField(totpText, { totpText = it }, label = { Text("2FA secret or otpauth link") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("edit-totp"))
            OutlinedButton(onClick = { scanQr(ctx, { totpText = it }, { error = it }) }, Modifier.testTag("edit-scan-totp")) { Text("Scan a 2FA QR") }
        }
        for (f in FIELDS[k] ?: emptyList()) {
            val v = extra.value[f.key] ?: ""
            val set: (String) -> Unit = { extra.value = extra.value + (f.key to it) }
            if (f.secret && !f.area) {
                var show by remember { mutableStateOf(false) }
                SecretField(v, set, f.label, "edit-${f.key}", visible = show)
                TextButton(onClick = { show = !show }) { Text(if (show) "Hide" else "Show") }
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
