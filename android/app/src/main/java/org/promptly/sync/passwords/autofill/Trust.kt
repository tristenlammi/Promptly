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
import okhttp3.OkHttpClient
import okhttp3.Request
import org.promptly.sync.passwords.DebugHooks
import org.promptly.sync.passwords.Pw
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.b64u
import org.promptly.sync.passwords.core.fromHex
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
        rawRelease ?: releaseOnlyJson(load(context)).also { rawRelease = it }
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
    data class Web(val domain: String, val scheme: String, val pkg: String) : FillTarget() {
        val url: String get() = "$scheme://$domain/"
    }

    data class App(val pkg: String, val cert: String?, val claimedDomain: String?) : FillTarget()
}

/** Digital Asset Links: does this site say this app may use its credentials? */
object AssetLinks {
    private const val RELATION = "delegate_permission/common.get_login_creds"
    private const val MAX_BYTES = 1024 * 1024
    private const val TTL_MS = 7L * 24 * 3600 * 1000

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

    private fun fetch(domain: String): String? = runCatching {
        http.newCall(Request.Builder().url(urlFor(domain)).header("Accept", "application/json").build()).execute().use { r ->
            if (!r.isSuccessful) return null
            val source = r.body.source()
            source.request(MAX_BYTES + 1L)
            if (source.buffer.size > MAX_BYTES) return null
            source.buffer.readUtf8()
        }
    }.getOrNull()

    private fun key(pkg: String, cert: String, domain: String) = "dal|$pkg|$cert|$domain"

    /** The cached answer: true, false, or null for "never asked or too old". */
    fun cached(pkg: String, cert: String, domain: String): Boolean? {
        val v = Pw.prefs.prefs.getString(key(pkg, cert, domain), null) ?: return null
        val at = v.substringAfter('|').toLongOrNull() ?: return null
        val yes = v.startsWith("1")
        // A "yes" stays until it's checked again; a "no" is asked again after a week.
        if (!yes && System.currentTimeMillis() - at > TTL_MS) return null
        return yes
    }

    /** Asks the site. Blocking; never on the autofill answer's path. Null if unreachable. */
    fun check(pkg: String, cert: String, domain: String): Boolean? {
        val text = fetch(domain) ?: return cached(pkg, cert, domain)
        val yes = allows(text, pkg, cert)
        Pw.prefs.prefs.edit().putString(key(pkg, cert, domain), "${if (yes) 1 else 0}|${System.currentTimeMillis()}").apply()
        return yes
    }

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
        val todo = candidates(pkg, vaultDomains).filter { cached(pkg, cert, it) == null }
        if (todo.isEmpty()) return
        Thread {
            for (d in todo) runCatching { check(pkg, cert, d) }
        }.apply {
            isDaemon = true
            start()
        }
    }
}
