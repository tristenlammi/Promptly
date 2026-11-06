// What opens when a suggestion is picked. Unlocks if needed, checks the match again against
// the decrypted item (the index could be stale), asks where the plan says to ask, and only
// then returns the values. Everything it's told comes from our own service through a
// mutable PendingIntent the system fills in, and none of it is a secret.
package org.promptly.sync.passwords.autofill

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.service.autofill.Dataset
import android.view.WindowManager
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import android.view.autofill.AutofillValue
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import org.promptly.sync.passwords.Clip
import org.promptly.sync.passwords.Pw
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.ItemBody
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.Totp
import org.promptly.sync.passwords.ui.ConfirmIdentityPane
import org.promptly.sync.passwords.ui.ErrorCard
import org.promptly.sync.passwords.ui.PwTheme
import org.promptly.sync.passwords.ui.UnlockPane
import org.promptly.sync.passwords.ui.toast

class AutofillAuthActivity : FragmentActivity() {
    private lateinit var mode: String
    private var itemId: String? = null
    private lateinit var target: FillTarget
    private var downgrade = false
    private var frameDomain: String? = null
    private lateinit var usernames: ArrayList<AutofillId>
    private lateinit var passwords: ArrayList<AutofillId>
    private lateinit var otps: ArrayList<AutofillId>
    private lateinit var cardIds: ArrayList<AutofillId>
    private lateinit var cardKeys: ArrayList<String>
    private lateinit var identityIds: ArrayList<AutofillId>
    private lateinit var identityKeys: ArrayList<String>
    private val optionsFor = HashMap<AutofillId, List<String>>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        Pw.init(this)
        Pw.lockIfExpired()
        val i = intent
        mode = i.getStringExtra(EXTRA_MODE) ?: run {
            finish()
            return
        }
        itemId = i.getStringExtra(EXTRA_ITEM)
        target = readTarget(i)
        downgrade = i.getBooleanExtra(EXTRA_DOWNGRADE, false)
        frameDomain = i.getStringExtra(EXTRA_FRAME)
        usernames = ids(i, EXTRA_USERNAMES)
        passwords = ids(i, EXTRA_PASSWORDS)
        otps = ids(i, EXTRA_OTPS)
        cardIds = ids(i, EXTRA_CARD_IDS)
        cardKeys = i.getStringArrayListExtra(EXTRA_CARD_KEYS) ?: ArrayList()
        identityIds = ids(i, EXTRA_IDENTITY_IDS)
        identityKeys = i.getStringArrayListExtra(EXTRA_IDENTITY_KEYS) ?: ArrayList()
        val optionIds = ids(i, EXTRA_OPTION_IDS)
        val optionValues = i.getStringArrayListExtra(EXTRA_OPTION_VALUES) ?: ArrayList()
        optionIds.forEachIndexed { at, id -> optionsFor[id] = optionValues.getOrElse(at) { "" }.split('\u0001') }
        setResult(RESULT_CANCELED)
        setContent { PwTheme { Flow() } }
    }

    private fun ids(i: Intent, key: String): ArrayList<AutofillId> {
        @Suppress("DEPRECATION")
        return i.getParcelableArrayListExtra<AutofillId>(key) ?: ArrayList()
    }

    private sealed class Step {
        data object Unlock : Step()
        data object Pick : Step()
        data class Confirm(val item: Item, val title: String, val detail: String, val remember: Boolean) : Step()
        data class Reprompt(val item: Item) : Step()
        data class Fail(val text: String) : Step()
    }

    @Composable
    private fun Flow() {
        var step by remember { mutableStateOf<Step>(if (Pw.unlocked) Step.Pick else Step.Unlock) }
        val scope = rememberCoroutineScope()

        fun deliver(item: Item) {
            val dataset = buildDataset(item.body)
            if (dataset == null) {
                step = Step.Fail("This item has nothing to fill here.")
                return
            }
            Pw.markUsed(item.id)
            val totp = item.body.totp
            if (mode == MODE_LOGIN && totp != null && otps.isEmpty() && Pw.prefs.copyTotpAfterFill) {
                runCatching {
                    Clip.copySecret(this, "2FA code", Totp.code(totp))
                    toast(this, "2FA code copied")
                }
            }
            setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset))
            finish()
        }

        fun afterChecks(item: Item) {
            if (item.body.reprompt) step = Step.Reprompt(item) else deliver(item)
        }

        /** The item's real rules, now that it's decrypted. */
        fun check(item: Item, picked: Boolean) {
            val t = target
            val isMatch = when (t) {
                is FillTarget.Web -> Match.matchItems(listOf(item), t.url).isNotEmpty() || mode == MODE_CARD || mode == MODE_IDENTITY
                is FillTarget.App -> mode == MODE_CARD || mode == MODE_IDENTITY || appLinked(item, t)
            }
            val where = when (t) {
                is FillTarget.Web -> t.domain
                is FillTarget.App -> appLabel(this, t.pkg)
            }
            when {
                !isMatch && !picked -> step = Step.Fail("This login isn't saved for $where any more.")
                !isMatch && t is FillTarget.Web -> step = Step.Confirm(item, "Fill on $where?", "\"${item.body.title}\" isn't saved for $where. Check the address before you go on.", true)
                !isMatch && t is FillTarget.App -> scope.launch {
                    val viaLinks = withContext(Dispatchers.IO) { siteLinksApp(item, t) }
                    if (viaLinks) {
                        withContext(Dispatchers.IO) { rememberApp(item, t) }
                        afterChecks(Pw.client()!!.get(item.id)!!)
                    } else {
                        val claim = t.claimedDomain?.let { " It's showing a page that says it's from $it, which an app can't prove." } ?: ""
                        step = Step.Confirm(item, "Fill in $where?", "\"${item.body.title}\" isn't linked to this app, and its site doesn't list it.$claim Only go on if you trust this app.", true)
                    }
                }
                downgrade -> step = Step.Confirm(item, "Not a secure page", "$where is http, and this login was saved for https. Anyone on the network could read it.", false)
                frameDomain != null -> step = Step.Confirm(item, "A form inside another site", "This form comes from $frameDomain, inside the page you're on. Only fill it if you expected that.", false)
                mode == MODE_CARD -> step = Step.Confirm(item, "Fill this card?", "\"${item.body.title}\" into $where.", false)
                mode == MODE_IDENTITY -> step = Step.Confirm(item, "Fill this identity?", "\"${item.body.title}\" into $where.", false)
                else -> afterChecks(item)
            }
        }

        LaunchedEffect(step) {
            if (step is Step.Pick && itemId != null) {
                val item = Pw.client()?.get(itemId!!)
                if (item == null) step = Step.Fail("That item isn't in your vault any more.") else check(item, false)
            }
            Pw.touch()
        }

        when (val s = step) {
            Step.Unlock -> UnlockPane(this, "Unlock to fill", { step = Step.Pick }, { finish() })
            Step.Pick -> if (itemId == null) PickPane { check(it, true) } else Busy()
            is Step.Confirm -> ConfirmPane(s) { remember ->
                scope.launch {
                    val fresh = if (remember) withContext(Dispatchers.IO) { rememberTarget(s.item) } else s.item
                    afterChecks(fresh)
                }
            }
            is Step.Reprompt -> ConfirmIdentityPane(this, "Confirm it's you", s.item.body.title, true, { deliver(s.item) }, { finish() })
            is Step.Fail -> Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                ErrorCard(s.text)
                Button(onClick = { finish() }) { Text("Close") }
            }
        }
    }

    @Composable
    private fun Busy() {
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp)) { CircularProgressIndicator() }
    }

    @Composable
    private fun ConfirmPane(s: Step.Confirm, onYes: (remember: Boolean) -> Unit) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(s.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            Text(s.detail, style = MaterialTheme.typography.bodyMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { onYes(false) }, modifier = Modifier.testTag("confirm-fill")) { Text("Fill") }
                if (s.remember) OutlinedButton(onClick = { onYes(true) }, modifier = Modifier.testTag("confirm-remember")) { Text("Fill and remember") }
                TextButton(onClick = { finish() }, modifier = Modifier.testTag("confirm-cancel")) { Text("Cancel") }
            }
        }
    }

    @Composable
    private fun PickPane(onPick: (Item) -> Unit) {
        var query by remember { mutableStateOf("") }
        val c = Pw.client()!!
        val hits = remember(query) {
            val all = if (query.isBlank()) c.allItems() else c.search(query)
            all.filter { it.body.kind == "login" }
        }
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(query, { query = it }, label = { Text("Search your logins") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("pick-search"))
            LazyColumn(Modifier.weight(1f)) {
                items(hits, key = { it.id }) { item ->
                    Column(Modifier.fillMaxWidth().clickable { onPick(item) }.padding(vertical = 10.dp).testTag("pick-${item.body.title}")) {
                        Text(item.body.title)
                        item.body.username?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    }
                    HorizontalDivider()
                }
            }
            TextButton(onClick = { finish() }) { Text("Cancel") }
        }
    }

    private fun appLinked(item: Item, t: FillTarget.App): Boolean {
        val cert = t.cert ?: return false
        return item.body.urls.any { u ->
            val a = Match.parseAppUrl(u.url)
            if (a != null) {
                a.pkg == t.pkg && a.cert == cert
            } else {
                val base = Match.hostOf(u.url)?.let { Match.baseDomain(it) }
                base != null && u.match != "never" && AssetLinks.cached(t.pkg, cert, base) == true
            }
        }
    }

    /** Does a site on this login's list name this app? Over the network, once it's picked. */
    private fun siteLinksApp(item: Item, t: FillTarget.App): Boolean {
        val cert = t.cert ?: return false
        return item.body.urls.any { u ->
            if (u.url.startsWith(Match.APP_SCHEME) || u.match == "never") return@any false
            val base = Match.hostOf(u.url)?.let { Match.baseDomain(it) } ?: return@any false
            AssetLinks.check(t.pkg, cert, base) == true
        }
    }

    private fun rememberApp(item: Item, t: FillTarget.App): Item {
        val cert = t.cert ?: return item
        val c = Pw.client()!!
        val updated = c.update(item.id, item.body.withUrls(item.body.urls + Match.appUrl(t.pkg, cert)))
        runCatching { c.sync() }
        return updated
    }

    private fun rememberTarget(item: Item): Item {
        val c = Pw.client()!!
        return when (val t = target) {
            is FillTarget.App -> rememberApp(item, t)
            is FillTarget.Web -> {
                val updated = c.update(item.id, item.body.withUrls(item.body.urls + LoginUrl("${t.scheme}://${t.domain}")))
                runCatching { c.sync() }
                updated
            }
        }
    }

    private fun valueFor(id: AutofillId, text: String): AutofillValue {
        val opts = optionsFor[id] ?: return AutofillValue.forText(text)
        val at = opts.indexOfFirst { it.equals(text, true) || it.trimStart('0') == text.trimStart('0') }
        return if (at >= 0) AutofillValue.forList(at) else AutofillValue.forText(text)
    }

    private fun buildDataset(b: ItemBody): Dataset? {
        val out = Dataset.Builder()
        var any = false
        fun put(id: AutofillId, text: String?) {
            if (text.isNullOrEmpty()) return
            out.setValue(id, valueFor(id, text))
            any = true
        }
        when (mode) {
            MODE_OTP -> {
                val cfg = b.totp ?: return null
                val code = Totp.code(cfg)
                // Split boxes, one digit each, get one digit each.
                if (otps.size > 1 && otps.size == code.length) otps.forEachIndexed { i, id -> put(id, code[i].toString()) } else otps.firstOrNull()?.let { put(it, code) }
            }
            MODE_CARD -> cardIds.forEachIndexed { i, id ->
                val month = b.text("cardExpMonth")
                val year = b.text("cardExpYear")
                put(id, when (cardKeys.getOrNull(i)) {
                    "number" -> b.str("cardNumber")
                    "cvv" -> b.str("cardCvv")
                    "name" -> b.str("cardholder")
                    "month" -> month
                    "year" -> year
                    "exp" -> if (month.isNotEmpty() && year.isNotEmpty()) "${month.padStart(2, '0')}/${year.takeLast(2)}" else null
                    else -> null
                })
            }
            MODE_IDENTITY -> identityIds.forEachIndexed { i, id ->
                put(id, when (val k = identityKeys.getOrNull(i)) {
                    "fullName" -> listOfNotNull(b.str("firstName"), b.str("middleName"), b.str("lastName")).joinToString(" ").ifEmpty { null }
                    null -> null
                    else -> b.str(k)
                })
            }
            else -> {
                val user = b.username ?: b.str("email")
                usernames.forEach { put(it, user) }
                passwords.forEach { put(it, b.password) }
            }
        }
        return if (any) out.build() else null
    }

    companion object {
        const val MODE_LOGIN = "login"
        const val MODE_OTP = "otp"
        const val MODE_CARD = "card"
        const val MODE_IDENTITY = "identity"
        const val MODE_PICK = "pick"
        private const val EXTRA_MODE = "pw.mode"
        private const val EXTRA_ITEM = "pw.item"
        private const val EXTRA_KIND = "pw.target.kind"
        private const val EXTRA_DOMAIN = "pw.target.domain"
        private const val EXTRA_SCHEME = "pw.target.scheme"
        private const val EXTRA_PKG = "pw.target.pkg"
        private const val EXTRA_CERT = "pw.target.cert"
        private const val EXTRA_DOWNGRADE = "pw.downgrade"
        private const val EXTRA_FRAME = "pw.frame"
        private const val EXTRA_USERNAMES = "pw.ids.usernames"
        private const val EXTRA_PASSWORDS = "pw.ids.passwords"
        private const val EXTRA_OTPS = "pw.ids.otps"
        private const val EXTRA_CARD_IDS = "pw.ids.card"
        private const val EXTRA_CARD_KEYS = "pw.keys.card"
        private const val EXTRA_IDENTITY_IDS = "pw.ids.identity"
        private const val EXTRA_IDENTITY_KEYS = "pw.keys.identity"
        private const val EXTRA_OPTION_IDS = "pw.ids.options"
        private const val EXTRA_OPTION_VALUES = "pw.values.options"

        fun intent(context: Context, mode: String, itemId: String?, target: FillTarget, form: ParsedForm<AutofillId>, downgrade: Boolean): Intent {
            val i = Intent(context, AutofillAuthActivity::class.java)
                .putExtra(EXTRA_MODE, mode)
                .putExtra(EXTRA_ITEM, itemId)
                .putExtra(EXTRA_DOWNGRADE, downgrade)
                .putExtra(EXTRA_FRAME, form.frameDomain)
                .putParcelableArrayListExtra(EXTRA_USERNAMES, ArrayList(form.usernames))
                .putParcelableArrayListExtra(EXTRA_PASSWORDS, ArrayList(form.passwords))
                .putParcelableArrayListExtra(EXTRA_OTPS, ArrayList(form.otps))
                .putParcelableArrayListExtra(EXTRA_CARD_IDS, ArrayList(form.cards.values))
                .putStringArrayListExtra(EXTRA_CARD_KEYS, ArrayList(form.cards.keys))
                .putParcelableArrayListExtra(EXTRA_IDENTITY_IDS, ArrayList(form.identity.values))
                .putStringArrayListExtra(EXTRA_IDENTITY_KEYS, ArrayList(form.identity.keys))
                .putParcelableArrayListExtra(EXTRA_OPTION_IDS, ArrayList(form.options.keys))
                .putStringArrayListExtra(EXTRA_OPTION_VALUES, ArrayList(form.options.values.map { it.joinToString("\u0001") }))
            when (target) {
                is FillTarget.Web -> i.putExtra(EXTRA_KIND, "web").putExtra(EXTRA_DOMAIN, target.domain).putExtra(EXTRA_SCHEME, target.scheme).putExtra(EXTRA_PKG, target.pkg)
                is FillTarget.App -> i.putExtra(EXTRA_KIND, "app").putExtra(EXTRA_PKG, target.pkg).putExtra(EXTRA_CERT, target.cert).putExtra(EXTRA_DOMAIN, target.claimedDomain)
            }
            return i
        }

        private fun readTarget(i: Intent): FillTarget = if (i.getStringExtra(EXTRA_KIND) == "web") {
            FillTarget.Web(i.getStringExtra(EXTRA_DOMAIN)!!, i.getStringExtra(EXTRA_SCHEME) ?: "https", i.getStringExtra(EXTRA_PKG) ?: "")
        } else {
            FillTarget.App(i.getStringExtra(EXTRA_PKG) ?: "", i.getStringExtra(EXTRA_CERT), i.getStringExtra(EXTRA_DOMAIN))
        }

        fun appLabel(context: Context, pkg: String): String = runCatching {
            context.packageManager.getApplicationLabel(context.packageManager.getApplicationInfo(pkg, 0)).toString()
        }.getOrDefault(pkg)
    }
}
