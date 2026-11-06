// Where the vault meets the rest of Promptly, on a phone: the activity log, and the web vault's
// Connections screens. What the server hands over is compared with the vault here, and shown as text.
package org.promptly.sync.passwords.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.promptly.sync.passwords.core.ActivityLog
import org.promptly.sync.passwords.core.ActivityOut
import org.promptly.sync.passwords.core.ApiError
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
