// What autofill can answer from with the vault locked and no network: for each login,
// card and identity, an id, a label and its match rules. Never a secret. Sealed under the
// Keystore key that only works while the phone itself is unlocked. Rebuilt whenever the
// vault changes while unlocked. See passwords/ANDROID_NOTES.md for why this exists.
package org.promptly.sync.passwords.autofill

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.promptly.sync.passwords.DeviceSeal
import org.promptly.sync.passwords.Pw
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.bool
import org.promptly.sync.passwords.core.str
import java.io.File

data class IndexEntry(
    val itemId: String,
    val kind: String,
    val title: String?,
    val username: String?,
    val urls: List<LoginUrl>,
    val reprompt: Boolean,
    val hasTotp: Boolean,
    /** Per URL, where a lookup finds it: base domain, "*" for pattern modes, "" for none. */
    val keys: List<String> = AutofillIndex.keysOf(urls),
)

/** The index arranged for a fill request: a hash lookup, so its cost doesn't grow with the
 *  vault. Only the few logins that could match go through the full matching rules. */
class IndexLookup(val entries: List<IndexEntry>) {
    val byKey = HashMap<String, MutableList<IndexEntry>>()
    val patterned = ArrayList<IndexEntry>()
    val byApp = HashMap<String, MutableList<IndexEntry>>()

    /** Every site with a login here, for the lookalike check. Mostly the keys above, which are base
     *  domains already, so a request on a site with no login doesn't parse the whole vault. An IP or
     *  a single name has no base domain, and is left out by its shape. */
    val savedDomains: Set<String> by lazy {
        val out = HashSet<String>()
        for (k in byKey.keys) if ('.' in k && ':' !in k && !k.last().isDigit()) out += k
        for (e in entries) {
            for ((i, u) in e.urls.withIndex()) {
                val k = e.keys.getOrElse(i) { "" }
                if (k == "*" || (k == "" && !u.url.startsWith(Match.APP_SCHEME))) out += Match.savedDomainsOf(listOf(u))
            }
        }
        out
    }

    init {
        for (e in entries) {
            if (e.kind != "login") continue
            for ((i, u) in e.urls.withIndex()) {
                when (val k = e.keys.getOrElse(i) { "" }) {
                    "" -> Match.parseAppUrl(u.url)?.let { byApp.getOrPut(it.pkg) { ArrayList() } += e }
                    "*" -> patterned += e
                    else -> byKey.getOrPut(k) { ArrayList() } += e
                }
            }
        }
    }
}

object AutofillIndex {
    private const val FILE = "pw_autofill_index"

    @Volatile
    private var memory: IndexLookup? = null

    private val worker: Handler by lazy { Handler(HandlerThread("pw-index").apply { start() }.looper) }
    private val task = Runnable { runCatching { writeNow() } }

    @Volatile
    private var pendingContext: Context? = null

    @Volatile
    private var pendingClient: VaultClient? = null

    fun entryOf(i: Item, withNames: Boolean): IndexEntry? {
        val b = i.body
        if (i.deleted || b.archived) return null
        if (b.kind != "login" && b.kind != "card" && b.kind != "identity") return null
        return IndexEntry(
            i.id, b.kind,
            if (withNames) b.title else null,
            if (withNames) b.username ?: b.str("email") else null,
            b.urls, b.reprompt, b.totp != null,
        )
    }

    private val keyCache = java.util.concurrent.ConcurrentHashMap<String, String>()

    private fun keyOf(u: LoginUrl): String = when {
        u.url.startsWith(Match.APP_SCHEME) || u.match == "never" -> ""
        u.match == "regex" || u.match == "exact" || u.match == "prefix" -> "*"
        else -> keyCache.getOrPut(u.url) { Match.hostOf(u.url)?.let { Match.baseDomain(it) ?: it } ?: "" }
    }

    fun keysOf(urls: List<LoginUrl>): List<String> = urls.map { keyOf(it) }

    /** Debounced: a sync can change a thousand items at once. */
    fun rebuild(context: Context, client: VaultClient) {
        pendingContext = context.applicationContext
        pendingClient = client
        worker.removeCallbacks(task)
        worker.postDelayed(task, 300)
    }

    /** Writes right away, for tests that need the index before the debounce. */
    fun rebuildNow(context: Context, client: VaultClient) {
        pendingContext = context.applicationContext
        pendingClient = client
        writeNow()
    }

    /** One at a time: an older snapshot must never land after a newer one. */
    @Synchronized
    private fun writeNow() {
        val ctx = pendingContext ?: return
        val c = pendingClient ?: return
        if (!c.unlocked) return
        val withNames = Pw.prefs.namesWhileLocked
        val list = c.allItems().mapNotNull { entryOf(it, withNames) }
        memory = IndexLookup(list)
        File(ctx.filesDir, FILE).writeText(DeviceSeal.seal(encode(list).toByteArray()))
    }

    fun encode(list: List<IndexEntry>): String = buildJsonArray {
        for (e in list) add(buildJsonObject {
            put("i", e.itemId)
            put("k", e.kind)
            if (e.title != null) put("t", e.title)
            if (e.username != null) put("u", e.username)
            put("r", e.reprompt)
            put("o", e.hasTotp)
            put("l", JsonArray(e.urls.map { it.toJson() }))
            put("b", JsonArray(e.keys.map { kotlinx.serialization.json.JsonPrimitive(it) }))
        })
    }.toString()

    fun decode(text: String): List<IndexEntry> = (Json.parseToJsonElement(text) as JsonArray).mapNotNull { e ->
        val o = e as? JsonObject ?: return@mapNotNull null
        IndexEntry(
            o.str("i") ?: return@mapNotNull null, o.str("k") ?: "login", o.str("t"), o.str("u"),
            (o["l"] as? JsonArray)?.mapNotNull { u -> (u as? JsonObject)?.let { x -> x.str("url")?.let { LoginUrl(it, x.str("match")) } } } ?: emptyList(),
            o.bool("r") ?: false, o.bool("o") ?: false,
            (o["b"] as? JsonArray)?.map { (it as kotlinx.serialization.json.JsonPrimitive).content } ?: emptyList(),
        )
    }

    fun lookup(context: Context): IndexLookup {
        memory?.let { return it }
        val f = File(context.filesDir, FILE)
        val empty = IndexLookup(emptyList())
        if (!f.exists()) return empty
        val plain = DeviceSeal.open(f.readText()) ?: return empty
        // Read fresh for each request while the vault's locked: nothing stays in memory then.
        return runCatching { IndexLookup(decode(String(plain))) }.getOrDefault(empty).also { if (Pw.unlocked) memory = it }
    }

    /** The vault locked: the names and addresses in here shouldn't outlive that. */
    fun forgetMemory() {
        memory = null
        keyCache.clear()
    }

    @Synchronized
    fun clear(context: Context) {
        worker.removeCallbacks(task)
        memory = null
        File(context.filesDir, FILE).delete()
    }

    /** All the sites in the index, for the Digital Asset Links candidates. */
    fun vaultDomains(lookup: IndexLookup): Set<String> = lookup.byKey.keys

    class Hit(val entry: IndexEntry, val rank: Int, val downgrade: Boolean)

    /** The saved site this page only looks like, if any. A page that a login is really saved for
     *  isn't a lookalike, as in the extension. For an app the domain is only its claim, and a linked
     *  app's own hits are for the app, not for whatever page it's showing, so they don't clear it. */
    fun lookalikeFor(lookup: IndexLookup, target: FillTarget, hits: List<Hit>): String? = when (target) {
        is FillTarget.Web -> if (hits.isEmpty()) Match.lookalikeAmong(target.host, lookup.savedDomains) else null
        is FillTarget.App -> target.claimedDomain?.takeIf { it.isNotEmpty() }?.substringBefore(':')?.let { host ->
            if (hits.any { !spillsTo(target, it.entry.urls) }) null else Match.lookalikeAmong(host, lookup.savedDomains)
        }
    }

    /** Sites saved in the vault as it is now, for a screen that has it open. */
    fun savedDomainsOf(items: Collection<Item>): Set<String> = IndexLookup(items.mapNotNull { entryOf(it, false) }).savedDomains

    /** Logins for this page or app, best first. Pure: the tests call it directly.
     *  `linked` says whether a site's asset links name this app (cached, no network). */
    fun matches(lookup: IndexLookup, target: FillTarget, recents: Map<String, Long>, linked: (String) -> Boolean): List<Hit> {
        val hits = ArrayList<Hit>()
        when (target) {
            is FillTarget.Web -> {
                val host = target.host.lowercase()
                val base = Match.baseDomain(host)
                val keys = LinkedHashSet<String>()
                keys += host
                if (base != null) {
                    keys += base
                    keys += Match.sharedWith(base)
                }
                val candidates = LinkedHashSet<IndexEntry>()
                for (k in keys) lookup.byKey[k]?.let { candidates += it }
                candidates += lookup.patterned
                for (e in candidates) {
                    var best: Match.Kind? = null
                    var savedHttps = false
                    for (u in e.urls) {
                        val k = Match.matchUrl(u, target.url) ?: continue
                        if (best == null || k.rank < best.rank) {
                            best = k
                            savedHttps = u.url.startsWith("https://") || !u.url.contains("://")
                        }
                    }
                    if (best != null) hits += Hit(e, best.rank, !target.schemeKnown || (target.scheme == "http" && savedHttps))
                }
            }
            is FillTarget.App -> {
                val cert = target.cert
                val seen = HashSet<String>()
                for (e in lookup.byApp[target.pkg] ?: emptyList<IndexEntry>()) {
                    val explicit = e.urls.any { u ->
                        val a = Match.parseAppUrl(u.url)
                        a != null && a.pkg == target.pkg && a.cert != null && a.cert == cert
                    }
                    if (explicit && seen.add(e.itemId)) hits += Hit(e, 0, false)
                }
                if (cert != null) {
                    for ((key, list) in lookup.byKey) {
                        if (!linked(key)) continue
                        for (e in list) if (seen.add(e.itemId)) hits += Hit(e, 1, false)
                    }
                }
            }
        }
        return hits.sortedWith(compareBy<Hit> { it.rank }.thenByDescending { recents[it.entry.itemId] ?: 0L }.thenBy { it.entry.title ?: "" })
    }

    fun matches(entries: List<IndexEntry>, target: FillTarget, recents: Map<String, Long>, linked: (String) -> Boolean): List<Hit> =
        matches(IndexLookup(entries), target, recents, linked)
}
