// What an independent review proved could be done, as tests that the attack now fails. These need
// Android's Public Suffix List, so they run under Robolectric. HostileTest has the ones that need
// a lying server.
package org.promptly.sync.passwords

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.passwords.autofill.AssetLinkCache
import org.promptly.sync.passwords.autofill.AssetLinks
import org.promptly.sync.passwords.autofill.AutofillIndex
import org.promptly.sync.passwords.autofill.FieldNode
import org.promptly.sync.passwords.autofill.FillTarget
import org.promptly.sync.passwords.autofill.FormParser
import org.promptly.sync.passwords.autofill.IndexEntry
import org.promptly.sync.passwords.autofill.TrustedBrowsers
import org.promptly.sync.passwords.autofill.spillsTo
import org.promptly.sync.passwords.core.Exporter
import org.promptly.sync.passwords.core.Importers
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.newBody
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.InputStream

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReviewFixesTest {
    init {
        Fixtures.setup()
        okhttp3.OkHttp.initialize(androidx.test.core.app.ApplicationProvider.getApplicationContext())
    }

    private fun web(domain: String, scheme: String = "https") = FillTarget.Web(domain, scheme, "com.android.chrome")
    private fun hits(u: LoginUrl, target: FillTarget) = AutofillIndex.matches(listOf(IndexEntry("i", "login", "T", "u", listOf(u), false, false)), target, emptyMap()) { false }

    // ---- 2. Matching, from one list shared with match.ts ----

    @Test fun matchVectorsSharedWithTheWebClient() {
        val v = Json.parseToJsonElement(File(Fixtures.frontend.parentFile, "android/app/src/test/cross/match-vectors.json").readText()).jsonObject
        val match = v.getValue("match").jsonArray
        assertTrue(match.size >= 50)
        assertTrue(match.size >= 100)
        for (e in match) {
            val c = e.jsonObject
            val want = c["want"].takeIf { it !is JsonNull }?.jsonPrimitive?.content
            val saved = LoginUrl(c.getValue("url").jsonPrimitive.content, c["mode"]?.jsonPrimitive?.content)
            val page = c.getValue("page").jsonPrimitive.content
            val item = c["item"]?.jsonPrimitive?.content
            assertEquals("$saved ($item) on $page", want, Match.matchUrl(saved, page, item)?.name?.lowercase())
        }
        for (e in v.getValue("host").jsonArray) {
            val c = e.jsonObject
            assertEquals(c.toString(), c["want"].takeIf { it !is JsonNull }?.jsonPrimitive?.content, Match.hostOf(c.getValue("url").jsonPrimitive.content))
        }
    }

    @Test fun autofillOffersNothingOnAnAttackersDomain() {
        assertEquals(0, hits(LoginUrl("https://bank.example", "prefix"), web("bank.example.evil.test")).size)
        assertEquals(0, hits(LoginUrl("bank\\.example", "regex"), web("bank.example.evil.test")).size)
        assertEquals(1, hits(LoginUrl("https://bank.example", "prefix"), web("bank.example")).size)
    }

    @Test fun aPortIsHonouredWhenTheAskerGivesOne() {
        val saved = LoginUrl("https://bank.example")
        val onPort = web("bank.example:8443")
        assertEquals("bank.example", onPort.host)
        assertTrue(onPort.portKnown)
        // No saved port: its host on any port (D91), below an exact match.
        assertEquals(Match.Kind.ANYPORT, hits(saved, onPort).single().kind)
        assertEquals(Match.Kind.HOST, hits(LoginUrl("https://bank.example:8443"), onPort).single().kind)
        assertEquals(0, hits(LoginUrl("https://bank.example:9443"), onPort).size)
        assertEquals(0, hits(LoginUrl("https://bank.example", "port"), onPort).size)
        // Android's webDomain has no port. A login saved with one, for this very host, is still
        // offered, below one saved with none.
        assertFalse(web("bank.example").portKnown)
        assertEquals(Match.Kind.ANYPORT, hits(LoginUrl("https://bank.example:8443"), web("bank.example")).single().kind)
        assertEquals(Match.Kind.HOST, hits(saved, web("bank.example")).single().kind)
        assertEquals(0, hits(LoginUrl("https://app.bank.example:8443"), web("bank.example")).size)
        assertEquals(0, hits(LoginUrl("https://bank.example:8443", "port"), web("bank.example")).size)
    }

    @Test fun anAwkwardRegexCantStallAFill() {
        val long = "https://" + "a".repeat(34) + ".evil.test/"
        val started = System.currentTimeMillis()
        // Alternation under a quantifier is refused by shape.
        assertNull(Match.matchUrl(LoginUrl("^https://(a|aa)+$", "regex"), long))
        // One that gets past the shape check runs out of time instead.
        val slow = "https://" + "a".repeat(60) + ".evil.test/"
        assertNull(Match.matchUrl(LoginUrl("^https://" + "a*".repeat(24) + "!$", "regex"), slow))
        assertTrue("took ${System.currentTimeMillis() - started} ms", System.currentTimeMillis() - started < 2000)
        // And ordinary ones still work.
        assertEquals(Match.Kind.REGEX, Match.matchUrl(LoginUrl("^https://(www\\.)?bank\\.example/", "regex"), "https://www.bank.example/x"))
    }

    // ---- 3. An imported file can't plant anything ----

    private val PLANTED = """{"format":"promptly-pw-plain","version":1,"items":[
        {"v":1,"kind":"login","title":"Portal","username":"guest","password":"guest","seq":999,"conflicts":[{"at":"x","body":{}}],"pendingPassword":"p","sendId":"s","trustBook":{"contacts":["evil"]}},
        {"v":1,"kind":"trust","title":"trust-book","trustBook":{"people":{},"accepted":["v"],"contacts":["evil"],"generations":{}}},
        {"v":1,"kind":"prefs","title":"p"},
        {"v":1,"kind":"site_rule","title":"r"},
        {"v":1,"kind":"folder","title":"f"},
        {"v":1,"kind":"send","title":"s"},
        {"v":1,"kind":"something-new","title":"n"}
    ]}"""

    @Test fun anImportBringsOnlyWhatAPersonCouldMake() {
        val r = Importers.importFile("team.json", PLANTED.toByteArray())
        assertEquals(listOf("Portal"), r.items.map { it.body.title })
        val fields = r.items.single().body.fields.keys
        for (f in listOf("trustBook", "conflicts", "seq", "pendingPassword", "sendId")) assertFalse(f, f in fields)
        assertEquals(0L, r.items.single().body.seq)
        assertEquals("guest", r.items.single().body.password)
        assertTrue(r.warnings.single(), r.warnings.single().contains("6 entries"))
    }

    @Test fun theSameGoesForAnEncryptedFile() {
        val bad = listOf(newBody("trust", "trust-book").with("trustBook" to JsonObject(emptyMap())), newBody("login", "Fine").withText("password", "pw"))
        val file = Exporter.encrypted(bad.mapIndexed { i, b -> Item("i$i", "v", 1, false, "", b) }, "file-password-1")
        val r = Importers.importFile("x.json", file.toByteArray(), "file-password-1")
        assertEquals(listOf("Fine"), r.items.map { it.body.title })
    }

    // ---- 4. An app's id isn't a website ----

    @Test fun importedAppLoginsNeverMatchAWebsite() {
        val csv = "name,url,username,password\nAcme,android://H==@com.acme.app/,me,hunter2\n"
        val chrome = Importers.importFile("p.csv", csv.toByteArray()).items.single().body.urls.single()
        assertEquals(LoginUrl("androidapp://com.acme.app", "never"), chrome)
        assertEquals(0, hits(chrome, web("acme.app")).size)
        assertEquals(0, AutofillIndex.keysOf(listOf(chrome)).count { it.isNotEmpty() })

        val bw = """{"encrypted":false,"folders":[],"items":[{"type":1,"name":"B","login":{"username":"u","password":"p","uris":[{"uri":"androidapp://com.acme.app","match":null},{"uri":"https://acme.app","match":null}]}}]}"""
        val urls = Importers.importFile("b.json", bw.toByteArray()).items.single().body.urls
        assertEquals(LoginUrl("androidapp://com.acme.app", "never"), urls[0])
        assertEquals(LoginUrl("https://acme.app"), urls[1])

        val own = """{"format":"promptly-pw-plain","version":1,"items":[{"v":1,"kind":"login","title":"O","urls":[{"url":"android://x@com.acme.app"},{"url":"androidapp://com.acme.app?cert=ABC","match":"never"}]}]}"""
        val mine = Importers.importFile("o.json", own.toByteArray()).items.single().body.urls
        assertEquals("never", mine[0].match)
        assertEquals("androidapp://com.acme.app", mine[0].url)
        assertEquals(Match.AppRef("com.acme.app", "ABC"), Match.parseAppUrl(mine[1].url))
    }

    // ---- 5. AutoSpill ----

    @Test fun aLinkedAppsWebViewIsNotTheSite() {
        val linked = listOf(Match.appUrl("com.bank", "CERT"))
        assertTrue(spillsTo(FillTarget.App("com.bank", "CERT", "evil.test"), linked))
        assertFalse(spillsTo(FillTarget.App("com.bank", "CERT", null), linked))
        val both = linked + LoginUrl("https://bank.example")
        assertFalse(spillsTo(FillTarget.App("com.bank", "CERT", "bank.example"), both))
        assertTrue(spillsTo(FillTarget.App("com.bank", "CERT", "bank.example.evil.test"), both))
    }

    // ---- 7. Asset links ----

    private class Clock(var at: Long = 1_000_000L)

    @Test fun anAssetLinkYesExpires() {
        val clock = Clock()
        var saved: String? = null
        val c = AssetLinkCache({ clock.at }, { saved }, { saved = it })
        assertNull(c.get("p", "c", "d"))
        assertTrue(c.needsAsking("p", "c", "d"))
        c.put("p", "c", "d", true)
        assertEquals(true, c.get("p", "c", "d"))
        assertFalse(c.needsAsking("p", "c", "d"))
        clock.at += AssetLinkCache.REFRESH_MS + 1
        assertEquals("still usable, and asked again in the background", true, c.get("p", "c", "d"))
        assertTrue(c.needsAsking("p", "c", "d"))
        clock.at += AssetLinkCache.TTL_MS
        assertNull("too old to go on, which is a no for a passkey", c.get("p", "c", "d"))
        // It comes back from its store, with its age.
        c.put("p", "c", "d", false)
        val again = AssetLinkCache({ clock.at }, { saved }, { saved = it })
        assertEquals(false, again.get("p", "c", "d"))
        again.forgetMemory()
        assertEquals(false, again.get("p", "c", "d"))
    }

    @Test fun only200And404AreAnAnswer() {
        assertEquals(false, AssetLinks.answer(404, null, "p", "c"))
        assertEquals(false, AssetLinks.answer(200, "[]", "p", "c"))
        assertEquals(false, AssetLinks.answer(200, "not json", "p", "c"))
        for (status in listOf(301, 302, 403, 429, 500, 503)) assertNull("$status", AssetLinks.answer(status, null, "p", "c"))
    }

    // ---- 9. Fields you can't see ----

    private fun field(id: String, hint: String, left: Int? = 10, top: Int? = 10, alpha: Float = 1f, visible: Boolean = true, section: String? = null, focused: Boolean = false, attrs: Map<String, String> = emptyMap()) =
        FieldNode(id, hints = listOf(hint), left = left, top = top, windowWidth = 1000, windowHeight = 2000, alpha = alpha, visible = visible, section = section, focused = focused, htmlAttrs = attrs)

    @Test fun offScreenOrInvisibleFieldsGetNothing() {
        val form = FormParser.parse(
            listOf(
                field("u", "username", focused = true),
                field("p", "password", top = 200),
                field("left", "password", left = -9999),
                field("right", "password", left = 5000),
                field("above", "password", top = -9999),
                field("below", "password", top = 9000),
                field("clear", "password", alpha = 0f),
                field("hidden-parent", "password", visible = false),
            ),
        )
        assertEquals(listOf("u"), form.usernames)
        assertEquals(listOf("p"), form.passwords)
    }

    @Test fun aFieldScrolledOutOfSightStillCounts() {
        val form = FormParser.parse(listOf(field("u", "username", top = -300, focused = true), field("p", "password", top = 2300)))
        assertEquals(listOf("u"), form.usernames)
        assertEquals(listOf("p"), form.passwords)
    }

    @Test fun aCardOrIdentityFillsOnlyTheFocusedSection() {
        val form = FormParser.parse(
            listOf(
                field("n1", "cc-number", section = "w0/f0", focused = true),
                field("c1", "cc-csc", section = "w0/f0"),
                field("n2", "cc-number", section = "w0/f1"),
                field("x2", "cc-exp", section = "w0/f1"),
            ),
        )
        assertEquals(mapOf("number" to "n1", "cvv" to "c1"), form.cards.toMap())

        val auto = { v: String -> mapOf("autocomplete" to v) }
        val id = FormParser.parse(
            listOf(
                FieldNode("g1", htmlAttrs = auto("shipping given-name"), focused = true),
                FieldNode("f1", htmlAttrs = auto("shipping family-name")),
                FieldNode("g2", htmlAttrs = auto("billing given-name")),
                FieldNode("t2", htmlAttrs = auto("billing tel")),
            ),
        )
        assertEquals(mapOf("firstName" to "g1", "lastName" to "f1"), id.identity.toMap())
    }

    // ---- 14 ----

    @Test fun http() {
        val saved = LoginUrl("https://bank.example")
        assertFalse(hits(saved, web("bank.example")).single().downgrade)
        assertTrue(hits(saved, web("bank.example", "http")).single().downgrade)
        assertTrue("Nothing said it's https", hits(saved, FillTarget.Web("bank.example", "https", "x", schemeKnown = false)).single().downgrade)
    }

    @Test fun debugAndInternalBrowsersAreOffTheList() {
        val list = File(Fixtures.frontend.parentFile, "android/app/src/main/assets/passwords/privileged_apps.json").readText()
        val table = TrustedBrowsers.parse(list)
        assertTrue("com.android.chrome" in table)
        assertTrue("org.mozilla.firefox" in table)
        assertTrue(table.keys.none { Regex("debug|\\.local$|internal", RegexOption.IGNORE_CASE).containsMatchIn(it) })
        val json = TrustedBrowsers.releaseOnlyJson(list)
        assertFalse(json.contains("com.duckduckgo.mobile.android.debug"))
        assertFalse(json.contains("com.microsoft.emmx.local"))
    }

    @Test fun whatShipsAllowsNoCleartext() {
        val root = File(Fixtures.frontend.parentFile, "android/app/src")
        assertFalse(File(root, "main/res/xml/network_security_config.xml").readText().contains("cleartextTrafficPermitted=\"true\""))
        assertTrue(File(root, "debug/res/xml/network_security_config.xml").readText().contains("10.0.2.2"))
    }

    @Test fun readingAFileStopsAtTheLimit() {
        var served = 0L
        val endless = object : InputStream() {
            override fun read(): Int = 0
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                served += len
                return len
            }
        }
        assertThrows(IllegalArgumentException::class.java) { Importers.readLimited(endless) }
        assertTrue("read $served", served <= Importers.MAX_BYTES + 1024 * 1024)
        assertEquals(3, Importers.readLimited(byteArrayOf(1, 2, 3).inputStream()).size)
    }
}
