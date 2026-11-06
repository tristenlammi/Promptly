// Security check, shared vaults, import and export, Secure Send and emergency access. The
// web vault's screens of the same names, for a phone.
package org.promptly.sync.passwords.ui

import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import org.promptly.sync.passwords.Clip
import org.promptly.sync.passwords.Pw
import org.promptly.sync.passwords.core.EmergencyOut
import org.promptly.sync.passwords.core.Exporter
import org.promptly.sync.passwords.core.Health
import org.promptly.sync.passwords.core.HealthReport
import org.promptly.sync.passwords.core.ImportResult
import org.promptly.sync.passwords.core.Imported
import org.promptly.sync.passwords.core.Importers
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.Kdbx
import org.promptly.sync.passwords.core.KeyChangedError
import org.promptly.sync.passwords.core.MemberOut
import org.promptly.sync.passwords.core.NeedsPasswordError
import org.promptly.sync.passwords.core.Person
import org.promptly.sync.passwords.core.EmergencyText
import org.promptly.sync.passwords.core.SecureSend
import org.promptly.sync.passwords.core.SendOut
import org.promptly.sync.passwords.core.SendRecords
import org.promptly.sync.passwords.core.SiteDirectory
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.newBody

@Composable
private fun Header(title: String, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    Row(verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = onBack, Modifier.testTag("back")) { Text("Back") }
        Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
    }
}

// ---- Security check -------------------------------------------------------------

@Composable
private fun IssueSection(title: String, explain: String, tag: String, items: List<Pair<Item, String?>>, onOpen: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Card(Modifier.fillMaxWidth().clickable { open = !open }.testTag("health-$tag")) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                Text(items.size.toString(), Modifier.testTag("health-count-$tag"), style = MaterialTheme.typography.titleMedium)
            }
            Text(explain, style = MaterialTheme.typography.bodySmall)
            if (open) {
                for ((item, note) in items) {
                    Column(Modifier.fillMaxWidth().clickable { onOpen(item.id) }.padding(vertical = 6.dp)) {
                        Text(item.body.title)
                        if (note != null) Text(note, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

@Composable
fun SecurityCheckScreen(client: VaultClient, onOpen: (String) -> Unit, onExport: () -> Unit, onBack: () -> Unit) {
    var report by remember { mutableStateOf<HealthReport?>(null) }
    var progress by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var run by remember { mutableIntStateOf(0) }
    LaunchedEffect(run) {
        progress = "Checking…"
        error = null
        val r = withContext(Dispatchers.IO) {
            runCatching {
                val dir = runCatching { client.api.directory() }.getOrDefault(SiteDirectory.EMPTY)
                Health.run(client.allItems(), { client.api.breachRange(it) }, dir.twofa, passkeys = dir.passkeys) { d, t -> progress = "Checking $d of $t" }
            }
        }
        r.onSuccess { report = it }.onFailure { error = errorText(it) }
        progress = ""
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Header("Security check", onBack)
        SurvivalPanel(client, onExport)
        DuplicatesPanel(client, onOpen)
        Text("All worked out on this phone. Only the first five characters of each password's SHA-1 leave it, through your server, to ask whether it's been in a breach.", style = MaterialTheme.typography.bodySmall)
        if (progress.isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CircularProgressIndicator()
            Text(progress, Modifier.testTag("health-progress"))
        }
        error?.let { ErrorCard(it) }
        report?.let { r ->
            Text("Checked ${r.checked} logins.", Modifier.testTag("health-checked"))
            r.breachSkipped?.let { ErrorCard(it) }
            IssueSection("Breached", "Seen in a known breach. Change these first.", "breached", r.breached.map { it.first to "Seen ${it.second} times" }, onOpen)
            IssueSection("Weak", "Quick to guess.", "weak", r.weak.map { it to null }, onOpen)
            IssueSection("Reused", "If one site leaks, the others are open too.", "reused", r.reused.flatten().map { it to null }, onOpen)
            IssueSection("Old", "Not changed for over a year.", "old", r.old.map { it to null }, onOpen)
            IssueSection("Not secure", "Saved for an http address.", "http", r.http.map { it to null }, onOpen)
            IssueSection("2FA available", "These sites offer it, and you haven't set it up here.", "no2fa", r.no2fa.map { it.first to it.second }, onOpen)
            IssueSection("No 2FA saved", "Worth checking whether these sites offer it.", "nototp", r.noTotp.map { it to null }, onOpen)
            IssueSection("Could use a passkey", "These sites support passkeys.", "nopasskey", r.noPasskey.map { it to null }, onOpen)
            Text("Data sourced from 2FA Directory by 2factorauth (2fa.directory) and Passkeys Directory by 2factorauth (passkeys.2fa.directory). Breach data from Have I Been Pwned.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("health-credit"))
            OutlinedButton(onClick = { run++ }, Modifier.testTag("health-again")) { Text("Check again") }
        }
    }
}

/** Same site, same username, saved twice. */
@Composable
private fun DuplicatesPanel(client: VaultClient, onOpen: (String) -> Unit) {
    val ctx = LocalContext.current
    val version by Pw.version.collectAsState()
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var groups by remember { mutableStateOf<List<List<Item>>>(emptyList()) }
    LaunchedEffect(version) { groups = withContext(Dispatchers.IO) { runCatching { client.duplicates() }.getOrDefault(emptyList()) } }
    if (groups.isEmpty() && error == null) return
    Column(Modifier.testTag("duplicates"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Saved twice", fontWeight = FontWeight.SemiBold)
        Text("Same site, same username. Merging keeps the newest, and moves other passwords to its history, so nothing's lost.", style = MaterialTheme.typography.bodySmall)
        error?.let { ErrorCard(it) }
        busy?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("duplicate-busy")) }
        for (g in groups) {
            Row(Modifier.fillMaxWidth().testTag("duplicate-${g[0].body.title}"), verticalAlignment = Alignment.CenterVertically) {
                Text("${g[0].body.title}, ${g[0].body.username}, ${g.size} copies", Modifier.weight(1f).clickable { onOpen(g[0].id) })
                TextButton(onClick = {
                    busy = "Merging"
                    error = null
                    scope.launch {
                        val r = withContext(Dispatchers.IO) { runCatching { client.mergeDuplicates(g) { d, t -> busy = "Moving attachments: $d of $t MB" } } }
                        busy = null
                        r.onSuccess { toast(ctx, "Merged. The others are in Trash for 30 days.") }.onFailure { error = errorText(it) }
                    }
                }, enabled = busy == null, modifier = Modifier.testTag("duplicate-merge")) { Text("Merge") }
            }
        }
    }
}

/** Who gets a say over which vaults show site icons. Off unless turned on, per vault. */
@Composable
fun VaultIconsToggle(client: VaultClient, vaultId: String, tag: String) {
    val version by Pw.version.collectAsState()
    val scope = rememberCoroutineScope()
    val on = remember(version, vaultId) { runCatching { vaultId in client.iconVaults() }.getOrDefault(false) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text("Show site icons in this vault. They're fetched through your server, which sees each site's name at that moment.", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
        androidx.compose.material3.Switch(on, { want -> scope.launch { withContext(Dispatchers.IO) { runCatching { client.setVaultIcons(vaultId, want) } } } }, Modifier.testTag(tag))
    }
}

// ---- Shared vaults -----------------------------------------------------------------

val ROLE_TEXT = linkedMapOf("view" to "Can view", "fill" to "Can fill only (can't reveal)", "edit" to "Can edit", "manage" to "Can manage")

@Composable
fun SharedVaultsScreen(client: VaultClient, onBack: () -> Unit) {
    val version by Pw.version.collectAsState()
    var vaults by remember { mutableStateOf<List<VaultClient.VaultInfo>>(emptyList()) }
    var people by remember { mutableStateOf<List<Person>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var making by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var bump by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()

    fun act(block: () -> Unit) {
        scope.launch {
            withContext(Dispatchers.IO) { runCatching { block() } }.onFailure { error = errorText(it) }
            bump++
        }
    }
    LaunchedEffect(version, bump) {
        withContext(Dispatchers.IO) {
            runCatching {
                vaults = client.vaults().filter { it.vault.kind == "shared" }
                people = client.api.people()
            }.onFailure { error = errorText(it) }
        }
    }
    LaunchedEffect(Unit) { withContext(Dispatchers.IO) { runCatching { client.sync() } } }
    val words = remember { runCatching { client.myIdentityWords().joinToString(" ") }.getOrDefault("") }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Header("Shared vaults", onBack)
        Text("Your safety words: $words. Someone sharing with you can compare these with what their screen shows.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("my-words"))
        error?.let { ErrorCard(it) }
        if (making) {
            OutlinedTextField(name, { name = it }, label = { Text("Vault name") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("new-vault-name"))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = {
                    making = false
                    val n = name
                    name = ""
                    act { client.createSharedVault(n) }
                }, enabled = name.isNotBlank(), modifier = Modifier.testTag("new-vault-create")) { Text("Create") }
                TextButton(onClick = { making = false }) { Text("Cancel") }
            }
        } else {
            Button(onClick = { making = true }, Modifier.testTag("new-vault")) { Text("New vault") }
        }
        // What the server says about who accepted what doesn't come into it.
        for (v in vaults.filter { !client.chosen(it.vault) }) InvitationCard(client, v) { bump++ }
        for (v in vaults.filter { client.chosen(it.vault) }) VaultCard(client, v, people) { bump++ }
        if (vaults.isEmpty()) Text("No shared vaults yet.", Modifier.testTag("shared-empty"))
    }
}

/** Nobody's trusted yet at this point: the name can't be read, and all that's shown is who
 *  the server says this is from, and the words to check that with them. */
@Composable
private fun InvitationCard(client: VaultClient, v: VaultClient.VaultInfo, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var info by remember(v.vault.id) { mutableStateOf<VaultClient.InviterInfo?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(v.vault.id) {
        val from = v.vault.grantedBy ?: return@LaunchedEffect
        withContext(Dispatchers.IO) { runCatching { client.inviterInfo(from) } }.onSuccess { info = it }
    }
    fun act(block: () -> Unit) {
        scope.launch {
            withContext(Dispatchers.IO) { runCatching { block() } }.onFailure { error = errorText(it) }
            onDone()
        }
    }
    val i = info
    val odd = i != null && (i.twin || i.changed)
    Card(Modifier.fillMaxWidth().testTag("invite-${i?.username ?: v.vault.id}"), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("${i?.username?.ifEmpty { null } ?: "Someone"} shared a vault with you", fontWeight = FontWeight.SemiBold)
            Text(ROLE_TEXT[v.vault.role] ?: v.vault.role, style = MaterialTheme.typography.bodySmall)
            if (odd) ErrorCard("You already know someone by this name, with different keys. This might not be who it says. Check with them directly before accepting.")
            if (i != null) Text("Their safety words should be ${i.words.joinToString(" ")}. If you can, check with them before accepting.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("invite-words"))
            error?.let { ErrorCard(it) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = {
                    act {
                        val from = v.vault.grantedBy
                        if (odd && from != null) client.acceptChangedKey(from)
                        client.acceptVault(v.vault.id)
                    }
                }, Modifier.testTag("invite-accept")) { Text("Accept") }
                OutlinedButton(onClick = { act { client.leaveVault(v.vault.id) } }, Modifier.testTag("invite-decline")) { Text("Decline") }
            }
        }
    }
}

/** Who gets the new key, shown before it goes. A server can add names to a list. */
@Composable
private fun Recipients(plan: List<VaultClient.PlanEntry>) {
    if (plan.isEmpty()) {
        Text("Only you will have the new key.", Modifier.testTag("recipients"))
        return
    }
    Column(Modifier.testTag("recipients")) {
        Text("The new key goes to you and:", fontWeight = FontWeight.Medium)
        plan.forEach { p ->
            Text(
                p.username + when {
                    p.changed -> " (their keys have changed, so this will stop until you've checked)"
                    !p.known -> " (you haven't dealt with them before. Check you expect them here)"
                    else -> ""
                },
                Modifier.testTag("plan-${p.username}"),
            )
        }
    }
}

@Composable
private fun VaultCard(client: VaultClient, v: VaultClient.VaultInfo, people: List<Person>, onChange: () -> Unit) {
    val manager = v.vault.role == "manage"
    var members by remember(v.vault.id) { mutableStateOf<List<MemberOut>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf<Person?>(null) }
    var pick by remember { mutableStateOf(false) }
    var role by remember { mutableStateOf("view") }
    var rolePick by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<MemberOut?>(null) }
    var rotating by remember { mutableStateOf(false) }
    var plan by remember { mutableStateOf<List<VaultClient.PlanEntry>>(emptyList()) }
    var wordsFor by remember { mutableStateOf<Pair<MemberOut, String>?>(null) }
    var toChange by remember { mutableStateOf<List<Item>?>(null) }
    var changedKey by remember { mutableStateOf<KeyChangedError?>(client.keyChanges[v.vault.id]) }
    var confirmLeave by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var refresh by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()

    fun act(block: () -> Unit) {
        busy = true
        scope.launch {
            withContext(Dispatchers.IO) { runCatching { block() } }.onFailure {
                if (it is KeyChangedError) changedKey = it else error = errorText(it)
            }
            busy = false
            refresh++
            onChange()
        }
    }
    LaunchedEffect(v.vault.id, refresh) {
        withContext(Dispatchers.IO) { runCatching { client.api.members(v.vault.id) } }.onSuccess { members = it }.onFailure { error = errorText(it) }
    }
    Card(Modifier.fillMaxWidth().testTag("vault-${v.displayName}")) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(v.displayName, fontWeight = FontWeight.SemiBold)
            Text(ROLE_TEXT[v.vault.role] ?: v.vault.role, style = MaterialTheme.typography.bodySmall)
            if (v.vault.role == "fill") Text("Fill only is a convenience, not a lock: your device holds the password in order to fill it.", style = MaterialTheme.typography.bodySmall)
            changedKey?.let { k ->
                ErrorCard("${k.username.ifEmpty { "This person" }}'s keys aren't the ones you saw before, so this vault stays shut. They may have reset their vault, or something may be wrong with the server. Check with them directly.")
                OutlinedButton(onClick = {
                    changedKey = null
                    act { client.acceptChangedKey(k.userId) }
                }, Modifier.testTag("key-accept")) { Text("I've checked, use the new keys") }
            }
            error?.let { ErrorCard(it) }
            for (m in members) {
                Row(Modifier.fillMaxWidth().testTag("member-${m.username}"), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(m.username + if (!m.accepted) " (invited)" else "")
                        var menu by remember { mutableStateOf(false) }
                        Text(ROLE_TEXT[m.role] ?: m.role, style = MaterialTheme.typography.bodySmall, modifier = if (manager) Modifier.clickable { menu = true }.testTag("member-role-${m.username}") else Modifier)
                        DropdownMenu(menu, { menu = false }) {
                            ROLE_TEXT.forEach { (k, t) ->
                                DropdownMenuItem({ Text(t) }, {
                                    menu = false
                                    act { client.api.setRole(v.vault.id, m.userId, k) }
                                }, Modifier.testTag("set-role-$k"))
                            }
                        }
                    }
                    TextButton(onClick = {
                        scope.launch {
                            withContext(Dispatchers.IO) { runCatching { client.identityWordsFor(m.userId).joinToString(" ") } }
                                .onSuccess { wordsFor = m to it }.onFailure { error = errorText(it) }
                        }
                    }, Modifier.testTag("member-words-${m.username}")) { Text("Words") }
                    if (manager) TextButton(onClick = {
                        scope.launch {
                            withContext(Dispatchers.IO) { runCatching { client.rotationPlan(v.vault.id, listOf(m.userId)) } }
                                .onSuccess {
                                    plan = it
                                    removing = m
                                }.onFailure { error = errorText(it) }
                        }
                    }, Modifier.testTag("member-remove-${m.username}")) { Text("Remove") }
                }
            }
            if (manager) {
                val available = people.filter { p -> p.hasVault && members.none { it.userId == p.id } }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        TextButton(onClick = { pick = true }, Modifier.testTag("add-person")) { Text(adding?.username ?: "Choose someone") }
                        DropdownMenu(pick, { pick = false }) {
                            available.forEach { p ->
                                DropdownMenuItem({ Text(p.username) }, {
                                    adding = p
                                    pick = false
                                }, Modifier.testTag("person-${p.username}"))
                            }
                        }
                    }
                    Column {
                        TextButton(onClick = { rolePick = true }, Modifier.testTag("add-role")) { Text(ROLE_TEXT[role] ?: role) }
                        DropdownMenu(rolePick, { rolePick = false }) {
                            ROLE_TEXT.forEach { (k, t) ->
                                DropdownMenuItem({ Text(t) }, {
                                    role = k
                                    rolePick = false
                                }, Modifier.testTag("add-role-$k"))
                            }
                        }
                    }
                }
                if (role == "fill") Text("Fill only is a convenience, not a lock: their device holds the password in order to fill it, so someone determined could still get at it.", style = MaterialTheme.typography.bodySmall)
                Button(onClick = {
                    val p = adding ?: return@Button
                    adding = null
                    act { client.addMember(v.vault.id, p.id, role) }
                }, enabled = adding != null && !busy, modifier = Modifier.testTag("invite-person")) { Text("Invite") }
            }
            if (manager) VaultIconsToggle(client, v.vault.id, "icons-${v.displayName}")
            if (manager && v.vault.rotateNeeded) {
                ErrorCard("Someone who could read this vault has gone, and it still has the key they knew. Change it, so nothing new can be read with that key.")
                OutlinedButton(onClick = {
                    scope.launch {
                        withContext(Dispatchers.IO) { runCatching { client.rotationPlan(v.vault.id, emptyList()) } }
                            .onSuccess {
                                plan = it
                                rotating = true
                            }.onFailure { error = errorText(it) }
                    }
                }, Modifier.testTag("rotate-needed")) { Text("Change the key") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { confirmLeave = true }, Modifier.testTag("leave-vault")) { Text("Leave") }
                if (manager) OutlinedButton(onClick = { confirmDelete = true }, Modifier.testTag("delete-vault")) { Text("Delete") }
                if (busy) CircularProgressIndicator()
            }
            toChange?.let { list ->
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer), modifier = Modifier.testTag("to-change")) {
                    Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Passwords to change", fontWeight = FontWeight.SemiBold)
                        Text("They may have copied what they could see. No key change undoes that.", style = MaterialTheme.typography.bodySmall)
                        if (list.isEmpty()) Text("None in this vault.")
                        list.forEach { Text(it.body.title, Modifier.testTag("change-${it.body.title}")) }
                    }
                }
            }
        }
    }
    wordsFor?.let { (m, words) ->
        AlertDialog(
            onDismissRequest = { wordsFor = null },
            title = { Text("Safety words for ${m.username}") },
            text = { Text("Ask ${m.username} what Shared vaults shows as their words. They should be exactly these:\n\n$words") },
            confirmButton = {
                TextButton(onClick = {
                    wordsFor = null
                    act { client.markVerified(m.userId) }
                }) { Text("They match") }
            },
            dismissButton = { TextButton(onClick = { wordsFor = null }) { Text("Close") } },
        )
    }
    removing?.let { m ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove ${m.username}?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("The vault gets a new key and everything in it is encrypted again, on this phone. This can take a moment. They may have copied what they could see, and no key change undoes that. You'll get a list of passwords to change.")
                    Recipients(plan)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    removing = null
                    val confirmed = plan.filter { !it.known }.map { it.userId }
                    act { toChange = client.removeMembers(v.vault.id, listOf(m.userId), confirmed) }
                }) { Text("Remove them") }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Keep") } },
        )
    }
    if (rotating) {
        AlertDialog(
            onDismissRequest = { rotating = false },
            title = { Text("Change this vault's key") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Everything in it gets encrypted again, on this phone.")
                    Recipients(plan)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    rotating = false
                    val confirmed = plan.filter { !it.known }.map { it.userId }
                    act { toChange = client.removeMembers(v.vault.id, emptyList(), confirmed) }
                }) { Text("Change the key") }
            },
            dismissButton = { TextButton(onClick = { rotating = false }) { Text("Not now") } },
        )
    }
    if (confirmLeave) {
        AlertDialog(
            onDismissRequest = { confirmLeave = false },
            title = { Text("Leave ${v.displayName}?") },
            text = { Text("You won't be able to read it after this.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmLeave = false
                    act { client.leaveVault(v.vault.id) }
                }) { Text("Leave it") }
            },
            dismissButton = { TextButton(onClick = { confirmLeave = false }) { Text("Stay") } },
        )
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete ${v.displayName}?") },
            text = { Text("This deletes it and everything in it, for everyone.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    act { client.deleteVault(v.vault.id) }
                }) { Text("Delete it") }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Keep") } },
        )
    }
}

// ---- Import and export ----------------------------------------------------------------

fun displayName(context: android.content.Context, uri: Uri): String =
    runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    }.getOrNull() ?: uri.lastPathSegment ?: "file"

/** Import into the vault: folders by name, reusing any of the same name. */
fun saveImported(client: VaultClient, fresh: List<Imported>, onProgress: (Int, Int) -> Unit = { _, _ -> }) {
    val vault = client.personalVaultId()
    val folders = client.allItems(includeSystem = true).filter { it.body.kind == "folder" }.associate { it.body.title to it.id }.toMutableMap()
    for (name in fresh.mapNotNull { it.folder }.toSet()) {
        if (name !in folders) folders[name] = client.saveNew(vault, newBody("folder", name)).id
    }
    for ((i, it) in fresh.withIndex()) {
        val id = it.folder?.let { f -> folders[f] }
        client.saveNew(vault, if (id != null) it.body.with("folderId" to JsonPrimitive(id)) else it.body)
        onProgress(i + 1, fresh.size)
    }
    runCatching { client.sync() }
}

@Composable
fun TransferScreen(client: VaultClient, onBack: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf<Pair<String, ByteArray>?>(null) }
    var filePassword by remember { mutableStateOf("") }
    var needsPassword by remember { mutableStateOf<String?>(null) }
    var preview by remember { mutableStateOf<ImportResult?>(null) }
    var fresh by remember { mutableStateOf<List<Imported>>(emptyList()) }
    var duplicates by remember { mutableIntStateOf(0) }

    var exportMaster by remember { mutableStateOf("") }
    var exportPassword by remember { mutableStateOf("") }
    var exportAgain by remember { mutableStateOf("") }
    var plainTyped by remember { mutableStateOf("") }
    var plainKind by remember { mutableStateOf("json") }
    var exportText by remember { mutableStateOf<String?>(null) }
    var exportEncrypted by remember { mutableStateOf(false) }

    fun read(name: String, bytes: ByteArray, password: String?) {
        busy = if (password == null) "Reading…" else "Opening it. A KeePass file can take a while…"
        error = null
        // A file chooses how much memory its password takes. It gets half of what's free at most.
        runCatching {
            val memory = android.app.ActivityManager.MemoryInfo()
            ctx.getSystemService(android.app.ActivityManager::class.java).getMemoryInfo(memory)
            Kdbx.memoryLimit = memory.availMem / 2
        }
        scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { Importers.importFile(name, bytes, password) } }
            busy = null
            r.onSuccess { res ->
                val existing = runCatching { client.allItems(includeSystem = false, includeDeleted = true).map { it.body } }.getOrDefault(emptyList())
                val (f, d) = Importers.dedupe(res.items, existing)
                preview = res
                fresh = f
                duplicates = d
                needsPassword = null
                filePassword = ""
            }.onFailure { e ->
                if (e is NeedsPasswordError) needsPassword = e.format else error = e.message ?: "That file can't be read."
            }
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            scope.launch {
                val r = withContext(Dispatchers.IO) {
                    runCatching { displayName(ctx, uri) to ctx.contentResolver.openInputStream(uri)!!.use { Importers.readLimited(it) } }
                }
                r.onSuccess { (name, bytes) ->
                    pending = name to bytes
                    needsPassword = null
                    filePassword = ""
                    preview = null
                    read(name, bytes, null)
                }.onFailure { error = (it as? IllegalArgumentException)?.message ?: "That file can't be opened." }
            }
        }
    }

    fun writeTo(uri: Uri, text: String) {
        val encrypted = exportEncrypted
        scope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    ctx.contentResolver.openOutputStream(uri, "wt")!!.use { it.write(text.toByteArray()) }
                    runCatching { client.api.noteExport() }
                }
            }
            exportText = null
            r.onSuccess {
                if (encrypted) Pw.prefs.exportLast = System.currentTimeMillis()
                message = "Saved."
            }.onFailure { error = "That file couldn't be saved." }
        }
    }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val text = exportText
        if (uri != null && text != null) writeTo(uri, text) else exportText = null
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Header("Import and export", onBack)
        error?.let { ErrorCard(it) }
        message?.let { Text(it, Modifier.testTag("transfer-message")) }
        busy?.let {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CircularProgressIndicator()
                Text(it, Modifier.testTag("transfer-busy"))
            }
        }
        Text("Import", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text("Files are read on this phone and never uploaded. Browser CSVs (Chrome, Edge, Firefox, Google, Apple), LastPass CSV, Bitwarden JSON, 1Password .1pux, Proton Pass JSON, Dashlane zip, KeePass XML and KDBX, Credential Exchange (CXF) JSON, Aegis and 2FAS JSON without a password, Google Authenticator migration links in a text file, and Promptly's own exports.", style = MaterialTheme.typography.bodySmall)
        OutlinedButton(onClick = { picker.launch(arrayOf("*/*")) }, Modifier.testTag("import-pick")) { Text("Choose a file") }
        needsPassword?.let { format ->
            SecretField(filePassword, { filePassword = it }, "Password for this $format file", "import-password")
            Button(onClick = { pending?.let { (n, b) -> read(n, b, filePassword) } }, enabled = filePassword.isNotEmpty(), modifier = Modifier.testTag("import-open")) { Text("Open it") }
        }
        preview?.let { res ->
            Card(Modifier.fillMaxWidth().testTag("import-preview")) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("${res.format}: ${fresh.size} to add, $duplicates duplicates left out", fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("import-summary"))
                    res.warnings.take(10).forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                    fresh.take(50).forEach { Text("${it.body.title}${it.body.username?.let { u -> " ($u)" } ?: ""}", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("import-row-${it.body.title}")) }
                    if (fresh.size > 50) Text("And ${fresh.size - 50} more.", style = MaterialTheme.typography.bodySmall)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = {
                            val list = fresh
                            val format = res.format
                            preview = null
                            busy = "Saving…"
                            scope.launch {
                                val r = withContext(Dispatchers.IO) { runCatching { saveImported(client, list) { d, t -> busy = "Saving $d of $t" } } }
                                busy = null
                                r.onSuccess { message = "Imported ${list.size}. " + (Importers.AFTER_IMPORT[format] ?: "") }.onFailure { error = errorText(it) }
                            }
                        }, enabled = fresh.isNotEmpty(), modifier = Modifier.testTag("import-confirm")) { Text("Import ${fresh.size}") }
                        TextButton(onClick = { preview = null }) { Text("Cancel") }
                    }
                }
            }
        }
        HorizontalDivider()
        Text("Export", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        val fillOnlyLeftOut = remember { runCatching { client.allItems().size - client.exportable().size }.getOrDefault(0) }
        if (fillOnlyLeftOut > 0) Text("$fillOnlyLeftOut items from fill-only vaults aren't included.", style = MaterialTheme.typography.bodySmall)
        Text("Either kind of export asks for your master password first.", style = MaterialTheme.typography.bodySmall)
        SecretField(exportMaster, { exportMaster = it }, "Your master password", "export-master")
        Text("An encrypted file opens only with the password you choose here.", style = MaterialTheme.typography.bodySmall)
        SecretField(exportPassword, { exportPassword = it }, "Password for the file", "export-password")
        SecretField(exportAgain, { exportAgain = it }, "Type it again", "export-password-again")
        Button(onClick = {
            busy = "Encrypting…"
            val pw = exportPassword
            val master = exportMaster
            error = null
            scope.launch {
                val r = withContext(Dispatchers.IO) {
                    runCatching {
                        if (!client.checkPassword(master)) throw IllegalStateException("That master password isn't right.")
                        Exporter.encrypted(client.exportable(), pw)
                    }
                }
                busy = null
                r.onSuccess {
                    exportText = it
                    exportEncrypted = true
                    exportPassword = ""
                    exportAgain = ""
                    exportMaster = ""
                    saver.launch("promptly-passwords-export.json")
                }.onFailure { error = errorText(it) }
            }
        }, enabled = exportMaster.isNotEmpty() && exportPassword.length >= 8 && exportPassword == exportAgain, modifier = Modifier.testTag("export-encrypted")) { Text("Save encrypted export") }
        Text("A plain file holds every password in readable text. Anything on this phone, or any place you copy it to, can read it. To go ahead, type EXPORT.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        OutlinedTextField(plainTyped, { plainTyped = it }, label = { Text("Type EXPORT") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("export-typed"))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FilterChip(plainKind == "json", { plainKind = "json" }, { Text("JSON") }, Modifier.testTag("export-kind-json"))
            FilterChip(plainKind == "csv", { plainKind = "csv" }, { Text("CSV, logins only") }, Modifier.testTag("export-kind-csv"))
        }
        OutlinedButton(onClick = {
            val master = exportMaster
            val kind = plainKind
            busy = "Checking…"
            error = null
            scope.launch {
                val r = withContext(Dispatchers.IO) {
                    runCatching {
                        if (!client.checkPassword(master)) throw IllegalStateException("That master password isn't right.")
                        val items = client.exportable()
                        if (kind == "csv") Exporter.plainCsv(items) else Exporter.plainJson(items)
                    }
                }
                busy = null
                r.onSuccess {
                    exportText = it
                    exportEncrypted = false
                    plainTyped = ""
                    exportMaster = ""
                    saver.launch(if (kind == "csv") "promptly-passwords.csv" else "promptly-passwords.json")
                }.onFailure { error = errorText(it) }
            }
        }, enabled = exportMaster.isNotEmpty() && plainTyped == "EXPORT", modifier = Modifier.testTag("export-plain")) { Text("Save plain file") }
    }
}

// ---- Secure Send ------------------------------------------------------------------------

@Composable
fun SendsScreen(client: VaultClient, onBack: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var title by remember { mutableStateOf("") }
    var text by remember { mutableStateOf("") }
    var days by remember { mutableIntStateOf(7) }
    var views by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var link by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var list by remember { mutableStateOf<List<SendOut>>(emptyList()) }
    var refresh by remember { mutableIntStateOf(0) }
    var askedPassword by remember { mutableStateOf(false) }
    var posting by remember { mutableStateOf<Posting?>(null) }
    val version by Pw.version.collectAsState()
    val records = remember(version) { runCatching { client.sendRecords() }.getOrDefault(emptyMap()) }
    LaunchedEffect(refresh) {
        withContext(Dispatchers.IO) { runCatching { client.api.sends() } }.onSuccess { list = it }.onFailure { error = errorText(it) }
    }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            busy = true
            error = null
            val name = displayName(ctx, uri)
            val mime = ctx.contentResolver.getType(uri)
            scope.launch {
                val hadPassword = password.isNotEmpty()
                val r = withContext(Dispatchers.IO) {
                    runCatching {
                        val bytes = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                        val made = SecureSend.create(client.api, SecureSend.filePayload(title.ifBlank { name }, name, mime, bytes), days, views.toIntOrNull(), password.ifEmpty { null })
                        client.recordSend(title.ifBlank { name }, made.link, made.id)
                        made
                    }
                }
                busy = false
                r.onSuccess {
                    link = it.link
                    askedPassword = hadPassword
                    password = ""
                    refresh++
                }.onFailure { error = errorText(it) }
            }
        }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Header("Secure Send", onBack)
        Text("A link that opens a note or a file, then expires. The key is in the part of the link your server never sees.", style = MaterialTheme.typography.bodySmall)
        error?.let { ErrorCard(it) }
        OutlinedTextField(title, { title = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("send-title"))
        OutlinedTextField(text, { text = it }, label = { Text("What to send") }, minLines = 3, modifier = Modifier.fillMaxWidth().testTag("send-text"))
        Text("Expires after")
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf(1, 7, 30).forEach { d -> FilterChip(days == d, { days = d }, { Text("$d day${if (d == 1) "" else "s"}") }, Modifier.testTag("send-days-$d")) }
        }
        OutlinedTextField(views, { v -> views = v.filter { it.isDigit() }.take(4) }, label = { Text("Views allowed, blank for no limit") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("send-views"))
        SecretField(password, { password = it }, "Password, if you want one", "send-password")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = {
                busy = true
                error = null
                val hadPassword = password.isNotEmpty()
                scope.launch {
                    val r = withContext(Dispatchers.IO) {
                        runCatching {
                            val made = SecureSend.create(client.api, SecureSend.textPayload(title.ifBlank { "Secure Send" }, text), days, views.toIntOrNull(), password.ifEmpty { null })
                            client.recordSend(title.ifBlank { "Text" }, made.link, made.id)
                            made
                        }
                    }
                    busy = false
                    r.onSuccess {
                        link = it.link
                        askedPassword = hadPassword
                        text = ""
                        password = ""
                        refresh++
                    }.onFailure { error = errorText(it) }
                }
            }, enabled = text.isNotBlank() && !busy, modifier = Modifier.testTag("send-create")) { Text("Make link") }
            OutlinedButton(onClick = { filePicker.launch(arrayOf("*/*")) }, enabled = !busy, modifier = Modifier.testTag("send-file")) { Text("Send a file") }
            if (busy) CircularProgressIndicator()
        }
        link?.let {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Anyone with this link can open it:", fontWeight = FontWeight.SemiBold)
                    Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("send-link"))
                    Button(onClick = {
                        Clip.copySecret(ctx, "Send link", it)
                        toast(ctx, "Link copied")
                    }, Modifier.testTag("send-copy")) { Text("Copy link") }
                    if (askedPassword) Text("Tell them the password some other way, not in the same message as the link.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("send-password-note"))
                }
            }
        }
        if (list.isNotEmpty()) Text("Your Sends", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        for (s in list) {
            val rec = records[s.id]
            val finished = SendRecords.finished(s)
            Column(Modifier.fillMaxWidth().testTag("send-row")) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        // Only your own vault knows what it's called. Sent elsewhere and not synced yet, it isn't known here.
                        Text(rec?.title ?: "Sent from another device", fontWeight = FontWeight.Medium, modifier = Modifier.testTag("send-name"))
                        Text(if (finished) "Finished" else "Expires ${s.expiresAt.take(10)}", style = MaterialTheme.typography.bodySmall)
                        Text(listOfNotNull(s.viewsLeft?.let { "$it views left" }, if (s.hasPassword) "has a password" else null).joinToString(", ").ifEmpty { "No view limit" }, style = MaterialTheme.typography.bodySmall)
                    }
                    TextButton(onClick = {
                        scope.launch {
                            withContext(Dispatchers.IO) { runCatching { client.deleteSend(s.id) } }.onFailure { error = errorText(it) }
                            refresh++
                        }
                    }, Modifier.testTag("send-delete")) { Text("Delete") }
                }
                if (rec != null && !finished) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        TextButton(onClick = {
                            Clip.copySecret(ctx, "Send link", rec.link)
                            toast(ctx, "Link copied")
                        }, Modifier.testTag("send-copy-again")) { Text("Copy link") }
                        TextButton(onClick = { posting = Posting(s.id, rec.link, "rooms") }, Modifier.testTag("send-rooms")) { Text("Rooms") }
                        TextButton(onClick = { posting = Posting(s.id, rec.link, "mail") }, Modifier.testTag("send-mail")) { Text("Mail") }
                    }
                }
                HorizontalDivider()
            }
        }
    }
    posting?.let { p -> PostSendDialog(client, p) { posting = null } }
}

private data class Posting(val id: String, val link: String, val via: String)

/** The link, never what's behind it: there's no field to put a secret in, the record is checked
 *  to really be a link to this Send, and the server writes the message around it. */
@Composable
private fun PostSendDialog(client: VaultClient, p: Posting, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var people by remember { mutableStateOf<List<Person>>(emptyList()) }
    var who by remember { mutableStateOf<Person?>(null) }
    var pick by remember { mutableStateOf(false) }
    var to by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val rooms = p.via == "rooms"
    LaunchedEffect(Unit) {
        if (rooms) withContext(Dispatchers.IO) { runCatching { client.api.people() } }.onSuccess { people = it }.onFailure { error = errorText(it) }
    }
    AlertDialog(
        onDismissRequest = onClose,
        modifier = Modifier.exposeTags(),
        title = { Text(if (rooms) "Send in Rooms" else "Send by Mail") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("The link passes through your Promptly server this way, and the link is enough to open it unless it has a password. Copying the link into something end-to-end encrypted is safer.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("send-post-warning"))
                if (rooms) {
                    Column {
                        TextButton(onClick = { pick = true }, Modifier.testTag("send-post-who")) { Text(who?.username ?: "Choose someone") }
                        DropdownMenu(pick, { pick = false }, Modifier.exposeTags()) {
                            people.forEach { x ->
                                DropdownMenuItem({ Text(x.username) }, {
                                    who = x
                                    pick = false
                                }, Modifier.testTag("send-person-${x.username}"))
                            }
                        }
                    }
                } else {
                    OutlinedTextField(to, { to = it }, label = { Text("Their email address") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("send-post-to"))
                }
                error?.let { ErrorCard(it) }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                if (!SendRecords.isLinkTo(p.id, p.link, client.api.baseUrl)) {
                    error = "That record doesn't hold a link to this Send, so it wasn't posted."
                    return@TextButton
                }
                busy = true
                error = null
                val person = who
                val address = to.trim()
                scope.launch {
                    val r = withContext(Dispatchers.IO) {
                        runCatching {
                            if (rooms) client.api.sendViaRooms(p.id, p.link, person!!.id) else client.api.sendViaMail(p.id, p.link, address)
                        }
                    }
                    busy = false
                    r.onSuccess {
                        toast(ctx, if (rooms) "Posted in Rooms" else "Queued in Mail")
                        onClose()
                    }.onFailure { error = errorText(it) }
                }
            }, enabled = !busy && (if (rooms) who != null else to.isNotBlank()), modifier = Modifier.testTag("send-post-go")) { Text("Send the link") }
        },
        dismissButton = { TextButton(onClick = onClose, Modifier.testTag("send-post-cancel")) { Text("Cancel") } },
    )
}

// ---- Emergency access ---------------------------------------------------------------------

@Composable
fun EmergencyScreen(client: VaultClient, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var rows by remember { mutableStateOf<List<EmergencyOut>>(emptyList()) }
    var people by remember { mutableStateOf<List<Person>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    var who by remember { mutableStateOf<Person?>(null) }
    var pick by remember { mutableStateOf(false) }
    var days by remember { mutableStateOf("7") }
    var asking by remember { mutableStateOf<EmergencyOut?>(null) }
    LaunchedEffect(refresh) {
        while (true) {
            withContext(Dispatchers.IO) {
                // A row's only the server's word: this seals keys only to someone you named, on the keys you saw.
                runCatching { client.refreshEmergency() }
                runCatching { client.api.emergencyList() }
            }.onSuccess {
                rows = it
                error = null
            }.onFailure { error = errorText(it) }
            delay(5000)
        }
    }
    LaunchedEffect(Unit) {
        withContext(Dispatchers.IO) { runCatching { client.api.people() } }.onSuccess { list -> people = list.filter { it.hasVault } }
    }
    fun act(block: () -> Unit) {
        scope.launch {
            error = null
            val r = withContext(Dispatchers.IO) { runCatching { block() } }
            r.onFailure { error = errorText(it) }
            if (r.isSuccess) refresh++
        }
    }
    val me = client.userId
    val granted = rows.filter { it.grantorId == me }
    val received = rows.filter { it.granteeId == me }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Header("Emergency access", onBack)
        Text("Name someone who can ask for your vault if you can't reach it. When they ask, you get a push and an email, and you can refuse.", style = MaterialTheme.typography.bodySmall)
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer), modifier = Modifier.fillMaxWidth().testTag("emergency-warning")) {
            Text(EmergencyText.WARNING, Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall)
        }
        error?.let { ErrorCard(it) }
        if (rows.isEmpty()) Text("Nothing set up.", Modifier.testTag("emergency-empty"))
        for (r in granted) {
            Card(Modifier.fillMaxWidth().testTag("emergency-${r.grantee}")) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("${r.grantee} can ask for your vault", fontWeight = FontWeight.SemiBold)
                    Text("A ${r.waitDays} day wait.", style = MaterialTheme.typography.bodySmall)
                    Text(EmergencyText.state(r, true), style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("emergency-state"))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (r.state == "requested") Button(onClick = { act { client.api.emergencyAct(r.id, "refuse") } }, Modifier.testTag("emergency-refuse")) { Text("Refuse") }
                        OutlinedButton(onClick = { act { client.emergencyEnd(r) } }, Modifier.testTag("emergency-end")) { Text(if (r.state == "opened" || r.state == "ended") "End and change the keys" else "End") }
                    }
                }
            }
        }
        for (r in received) {
            Card(Modifier.fillMaxWidth().testTag("emergency-${r.grantor}")) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("${r.grantor} trusts you", fontWeight = FontWeight.SemiBold)
                    Text("A ${r.waitDays} day wait.", style = MaterialTheme.typography.bodySmall)
                    Text(EmergencyText.state(r, false), style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("emergency-state"))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (r.state == "invited") Button(onClick = { act { client.api.emergencyAct(r.id, "accept") } }, Modifier.testTag("emergency-accept")) { Text("Accept") }
                        if (EmergencyText.canAsk(r)) OutlinedButton(onClick = { asking = r }, Modifier.testTag("emergency-ask")) { Text("Ask for access") }
                        if (EmergencyText.due(r)) Button(onClick = { act { client.emergencyOpen(r.id) } }, Modifier.testTag("emergency-open")) { Text("Open their vault") }
                        OutlinedButton(onClick = { act { client.emergencyEnd(r) } }, Modifier.testTag("emergency-stop")) { Text("Stop being their contact") }
                    }
                }
            }
        }
        HorizontalDivider()
        Text("Add a trusted contact", fontWeight = FontWeight.SemiBold)
        val available = people.filter { p -> granted.none { it.granteeId == p.id } }
        Column {
            TextButton(onClick = { pick = true }, Modifier.testTag("emergency-person")) { Text(who?.username ?: "Choose someone") }
            DropdownMenu(pick, { pick = false }, Modifier.exposeTags()) {
                available.forEach { p ->
                    DropdownMenuItem({ Text(p.username) }, {
                        who = p
                        pick = false
                    }, Modifier.testTag("emergency-person-${p.username}"))
                }
            }
        }
        OutlinedTextField(days, { v -> days = v.filter { it.isDigit() }.take(3) }, label = { Text("Wait, in days (1 to 90)") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("emergency-days"))
        val wait = EmergencyText.validWait(days)
        Button(onClick = {
            val p = who ?: return@Button
            val d = wait ?: return@Button
            who = null
            act { client.emergencyInvite(p.id, d) }
        }, enabled = who != null && wait != null, modifier = Modifier.testTag("emergency-add")) { Text("Add") }
    }
    asking?.let { r ->
        AlertDialog(
            onDismissRequest = { asking = null },
            modifier = Modifier.exposeTags(),
            title = { Text("Ask for ${r.grantor}'s vault?") },
            text = { Text("They'll be told straight away.") },
            confirmButton = {
                TextButton(onClick = {
                    asking = null
                    act { client.api.emergencyAct(r.id, "request") }
                }, Modifier.testTag("emergency-ask-confirm")) { Text("Ask") }
            },
            dismissButton = { TextButton(onClick = { asking = null }) { Text("Not now") } },
        )
    }
}
