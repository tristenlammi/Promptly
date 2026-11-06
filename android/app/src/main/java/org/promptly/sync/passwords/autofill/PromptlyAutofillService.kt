// The AutofillService. Answers from the local index with no network and no unlock: every
// suggestion is a gated dataset, so picking one opens AutofillAuthActivity, which unlocks
// if needed and only then hands back the values. Secrets never reach the system until
// someone picks a suggestion. No Accessibility service, here or anywhere.
package org.promptly.sync.passwords.autofill

import android.app.PendingIntent
import android.app.assist.AssistStructure
import android.app.slice.Slice
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.Dataset
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.InlinePresentation
import android.service.autofill.SaveCallback
import android.service.autofill.SaveInfo
import android.service.autofill.SaveRequest
import android.util.Log
import android.view.View
import android.view.autofill.AutofillId
import android.view.inputmethod.InlineSuggestionsRequest
import android.widget.RemoteViews
import android.widget.inline.InlinePresentationSpec
import androidx.autofill.inline.UiVersions
import androidx.autofill.inline.v1.InlineSuggestionUi
import org.promptly.sync.R
import org.promptly.sync.passwords.Pw

class PromptlyAutofillService : AutofillService() {
    private data class Walked(val nodes: List<FieldNode<AutofillId>>, val values: Map<AutofillId, String>)

    private fun walk(structure: AssistStructure): Walked {
        val out = ArrayList<FieldNode<AutofillId>>()
        val values = HashMap<AutofillId, String>()
        var forms = 0
        for (w in 0 until structure.windowNodeCount) {
            val window = structure.getWindowNodeAt(w)
            fun visit(n: AssistStructure.ViewNode, inherited: String?, scheme: String?, offsetX: Int, offsetY: Int, alpha: Float, shown: Boolean, form: String?) {
                val domain = n.webDomain?.takeIf { it.isNotEmpty() } ?: inherited
                val sch = n.webScheme?.takeIf { it.isNotEmpty() } ?: scheme
                val id = n.autofillId
                val html = n.htmlInfo
                val x = offsetX + n.left
                val y = offsetY + n.top
                val a = alpha * n.alpha
                val isShown = shown && n.visibility == View.VISIBLE
                val section = if (html?.tag.equals("form", true)) "f${forms++}" else form
                val isField = n.autofillType != View.AUTOFILL_TYPE_NONE && n.importantForAutofill != View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
                if (id != null && isField) {
                    val attrs = HashMap<String, String>()
                    html?.attributes?.forEach { attrs[it.first.lowercase()] = it.second ?: "" }
                    val options = n.autofillOptions?.map { it.toString() }
                    out += FieldNode(
                        id, n.className, n.autofillHints?.toList() ?: emptyList(), html?.tag, attrs, n.inputType, n.idEntry,
                        n.hint?.toString(), isShown, n.isFocused, n.width, n.height, domain, sch, options,
                        n.autofillType == View.AUTOFILL_TYPE_TEXT || n.autofillType == View.AUTOFILL_TYPE_LIST,
                        x, y, window.width, window.height, a, "w$w/${section ?: ""}",
                    )
                    n.autofillValue?.takeIf { it.isText }?.textValue?.toString()?.let { values[id] = it }
                }
                for (i in 0 until n.childCount) visit(n.getChildAt(i), domain, sch, x - n.scrollX, y - n.scrollY, a, isShown, section)
            }
            visit(window.rootViewNode, null, null, 0, 0, 1f, true, null)
        }
        return Walked(out, values)
    }

    /** What we believe this request is for. `webDomain` from an unknown package isn't believed. */
    private fun targetOf(pkg: String, form: ParsedForm<AutofillId>): FillTarget {
        val domain = form.webDomain?.lowercase()
        if (domain != null && TrustedBrowsers.isTrusted(this, pkg)) return FillTarget.Web(domain, form.webScheme?.lowercase() ?: "https", pkg, form.webScheme != null)
        return FillTarget.App(pkg, signingCerts(this, pkg).singleOrNull(), domain)
    }

    override fun onFillRequest(request: FillRequest, cancellationSignal: CancellationSignal, callback: FillCallback) {
        val started = System.nanoTime()
        try {
            Pw.init(this)
            callback.onSuccess(answer(request))
        } catch (e: Exception) {
            Log.w(TAG, "fill request failed: ${e.javaClass.simpleName}")
            callback.onSuccess(null)
        } finally {
            if (!Pw.unlocked) AssetLinks.forgetMemory()
            Log.i(TAG, "fill answered in ${(System.nanoTime() - started) / 1_000_000} ms")
        }
    }

    private fun answer(request: FillRequest): FillResponse? {
        if (!Pw.connected) return null
        val structure = request.fillContexts.last().structure
        val pkg = structure.activityComponent.packageName
        if (pkg == packageName) return null
        val walked = walk(structure)
        val form = FormParser.parse(walked.nodes)
        if (form.isEmpty) return null
        val target = targetOf(pkg, form)
        val lookup = AutofillIndex.lookup(this)
        val entries = lookup.entries
        val recents = Pw.prefs.recents
        val cert = (target as? FillTarget.App)?.cert
        if (target is FillTarget.App && cert != null) AssetLinks.refreshInBackground(target.pkg, cert, AutofillIndex.vaultDomains(lookup))
        val hits = AutofillIndex.matches(lookup, target, recents) { domain -> cert != null && AssetLinks.cached(pkg, cert, domain) == true }

        val inline = if (Build.VERSION.SDK_INT >= 30) request.inlineSuggestionsRequest else null
        lastInlineCount = 0
        if (org.promptly.sync.BuildConfig.DEBUG) Log.d(TAG, "target=$target entries=${entries.size} hits=${hits.size} login=${form.hasLogin} otp=${form.otps.size} inline=${inline != null}")
        val response = FillResponse.Builder()
        var code = (System.nanoTime() and 0x0fffffff).toInt()
        var added = 0
        val maxInline = if (Build.VERSION.SDK_INT >= 30 && inline != null) maxOf(1, inline.maxSuggestionCount - 1) else 0

        fun addDataset(mode: String, itemId: String?, title: String, subtitle: String?, downgrade: Boolean = false) {
            val intent = AutofillAuthActivity.intent(this, mode, itemId, target, form, downgrade)
            val sender = PendingIntent.getActivity(this, code++, intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_CANCEL_CURRENT).intentSender
            val builder = Dataset.Builder()
            val views = remote(title, subtitle)
            val ids = when (mode) {
                AutofillAuthActivity.MODE_OTP, AutofillAuthActivity.MODE_MAIL_CODE -> form.otps
                AutofillAuthActivity.MODE_MAIL_LINK -> form.usernames
                AutofillAuthActivity.MODE_CARD -> form.cards.values.toList()
                AutofillAuthActivity.MODE_IDENTITY -> form.identity.values.toList()
                else -> form.allIds.filter { it in form.usernames || it in form.passwords || it in form.newPasswords }.ifEmpty { form.allIds }
            }
            val pres = if (Build.VERSION.SDK_INT >= 30 && added < maxInline) inlinePresentation(inline, added, title, subtitle) else null
            if (pres != null) lastInlineCount++
            for (id in ids) {
                if (pres != null && Build.VERSION.SDK_INT >= 30) builder.setValue(id, null, views, pres) else builder.setValue(id, null, views)
            }
            builder.setAuthentication(sender)
            response.addDataset(builder.build())
            added++
        }

        val site = (target as? FillTarget.Web)?.domain ?: appLabel(pkg)
        // Not an ordinary suggestion: no logins, cards or names, and nothing offered to save, since
        // a saved login would turn this into a known site. One row, and it opens a warning first.
        val looks = AutofillIndex.lookalikeFor(lookup, target, hits)
        if (looks != null) {
            if (form.hasLogin) addDataset(AutofillAuthActivity.MODE_PICK, null, "Looks like $looks", "It isn't. Opens a warning first")
            return if (added == 0) null else response.build()
        }
        if (form.hasLogin) {
            for (h in hits.take(8)) {
                addDataset(AutofillAuthActivity.MODE_LOGIN, h.entry.itemId, h.entry.title ?: "Login for $site", h.entry.username ?: if (Pw.unlocked) null else "Tap to unlock", h.downgrade)
            }
        }
        if (form.otps.isNotEmpty()) {
            for (h in hits.filter { it.entry.hasTotp }.take(4)) {
                addDataset(AutofillAuthActivity.MODE_OTP, h.entry.itemId, h.entry.title ?: "2FA code", "2FA code")
            }
        }
        when (MailOffer.row(Pw.prefs.mailCodes, form.otps.isNotEmpty(), form.usernames.isNotEmpty() && form.passwords.isEmpty() && form.newPasswords.isEmpty(), form.frameDomain, target, hits.size)) {
            MailOffer.Row.CODE -> addDataset(AutofillAuthActivity.MODE_MAIL_CODE, null, "Code from email", "Opens to show what's arrived")
            MailOffer.Row.LINK -> addDataset(AutofillAuthActivity.MODE_MAIL_LINK, null, "Sign-in link from email", "Opens to show what's arrived")
            null -> Unit
        }
        if (form.hasCard) {
            for (e in entries.filter { it.kind == "card" }.take(4)) addDataset(AutofillAuthActivity.MODE_CARD, e.itemId, e.title ?: "A saved card", "Card, opens to confirm")
        }
        if (form.hasIdentity && !form.hasLogin) {
            for (e in entries.filter { it.kind == "identity" }.take(4)) addDataset(AutofillAuthActivity.MODE_IDENTITY, e.itemId, e.title ?: "A saved identity", "Identity, opens to confirm")
        }
        if (form.hasLogin) addDataset(AutofillAuthActivity.MODE_PICK, null, "Search Passwords", "Pick a login for $site")

        saveInfo(form, target)?.let { response.setSaveInfo(it) }
        if (added == 0) return null
        return response.build()
    }

    private fun saveInfo(form: ParsedForm<AutofillId>, target: FillTarget): SaveInfo? {
        val key = saveKey(target)
        if (key in Pw.prefs.neverSave) return null
        val passwords = form.passwords + form.newPasswords
        return when {
            passwords.isNotEmpty() -> {
                val b = SaveInfo.Builder(SaveInfo.SAVE_DATA_TYPE_PASSWORD or SaveInfo.SAVE_DATA_TYPE_USERNAME, arrayOf(passwords.first()))
                    .setFlags(SaveInfo.FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE)
                val extra = (form.usernames + passwords.drop(1))
                if (extra.isNotEmpty()) b.setOptionalIds(extra.toTypedArray())
                b.build()
            }
            // Email-first flows: keep this step, and save once the password page comes.
            form.usernames.isNotEmpty() && Build.VERSION.SDK_INT >= 28 ->
                SaveInfo.Builder(SaveInfo.SAVE_DATA_TYPE_USERNAME, arrayOf(form.usernames.first())).setFlags(SaveInfo.FLAG_DELAY_SAVE).build()
            else -> null
        }
    }

    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        Pw.init(this)
        var username: String? = null
        var password: String? = null
        var target: FillTarget? = null
        for (ctx in request.fillContexts) {
            val walked = walk(ctx.structure)
            val form = FormParser.parse(walked.nodes)
            val pkg = ctx.structure.activityComponent.packageName
            target = targetOf(pkg, form)
            form.usernames.firstNotNullOfOrNull { walked.values[it]?.takeIf { v -> v.isNotBlank() } }?.let { username = it }
            (form.newPasswords + form.passwords).firstNotNullOfOrNull { walked.values[it]?.takeIf { v -> v.isNotEmpty() } }?.let { password = it }
        }
        val t = target
        val pw = password
        if (t == null || pw == null) {
            callback.onSuccess()
            return
        }
        val id = PendingSaves.put(PendingSaves.Save(t, username, pw))
        val intent = Intent(this, AutofillSaveActivity::class.java).putExtra(AutofillSaveActivity.EXTRA_ID, id)
        val sender = PendingIntent.getActivity(this, id.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_CANCEL_CURRENT).intentSender
        callback.onSuccess(sender)
    }

    private fun remote(title: String, subtitle: String?): RemoteViews =
        RemoteViews(packageName, R.layout.pw_autofill_item).apply {
            setTextViewText(R.id.pw_autofill_title, title)
            setTextViewText(R.id.pw_autofill_subtitle, subtitle ?: "")
            setViewVisibility(R.id.pw_autofill_subtitle, if (subtitle.isNullOrEmpty()) View.GONE else View.VISIBLE)
        }

    private fun appLabel(pkg: String): String = runCatching {
        packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
    }.getOrDefault(pkg)

    // getSlice is how the library's own docs hand the content to InlinePresentation.
    @android.annotation.SuppressLint("RestrictedApi")
    private fun inlinePresentation(inline: InlineSuggestionsRequest?, index: Int, title: String, subtitle: String?): InlinePresentation? {
        if (inline == null || Build.VERSION.SDK_INT < 30) return null
        val specs = inline.inlinePresentationSpecs
        if (specs.isEmpty()) return null
        val spec: InlinePresentationSpec = specs[minOf(index, specs.size - 1)]
        if (!UiVersions.getVersions(spec.style).contains(UiVersions.INLINE_UI_VERSION_1)) return null
        val attribution = PendingIntent.getActivity(this, 0, Intent(this, AutofillAuthActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val content = InlineSuggestionUi.newContentBuilder(attribution)
            .setTitle(title)
            .apply { if (!subtitle.isNullOrEmpty()) setSubtitle(subtitle) }
            .setStartIcon(Icon.createWithResource(this, R.drawable.pw_key))
            .build()
        val slice: Slice = content.slice
        return InlinePresentation(slice, spec, false)
    }

    companion object {
        private const val TAG = "PromptlyAutofill"

        /** How many suggestions the last answer offered inline in the keyboard. For tests. */
        @Volatile
        var lastInlineCount = 0

        fun saveKey(target: FillTarget): String = when (target) {
            is FillTarget.Web -> "web:${org.promptly.sync.passwords.core.Match.baseDomain(target.host) ?: target.host}"
            is FillTarget.App -> "app:${target.pkg}"
        }
    }
}

/** Saves wait here, in memory, so a typed password is never put in a system-held Intent. */
object PendingSaves {
    data class Save(val target: FillTarget, val username: String?, val password: String)

    private val map = HashMap<String, Save>()

    @Synchronized
    fun put(s: Save): String {
        val id = java.util.UUID.randomUUID().toString()
        map[id] = s
        return id
    }

    @Synchronized
    fun take(id: String): Save? = map.remove(id)
}
