// Merge, matching, generator, passkey, TOTP-link, form-parser and updater logic, checked
// against the same expectations as the TypeScript suites (match.test.ts, tools.test.ts).
package org.promptly.sync.passwords

import com.sun.net.httpserver.HttpServer
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import org.bouncycastle.asn1.ASN1Integer
import org.bouncycastle.asn1.ASN1Sequence
import org.bouncycastle.crypto.ec.CustomNamedCurves
import org.bouncycastle.crypto.params.ECDomainParameters
import org.bouncycastle.crypto.params.ECPublicKeyParameters
import org.bouncycastle.crypto.signers.ECDSASigner
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.promptly.sync.UpdateHashMismatch
import org.promptly.sync.UpdateVerifier
import org.promptly.sync.passwords.autofill.AssetLinks
import org.promptly.sync.passwords.autofill.AutofillIndex
import org.promptly.sync.passwords.autofill.FieldNode
import org.promptly.sync.passwords.autofill.FillTarget
import org.promptly.sync.passwords.autofill.FormParser
import org.promptly.sync.passwords.autofill.IndexEntry
import org.promptly.sync.passwords.autofill.TrustedBrowsers
import org.promptly.sync.passwords.core.Generator
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.ItemBody
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.Passkeys
import org.promptly.sync.passwords.core.Primitives
import org.promptly.sync.passwords.core.Totp
import org.promptly.sync.passwords.core.b64u
import org.promptly.sync.passwords.core.concat
import org.promptly.sync.passwords.core.fromB64u
import org.promptly.sync.passwords.core.mergeBodies
import org.promptly.sync.passwords.core.newBody
import org.promptly.sync.passwords.core.parseKitQr
import org.promptly.sync.passwords.core.searchText
import org.promptly.sync.passwords.core.touch
import org.promptly.sync.passwords.core.utf8
import java.io.File
import java.math.BigInteger
import java.net.InetSocketAddress
import java.nio.file.Files
import java.security.MessageDigest

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CoreTest {
    init {
        Fixtures.setup()
        // OkHttp's Public Suffix List is an Android asset; the app gets this from androidx.startup.
        okhttp3.OkHttp.initialize(androidx.test.core.app.ApplicationProvider.getApplicationContext())
    }

    private fun login(id: String, vararg urls: LoginUrl) = Item(id, "v", 1, false, "", newBody("login", id).withText("username", "u").withText("password", "p").withUrls(urls.toList()))

    // ---- Matching: the cases in match.test.ts ----

    @Test fun matchByBaseDomainThroughPsl() {
        fun m(saved: String, page: String) = Match.matchUrl(LoginUrl(saved), page)
        assertEquals(Match.Kind.BASE, m("https://accounts.example.com/x", "https://www.example.com/login"))
        assertEquals(Match.Kind.HOST, m("https://example.com", "https://example.com/login"))
        assertEquals(Match.Kind.BASE, m("example.com", "https://shop.example.com"))
        assertEquals(Match.Kind.BASE, m("https://a.example.co.uk", "https://b.example.co.uk"))
        assertNull(m("https://alice.github.io", "https://bob.github.io"))
        assertNull(m("https://example.co.uk", "https://other.co.uk"))
        assertNull(m("https://a.herokuapp.com", "https://b.herokuapp.com"))
    }

    @Test fun matchPerUrlModes() {
        fun m(saved: String, mode: String, page: String) = Match.matchUrl(LoginUrl(saved, mode), page)
        assertNull(m("https://a.example.com", "host", "https://b.example.com"))
        assertEquals(Match.Kind.HOST, m("https://a.example.com", "host", "https://a.example.com/x"))
        assertEquals(Match.Kind.EXACT, m("https://a.example.com/login", "exact", "https://a.example.com/login/"))
        assertNull(m("https://a.example.com/login", "exact", "https://a.example.com/other"))
        assertEquals(Match.Kind.PREFIX, m("https://a.example.com/app", "prefix", "https://a.example.com/app/x"))
        assertEquals(Match.Kind.REGEX, m("^https://a\\.example\\.com/", "regex", "https://a.example.com/q"))
        assertNull(m("https://a.example.com", "never", "https://a.example.com"))
        assertNull(m("(", "regex", "https://x.example"))
        assertNull(m("(a+)+$", "regex", "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!"))
    }

    @Test fun originConfusionFailsSafe() {
        val saved = LoginUrl("https://bank.example.com")
        for (page in listOf(
            "https://bank.example.com.evil.test/",
            "https://evil.test/bank.example.com",
            "https://bank.example.com@evil.test/",
            "https://user:pw@bank.example.com/",
            "https://evil.test/?u=https://bank.example.com",
            "ftp://bank.example.com/",
            "file:///bank.example.com",
            "about:blank",
            "data:text/html,bank.example.com",
        )) assertNull(page, Match.matchUrl(saved, page))
        // IP addresses and single-label hosts only ever match exactly.
        assertEquals(Match.Kind.HOST, Match.matchUrl(LoginUrl("http://192.168.1.10"), "http://192.168.1.10/x"))
        assertNull(Match.matchUrl(LoginUrl("http://192.168.1.10"), "http://192.168.1.11/x"))
        assertNull(Match.matchUrl(LoginUrl("http://intranet"), "http://other/x"))
        // A saved port must match.
        assertNull(Match.matchUrl(LoginUrl("https://a.example.com:8443"), "https://a.example.com/"))
        assertEquals(Match.Kind.HOST, Match.matchUrl(LoginUrl("https://a.example.com:8443"), "https://a.example.com:8443/"))
    }

    @Test fun rankingAndHttpDowngrade() {
        val exact = login("host", LoginUrl("https://www.example.com"))
        val base = login("base", LoginUrl("https://example.com"))
        val out = Match.matchItems(listOf(base, exact), "https://www.example.com/x")
        assertEquals(listOf("host", "base"), out.map { it.item.id })
        val down = Match.matchItems(listOf(login("a", LoginUrl("https://example.com"))), "http://example.com/")
        assertTrue(down.single().downgrade)
        val up = Match.matchItems(listOf(login("a", LoginUrl("http://example.com"))), "http://example.com/")
        assertFalse(up.single().downgrade)
    }

    @Test fun sharedCredentialGroups() {
        assertTrue("audiojungle.net" in Match.sharedWith("3docean.net"))
        assertEquals(Match.Kind.SHARED, Match.matchUrl(LoginUrl("https://3docean.net"), "https://audiojungle.net/login"))
    }

    @Test fun appUrlsNeverMatchAWebPage() {
        val saved = Match.appUrl("com.example.app", "CERT")
        assertEquals("never", saved.match)
        assertNull(Match.matchUrl(saved, "https://com.example.app/"))
        assertEquals(Match.AppRef("com.example.app", "CERT"), Match.parseAppUrl(saved.url))
        assertNull(Match.parseAppUrl("https://x.example"))
    }

    // ---- The autofill index: who's believed ----

    private val entries = listOf(
        IndexEntry("web", "login", "Example", "ana", listOf(LoginUrl("https://example.com")), false, true),
        IndexEntry("app", "login", "App", "bo", listOf(Match.appUrl("com.good.app", "GOODCERT")), false, false),
        IndexEntry("linked", "login", "Linked", "cy", listOf(LoginUrl("https://linked.example")), false, false),
        IndexEntry("card", "card", "Card", null, emptyList(), false, false),
    )

    @Test fun webDomainMatchesOnlyForAWebTarget() {
        val web = AutofillIndex.matches(entries, FillTarget.Web("www.example.com", "https", "com.android.chrome"), emptyMap()) { false }
        assertEquals(listOf("web"), web.map { it.entry.itemId })
        // An unknown app claiming example.com in a WebView gets nothing for it.
        val app = AutofillIndex.matches(entries, FillTarget.App("com.evil", "EVILCERT", "www.example.com"), emptyMap()) { false }
        assertTrue(app.isEmpty())
    }

    @Test fun lookupFindsWhatAFullScanWould() {
        val list = listOf(
            IndexEntry("base", "login", "T", null, listOf(LoginUrl("https://a.example.co.uk")), false, false),
            IndexEntry("host", "login", "T", null, listOf(LoginUrl("https://www.host.example", "host")), false, false),
            IndexEntry("hostmiss", "login", "T", null, listOf(LoginUrl("https://www.host.example", "host")), false, false),
            IndexEntry("regex", "login", "T", null, listOf(LoginUrl("^https://re\\.example/", "regex")), false, false),
            IndexEntry("prefix", "login", "T", null, listOf(LoginUrl("https://pre.example/app", "prefix")), false, false),
            IndexEntry("exact", "login", "T", null, listOf(LoginUrl("https://ex.example/", "exact")), false, false),
            IndexEntry("never", "login", "T", null, listOf(LoginUrl("https://never.example", "never")), false, false),
            IndexEntry("shared", "login", "T", null, listOf(LoginUrl("https://3docean.net")), false, false),
            IndexEntry("ip", "login", "T", null, listOf(LoginUrl("http://192.168.1.10")), false, false),
            IndexEntry("single", "login", "T", null, listOf(LoginUrl("http://intranet")), false, false),
        )
        fun hit(domain: String, scheme: String = "https") = AutofillIndex.matches(list, FillTarget.Web(domain, scheme, "b"), emptyMap()) { false }.map { it.entry.itemId }.toSet()
        assertEquals(setOf("base"), hit("b.example.co.uk"))
        assertEquals(setOf("host", "hostmiss"), hit("www.host.example"))
        assertTrue(hit("other.host.example").isEmpty())
        assertEquals(setOf("shared"), hit("audiojungle.net"))
        assertTrue(hit("never.example").isEmpty())
        assertEquals(setOf("ip"), hit("192.168.1.10", "http"))
        assertEquals(setOf("single"), hit("intranet", "http"))
        assertEquals(setOf("exact"), hit("ex.example"))
        assertEquals(setOf("regex"), hit("re.example"))
        val round = AutofillIndex.decode(AutofillIndex.encode(list))
        assertEquals(list, round)
    }

    @Test fun appMatchNeedsPackageAndCertificate() {
        fun hit(pkg: String, cert: String?) = AutofillIndex.matches(entries, FillTarget.App(pkg, cert, null), emptyMap()) { false }.map { it.entry.itemId }
        assertEquals(listOf("app"), hit("com.good.app", "GOODCERT"))
        assertTrue(hit("com.good.app", "OTHERCERT").isEmpty())
        assertTrue(hit("com.good.app", null).isEmpty())
        assertTrue(hit("com.other", "GOODCERT").isEmpty())
    }

    @Test fun digitalAssetLinksLetAnAppUseASite() {
        val hits = AutofillIndex.matches(entries, FillTarget.App("com.linked", "C", null), emptyMap()) { it == "linked.example" }
        assertEquals(listOf("linked"), hits.map { it.entry.itemId })
    }

    @Test fun indexRoundTripsAndHoldsNoSecrets() {
        val item = Item("i", "v", 1, false, "", newBody("login", "T").withText("username", "u").withText("password", "hunter2-secret").withUrls(listOf(LoginUrl("https://a.example"))))
        val e = AutofillIndex.entryOf(item, true)!!
        val text = AutofillIndex.encode(listOf(e))
        assertFalse(text.contains("hunter2-secret"))
        assertEquals(e, AutofillIndex.decode(text).single())
        val anon = AutofillIndex.entryOf(item, false)!!
        assertNull(anon.title)
        assertNull(anon.username)
        assertNull(AutofillIndex.entryOf(Item("d", "v", 1, true, "", item.body), true))
    }

    @Test fun assetLinksStatementParsing() {
        val fp = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"
        val cert = b64u(org.promptly.sync.passwords.core.fromHex(fp.replace(":", "").lowercase()))
        val good = """[{"relation":["delegate_permission/common.get_login_creds"],"target":{"namespace":"android_app","package_name":"com.a","sha256_cert_fingerprints":["$fp"]}}]"""
        assertTrue(AssetLinks.allows(good, "com.a", cert))
        assertFalse(AssetLinks.allows(good, "com.b", cert))
        assertFalse(AssetLinks.allows(good, "com.a", "OTHER"))
        assertFalse(AssetLinks.allows(good.replace("get_login_creds", "handle_all_urls"), "com.a", cert))
        assertFalse(AssetLinks.allows("not json", "com.a", cert))
        assertFalse(AssetLinks.allows("""{"a":1}""", "com.a", cert))
    }

    @Test fun assetLinksCandidates() {
        val c = AssetLinks.candidates("com.paypal.android.p2pmobile", setOf("paypal.com", "example.com", "abc.io"))
        assertTrue(c.contains("paypal.com"))
        assertFalse(c.contains("example.com"))
        assertTrue(c.size <= 5)
    }

    @Test fun bundledAllowlistParses() {
        val text = File("src/main/assets/passwords/privileged_apps.json").readText()
        val t = TrustedBrowsers.parse(text)
        for (p in listOf("com.android.chrome", "org.mozilla.firefox", "com.microsoft.emmx", "com.sec.android.app.sbrowser", "com.brave.browser", "com.opera.browser")) {
            assertTrue(p, t[p]?.isNotEmpty() == true)
        }
        // Only release keys: Chrome's userdebug key must not be trusted.
        assertEquals(1, t["com.android.chrome"]!!.size)
        assertNull(t["com.google.android.apps.chrome"])
        val filtered = TrustedBrowsers.parse(TrustedBrowsers.releaseOnlyJson(text))
        assertEquals(t, filtered)
    }

    // ---- The form parser ----

    private fun field(id: String, vararg attrs: Pair<String, String>, hints: List<String> = emptyList(), inputType: Int = 0x1, idEntry: String? = null, hint: String? = null, domain: String? = null, focused: Boolean = false, visible: Boolean = true, w: Int = 100) =
        FieldNode(id, "android.widget.EditText", hints, if (attrs.isEmpty()) null else "input", attrs.toMap(), inputType, idEntry, hint, visible, focused, w, 40, domain, null)

    @Test fun parseNativeForm() {
        val f = FormParser.parse(listOf(field("u", idEntry = "username"), field("p", inputType = 0x81, idEntry = "pw"), field("s", idEntry = "search_box")))
        assertEquals(listOf("u"), f.usernames)
        assertEquals(listOf("p"), f.passwords)
    }

    @Test fun parseByHints() {
        val f = FormParser.parse(listOf(field("a", hints = listOf("emailAddress")), field("b", hints = listOf("password")), field("c", hints = listOf("one-time-code"))))
        assertEquals(listOf("a"), f.usernames)
        assertEquals(listOf("b"), f.passwords)
        assertEquals(listOf("c"), f.otps)
    }

    @Test fun parseHtmlForm() {
        val f = FormParser.parse(listOf(field("e", "type" to "email", "name" to "login"), field("p", "type" to "password", "name" to "pass", "autocomplete" to "current-password"), field("x", "type" to "hidden", "name" to "csrf")))
        assertEquals(listOf("e"), f.usernames)
        assertEquals(listOf("p"), f.passwords)
        assertFalse("x" in f.allIds)
    }

    @Test fun unnamedFieldBeforePasswordIsTheUsername() {
        val f = FormParser.parse(listOf(field("a"), field("b"), field("p", inputType = 0x81)))
        assertEquals(listOf("b"), f.usernames)
    }

    @Test fun hiddenAndOffscreenAreNeverFilled() {
        val f = FormParser.parse(listOf(field("u", idEntry = "user", visible = false), field("t", idEntry = "user2", w = 1), field("p", inputType = 0x81)))
        assertTrue(f.usernames.isEmpty())
        assertEquals(listOf("p"), f.passwords)
    }

    @Test fun onlyTheFocusedFrameIsFilled() {
        val f = FormParser.parse(listOf(
            field("top", "type" to "email", domain = "shop.example"),
            field("iu", "type" to "email", domain = "pay.other", focused = true),
            field("ip", "type" to "password", domain = "pay.other"),
        ))
        assertEquals("pay.other", f.webDomain)
        assertEquals("pay.other", f.frameDomain)
        assertEquals(listOf("iu"), f.usernames)
        assertEquals(listOf("ip"), f.passwords)
    }

    @Test fun cardsAndOtpSplitBoxes() {
        val f = FormParser.parse(listOf(
            field("n", hints = listOf("creditCardNumber")), field("c", hints = listOf("cc-csc")),
            field("m", "name" to "exp-month"), field("y", "name" to "exp-year"),
        ))
        assertEquals("n", f.cards["number"])
        assertEquals("c", f.cards["cvv"])
        assertEquals("m", f.cards["month"])
        assertEquals("y", f.cards["year"])
        val o = FormParser.parse((1..6).map { field("d$it", "autocomplete" to "one-time-code") })
        assertEquals(6, o.otps.size)
    }

    @Test fun signUpFormHasNewPasswords() {
        val f = FormParser.parse(listOf(field("u", idEntry = "email"), field("p1", inputType = 0x81, idEntry = "new_password"), field("p2", inputType = 0x81, idEntry = "confirm_password")))
        assertEquals(listOf("p1", "p2"), f.newPasswords)
        assertTrue(f.passwords.isEmpty())
    }

    // ---- Model ----

    @Test fun unknownFieldsSurviveAnEdit() {
        val future = ItemBody.parse("""{"v":1,"kind":"login","title":"T","futureThing":{"a":[1,2.5,"x",null]},"createdAt":"c","updatedAt":"u"}""")
        val edited = future.withText("title", "New").withText("username", "ana")
        val again = ItemBody.parse(edited.toJson())
        assertEquals(future["futureThing"], again["futureThing"])
        assertEquals("New", again.title)
    }

    @Test fun touchKeepsPasswordHistory() {
        val a = touch(null, newBody("login", "T").withText("password", "one"))
        assertNotNull(a.str("passwordChangedAt"))
        val b = touch(a, a.withText("password", "two"))
        assertEquals("one", b.passwordHistory.single().first)
        val c = touch(b, b.withText("notes", "x"))
        assertEquals(1, c.passwordHistory.size)
    }

    @Test fun searchNeverLooksAtSecrets() {
        val t = searchText(newBody("login", "Bank").withText("password", "hunter2").withText("username", "ana").withUrls(listOf(LoginUrl("https://b.example"))))
        assertTrue(t.contains("bank") && t.contains("ana") && t.contains("b.example"))
        assertFalse(t.contains("hunter2"))
    }

    @Test fun mergeKeepsWhatOnlyOneSideChanged() {
        val base = newBody("login", "T").withText("username", "ana").withText("password", "one").withText("notes", "n")
        val local = base.withText("notes", "local note")
        val server = base.withText("username", "ana2")
        val m = mergeBodies(base, local, server)
        assertFalse(m.conflicted)
        assertEquals("local note", m.body.notes)
        assertEquals("ana2", m.body.username)
        assertTrue(m.body.conflicts.isEmpty())
    }

    @Test fun mergeKeepsBothWhenBothChanged() {
        val base = newBody("login", "T").withText("password", "one")
        val local = base.withText("password", "local")
        val server = base.withText("password", "server")
        val m = mergeBodies(base, local, server)
        assertTrue(m.conflicted)
        assertEquals("server", m.body.password)
        assertEquals("local", (m.body.conflicts.single()["body"] as kotlinx.serialization.json.JsonObject).let { (it["password"] as JsonPrimitive).content })
    }

    @Test fun mergeDeletesWhatLocalDeleted() {
        val base = newBody("login", "T").withText("notes", "n")
        val m = mergeBodies(base, base.withText("notes", null), base)
        assertNull(m.body.notes)
    }

    @Test fun mergeWithNoBaseKeepsLocalAsConflict() {
        val m = mergeBodies(null, newBody("login", "L"), newBody("login", "S"))
        assertTrue(m.conflicted)
        assertEquals("S", m.body.title)
    }

    // ---- TOTP links ----

    @Test fun otpauthLinks() {
        val c = Totp.parseOtpauth("otpauth://totp/ACME%20Co:ana@example.com?secret=JBSWY3DPEHPK3PXP&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60")
        assertEquals("ACME Co", c.issuer)
        assertEquals("ana@example.com", c.label)
        assertEquals("SHA256", c.algorithm)
        assertEquals(8, c.digits)
        assertEquals(60, c.period)
        assertEquals(c, Totp.parseOtpauth(Totp.toOtpauth(c)))
        assertThrows(IllegalArgumentException::class.java) { Totp.parseOtpauth("otpauth://hotp/x?secret=JBSWY3DP") }
        assertThrows(IllegalArgumentException::class.java) { Totp.parseOtpauth("otpauth://totp/x") }
        assertThrows(IllegalArgumentException::class.java) { Totp.parseOtpauth("otpauth://totp/x?secret=JBSWY3DP&digits=9") }
        assertThrows(IllegalArgumentException::class.java) { Totp.parseOtpauth("https://example.com") }
    }

    @Test fun migrationQr() {
        // One TOTP entry, hand-encoded: secret "Hello", name "a:b", issuer "I", SHA1, 6 digits, TOTP.
        val entry = concat(
            byteArrayOf(0x0a, 5), utf8("Hello"), byteArrayOf(0x12, 3), utf8("a:b"), byteArrayOf(0x1a, 1), utf8("I"),
            byteArrayOf(0x20, 1, 0x28, 1, 0x30, 2),
        )
        val payload = concat(byteArrayOf(0x0a, entry.size.toByte()), entry)
        val data = java.util.Base64.getEncoder().encodeToString(payload)
        val m = Totp.parseMigration("otpauth-migration://offline?data=${java.net.URLEncoder.encode(data, "UTF-8")}")
        assertEquals(0, m.skipped)
        val c = m.codes.single()
        assertEquals("JBSWY3DP", c.secret)
        assertEquals("I", c.issuer)
        assertEquals("b", c.label)
    }

    @Test fun kitQr() {
        val k = parseKitQr("promptly-kit:1?server=https%3A%2F%2Fa.example&user=ana&sk=PWK1-AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD")!!
        assertEquals("https://a.example", k.serverUrl)
        assertEquals("ana", k.username)
        assertEquals("PWK1-AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD", k.secretKey)
        assertNull(parseKitQr("https://x"))
        assertNull(parseKitQr("promptly-kit:1?user=a"))
    }

    // ---- Generator ----

    @Test fun generatorsHonourTheirOptions() {
        repeat(50) {
            val p = Generator.password(Generator.PasswordOptions(24))
            assertEquals(24, p.length)
            assertTrue(p.any { it.isLowerCase() } && p.any { it.isUpperCase() } && p.any { it.isDigit() } && p.any { !it.isLetterOrDigit() })
            assertTrue(p.none { it in "O0oIl1|`'\"" })
        }
        assertTrue(Generator.pin(8).all { it.isDigit() })
        assertEquals(5, Generator.passphrase(5).split('-').size)
        assertThrows(IllegalArgumentException::class.java) { Generator.password(Generator.PasswordOptions(8, false, false, false, false)) }
    }

    @Test fun siteRules() {
        val r = Generator.parseRules("minlength: 8; maxlength: 12; required: lower; required: digit; allowed: [-_]; max-consecutive: 2;")
        assertEquals(8, r.minLength)
        assertEquals(12, r.maxLength)
        repeat(30) {
            val p = Generator.forRules(r)
            assertTrue(p.length in 8..12)
            assertTrue(p.any { it.isDigit() } && p.any { it.isLowerCase() })
        }
        assertNotNull(Generator.rulesForHost("www.apple.com"))
        assertNull(Generator.rulesForHost("no-such-site.invalid"))
    }

    // ---- Passkeys ----

    private fun verifyEs256(x: ByteArray, y: ByteArray, msg: ByteArray, der: ByteArray): Boolean {
        val curve = CustomNamedCurves.getByName("secp256r1")
        val q = curve.curve.createPoint(BigInteger(1, x), BigInteger(1, y))
        val s = ECDSASigner()
        s.init(false, ECPublicKeyParameters(q, ECDomainParameters(curve.curve, curve.g, curve.n, curve.h)))
        val seq = ASN1Sequence.getInstance(der)
        return s.verifySignature(MessageDigest.getInstance("SHA-256").digest(msg), (seq.getObjectAt(0) as ASN1Integer).value, (seq.getObjectAt(1) as ASN1Integer).value)
    }

    @Test fun assertionVerifies() {
        val made = Passkeys.makeCredential("example.com", "Example", b64u(utf8("uid")), "ana", "Ana", b64u(utf8("chal")), "android:apk-key-hash:AAAA", true, true)
        val (x, y) = Passkeys.publicOf(fromB64u(made.passkey.key))
        val spki = fromB64u(made.publicKey)
        assertEquals(91, spki.size)
        assertArrayEquals(x, spki.copyOfRange(27, 59))
        assertArrayEquals(y, spki.copyOfRange(59, 91))
        val a = Passkeys.getAssertion(made.passkey, b64u(utf8("c2")), "android:apk-key-hash:AAAA", true)
        val cd = fromB64u(a.clientDataJSON)
        val signed = concat(fromB64u(a.authenticatorData), Primitives.sha256(cd))
        assertTrue(verifyEs256(x, y, signed, fromB64u(a.signature)))
        // Flags: UP, UV, BE, BS. Counter 0, as multi-device keys report.
        val ad = fromB64u(a.authenticatorData)
        assertEquals(0x1d, ad[32].toInt() and 255)
        assertArrayEquals(Primitives.sha256(utf8("example.com")), ad.copyOfRange(0, 32))
        assertEquals("""{"type":"webauthn.get","challenge":"${b64u(utf8("c2"))}","origin":"android:apk-key-hash:AAAA","crossOrigin":false}""", String(cd))
    }

    @Test fun privilegedCallerHashIsWhatIsSigned() {
        val made = Passkeys.makeCredential("example.com", null, b64u(utf8("uid")), "ana", null, b64u(utf8("chal")), "https://example.com", true, true)
        val (x, y) = Passkeys.publicOf(fromB64u(made.passkey.key))
        val hash = Primitives.sha256(utf8("the browser's own client data"))
        val a = Passkeys.getAssertion(made.passkey, "x", "https://example.com", true, hash)
        assertTrue(verifyEs256(x, y, concat(fromB64u(a.authenticatorData), hash), fromB64u(a.signature)))
    }

    @Test fun passkeyJsonRoundTripsInTheWebShape() {
        val made = Passkeys.makeCredential("example.com", "Ex", b64u(utf8("u")), "ana", "A", b64u(utf8("c")), "https://example.com", true, true)
        val o = made.passkey.toJson()
        for (k in listOf("credentialId", "rpId", "userHandle", "userName", "key", "alg", "signCount", "createdAt", "discoverable")) assertNotNull(k, o[k])
        assertEquals(made.passkey, org.promptly.sync.passwords.core.Passkey.from(o))
        val reg = kotlinx.serialization.json.Json.parseToJsonElement(Passkeys.registrationJson(made, true)).jsonObject
        assertEquals("public-key", (reg["type"] as JsonPrimitive).content)
        assertEquals(made.credentialId, (reg["id"] as JsonPrimitive).content)
    }

    @Test fun passkeyRequestValidation() {
        val good = """{"rp":{"id":"example.com","name":"Ex"},"user":{"id":"dXNlcg","name":"ana","displayName":"Ana"},"challenge":"Y2hhbA","pubKeyCredParams":[{"type":"public-key","alg":-7}],"excludeCredentials":[{"id":"AAAA","type":"public-key"}],"authenticatorSelection":{"residentKey":"required"}}"""
        val c = Passkeys.parseCreate(good)
        assertEquals("example.com", c.rpId)
        assertEquals(listOf("AAAA"), c.excludeCredentials)
        assertTrue(c.discoverable)
        for (bad in listOf(
            "not json",
            good.replace("\"rp\":{\"id\":\"example.com\",\"name\":\"Ex\"},", ""),
            good.replace("\"id\":\"example.com\"", "\"id\":\"https://example.com/\""),
            good.replace("\"alg\":-7", "\"alg\":-257"),
            good.replace("\"challenge\":\"Y2hhbA\",", ""),
            good.replace("\"id\":\"dXNlcg\"", "\"id\":\"\""),
            good.replace("\"id\":\"dXNlcg\"", "\"id\":\"!!!\""),
            good.replace("\"id\":\"dXNlcg\"", "\"id\":\"${b64u(ByteArray(65))}\""),
        )) assertThrows(bad, Passkeys.BadRequest::class.java) { Passkeys.parseCreate(bad) }
        val g = Passkeys.parseGet("""{"rpId":"Example.com","challenge":"Y2hhbA","allowCredentials":[{"id":"AAAA","type":"public-key"}]}""")
        assertEquals("example.com", g.rpId)
        assertThrows(Passkeys.BadRequest::class.java) { Passkeys.parseGet("""{"challenge":"Y2hhbA"}""") }
        assertThrows(Passkeys.BadRequest::class.java) { Passkeys.parseGet("""{"rpId":"a.b"}""") }
    }

    @Test fun rpIdRules() {
        assertTrue(Passkeys.rpIdAllowed("example.com", "https://login.example.com"))
        assertTrue(Passkeys.rpIdAllowed("login.example.com", "https://login.example.com"))
        assertFalse(Passkeys.rpIdAllowed("com", "https://login.example.com"))
        assertFalse(Passkeys.rpIdAllowed("evil.com", "https://login.example.com"))
        assertFalse(Passkeys.rpIdAllowed("example.com", "http://example.com"))
        assertTrue(Passkeys.rpIdAllowed("localhost", "http://localhost:8000"))
        assertFalse(Passkeys.rpIdAllowed("github.io", "https://alice.github.io"))
    }

    @Test fun usablePasskeysFollowTheAllowList() {
        val made = Passkeys.makeCredential("example.com", null, b64u(utf8("u")), "ana", null, "Yw", "https://example.com", true, true).passkey
        val hidden = Passkeys.makeCredential("example.com", null, b64u(utf8("u")), "bo", null, "Yw", "https://example.com", true, false).passkey
        val all = listOf(Passkeys.Usable("1", made, "T"), Passkeys.Usable("2", hidden, "T"))
        assertEquals(listOf("1"), Passkeys.usable(all, "example.com", emptyList()).map { it.itemId })
        assertEquals(listOf("2"), Passkeys.usable(all, "example.com", listOf(hidden.credentialId)).map { it.itemId })
        assertTrue(Passkeys.usable(all, "other.com", emptyList()).isEmpty())
    }

    // ---- The updater's hash check ----

    private fun server(body: ByteArray): HttpServer {
        val s = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        s.createContext("/app.apk") { x ->
            x.sendResponseHeaders(200, body.size.toLong())
            x.responseBody.use { it.write(body) }
        }
        s.start()
        return s
    }

    @Test fun updaterKeepsAMatchingDownload() {
        val body = ByteArray(300_000) { (it % 251).toByte() }
        val sha = MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) }
        val s = server(body)
        val dir = Files.createTempDirectory("upd").toFile()
        try {
            val dest = File(dir, "a.apk")
            UpdateVerifier.download(OkHttpClient(), "http://127.0.0.1:${s.address.port}/app.apk", sha, dest)
            assertArrayEquals(body, dest.readBytes())
            assertFalse(File(dir, "a.apk.part").exists())
        } finally {
            s.stop(0)
            dir.deleteRecursively()
        }
    }

    @Test fun updaterRefusesATamperedDownload() {
        val body = ByteArray(1000) { 1 }
        val s = server(body)
        val dir = Files.createTempDirectory("upd").toFile()
        try {
            val dest = File(dir, "a.apk")
            assertThrows(UpdateHashMismatch::class.java) {
                UpdateVerifier.download(OkHttpClient(), "http://127.0.0.1:${s.address.port}/app.apk", "0".repeat(64), dest)
            }
            assertFalse(dest.exists())
            assertFalse(File(dir, "a.apk.part").exists())
            assertThrows(UpdateHashMismatch::class.java) {
                UpdateVerifier.download(OkHttpClient(), "http://127.0.0.1:${s.address.port}/app.apk", "not a hash", dest)
            }
        } finally {
            s.stop(0)
            dir.deleteRecursively()
        }
    }

    @Test fun smsCodesAreFoundAndNothingElse() {
        assertEquals("482913", org.promptly.sync.passwords.SmsCode.extract("Your code is 482913. Don't share it."))
        assertEquals("1234", org.promptly.sync.passwords.SmsCode.extract("1234 is your code"))
        assertNull(org.promptly.sync.passwords.SmsCode.extract("Call 0412345678901 now"))
        assertNull(org.promptly.sync.passwords.SmsCode.extract("No digits here"))
    }

    @Test fun updaterHashFieldFailsClosed() {
        assertNull(UpdateVerifier.validHash(null))
        assertNull(UpdateVerifier.validHash(""))
        assertNull(UpdateVerifier.validHash("abc"))
        assertEquals("a".repeat(64), UpdateVerifier.validHash("A".repeat(64)))
    }
}
