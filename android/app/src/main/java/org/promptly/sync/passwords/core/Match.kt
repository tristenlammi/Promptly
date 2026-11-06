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

    /** A saved address, read as the web would. Anything with another scheme (`android://`,
     *  `androidapp://`, `ftp://`) isn't a website, even when its package looks like a hostname. */
    private fun parseSaved(url: String): HttpUrl? {
        if (url.isEmpty()) return null
        val hasScheme = SCHEME.containsMatchIn(url)
        if (hasScheme && !url.startsWith("http://", true) && !url.startsWith("https://", true)) return null
        val u = (if (hasScheme) url else "https://$url").toHttpUrlOrNull() ?: return null
        return if (u.username.isNotEmpty() || u.password.isNotEmpty()) null else u
    }

    fun hostOf(url: String): String? = parseSaved(url)?.host?.lowercase()?.takeIf { it.isNotEmpty() }

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
    private const val SAFE_HREF_LEN = 2048
    private const val REGEX_MS = 250L
    private val CATASTROPHIC = Regex("(\\([^)]*[+*][^)]*\\))[+*{]")
    private val QUANTIFIED_CHOICE = Regex("\\([^)]*\\|[^)]*\\)[+*{]")

    private fun originOf(u: HttpUrl): String = u.newBuilder().encodedPath("/").query(null).fragment(null).build().toString().removeSuffix("/")

    /** A person's own regex, kept away from catastrophic patterns by shape and size, and given
     *  a time limit since Android's engine can't be stopped from inside. It has to match from
     *  the start of the address and take in the whole origin, so "example.com" can't match
     *  example.com.evil.test or evil.test/?example.com. */
    private fun regexMatches(pattern: String, page: HttpUrl): Boolean {
        if (pattern.length > SAFE_REGEX_LEN || CATASTROPHIC.containsMatchIn(pattern) || QUANTIFIED_CHOICE.containsMatchIn(pattern)) return false
        val href = page.toString()
        if (href.length > SAFE_HREF_LEN) return false
        val originLength = originOf(page).length
        val answer = java.util.concurrent.atomic.AtomicBoolean(false)
        val worker = Thread({
            val hit = runCatching {
                val m = Regex(pattern).find(href)
                m != null && m.range.first == 0 && m.value.length >= originLength
            }.getOrDefault(false)
            answer.set(hit)
        }, "pw-regex")
        worker.isDaemon = true
        worker.start()
        worker.join(REGEX_MS)
        return !worker.isAlive && answer.get()
    }

    /** Same origin first: a plain string prefix lets https://bank.example match
     *  https://bank.example.evil.test. */
    private fun prefixMatches(saved: String, page: HttpUrl): Boolean {
        val s = parseSaved(saved) ?: return false
        return originOf(s) == originOf(page) && page.toString().startsWith(s.toString())
    }

    private fun defaultPort(u: HttpUrl) = HttpUrl.defaultPort(u.scheme)

    /** Null for the scheme's default, as `URL.port` is empty for it in match.ts. */
    private fun portOf(u: HttpUrl): Int? = if (u.port == defaultPort(u)) null else u.port

    private fun normalize(u: String): String {
        val x = u.toHttpUrlOrNull() ?: return u
        val port = if (x.port == defaultPort(x)) "" else ":${x.port}"
        val path = x.encodedPath.removeSuffix("/")
        val q = x.encodedQuery?.let { "?$it" } ?: ""
        return "${x.scheme}://${x.host}$port$path$q"
    }

    /** The same port, and no saved port means the scheme's default: another port on the same
     *  host is often a different program. */
    private fun portsMatch(savedUrl: String, page: HttpUrl): Boolean {
        val u = parseSaved(savedUrl) ?: return true
        return portOf(u) == portOf(page)
    }

    enum class Kind(val rank: Int) { EXACT(0), HOST(1), REGEX(2), PREFIX(2), BASE(3), SHARED(4) }

    fun matchUrl(saved: LoginUrl, pageUrl: String): Kind? {
        val page = pageUrl.toHttpUrlOrNull() ?: return null
        if (page.username.isNotEmpty() || page.password.isNotEmpty()) return null
        val mode = saved.match ?: "base"
        when (mode) {
            "never" -> return null
            "regex" -> return if (regexMatches(saved.url, page)) Kind.REGEX else null
            "exact" -> return if (normalize(saved.url) == normalize(pageUrl)) Kind.EXACT else null
            "prefix" -> return if (prefixMatches(saved.url, page)) Kind.PREFIX else null
        }
        val savedHost = hostOf(saved.url) ?: return null
        val pageHost = page.host.lowercase()
        if (!portsMatch(saved.url, page)) return null
        if (savedHost == pageHost) return Kind.HOST
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

    // ---- Lookalike check (plan 5.13), the same rules as match.ts ----

    /** Common homoglyphs, to a plain latin skeleton. */
    private val CONFUSABLE = mapOf(
        'а' to 'a', 'е' to 'e', 'о' to 'o', 'р' to 'p', 'с' to 'c', 'у' to 'y', 'х' to 'x', 'і' to 'i', 'ј' to 'j', 'ѕ' to 's',
        'һ' to 'h', 'ԁ' to 'd', 'ɡ' to 'g', 'ո' to 'n', 'ν' to 'v', 'ο' to 'o', 'α' to 'a', 'ι' to 'i',
        '0' to 'o', '1' to 'l', '|' to 'l', '5' to 's', '3' to 'e', '7' to 't', '$' to 's',
    )
    private val COMBINING = Regex("[̀-ͯ]")
    private val SCAM_WORD = Regex("(^|[-.])(login|secure|account|verify|signin|auth|support|update)|(login|secure|account|verify|signin|auth|support|update)($|[-.])")

    fun skeleton(domain: String): String {
        // Plain ASCII has nothing to normalize, and that's nearly every saved site.
        val plain = if (domain.all { it.code < 128 }) domain.lowercase() else java.text.Normalizer.normalize(domain, java.text.Normalizer.Form.NFKD).lowercase().replace(COMBINING, "")
        val s = plain.replace("rn", "m").replace("vv", "w")
        val out = StringBuilder(s.length)
        for (c in s) out.append(CONFUSABLE[c] ?: c)
        return out.toString().replace('l', 'i')
    }

    /** Damerau-Levenshtein: a swap of two neighbours counts as one edit. */
    fun editDistance(a: String, b: String, cap: Int = 3): Int {
        if (kotlin.math.abs(a.length - b.length) > cap) return cap + 1
        val d = Array(a.length + 1) { IntArray(b.length + 1) }
        for (i in 0..a.length) d[i][0] = i
        for (j in 0..b.length) d[0][j] = j
        for (i in 1..a.length) {
            for (j in 1..b.length) {
                d[i][j] = minOf(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + if (a[i - 1] == b[j - 1]) 0 else 1)
                if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1]) d[i][j] = minOf(d[i][j], d[i - 2][j - 2] + 1)
            }
        }
        return d[a.length][b.length]
    }

    /** The site each saved address belongs to. An app's id isn't a website, so it isn't one. */
    fun savedDomainsOf(urls: Iterable<LoginUrl>): Set<String> {
        val out = LinkedHashSet<String>()
        for (u in urls) hostOf(u.url)?.let { baseDomain(it) }?.let { out += it }
        return out
    }

    /** The domain in your vault this page looks like but isn't, if any. */
    fun lookalikeOf(pageHost: String, savedDomains: Iterable<String>): String? {
        val known = LinkedHashSet<String>()
        for (d in savedDomains) baseDomain(d.lowercase())?.let { known += it }
        return lookalikeAmong(pageHost, known)
    }

    /** The same, for sites already worked down to their base domains: nothing's parsed per site,
     *  which on a big vault is most of the time. */
    fun lookalikeAmong(pageHost: String, known: Set<String>): String? {
        val host = pageHost.lowercase()
        val ascii = baseDomain(host) ?: return null
        if (ascii in known) return null
        for (k in known) if (ascii in sharedWith(k)) return null
        // A host that arrives written out in Unicode is compared as written: that's the point of
        // a homoglyph. Browsers mostly hand over the xn-- form, which is what isPuny is for.
        val page = if (host.all { it.code < 128 }) ascii else runCatching { java.net.IDN.toUnicode(ascii) }.getOrDefault(ascii)
        val isPuny = page.contains("xn--")
        val pageName = page.substringBefore('.')
        // Read as the letters it stands for, so the warning can name the site it's dressed as.
        val pageSkel = skeleton(if (isPuny) runCatching { java.net.IDN.toUnicode(pageName) }.getOrDefault(pageName) else pageName)
        for (k in known) {
            val name = k.substringBefore('.')
            if (name.length < 4) continue
            if (pageName == name) return k // same name, different suffix: paypal.co vs paypal.com
            if (skeleton(name) == pageSkel) return k
            val limit = if (name.length >= 8) 2 else 1
            if (kotlin.math.abs(pageName.length - name.length) <= limit && editDistance(pageName, name) <= limit) return k
            if (pageName.contains(name) && SCAM_WORD.containsMatchIn(pageName)) return k
        }
        // Punycode that's close to nothing here still gets the warning, as in match.ts.
        return if (isPuny) known.firstOrNull { it.substringBefore('.').length >= 4 } else null
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
