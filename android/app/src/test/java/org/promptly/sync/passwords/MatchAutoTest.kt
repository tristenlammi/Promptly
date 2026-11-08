package org.promptly.sync.passwords

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.passwords.autofill.AutofillIndex
import org.promptly.sync.passwords.autofill.FillTarget
import org.promptly.sync.passwords.autofill.IndexEntry
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.newBody
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.File

/** Auto matching, the item's match setting and ports (DECISIONS.md D-MATCH-1 to D-MATCH-5),
 *  from the same vectors match.test.ts reads, through Match.kt and through the autofill index. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MatchAutoTest {
    init {
        Fixtures.setup()
        okhttp3.OkHttp.initialize(androidx.test.core.app.ApplicationProvider.getApplicationContext())
    }

    private fun login(id: String, vararg urls: LoginUrl, match: String? = null, deleted: Boolean = false) =
        Item(id, "v", 1, deleted, "", newBody("login", id).withText("username", "u").withText("password", "p").withUrls(urls.toList()).with("match" to match?.let { JsonPrimitive(it) }))

    private fun offered(items: List<Item>, page: String) = Match.matchItems(items, page).map { listOf(it.item.id, it.kind.name.lowercase()) }

    private fun entryOf(i: Item) = AutofillIndex.entryOf(i, true)!!

    /** As a browser that gives the port would ask: the page's host and port, always written out
     *  so a default port is known too, and no path. */
    private fun webOf(page: String): FillTarget.Web {
        val u = page.toHttpUrlOrNull()!!
        val host = if (':' in u.host) "[${u.host}]" else u.host
        return FillTarget.Web("$host:${u.port}", u.scheme, "com.android.chrome")
    }

    @Test fun vaultVectorsSharedWithTheWebClient() {
        val v = Json.parseToJsonElement(File(Fixtures.frontend.parentFile, "android/app/src/test/cross/match-vectors.json").readText()).jsonObject
        val list = v.getValue("items").jsonArray
        assertTrue(list.size >= 25)
        for (e in list) {
            val c = e.jsonObject
            val vault = c.getValue("vault").jsonArray.map { x ->
                val o = x.jsonObject
                val urls = o.getValue("urls").jsonArray.map { u -> LoginUrl(u.jsonObject.getValue("url").jsonPrimitive.content, u.jsonObject["match"]?.jsonPrimitive?.content) }
                login(o.getValue("id").jsonPrimitive.content, *urls.toTypedArray(), match = o["match"]?.jsonPrimitive?.content, deleted = o["deleted"]?.jsonPrimitive?.booleanOrNull == true)
            }
            val page = c.getValue("page").jsonPrimitive.content
            val want = c.getValue("want").jsonArray.map { p -> p.jsonArray.map { it.jsonPrimitive.content } }
            assertEquals("vault on $page", want, offered(vault, page))
            // The autofill index finds the same, in the same order, when the browser gives the port.
            val hits = AutofillIndex.matches(vault.mapNotNull { AutofillIndex.entryOf(it, true) }, webOf(page), emptyMap()) { false }
            assertEquals("index on $page", want, hits.map { listOf(it.entry.itemId, it.kind!!.name.lowercase()) })
        }
    }

    @Test fun theOwnersTwoServices() {
        val zyx = login("zyx", LoginUrl("https://zyx.gymserver.org"))
        val abc = login("abc", LoginUrl("https://abc.gymserver.org"))
        val onZyx = Match.matchItems(listOf(zyx, abc), "https://zyx.gymserver.org/login")
        assertEquals(listOf("zyx"), Match.offered(onZyx).map { it.item.id })
        // With nothing for the page's own host, the others are what's offered, and they're named.
        val onApex = Match.matchItems(listOf(zyx, abc), "https://gymserver.org/")
        assertEquals(listOf("abc", "zyx"), Match.offered(onApex).map { it.item.id })
        assertTrue(onApex.none { Match.isPrimary(it.kind) })
        assertEquals("gymserver.org", Match.siteName("zyx.gymserver.org"))
        assertEquals("192.168.1.10", Match.siteName("192.168.1.10"))
    }

    @Test fun androidWithNoPortStillFindsASelfHostedLogin() {
        val dsm = login("dsm", LoginUrl("https://nas.home:5001"))
        val router = login("router", LoginUrl("https://nas.home"))
        val files = login("files", LoginUrl("https://files.nas.home:5001"))
        // webDomain "nas.home", with no port: the port could be any.
        val hits = AutofillIndex.matches(listOf(dsm, router, files).map { entryOf(it) }, FillTarget.Web("nas.home", "https", "com.android.chrome"), emptyMap()) { false }
        assertEquals(listOf("router" to Match.Kind.HOST, "dsm" to Match.Kind.ANYPORT), hits.map { it.entry.itemId to it.kind })
        // Given the port, only that port's.
        val known = AutofillIndex.matches(listOf(dsm, router, files).map { entryOf(it) }, FillTarget.Web("nas.home:5001", "https", "com.android.chrome"), emptyMap()) { false }
        assertEquals(listOf("dsm" to Match.Kind.HOST, "files" to Match.Kind.SIBLING, "router" to Match.Kind.SIBLING), known.map { it.entry.itemId to it.kind })
        assertEquals(listOf("dsm"), AutofillIndex.offered(known).map { it.entry.itemId })
    }

    @Test fun anIpNeverMatchesAnother() {
        val ip = login("ip", LoginUrl("http://192.168.1.10"))
        for (domain in listOf("192.168.1.11", "192.168.1.100", "192.168.1.1:8080", "192.168.1.10.evil.test")) {
            assertTrue(domain, AutofillIndex.matches(listOf(entryOf(ip)), FillTarget.Web(domain, "http", "b"), emptyMap()) { false }.isEmpty())
        }
        assertEquals(Match.Kind.ANYPORT, AutofillIndex.matches(listOf(entryOf(ip)), FillTarget.Web("192.168.1.10:8443", "https", "b"), emptyMap()) { false }.single().kind)
    }

    @Test fun theItemsSettingIsKeptInTheIndex() {
        val never = login("n", LoginUrl("https://zyx.gymserver.org"), match = "never")
        val prefix = login("p", LoginUrl("https://zyx.gymserver.org/app"), match = "prefix")
        val e = entryOf(never)
        assertEquals("never", e.match)
        assertEquals(listOf(""), e.keys)
        assertEquals(listOf("*"), entryOf(prefix).keys)
        // An address's own setting beats the item's.
        assertEquals(listOf("gymserver.org"), entryOf(login("o", LoginUrl("https://zyx.gymserver.org", "host"), match = "never")).keys)
        val back = AutofillIndex.decode(AutofillIndex.encode(listOf(e, entryOf(prefix))))
        assertEquals(listOf("never", "prefix"), back.map { it.match })
        assertTrue(AutofillIndex.matches(back, FillTarget.Web("zyx.gymserver.org", "https", "b"), emptyMap()) { false }.isEmpty())
        // An index written before this setting existed reads as Auto.
        val old = AutofillIndex.decode("""[{"i":"x","k":"login","r":false,"o":false,"l":[{"url":"https://zyx.gymserver.org"}],"b":["gymserver.org"]}]""")
        assertEquals(null, old.single().match)
        assertEquals(1, AutofillIndex.matches(old, FillTarget.Web("zyx.gymserver.org", "https", "b"), emptyMap()) { false }.size)
    }

    @Test fun modesAndNames() {
        assertEquals("auto", Match.modeOf(LoginUrl("x")))
        assertEquals("host", Match.modeOf(LoginUrl("x"), "host"))
        assertEquals("base", Match.modeOf(LoginUrl("x", "base"), "host"))
        assertEquals("port", Match.modeOf(LoginUrl("x", "later")))
        assertEquals(listOf("auto", "base", "host", "port", "prefix", "never"), Match.ITEM_MATCHES.map { it.first })
        assertEquals(listOf("Auto", "Same domain", "Exact host", "Exact host and port", "Starts with", "Never"), Match.ITEM_MATCHES.map { it.second })
        assertEquals(null to "As the login", Match.URL_MATCHES.first())
        assertEquals("example.com", Match.hostKey("www.example.com"))
        assertEquals("www.github.io", Match.hostKey("www.github.io"))
        assertEquals(Match.PageContext(true, 2), Match.pageContext(listOf("https://zyx.gymserver.org" to "auto", "https://abc.gymserver.org" to "auto"), "https://zyx.gymserver.org/"))
        assertEquals(Match.PageContext(false, 0), Match.pageContext(listOf("https://zyx.gymserver.org" to "never"), "https://zyx.gymserver.org/"))
        assertFalse(Match.isExactKind(Match.Kind.ANYPORT))
        assertTrue(Match.isExactKind(Match.Kind.HOST))
    }

    @Test fun anOldIndexEntryWithoutTheSettingStillBuilds() {
        val e = IndexEntry("x", "login", "T", "u", listOf(LoginUrl("https://a.example")), false, false)
        assertEquals(null, e.match)
        assertEquals(listOf("a.example"), e.keys)
    }
}
