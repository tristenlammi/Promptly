// After Android's own "Save to Promptly?" sheet: save a new login or update one, unlocking
// first if the vault's locked. "Never for this site" sticks on this device.
package org.promptly.sync.passwords.autofill

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import org.promptly.sync.passwords.Pw
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.PasswordChange
import org.promptly.sync.passwords.core.newBody
import org.promptly.sync.passwords.ui.ErrorCard
import org.promptly.sync.passwords.ui.PwTheme
import org.promptly.sync.passwords.ui.UnlockPane
import org.promptly.sync.passwords.ui.errorText
import org.promptly.sync.passwords.ui.toast

class AutofillSaveActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        org.promptly.sync.passwords.ui.hardenWindow(this)
        Pw.init(this)
        Pw.lockIfExpired()
        val save = intent.getStringExtra(EXTRA_ID)?.let { PendingSaves.take(it) }
        if (save == null) {
            finish()
            return
        }
        setContent {
            PwTheme {
                var unlocked by remember { mutableStateOf(Pw.unlocked) }
                if (!unlocked) UnlockPane(this, "Unlock to save", { unlocked = true }, { finish() }) else SavePane(save)
            }
        }
    }

    /** The login this save updates: same username, and saved for exactly this host and port, as in
     *  the extension (D51). A login on another host of the same domain, or one saved for another
     *  port, is a different service: a new login is saved beside it instead (D-MATCH-4). */
    private fun sameAccount(save: PendingSaves.Save, item: Item): Boolean {
        val u = item.body.username ?: ""
        if ((save.username ?: "") != u) return false
        return when (val t = save.target) {
            is FillTarget.Web -> t.matchItems(listOf(item)).firstOrNull()?.let { Match.isExactKind(it.kind) } == true
            is FillTarget.App -> hitsTarget(t, item)
        }
    }

    private fun hitsTarget(t: FillTarget, item: Item): Boolean = when (t) {
        is FillTarget.Web -> t.matchItems(listOf(item)).isNotEmpty()
        is FillTarget.App -> item.body.urls.any { u -> Match.parseAppUrl(u.url)?.let { it.pkg == t.pkg && it.cert == t.cert } == true }
    }

    @Composable
    private fun SavePane(save: PendingSaves.Save) {
        val c = Pw.client()!!
        val where = when (val t = save.target) {
            is FillTarget.Web -> t.domain
            is FillTarget.App -> "${AutofillAuthActivity.appLabel(this, t.pkg)} (${t.pkg})"
        }
        val existing = remember { c.allItems().firstOrNull { it.body.kind == "login" && sameAccount(save, it) } }
        val unchanged = existing != null && existing.body.password == save.password
        // Partway through changing it: this is the new one the helper made, whoever it says is signing in.
        val changing = remember { c.allItems().firstOrNull { it.body.kind == "login" && it.body.str("pendingPassword") == save.password && hitsTarget(save.target, it) && c.canEdit(it.vaultId) } }
        var title by remember { mutableStateOf(existing?.body?.title ?: where) }
        var error by remember { mutableStateOf<String?>(null) }
        var busy by remember { mutableStateOf(false) }
        val scope = rememberCoroutineScope()

        fun run(block: () -> Unit) {
            busy = true
            scope.launch {
                val done = withContext(Dispatchers.IO) {
                    runCatching {
                        block()
                        // Saved locally first; a failed sync just tries again later.
                        runCatching { c.sync() }
                    }
                }
                busy = false
                done.onSuccess {
                    toast(this@AutofillSaveActivity, "Saved to Passwords")
                    finish()
                }.onFailure { error = errorText(it) }
            }
        }

        if (unchanged && changing == null) {
            finish()
            return
        }
        if (changing != null) {
            Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("Did $where take your new password?", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                Text("\"${changing.body.title}\" has a new password waiting. If the site accepted it, it becomes the password, and the old one goes to its history.", style = MaterialTheme.typography.bodyMedium)
                error?.let { ErrorCard(it) }
                Button(onClick = { run { c.update(changing.id, PasswordChange.commit(changing.body)) } }, enabled = !busy, modifier = Modifier.fillMaxWidth().testTag("save-commit")) { Text("Yes, it's changed") }
                TextButton(onClick = { finish() }, enabled = !busy, modifier = Modifier.fillMaxWidth().testTag("save-not-now")) { Text("Not yet") }
            }
            return
        }
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(if (existing != null) "Update this login?" else "Save this login?", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            Text("${save.username ?: "No username"} on $where", style = MaterialTheme.typography.bodyMedium)
            if (existing == null) OutlinedTextField(title, { title = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("save-title"))
            error?.let { ErrorCard(it) }
            Button(
                onClick = {
                    run {
                        if (existing != null) {
                            c.update(existing.id, existing.body.with("password" to JsonPrimitive(save.password)))
                        } else {
                            val urls = when (val t = save.target) {
                                is FillTarget.Web -> listOf(LoginUrl("${t.scheme}://${t.domain}"))
                                is FillTarget.App -> t.cert?.let { listOf(Match.appUrl(t.pkg, it)) } ?: emptyList()
                            }
                            val body = newBody("login", title.ifBlank { where }, "password" to JsonPrimitive(save.password))
                                .withText("username", save.username).withUrls(urls)
                            c.saveNew(c.personalVaultId(), body)
                        }
                    }
                },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().testTag("save-confirm"),
            ) { Text(if (existing != null) "Update" else "Save") }
            OutlinedButton(
                onClick = {
                    Pw.prefs.neverSave = Pw.prefs.neverSave + PromptlyAutofillService.saveKey(save.target)
                    finish()
                },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().testTag("save-never"),
            ) { Text("Never for this site") }
            TextButton(onClick = { finish() }, enabled = !busy, modifier = Modifier.fillMaxWidth().testTag("save-not-now")) { Text("Not now") }
        }
    }

    companion object {
        const val EXTRA_ID = "pw.save.id"
    }
}
