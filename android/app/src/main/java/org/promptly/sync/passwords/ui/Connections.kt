// Where the vault meets the rest of Promptly, on a phone: the activity log, and the web vault's
// Connections screens. What the server hands over is compared with the vault here, and shown as text.
package org.promptly.sync.passwords.ui

import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
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
import org.promptly.sync.Api
import org.promptly.sync.Store
import org.promptly.sync.passwords.Links
import org.promptly.sync.passwords.Pw
import org.promptly.sync.passwords.core.ActivityLog
import org.promptly.sync.passwords.core.ActivityOut
import org.promptly.sync.passwords.core.ApiError
import org.promptly.sync.passwords.core.VaultApi
import org.promptly.sync.passwords.core.VaultClient
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
