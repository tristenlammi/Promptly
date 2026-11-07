// Credential Manager (Android 14+), the two-phase flow in the official docs. The service's
// first phase answers fast with entries, from what's in memory. Picking one opens
// CredentialActivity, which validates the request, checks who's asking, gets a biometric
// or the master password, and only then signs or hands a password over.
package org.promptly.sync.passwords.credentials

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.CancellationSignal
import android.os.OutcomeReceiver
import android.util.Log
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.annotation.RequiresApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.credentials.CreatePasswordRequest
import androidx.credentials.CreatePasswordResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPasswordOption
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PasswordCredential
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.domerrors.InvalidStateError
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.provider.AuthenticationAction
import androidx.credentials.provider.BeginCreateCredentialRequest
import androidx.credentials.provider.BeginCreateCredentialResponse
import androidx.credentials.provider.BeginCreatePasswordCredentialRequest
import androidx.credentials.provider.BeginCreatePublicKeyCredentialRequest
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPasswordOption
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption
import androidx.credentials.provider.CallingAppInfo
import androidx.credentials.provider.CreateEntry
import androidx.credentials.provider.CredentialEntry
import androidx.credentials.provider.CredentialProviderService
import androidx.credentials.provider.PasswordCredentialEntry
import androidx.credentials.provider.PendingIntentHandler
import androidx.credentials.provider.ProviderClearCredentialStateRequest
import androidx.credentials.provider.PublicKeyCredentialEntry
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.promptly.sync.passwords.Pw
import org.promptly.sync.passwords.autofill.AssetLinks
import org.promptly.sync.passwords.autofill.AutofillIndex
import org.promptly.sync.passwords.autofill.TrustedBrowsers
import org.promptly.sync.passwords.autofill.appOrigin
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.Passkeys
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.b64u
import org.promptly.sync.passwords.core.isoNow
import org.promptly.sync.passwords.core.newBody
import org.promptly.sync.passwords.ui.ConfirmIdentityPane
import org.promptly.sync.passwords.ui.ErrorCard
import org.promptly.sync.passwords.ui.LookalikeWarning
import org.promptly.sync.passwords.ui.PwTheme
import org.promptly.sync.passwords.ui.UnlockPane
import org.promptly.sync.passwords.ui.errorText
import java.security.MessageDigest
import java.time.Instant

private const val TAG = "PromptlyCredentials"

/** Who's asking: a browser on the bundled list, named by its origin, or an app, named by
 *  its signing certificate. Unknown and unprovable is refused (fails closed). */
data class Caller(val pkg: String, val origin: String?, val cert: String?)

@RequiresApi(34)
fun callerOf(context: Context, info: CallingAppInfo): Caller {
    val signing = info.signingInfo
    val sigs = if (signing.hasMultipleSigners()) signing.apkContentsSigners else signing.signingCertificateHistory.takeLast(1).toTypedArray()
    val cert = sigs.singleOrNull()?.let { b64u(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }
    // getOrigin throws for a caller naming an origin it isn't privileged to name.
    val origin = runCatching { info.getOrigin(TrustedBrowsers.allowlistJson(context)) }.getOrElse { e ->
        Log.w(TAG, "origin refused for ${info.packageName}: ${e.javaClass.simpleName}")
        throw SecurityException("This app can't speak for a website.")
    }
    return Caller(info.packageName, origin?.trimEnd('/'), cert)
}

/** The saved site this page only looks like, if any, before a password or passkey goes to it. Only
 *  a browser has a page to look like anything. A login that's really saved for the page clears it
 *  unless it matched by pattern, where nothing says the page's name was ever typed in. */
fun credentialLookalike(items: Collection<Item>, caller: Caller): String? {
    val host = caller.origin?.let { Match.hostOf(it) } ?: return null
    return Match.lookalikeAmong(host, AutofillIndex.savedDomainsOf(items))
}

/** Passwords for this caller: same rules as autofill. */
fun passwordsFor(client: VaultClient, caller: Caller): List<Item> {
    val origin = caller.origin
    val logins = client.allItems().filter { it.body.kind == "login" && !it.body.password.isNullOrEmpty() && !it.body.archived }
    if (origin != null) return Match.matchItems(logins, "$origin/").map { it.item }
    val cert = caller.cert ?: return emptyList()
    return logins.filter { item ->
        item.body.urls.any { u ->
            val a = Match.parseAppUrl(u.url)
            if (a != null) a.pkg == caller.pkg && a.cert == cert
            else {
                val base = Match.hostOf(u.url)?.let { Match.baseDomain(it) }
                base != null && u.match != "never" && AssetLinks.cached(caller.pkg, cert, base) == true
            }
        }
    }
}

@RequiresApi(34)
class PromptlyCredentialProviderService : CredentialProviderService() {
    override fun onBeginCreateCredentialRequest(request: BeginCreateCredentialRequest, cancellationSignal: CancellationSignal, callback: OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException>) {
        Pw.init(this)
        if (!Pw.connected) {
            callback.onResult(BeginCreateCredentialResponse())
            return
        }
        val label = when (request) {
            is BeginCreatePublicKeyCredentialRequest -> "Save passkey to Passwords"
            is BeginCreatePasswordCredentialRequest -> "Save password to Passwords"
            else -> {
                callback.onResult(BeginCreateCredentialResponse())
                return
            }
        }
        val intent = Intent(this, CredentialActivity::class.java).setAction(ACTION_CREATE)
        val pending = PendingIntent.getActivity(this, nextCode(), intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val entry = CreateEntry.Builder(label, pending).setDescription("End-to-end encrypted on your own server").build()
        callback.onResult(BeginCreateCredentialResponse.Builder().setCreateEntries(listOf(entry)).build())
    }

    override fun onBeginGetCredentialRequest(request: BeginGetCredentialRequest, cancellationSignal: CancellationSignal, callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>) {
        Pw.init(this)
        Pw.lockIfExpired()
        if (!Pw.connected) {
            callback.onResult(BeginGetCredentialResponse())
            return
        }
        // Locked: a single "unlock" action. Nothing about the vault shows until then.
        if (!Pw.unlocked) {
            val intent = Intent(this, CredentialActivity::class.java).setAction(ACTION_UNLOCK)
            val pending = PendingIntent.getActivity(this, nextCode(), intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            callback.onResult(BeginGetCredentialResponse.Builder().setAuthenticationActions(listOf(AuthenticationAction("Unlock Passwords", pending))).build())
            return
        }
        try {
            callback.onResult(BeginGetCredentialResponse.Builder().setCredentialEntries(entries(this, request)).build())
        } catch (e: Exception) {
            Log.w(TAG, "begin get failed: ${e.javaClass.simpleName}")
            callback.onError(GetCredentialUnknownException(e.message))
        }
    }

    override fun onClearCredentialStateRequest(request: ProviderClearCredentialStateRequest, cancellationSignal: CancellationSignal, callback: OutcomeReceiver<Void?, ClearCredentialException>) {
        // Nothing is kept per session here.
        callback.onResult(null)
    }

    companion object {
        const val ACTION_CREATE = "org.promptly.passwords.CREATE"
        const val ACTION_UNLOCK = "org.promptly.passwords.UNLOCK"
        const val ACTION_GET_PASSKEY = "org.promptly.passwords.GET_PASSKEY"
        const val ACTION_GET_PASSWORD = "org.promptly.passwords.GET_PASSWORD"
        const val EXTRA_ITEM = "pw.item"
        const val EXTRA_CREDENTIAL = "pw.credential"
        private var counter = (System.nanoTime() and 0xffff).toInt()

        /** The docs ask for a unique request code per entry. */
        @Synchronized
        fun nextCode(): Int = ++counter

        /** Entries for a request, for the service and after an unlock. */
        fun entries(context: Context, request: BeginGetCredentialRequest): List<CredentialEntry> {
            val client = Pw.client() ?: return emptyList()
            val out = ArrayList<CredentialEntry>()
            val info = request.callingAppInfo
            val caller = info?.let { callerOf(context, it) }
            for (option in request.beginGetCredentialOptions) {
                when (option) {
                    is BeginGetPublicKeyCredentialOption -> {
                        val req = runCatching { Passkeys.parseGet(option.requestJson) }.getOrNull() ?: continue
                        val all = Passkeys.allPasskeys(client.allItems())
                        for (u in Passkeys.usable(all, req.rpId, req.allow)) {
                            val intent = Intent(context, CredentialActivity::class.java).setAction(ACTION_GET_PASSKEY)
                                .putExtra(EXTRA_ITEM, u.itemId).putExtra(EXTRA_CREDENTIAL, u.passkey.credentialId)
                            val pending = PendingIntent.getActivity(context, nextCode(), intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                            val b = PublicKeyCredentialEntry.Builder(context, u.passkey.userName.ifEmpty { u.title }, pending, option)
                                .setDisplayName(u.passkey.userDisplayName ?: u.title)
                            u.passkey.lastUsedAt?.let { at -> runCatching { b.setLastUsedTime(Instant.parse(at)) } }
                            out += b.build()
                        }
                    }
                    is BeginGetPasswordOption -> {
                        if (caller == null) continue
                        val matched = passwordsFor(client, caller)
                        val looks = if (matched.isEmpty()) null else credentialLookalike(client.allItems(), caller)
                        for (item in matched) {
                            val name = item.body.username ?: continue
                            if (option.allowedUserIds.isNotEmpty() && name !in option.allowedUserIds) continue
                            val intent = Intent(context, CredentialActivity::class.java).setAction(ACTION_GET_PASSWORD).putExtra(EXTRA_ITEM, item.id)
                            val pending = PendingIntent.getActivity(context, nextCode(), intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                            // Not an ordinary suggestion: it says so, and picking it opens a warning first.
                            out += PasswordCredentialEntry.Builder(context, name, pending, option).setDisplayName(if (looks != null) "Looks like $looks. Check first" else item.body.title).build()
                        }
                    }
                }
            }
            return out
        }
    }
}

/** The app is known by its certificate. May it use this site's passkeys? Only if the site
 *  says so. A browser on the list has already done its own check, so that one isn't redone
 *  (VERIFY_NOTES item 15: doing so breaks Related Origin Requests). */
fun originForPasskey(caller: Caller, rpId: String): String {
    caller.origin?.let { return it }
    val cert = caller.cert ?: throw SecurityException("This app's signature can't be checked.")
    val base = Match.baseDomain(rpId) ?: rpId
    val ok = AssetLinks.check(caller.pkg, cert, rpId) == true || (base != rpId && AssetLinks.check(caller.pkg, cert, base) == true)
    if (!ok) throw SecurityException("$rpId doesn't list this app, so its passkey can't be used here.")
    return appOrigin(cert)
}

@RequiresApi(34)
class CredentialActivity : FragmentActivity() {
    private sealed class Step {
        data object Loading : Step()
        data object Unlock : Step()
        data class Confirm(val title: String, val detail: String, val button: String = "Save", val go: () -> Unit) : Step()
        data class Biometric(val title: String, val detail: String, val go: () -> Unit) : Step()
        data class Lookalike(val page: String, val looksLike: String, val go: () -> Unit) : Step()
        data class Fail(val text: String) : Step()
    }

    // Out here, not in the composition, so a lock can drop what's held even with the window stopped,
    // when Compose isn't running. A step's closures hold the login or the passkey.
    private var step by mutableStateOf<Step>(Step.Loading)
    private var unlocked by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        org.promptly.sync.passwords.ui.hardenWindow(this)
        Pw.init(this)
        Pw.lockIfExpired()
        unlocked = Pw.unlocked
        lifecycleScope.launch { Pw.unlockedFlow.collect { if (!Pw.unlocked) lockedOut() } }
        setContent { PwTheme { Flow() } }
    }

    /** The vault locked while this was open. After the unlock, the request's looked at from the start. */
    private fun lockedOut() {
        unlocked = false
        step = Step.Loading
    }

    /** It can have been a while, and Android's timer doesn't tick in deep sleep. */
    override fun onStart() {
        super.onStart()
        Pw.lockIfExpired()
        if (!Pw.unlocked) lockedOut()
    }

    /** Every answer goes through a tap on a step, or comes straight back from working one out. */
    private fun whileOpen(go: () -> Unit): () -> Unit = { if (Pw.unlocked) go() else lockedOut() }

    /** An unlock from here has no app of ours in front, so "Lock after: Leaving" counts here too.
     *  After a bare unlock, the entries it was for are about to be offered: a minute for that. */
    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) Pw.onBackgrounded(if (intent.action == PromptlyCredentialProviderService.ACTION_UNLOCK) 60_000L else 0L)
    }

    private fun finishGet(json: PublicKeyCredential? = null, password: PasswordCredential? = null) {
        val data = Intent()
        PendingIntentHandler.setGetCredentialResponse(data, GetCredentialResponse(json ?: password!!))
        setResult(RESULT_OK, data)
        finish()
    }

    private fun failGet(e: GetCredentialException) {
        val data = Intent()
        PendingIntentHandler.setGetCredentialException(data, e)
        setResult(RESULT_OK, data)
        finish()
    }

    private fun failCreate(e: CreateCredentialException) {
        val data = Intent()
        PendingIntentHandler.setCreateCredentialException(data, e)
        setResult(RESULT_OK, data)
        finish()
    }

    @Composable
    private fun Flow() {
        // Here to recompose on a lock, should the collector not have got there.
        Pw.unlockedFlow.collectAsState().value
        if (!unlocked || !Pw.unlocked) {
            UnlockPane(this, "Unlock Passwords", { unlocked = true }, {
                if (intent.action == PromptlyCredentialProviderService.ACTION_CREATE) failCreate(CreateCredentialCancellationException())
                else if (intent.action == PromptlyCredentialProviderService.ACTION_UNLOCK) finish()
                else failGet(GetCredentialCancellationException())
            })
            return
        }
        when (intent.action) {
            PromptlyCredentialProviderService.ACTION_UNLOCK -> FinishUnlock()
            PromptlyCredentialProviderService.ACTION_GET_PASSKEY -> GetPasskey()
            PromptlyCredentialProviderService.ACTION_GET_PASSWORD -> GetPassword()
            PromptlyCredentialProviderService.ACTION_CREATE -> Create()
            else -> finish()
        }
    }

    /** Phase one again, now that the vault's open: AuthenticationAction's contract. */
    @Composable
    private fun FinishUnlock() {
        LaunchedEffect(Unit) {
            val req = PendingIntentHandler.retrieveBeginGetCredentialRequest(intent)
            val data = Intent()
            val response = if (req == null) BeginGetCredentialResponse() else {
                withContext(Dispatchers.IO) {
                    runCatching { BeginGetCredentialResponse.Builder().setCredentialEntries(PromptlyCredentialProviderService.entries(this@CredentialActivity, req)).build() }
                }.getOrElse { BeginGetCredentialResponse() }
            }
            PendingIntentHandler.setBeginGetCredentialResponse(data, response)
            setResult(RESULT_OK, data)
            finish()
        }
        Busy()
    }

    @Composable
    private fun Busy() {
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp)) { CircularProgressIndicator() }
    }

    @Composable
    private fun Failure(text: String, close: () -> Unit) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            ErrorCard(text)
            Button(onClick = close, Modifier.testTag("credential-close")) { Text("Close") }
        }
    }

    @Composable
    private fun GetPasskey() {
        val client = Pw.client()!!
        LaunchedEffect(Unit) {
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    val request = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent) ?: throw SecurityException("No request came with this.")
                    val option = request.credentialOptions.filterIsInstance<GetPublicKeyCredentialOption>().firstOrNull() ?: throw SecurityException("That isn't a passkey request.")
                    val req = Passkeys.parseGet(option.requestJson)
                    val itemId = intent.getStringExtra(PromptlyCredentialProviderService.EXTRA_ITEM)!!
                    val credentialId = intent.getStringExtra(PromptlyCredentialProviderService.EXTRA_CREDENTIAL)!!
                    val item = client.get(itemId) ?: throw SecurityException("That passkey isn't in your vault any more.")
                    val all = Passkeys.usable(Passkeys.allPasskeys(listOf(item)), req.rpId, req.allow)
                    val chosen = all.firstOrNull { it.passkey.credentialId == credentialId } ?: throw SecurityException("That passkey isn't for this site.")
                    val caller = callerOf(this@CredentialActivity, request.callingAppInfo)
                    val origin = originForPasskey(caller, req.rpId)
                    val hash = option.clientDataHash
                    // A browser's origin needn't be the site the passkey's for (Related Origin Requests).
                    val looks = caller.origin?.takeIf { o -> Match.hostOf(o)?.let { Match.baseDomain(it) } != (Match.baseDomain(req.rpId) ?: req.rpId) }?.let { credentialLookalike(client.allItems(), caller) }
                    Triple(Triple(req, item, chosen), origin, hash) to (caller.origin to looks)
                }
            }
            if (!Pw.unlocked) {
                lockedOut()
                return@LaunchedEffect
            }
            r.onSuccess { (held, seen) ->
                val (t, origin, hash) = held
                val (req, item, chosen) = t
                val sign = Step.Biometric("Sign in to ${req.rpId}", "As ${chosen.passkey.userName}") {
                    lifecycleScopeLaunch {
                        val json = withContext(Dispatchers.IO) {
                            val a = Passkeys.getAssertion(chosen.passkey, req.challenge, origin, true, hash)
                            runCatching {
                                val passkeys = item.body.passkeys.map { if (it.credentialId == chosen.passkey.credentialId) it.copy(lastUsedAt = isoNow()) else it }
                                client.update(item.id, item.body.withPasskeys(passkeys))
                                client.sync()
                            }
                            Passkeys.assertionJson(a)
                        }
                        finishGet(json = PublicKeyCredential(json))
                    }
                }
                val looks = seen.second
                step = if (looks != null) Step.Lookalike(seen.first ?: "", looks) { step = sign } else sign
            }.onFailure {
                Log.w(TAG, "get passkey refused: ${it.javaClass.simpleName}")
                step = Step.Fail(it.message ?: "That request can't be answered.")
            }
        }
        Render(step) { failGet(GetCredentialCancellationException()) }
    }

    @Composable
    private fun GetPassword() {
        val client = Pw.client()!!
        LaunchedEffect(Unit) {
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    val request = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent) ?: throw SecurityException("No request came with this.")
                    if (request.credentialOptions.none { it is GetPasswordOption }) throw SecurityException("That isn't a password request.")
                    val caller = callerOf(this@CredentialActivity, request.callingAppInfo)
                    val itemId = intent.getStringExtra(PromptlyCredentialProviderService.EXTRA_ITEM)!!
                    val found = passwordsFor(client, caller).firstOrNull { it.id == itemId } ?: throw SecurityException("That login isn't for this app.")
                    // A saved https login asked for by an http page: the same question as autofill.
                    val insecure = caller.origin?.let { o -> Match.matchItems(listOf(found), "$o/").firstOrNull()?.downgrade } == true
                    Triple(found, insecure, caller.origin) to credentialLookalike(client.allItems(), caller)
                }
            }
            if (!Pw.unlocked) {
                lockedOut()
                return@LaunchedEffect
            }
            r.onSuccess { (held, looks) ->
                val (item, insecure, origin) = held
                val send = {
                    Pw.markUsed(item.id)
                    finishGet(password = PasswordCredential(item.body.username ?: "", item.body.password ?: ""))
                }
                val checked = { if (item.body.reprompt) step = Step.Biometric("Confirm it's you", item.body.title, send) else send() }
                val secureEnough = {
                    if (insecure) {
                        step = Step.Confirm("Not a secure page", "$origin is http, and this login was saved for https. Anyone on the network could read it.", "Fill anyway") { checked() }
                    } else {
                        checked()
                    }
                }
                if (looks != null) step = Step.Lookalike(origin ?: "", looks) { secureEnough() } else secureEnough()
            }.onFailure { step = Step.Fail(it.message ?: "That request can't be answered.") }
        }
        Render(step) { failGet(GetCredentialCancellationException()) }
    }

    @Composable
    private fun Create() {
        val client = Pw.client()!!
        LaunchedEffect(Unit) {
            val request = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent)
            if (request == null) {
                step = Step.Fail("No request came with this.")
                return@LaunchedEffect
            }
            when (val req = request.callingRequest) {
                is CreatePublicKeyCredentialRequest -> {
                    val prepared = withContext(Dispatchers.IO) {
                        runCatching {
                            val parsed = Passkeys.parseCreate(req.requestJson)
                            val caller = callerOf(this@CredentialActivity, request.callingAppInfo)
                            val origin = originForPasskey(caller, parsed.rpId)
                            parsed to origin
                        }
                    }
                    if (!Pw.unlocked) {
                        lockedOut()
                        return@LaunchedEffect
                    }
                    prepared.onSuccess { (parsed, origin) ->
                        val existing = Passkeys.allPasskeys(client.allItems()).filter { it.passkey.rpId == parsed.rpId }.map { Passkeys.siteCredentialId(it.passkey.credentialId) }
                        if (parsed.excludeCredentials.any { it in existing }) {
                            failCreate(CreatePublicKeyCredentialDomException(InvalidStateError(), "A passkey for this account already exists here."))
                            return@onSuccess
                        }
                        step = Step.Biometric("Create a passkey for ${parsed.rpId}", "As ${parsed.userName}") {
                            lifecycleScopeLaunch {
                                // It goes in the vault off this thread, and a lock can come on the way.
                                val r = withContext(Dispatchers.IO) {
                                    runCatching {
                                        val made = Passkeys.makeCredential(parsed.rpId, parsed.rpName, parsed.userHandle, parsed.userName, parsed.userDisplayName, parsed.challenge, origin, true, parsed.discoverable)
                                        // Same shape as the browser extension's, so it syncs and works there.
                                        val login = client.allItems().firstOrNull { i -> i.body.kind == "login" && i.body.username == parsed.userName && Match.hostOf(i.body.urls.firstOrNull()?.url ?: "") == parsed.rpId }
                                        if (login != null) client.update(login.id, login.body.withPasskeys(login.body.passkeys + made.passkey))
                                        else client.saveNew(client.personalVaultId(), newBody("passkey", parsed.rpName ?: parsed.rpId).withText("username", parsed.userName).withUrls(listOf(LoginUrl("https://${parsed.rpId}"))).withPasskeys(listOf(made.passkey)))
                                        runCatching { client.sync() }
                                        Passkeys.registrationJson(made, parsed.discoverable)
                                    }
                                }
                                r.onSuccess { json ->
                                    val data = Intent()
                                    PendingIntentHandler.setCreateCredentialResponse(data, CreatePublicKeyCredentialResponse(json))
                                    setResult(RESULT_OK, data)
                                    finish()
                                }.onFailure { failCreate(CreateCredentialUnknownException(errorText(it))) }
                            }
                        }
                    }.onFailure {
                        Log.w(TAG, "create passkey refused: ${it.javaClass.simpleName}")
                        step = Step.Fail(it.message ?: "That request can't be answered.")
                    }
                }
                is CreatePasswordRequest -> {
                    val caller = withContext(Dispatchers.IO) { runCatching { callerOf(this@CredentialActivity, request.callingAppInfo) } }.getOrElse {
                        step = Step.Fail(it.message ?: "That request can't be answered.")
                        return@LaunchedEffect
                    }
                    step = Step.Confirm("Save this login?", "${req.id} for ${caller.origin ?: caller.pkg}") {
                        lifecycleScopeLaunch {
                            val r = withContext(Dispatchers.IO) {
                                runCatching {
                                    val url = caller.origin?.let { LoginUrl(it) } ?: caller.cert?.let { Match.appUrl(caller.pkg, it) }
                                    val body = newBody("login", caller.origin?.let { Match.hostOf(it) } ?: caller.pkg)
                                        .withText("username", req.id).withText("password", req.password).withUrls(listOfNotNull(url))
                                    client.saveNew(client.personalVaultId(), body)
                                    runCatching { client.sync() }
                                }
                            }
                            r.onSuccess {
                                val data = Intent()
                                PendingIntentHandler.setCreateCredentialResponse(data, CreatePasswordResponse())
                                setResult(RESULT_OK, data)
                                finish()
                            }.onFailure { failCreate(CreateCredentialUnknownException(errorText(it))) }
                        }
                    }
                }
                else -> step = Step.Fail("That kind of credential isn't supported.")
            }
        }
        Render(step) { failCreate(CreateCredentialCancellationException()) }
    }

    @Composable
    private fun Render(step: Step, cancel: () -> Unit) {
        when (step) {
            Step.Loading -> Busy()
            Step.Unlock -> Busy()
            is Step.Fail -> Failure(step.text, cancel)
            is Step.Confirm -> Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text(step.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                Text(step.detail)
                Button(onClick = whileOpen(step.go), Modifier.testTag("credential-confirm")) { Text(step.button) }
                TextButton(onClick = cancel, Modifier.testTag("credential-cancel")) { Text("Cancel") }
            }
            is Step.Biometric -> ConfirmIdentityPane(this, step.title, step.detail, true, whileOpen(step.go), cancel)
            is Step.Lookalike -> LookalikeWarning(step.page, step.looksLike, emptyList(), "Fill anyway", cancel, whileOpen(step.go))
        }
    }

    private fun lifecycleScopeLaunch(block: suspend () -> Unit) {
        scopeJob.launch { block() }
    }

    private val scopeJob = kotlinx.coroutines.MainScope()

    override fun onDestroy() {
        super.onDestroy()
        scopeJob.coroutineContext[kotlinx.coroutines.Job]?.cancel()
    }
}

