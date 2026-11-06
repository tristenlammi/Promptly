// Who is asking. A browser's `webDomain` is only believed if the package is on the bundled
// allowlist with a matching signing certificate. Any other app's WebView can claim any
// domain, so for apps the question is package + certificate, through an explicit link in
// the item or the site's own Digital Asset Links file.
package org.promptly.sync.passwords.autofill

import android.content.Context
import android.content.pm.PackageManager
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import org.promptly.sync.passwords.DebugHooks
import org.promptly.sync.passwords.DeviceSeal
import org.promptly.sync.passwords.Pw
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.b64u
import org.promptly.sync.passwords.core.fromB64u
import org.promptly.sync.passwords.core.fromHex
import org.promptly.sync.passwords.core.hex
import org.promptly.sync.passwords.core.str
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** A package's current signing certificates, as b64u SHA-256. Empty if unknown. */
fun signingCerts(context: Context, pkg: String): List<String> = runCatching {
    val info = context.packageManager.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES)
    val signing = info.signingInfo ?: return emptyList()
    val sigs = if (signing.hasMultipleSigners()) signing.apkContentsSigners else signing.signingCertificateHistory.takeLast(1).toTypedArray()
    sigs.map { b64u(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }
}.getOrDefault(emptyList())

/** `android:apk-key-hash:...`, how WebAuthn names a native app. */
fun appOrigin(certB64u: String) = "android:apk-key-hash:$certB64u"

/** Google's openly available list of browsers (VERIFY_NOTES item 15), bundled as a file.
 *  Parsed once. Only `release` builds count: a debug key signing "Chrome" isn't Chrome.
 *  A few entries on the list aren't browsers, and don't get webDomain trust. */
object TrustedBrowsers {
    private val NOT_BROWSERS = setOf("com.google.android.gms", "com.fido.fido2client", "com.oplus.credential", "com.citrix.Receiver")

    /** Debug and internal builds on the published list. Nobody's phone should be trusting these. */
    private val INTERNAL_BUILD = Regex("debug|\\.local$|internal", RegexOption.IGNORE_CASE)

    private fun listed(pkg: String) = !INTERNAL_BUILD.containsMatchIn(pkg)

    @Volatile
    private var parsed: Map<String, Set<String>>? = null

    @Volatile
    private var rawRelease: String? = null

    fun parse(text: String): Map<String, Set<String>> {
        val out = HashMap<String, MutableSet<String>>()
        val apps = (Json.parseToJsonElement(text) as JsonObject)["apps"] as JsonArray
        for (a in apps) {
            val info = (a as JsonObject)["info"] as? JsonObject ?: continue
            val pkg = info.str("package_name") ?: continue
            if (!listed(pkg)) continue
            for (s in (info["signatures"] as? JsonArray) ?: continue) {
                val sig = s as? JsonObject ?: continue
                if (sig.str("build") != "release") continue
                val fp = sig.str("cert_fingerprint_sha256") ?: continue
                out.getOrPut(pkg) { HashSet() } += b64u(fromHex(fp.replace(":", "").lowercase()))
            }
        }
        return out
    }

    /** The same list as JSON, with only its `release` signatures, for `getOrigin`. */
    fun releaseOnlyJson(text: String): String {
        val root = Json.parseToJsonElement(text) as JsonObject
        val apps = (root["apps"] as JsonArray).mapNotNull { a ->
            val o = a as JsonObject
            val info = o["info"] as? JsonObject ?: return@mapNotNull null
            if (!listed(info.str("package_name") ?: "")) return@mapNotNull null
            val sigs = (info["signatures"] as? JsonArray)?.filter { (it as? JsonObject)?.str("build") == "release" } ?: emptyList()
            if (sigs.isEmpty()) null else JsonObject(o + ("info" to JsonObject(info + ("signatures" to JsonArray(sigs)))))
        }
        return JsonObject(mapOf("apps" to JsonArray(apps))).toString()
    }

    private fun load(context: Context): String = context.assets.open("passwords/privileged_apps.json").use { it.readBytes().decodeToString() }

    fun table(context: Context): Map<String, Set<String>> = parsed ?: synchronized(this) {
        parsed ?: parse(load(context)).also { parsed = it }
    }

    fun allowlistJson(context: Context): String = rawRelease ?: synchronized(this) {
        rawRelease ?: withDebugBrowsers(context, releaseOnlyJson(load(context))).also { rawRelease = it }
    }

    /** Debug builds name their test browser, so a request can be walked through the fill screens.
     *  In a release build the hook's set is empty and this returns what it's given. */
    private fun withDebugBrowsers(context: Context, json: String): String {
        if (DebugHooks.browsersWithoutCertCheck.isEmpty()) return json
        val root = Json.parseToJsonElement(json) as JsonObject
        val extra = DebugHooks.browsersWithoutCertCheck.mapNotNull { pkg ->
            val fps = signingCerts(context, pkg).map { hex(fromB64u(it)).uppercase().chunked(2).joinToString(":") }
            if (fps.isEmpty()) return@mapNotNull null
            JsonObject(mapOf(
                "type" to JsonPrimitive("android"),
                "info" to JsonObject(mapOf(
                    "package_name" to JsonPrimitive(pkg),
                    "signatures" to JsonArray(fps.map { JsonObject(mapOf("build" to JsonPrimitive("release"), "cert_fingerprint_sha256" to JsonPrimitive(it))) }),
                )),
            ))
        }
        return JsonObject(mapOf("apps" to JsonArray((root["apps"] as JsonArray) + extra))).toString()
    }

    /** Is this package a browser we believe, signed by the key we expect? */
    fun isTrusted(context: Context, pkg: String): Boolean {
        if (pkg in DebugHooks.browsersWithoutCertCheck) return true
        if (pkg in NOT_BROWSERS) return false
        val known = table(context)[pkg] ?: return false
        val certs = signingCerts(context, pkg)
        return certs.isNotEmpty() && certs.all { it in known }
    }
}

/** What the page or app is, once we've decided what to believe. */
sealed class FillTarget {
    /** `domain` keeps a port if whoever asked gave one. Android's own `webDomain` doesn't, so on
     *  most fills the port isn't known, and only logins saved with no port match. `schemeKnown`
     *  is false if nothing said whether this page is secure, which then gets a warning. */
    data class Web(val domain: String, val scheme: String, val pkg: String, val schemeKnown: Boolean = true) : FillTarget() {
        val url: String get() = "$scheme://$domain/"
        val host: String get() = url.toHttpUrlOrNull()?.host ?: domain.substringBefore(':')
    }

    data class App(val pkg: String, val cert: String?, val claimedDomain: String?) : FillTarget()
}

/** Whether a fill offers mail at all. The row itself is a door: nothing's fetched until it's picked,
 *  so nothing about the page goes anywhere, and what's behind it is worked out on the next screen. */
object MailOffer {
    enum class Row { CODE, LINK }

    /** Not in a frame from another site, since a code's for the site it's from. Not in an app showing
     *  a page, whose claim about whose page it is can't be checked. In an app, only with a login linked
     *  to it, as that's the only way to know which sites it's for. */
    fun row(on: Boolean, codeBox: Boolean, emailFirst: Boolean, frameDomain: String?, target: FillTarget, hits: Int): Row? {
        if (!on || frameDomain != null) return null
        if (target is FillTarget.App && (hits == 0 || !target.claimedDomain.isNullOrEmpty())) return null
        return if (codeBox) Row.CODE else if (emailFirst) Row.LINK else null
    }
}

/** An app's own WebView can show anyone's page. A login linked to the app isn't for that page
 *  unless it's saved for it, however much the app is trusted (AutoSpill). */
fun spillsTo(target: FillTarget.App, urls: List<LoginUrl>): Boolean {
    val claimed = target.claimedDomain?.takeIf { it.isNotEmpty() } ?: return false
    return urls.none { Match.matchUrl(it, "https://$claimed/") != null }
}

/** The answers from sites' asset links, kept sealed, since which sites you asked about says
 *  which accounts you have. A "yes" or "no" lasts a week; after a day it's asked again in the
 *  background. Past the week it's as if it was never asked, so a passkey needs the site to
 *  answer again. Only a 200 or a 404 changes it: an outage leaves what's known alone. */
class AssetLinkCache(private val now: () -> Long, private val load: () -> String?, private val save: (String) -> Unit) {
    private class Entry(val yes: Boolean, val at: Long)

    private var loaded = false
    private val entries = HashMap<String, Entry>()

    private fun key(pkg: String, cert: String, domain: String) = "$pkg|$cert|$domain"

    private fun ensure() {
        if (loaded) return
        loaded = true
        val o = runCatching { load()?.let { Json.parseToJsonElement(it) as JsonObject } }.getOrNull() ?: return
        for ((k, v) in o) {
            val s = (v as? JsonPrimitive)?.content ?: continue
            entries[k] = Entry(s.startsWith("1"), s.substringAfter('|').toLongOrNull() ?: continue)
        }
    }

    @Synchronized
    fun get(pkg: String, cert: String, domain: String): Boolean? {
        ensure()
        val e = entries[key(pkg, cert, domain)] ?: return null
        return if (now() - e.at > TTL_MS) null else e.yes
    }

    @Synchronized
    fun needsAsking(pkg: String, cert: String, domain: String): Boolean {
        ensure()
        val e = entries[key(pkg, cert, domain)] ?: return true
        return now() - e.at > REFRESH_MS
    }

    @Synchronized
    fun put(pkg: String, cert: String, domain: String, yes: Boolean) {
        ensure()
        entries[key(pkg, cert, domain)] = Entry(yes, now())
        save(JsonObject(entries.mapValues { (_, e) -> JsonPrimitive("${if (e.yes) 1 else 0}|${e.at}") }).toString())
    }

    /** Out of memory, for a locked vault. It reads back from the sealed copy when it's needed. */
    @Synchronized
    fun forgetMemory() {
        entries.clear()
        loaded = false
    }

    companion object {
        const val TTL_MS = 7L * 24 * 3600 * 1000
        const val REFRESH_MS = 24L * 3600 * 1000
    }
}

/** Digital Asset Links: does this site say this app may use its credentials? */
object AssetLinks {
    private const val RELATION = "delegate_permission/common.get_login_creds"
    private const val MAX_BYTES = 1024 * 1024

    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder().connectTimeout(4, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()
    }

    /** Pure: is (pkg, cert) named for the login relation? Certs are compared as b64u SHA-256. */
    fun allows(statements: String, pkg: String, cert: String): Boolean {
        val arr = runCatching { Json.parseToJsonElement(statements) as JsonArray }.getOrNull() ?: return false
        for (s in arr) {
            val o = s as? JsonObject ?: continue
            val relations = (o["relation"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: continue
            if (RELATION !in relations) continue
            val target = o["target"] as? JsonObject ?: continue
            if (target.str("namespace") != "android_app" || target.str("package_name") != pkg) continue
            val fps = (target["sha256_cert_fingerprints"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: continue
            for (fp in fps) {
                val b = runCatching { b64u(fromHex(fp.replace(":", "").lowercase())) }.getOrNull() ?: continue
                if (b == cert) return true
            }
        }
        return false
    }

    fun urlFor(domain: String): String = DebugHooks.assetLinksBase[domain]?.let { "$it/.well-known/assetlinks.json" } ?: "https://$domain/.well-known/assetlinks.json"

    /** What the site said: null if it didn't say anything we can go on. A 404 is an answer: the
     *  site has no such file, so it names nobody. */
    fun answer(status: Int, body: String?, pkg: String, cert: String): Boolean? = when (status) {
        200 -> body != null && allows(body, pkg, cert)
        404 -> false
        else -> null
    }

    private fun fetch(domain: String, pkg: String, cert: String): Boolean? = runCatching {
        http.newCall(Request.Builder().url(urlFor(domain)).header("Accept", "application/json").build()).execute().use { r ->
            if (r.code != 200) return@use answer(r.code, null, pkg, cert)
            val source = r.body.source()
            source.request(MAX_BYTES + 1L)
            if (source.buffer.size > MAX_BYTES) return@use null
            answer(200, source.buffer.readUtf8(), pkg, cert)
        }
    }.getOrNull()

    private const val SEALED = "dal_sealed"

    private val store: AssetLinkCache by lazy {
        val prefs = Pw.prefs.prefs
        AssetLinkCache(
            { System.currentTimeMillis() },
            {
                // What older builds left in the clear goes.
                val old = prefs.all.keys.filter { it.startsWith("dal|") }
                if (old.isNotEmpty()) prefs.edit().apply { old.forEach { remove(it) } }.apply()
                prefs.getString(SEALED, null)?.let { DeviceSeal.open(it) }?.let { String(it) }
            },
            { text -> runCatching { prefs.edit().putString(SEALED, DeviceSeal.seal(text.toByteArray())).apply() } },
        )
    }

    /** The cached answer: true, false, or null for "never asked or too old". */
    fun cached(pkg: String, cert: String, domain: String): Boolean? = store.get(pkg, cert, domain)

    /** Asks the site. Blocking; never on the autofill answer's path. Null if there's no answer
     *  from the site and none recent enough here, which a passkey treats as a no. */
    fun check(pkg: String, cert: String, domain: String): Boolean? {
        val yes = fetch(domain, pkg, cert) ?: return cached(pkg, cert, domain)
        store.put(pkg, cert, domain, yes)
        return yes
    }

    fun forgetMemory() = store.forgetMemory()

    /** Sites worth asking about for an app we don't recognise: its reversed package name,
     *  plus vault domains whose name appears in the package. Never more than five. */
    fun candidates(pkg: String, vaultDomains: Set<String>): List<String> {
        val parts = pkg.lowercase().split('.')
        val out = LinkedHashSet<String>()
        if (parts.size >= 2) Match.baseDomain("${parts[1]}.${parts[0]}")?.let { out += it }
        for (d in vaultDomains) {
            val name = d.substringBefore('.')
            if (name.length >= 4 && name in parts) out += d
        }
        return out.take(5)
    }

    fun refreshInBackground(pkg: String, cert: String, vaultDomains: Set<String>) {
        val todo = candidates(pkg, vaultDomains).filter { store.needsAsking(pkg, cert, it) }
        if (todo.isEmpty()) return
        Thread {
            for (d in todo) runCatching { check(pkg, cert, d) }
        }.apply {
            isDaemon = true
            start()
        }
    }
}
