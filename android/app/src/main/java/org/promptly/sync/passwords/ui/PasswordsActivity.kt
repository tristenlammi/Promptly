// The native vault's one activity: connect, join, unlock, then the vault. Native Compose,
// no TWA, so secrets never pass through a browser. FLAG_SECURE on the whole thing.
package org.promptly.sync.passwords.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.fragment.app.FragmentActivity
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.promptly.sync.Api
import org.promptly.sync.Store
import org.promptly.sync.passwords.Pw
import org.promptly.sync.passwords.core.ApiError
import org.promptly.sync.passwords.core.DeviceJoin
import org.promptly.sync.passwords.core.SecretKeys
import org.promptly.sync.passwords.core.VaultApi
import org.promptly.sync.passwords.core.calibrateKdf
import org.promptly.sync.passwords.core.parseKitQr

class PasswordsActivity : FragmentActivity() {
    /** What was shared in (a URL to add) or a request from the tile. */
    val shared = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        hardenWindow(this)
        enableEdgeToEdge()
        Pw.init(this)
        takeIntent(intent)
        setContent { PwTheme { Root(this) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeIntent(intent)
    }

    private fun takeIntent(intent: Intent?) {
        if (intent?.action == Intent.ACTION_SEND) shared.value = intent.getStringExtra(Intent.EXTRA_TEXT)
    }

    override fun onResume() {
        super.onResume()
        Pw.lockIfExpired()
    }

    override fun onUserInteraction() {
        super.onUserInteraction()
        Pw.touch()
    }

    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) Pw.onBackgrounded()
    }
}

/** ML Kit's scanner: no camera permission of our own, Google Play services runs it. */
fun scanQr(context: android.content.Context, onText: (String) -> Unit, onError: (String) -> Unit) {
    val opts = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
    GmsBarcodeScanning.getClient(context, opts).startScan()
        .addOnSuccessListener { code -> code.rawValue?.let(onText) ?: onError("That code was empty.") }
        .addOnFailureListener { e -> onError(e.message ?: "The scanner didn't start.") }
}

@Composable
private fun Root(activity: PasswordsActivity) {
    val unlocked by Pw.unlockedFlow.collectAsState()
    Pw.version.collectAsState().value
    var refresh by remember { mutableIntStateOf(0) }
    refresh.let { }
    val client = if (Pw.connected) Pw.client() else null
    // Sticky: creating a vault unlocks it, and the Secret Key still has to be shown after that.
    var joining by remember(client) { mutableStateOf(false) }
    if (client != null && !unlocked && !client.unlocked && (client.store.getAccount() == null || !client.keeper.has())) joining = true
    when {
        client == null -> ConnectScreen { refresh++ }
        joining -> JoinScreen(activity) {
            joining = false
            refresh++
        }
        !client.unlocked -> UnlockPane(activity, "Unlock Passwords", { refresh++ })
        else -> {
            // Once. If it's all on already there's nothing to lead anyone through.
            var guide by remember {
                if (!Pw.prefs.setupGuideDone && SetupGuide.allOn(activity)) Pw.prefs.setupGuideDone = true
                mutableStateOf(!Pw.prefs.setupGuideDone)
            }
            // Tabs a browser sent here open once the vault is unlocked (passwords/SYNC.md).
            LaunchedEffect(client) { org.promptly.sync.passwords.SentTabs.openWaiting(activity) }
            if (guide) Column(Modifier.fillMaxSize().safeDrawingPadding()) { SetupGuideScreen { guide = false } } else MainScreen(activity)
        }
    }
}

// ---- Connecting this phone to a server ------------------------------------------

/** The stored app password holds `assistant` on phones paired since that scope was added,
 *  and /devices/register accepts it. Older pairings get a 403, and no pairing gets nothing
 *  to send: both go through the browser, where a signed-in person approves the code. */
@Composable
private fun ConnectScreen(onDone: () -> Unit) {
    val ctx = LocalContext.current
    val paired = remember { runCatching { Store(ctx).account }.getOrNull() }
    var server by remember { mutableStateOf(Pw.prefs.server ?: paired?.server ?: "") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var code by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()

    fun clean(s: String) = s.trim().trimEnd('/').let { if (it.contains("://")) it else "https://$it" }

    fun viaBrowser(url: String) {
        scope.launch {
            val api = VaultApi(url, { null })
            val started = withContext(Dispatchers.IO) { runCatching { api.connectStart(Api.deviceName()) } }
            val s = started.getOrElse {
                error = errorText(it)
                busy = false
                return@launch
            }
            code = s.code
            activityStart(ctx, "$url/passwords/connect?code=${Uri.encode(s.code)}")
            val deadline = System.currentTimeMillis() + 10 * 60_000
            while (System.currentTimeMillis() < deadline) {
                delay(2000)
                val r = withContext(Dispatchers.IO) { runCatching { api.connectPoll(s.id, s.pollSecret) } }.getOrNull() ?: continue
                if (r.status == "denied") {
                    error = "That was turned down in the browser."
                    break
                }
                if (r.token != null && r.deviceId != null) {
                    Pw.connect(url, r.token, r.deviceId)
                    busy = false
                    code = null
                    onDone()
                    return@launch
                }
            }
            if (error == null) error = "No answer from the browser. Try again."
            code = null
            busy = false
        }
    }

    fun connect() {
        busy = true
        error = null
        val url = clean(server)
        scope.launch {
            val p = paired?.takeIf { clean(it.server) == url }
            if (p != null) {
                val api = VaultApi(url, { null })
                val r = withContext(Dispatchers.IO) { runCatching { api.registerDevice(VaultApi.basic(p.username, p.password), Api.deviceName()) } }
                val token = r.getOrNull()
                if (token != null) {
                    Pw.connect(url, token.token, token.deviceId)
                    busy = false
                    onDone()
                    return@launch
                }
                val e = r.exceptionOrNull()
                // 401/403: this phone's app password can't do it. Anything else is a real error.
                if (e !is ApiError || (e.status != 401 && e.status != 403)) {
                    error = errorText(e ?: IllegalStateException())
                    busy = false
                    return@launch
                }
            }
            viaBrowser(url)
        }
    }

    Column(Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("Passwords", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
        Text("Your own end-to-end encrypted password manager, on your Promptly server.", style = MaterialTheme.typography.bodyMedium)
        PreviewNote()
        OutlinedTextField(server, { server = it }, label = { Text("Your Promptly server") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("server"))
        error?.let { ErrorCard(it) }
        code?.let {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Approve this in your browser", fontWeight = FontWeight.SemiBold)
                    Text("Sign in to Promptly if it asks. This phone's code:")
                    Text(it, style = MaterialTheme.typography.titleLarge, fontFamily = FontFamily.Monospace, modifier = Modifier.testTag("connect-code"))
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = { attempt++; connect() }, enabled = !busy && server.isNotBlank(), modifier = Modifier.testTag("connect")) { Text("Connect") }
            if (busy) CircularProgressIndicator()
        }
    }
}

fun activityStart(ctx: android.content.Context, url: String) {
    runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
}

// ---- Joining a vault: new, approved by another device, or the recovery kit --------

private enum class JoinMode { CHOOSE, CREATE, KIT, APPROVE }

@Composable
private fun JoinScreen(activity: FragmentActivity, onDone: () -> Unit) {
    val client = Pw.client()!!
    var exists by remember { mutableStateOf<Boolean?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var mode by remember { mutableStateOf(JoinMode.CHOOSE) }

    LaunchedEffect(Unit) {
        withContext(Dispatchers.IO) { runCatching { client.api.prelogin() } }
            .onSuccess {
                exists = it.exists
                client.preview = it.preview
            }
            .onFailure { error = errorText(it) }
    }
    BackHandler(enabled = mode != JoinMode.CHOOSE) { mode = JoinMode.CHOOSE }

    Column(Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        when (mode) {
            JoinMode.CHOOSE -> {
                Text("Set up this phone", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                PreviewNote()
                error?.let { ErrorCard(it) }
                when (exists) {
                    null -> if (error == null) CircularProgressIndicator()
                    true -> {
                        Text("You already have a vault. This phone needs your Secret Key, and it can get it two ways.")
                        Button(onClick = { mode = JoinMode.APPROVE }, Modifier.fillMaxWidth().testTag("join-approve")) { Text("Approve from another device") }
                        OutlinedButton(onClick = { mode = JoinMode.KIT }, Modifier.fillMaxWidth().testTag("join-kit")) { Text("Use my recovery kit") }
                    }
                    false -> {
                        Text("There's no vault on this account yet.")
                        Button(onClick = { mode = JoinMode.CREATE }, Modifier.fillMaxWidth().testTag("join-create")) { Text("Create my vault") }
                    }
                }
            }
            JoinMode.KIT -> KitJoin(onDone)
            JoinMode.APPROVE -> ApproveJoin(onDone)
            JoinMode.CREATE -> CreateVault(activity, onDone)
        }
    }
}

@Composable
private fun KitJoin(onDone: () -> Unit) {
    val ctx = LocalContext.current
    val client = Pw.client()!!
    var key by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Text("Your recovery kit", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
    VisibleSecretField(key, { key = it }, "Secret Key", "secret-key")
    OutlinedButton(onClick = {
        scanQr(ctx, { text ->
            val kit = parseKitQr(text)
            if (kit == null) {
                error = "That QR isn't a recovery kit."
            } else {
                key = kit.secretKey
                if (kit.serverUrl.trimEnd('/') != client.api.baseUrl) error = "That kit is for ${kit.serverUrl}, not this server."
            }
        }, { error = it })
    }, Modifier.testTag("scan-kit")) { Text("Scan the QR on my kit") }
    SecretField(password, { password = it }, "Master password", "master-password")
    error?.let { ErrorCard(it) }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Button(onClick = {
            busy = true
            error = null
            scope.launch {
                val r = withContext(Dispatchers.IO) { runCatching { client.unlock(password, SecretKeys.parse(key)) } }
                busy = false
                r.onSuccess {
                    Pw.touch()
                    onDone()
                }.onFailure { error = errorText(it) }
            }
        }, enabled = !busy && key.isNotBlank() && password.isNotEmpty(), modifier = Modifier.testTag("kit-unlock")) { Text("Unlock") }
        if (busy) CircularProgressIndicator()
    }
}

@Composable
private fun ApproveJoin(onDone: () -> Unit) {
    val client = Pw.client()!!
    var join by remember { mutableStateOf<DeviceJoin?>(null) }
    var words by remember { mutableStateOf<List<String>?>(null) }
    var approved by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        val j = withContext(Dispatchers.IO) { runCatching { client.requestDevice(Api.deviceName()) } }.getOrElse {
            error = errorText(it)
            return@LaunchedEffect
        }
        join = j
        while (!approved) {
            delay(2000)
            val s = withContext(Dispatchers.IO) { runCatching { j.poll() } }.getOrNull() ?: continue
            words = s.words
            if (s.status == "denied") {
                error = "That was turned down on your other device."
                return@LaunchedEffect
            }
            if (s.status == DeviceJoin.REFUSED) {
                error = "What came back wasn't this account's Secret Key, so it wasn't saved. Don't enter your master password here, and tell your server's admin."
                return@LaunchedEffect
            }
            if (s.status == "approved" && s.secretKey != null) approved = true
        }
    }
    Text("Approve this phone", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
    error?.let { ErrorCard(it) }
    if (!approved) {
        join?.let {
            Text("On a device that's already unlocked, open Passwords, then Devices. This request's code:")
            Text(it.code, style = MaterialTheme.typography.titleLarge, fontFamily = FontFamily.Monospace, modifier = Modifier.testTag("request-code"))
            Text("Or scan this from there: Devices, then Scan a new device's QR.")
            QrImage(it.qrText, Modifier.testTag("request-qr"))
        }
        words?.let {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Check these words match your other device:", fontWeight = FontWeight.SemiBold)
                    Text(it.joinToString(" "), style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("safety-words"))
                }
            }
        }
        CircularProgressIndicator()
    } else {
        Text("Approved. Now your master password, to open it here.")
        SecretField(password, { password = it }, "Master password", "master-password")
        Button(onClick = {
            busy = true
            error = null
            scope.launch {
                val r = withContext(Dispatchers.IO) { runCatching { client.unlock(password) } }
                busy = false
                r.onSuccess {
                    Pw.touch()
                    onDone()
                }.onFailure { error = errorText(it) }
            }
        }, enabled = !busy && password.isNotEmpty(), modifier = Modifier.testTag("approve-unlock")) { Text("Unlock") }
    }
}

@Composable
private fun CreateVault(activity: FragmentActivity, onDone: () -> Unit) {
    val client = Pw.client()!!
    var understood by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    var again by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var kit by remember { mutableStateOf<String?>(null) }
    var typed by remember { mutableStateOf("") }
    var offerFamily by remember { mutableStateOf(false) }
    var offerPromptly by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    activity.hashCode()

    if (offerPromptly) {
        SavePromptlyStep(client, onDone)
        return
    }
    if (offerFamily) {
        FamilyStep(client) { offerPromptly = true }
        return
    }
    val shown = kit
    if (shown != null) {
        Text("Your Secret Key", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Text("Keep this somewhere safe, away from this phone, like on paper with your passport. With your master password it opens your vault on a new device. Screenshots are blocked here, so write it down, or get the printable kit from the web vault.")
        SensitiveWhile(true)
        Text(shown, style = MaterialTheme.typography.titleMedium, fontFamily = FontFamily.Monospace, modifier = Modifier.testTag("kit-secret-key"))
        VisibleSecretField(typed, { typed = it }, "To prove you saved it, type its last group", "kit-last-group")
        error?.let { ErrorCard(it) }
        Button(onClick = {
            scope.launch {
                withContext(Dispatchers.IO) { runCatching { client.api.confirmKit() } }
                offerFamily = true
            }
        }, enabled = typed.trim().equals(SecretKeys.lastGroup(shown), true), modifier = Modifier.testTag("kit-done")) { Text("I've saved it") }
        return
    }
    Text("Create your vault", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
    Text("Lost both your master password and your Secret Key? The vault is gone. Nobody can get it back, not even your server's admin.")
    Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(understood, { understood = it }, Modifier.testTag("understood"))
        Text("I understand")
    }
    SecretField(password, { password = it }, "Master password", "new-master")
    if (password.isNotEmpty()) StrengthLine(password)
    SecretField(again, { again = it }, "Type it again", "new-master-again")
    error?.let { ErrorCard(it) }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Button(onClick = {
            busy = true
            error = null
            scope.launch {
                val r = withContext(Dispatchers.IO) { runCatching { client.setup(password, calibrateKdf()) } }
                busy = false
                r.onSuccess {
                    Pw.touch()
                    kit = SecretKeys.encode(it)
                }.onFailure { error = errorText(it) }
            }
        }, enabled = !busy && understood && password.length >= 8 && password == again, modifier = Modifier.testTag("create-vault")) { Text("Create vault") }
        if (busy) CircularProgressIndicator()
    }
}
