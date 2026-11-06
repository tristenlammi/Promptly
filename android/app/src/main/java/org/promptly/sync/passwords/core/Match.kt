// Which saved logins belong to a page or an app (plan 6.2). Mirrors match.ts for the
// web rules, and adds the Android-only `androidapp://` entries: a package name plus its
// signing certificate, saved with match "never" so web clients ignore them.
package org.promptly.sync.passwords.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

object Match {
    /** OkHttp's bundled Public Suffix List includes the private section, like the
     *  web client's `allowPrivateDomains: true`. */
    @Volatile
    var baseDomainOf: (String) -> String? = { host ->
        "https://$host/".toHttpUrlOrNull()?.topPrivateDomain()?.lowercase()
    }

    fun baseDomain(host: String): String? = baseDomainOf(host)

    private val SCHEME = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://")

    fun hostOf(url: String): String? {
        if (url.isEmpty()) return null
        val withScheme = if (url.contains("://")) url else "https://$url"
        val swapped = if (withScheme.startsWith("http://", true) || withScheme.startsWith("https://", true)) withScheme else SCHEME.replace(withScheme, "https://")
        return swapped.toHttpUrlOrNull()?.host?.lowercase()?.takeIf { it.isNotEmpty() }
    }

    @Volatile
    private var groups: Map<String, Set<String>> = emptyMap()

    /** shared-credentials.json from Apple's list, the same file the web client reads. */
    fun loadSharedCredentials(text: String) {
        val out = HashMap<String, MutableSet<String>>()
        fun link(a: List<String>, b: List<String>) {
            for (x in a) {
                val set = out.getOrPut(x) { HashSet() }
                for (y in b) if (y != x) set += y
            }
        }
        fun strings(o: JsonObject, k: String) = (o[k] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }
        for (e in Json.parseToJsonElement(text) as JsonArray) {
            val g = e as? JsonObject ?: continue
            strings(g, "shared")?.let { link(it, it) }
            val from = strings(g, "from")
            val to = strings(g, "to")
            if (from != null && to != null) {
                link(from, to)
                if (g.bool("fromDomainsAreObsoleted") != true) link(to, from)
            }
        }
        groups = out
    }

    fun sharedWith(domain: String): Set<String> = groups[domain] ?: emptySet()

    private const val SAFE_REGEX_LEN = 200
    private val CATASTROPHIC = Regex("(\\([^)]*[+*][^)]*\\))[+*{]")

    private fun regexMatches(pattern: String, url: String): Boolean {
        if (pattern.length > SAFE_REGEX_LEN || CATASTROPHIC.containsMatchIn(pattern)) return false
        return runCatching { Regex(pattern).containsMatchIn(url) }.getOrDefault(false)
    }

    private fun defaultPort(u: HttpUrl) = HttpUrl.defaultPort(u.scheme)

    private fun normalize(u: String): String {
        val x = u.toHttpUrlOrNull() ?: return u
        val port = if (x.port == defaultPort(x)) "" else ":${x.port}"
        val path = x.encodedPath.removeSuffix("/")
        val q = x.encodedQuery?.let { "?$it" } ?: ""
        return "${x.scheme}://${x.host}$port$path$q"
    }

    private fun portsMatch(savedUrl: String, page: HttpUrl): Boolean {
        val u = (if (savedUrl.contains("://")) savedUrl else "https://$savedUrl").toHttpUrlOrNull() ?: return true
        // A saved port must match. No saved port means any standard one.
        if (u.port == defaultPort(u)) return true
        return u.port == page.port
    }

    enum class Kind(val rank: Int) { EXACT(0), HOST(1), REGEX(2), PREFIX(2), BASE(3), SHARED(4) }

    fun matchUrl(saved: LoginUrl, pageUrl: String): Kind? {
        val page = pageUrl.toHttpUrlOrNull() ?: return null
        if (page.username.isNotEmpty() || page.password.isNotEmpty()) return null
        val mode = saved.match ?: "base"
        when (mode) {
            "never" -> return null
            "regex" -> return if (regexMatches(saved.url, pageUrl)) Kind.REGEX else null
            "exact" -> return if (normalize(saved.url) == normalize(pageUrl)) Kind.EXACT else null
            "prefix" -> return if (pageUrl.startsWith(saved.url)) Kind.PREFIX else null
        }
        val savedHost = hostOf(saved.url) ?: return null
        val pageHost = page.host.lowercase()
        if (savedHost == pageHost) return if (portsMatch(saved.url, page)) Kind.HOST else null
        if (mode == "host") return null
        // IP addresses and single-label hosts only ever match exactly.
        val savedBase = baseDomain(savedHost) ?: return null
        val pageBase = baseDomain(pageHost) ?: return null
        if (savedBase == pageBase) return Kind.BASE
        if (pageBase in sharedWith(savedBase)) return Kind.SHARED
        return null
    }

    class Candidate(val item: Item, val kind: Kind, val downgrade: Boolean)

    /** Best matches first: exact host, then recently used. `downgrade` is a saved
     *  https login on an http page, which only fills after a confirmation. */
    fun matchItems(items: Collection<Item>, pageUrl: String, recent: Map<String, Long> = emptyMap()): List<Candidate> {
        val page = pageUrl.toHttpUrlOrNull() ?: return emptyList()
        val out = ArrayList<Candidate>()
        for (item in items) {
            if (item.deleted || item.body.archived || item.body.kind != "login") continue
            var best: Kind? = null
            var savedHttps = false
            for (u in item.body.urls) {
                val k = matchUrl(u, pageUrl) ?: continue
                if (best == null || k.rank < best.rank) {
                    best = k
                    savedHttps = u.url.startsWith("https://") || !u.url.contains("://")
                }
            }
            if (best != null) out += Candidate(item, best, page.scheme == "http" && savedHttps)
        }
        return out.sortedWith(
            compareBy<Candidate> { it.kind.rank }
                .thenByDescending { recent[it.item.id] ?: 0L }
                .thenBy { it.item.body.title },
        )
    }

    // ---- Android apps ----

    const val APP_SCHEME = "androidapp://"

    /** `androidapp://com.foo?cert=<b64u sha256>`. Saved with match "never": a package
     *  name is also a valid hostname, and a web client must not treat it as one. */
    fun appUrl(pkg: String, certSha256: String) = LoginUrl("$APP_SCHEME$pkg?cert=$certSha256", "never")

    data class AppRef(val pkg: String, val cert: String?)

    fun parseAppUrl(url: String): AppRef? {
        if (!url.startsWith(APP_SCHEME)) return null
        val rest = url.substring(APP_SCHEME.length)
        val q = rest.indexOf('?')
        val pkg = if (q < 0) rest else rest.substring(0, q)
        if (pkg.isEmpty()) return null
        return AppRef(pkg, if (q < 0) null else parseQuery(rest.substring(q + 1))["cert"])
    }
}
