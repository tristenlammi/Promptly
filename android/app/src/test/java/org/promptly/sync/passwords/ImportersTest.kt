// The other managers' files: the web's fixtures for each format, then hostile files. A bad file
// has to fail with a message, never crash or hang. StackTests has the check that the TypeScript
// reads the same files into the same items. Test values only.
package org.promptly.sync.passwords

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.promptly.sync.passwords.ImportFixtures.Raw
import org.promptly.sync.passwords.ImportFixtures.deflate
import org.promptly.sync.passwords.ImportFixtures.rawZip
import org.promptly.sync.passwords.core.Argon2Engine
import org.promptly.sync.passwords.core.BouncyCastleArgon2
import org.promptly.sync.passwords.core.BouncyCastleArgon2d
import org.promptly.sync.passwords.core.ImportFormats
import org.promptly.sync.passwords.core.ImportResult
import org.promptly.sync.passwords.core.Imported
import org.promptly.sync.passwords.core.Importers
import org.promptly.sync.passwords.core.Kdbx
import org.promptly.sync.passwords.core.NeedsPasswordError
import org.promptly.sync.passwords.core.Primitives
import org.promptly.sync.passwords.core.SafeXml
import org.promptly.sync.passwords.core.SafeZip
import org.promptly.sync.passwords.core.Totp
import org.promptly.sync.passwords.core.newBody
import org.promptly.sync.passwords.core.utf8
import java.net.ServerSocket
import java.net.SocketTimeoutException
import java.nio.file.Files
import java.util.Random

class ImportersTest {
    private val PASSWORD = ImportFixtures.KDBX_PASSWORD

    private fun readText(name: String, text: String, password: String? = null) = Importers.importFile(name, utf8(text), password)
    private fun obj(s: String) = Json.parseToJsonElement(s) as JsonObject
    private fun refuses(block: () -> Any?): String = assertThrows(IllegalArgumentException::class.java) { block() }.message ?: ""
    private fun refusedSaying(regex: String, block: () -> Any?) {
        val m = refuses(block)
        assertTrue("Said: $m", Regex(regex, RegexOption.IGNORE_CASE).containsMatchIn(m))
    }

    /** Only these two ways out, whatever the file is. */
    private fun readOrRefuse(name: String, bytes: ByteArray, password: String? = "pw") {
        try {
            val r = Importers.importFile(name, bytes, password)
            for (i in r.items) assertNotNull(i.body.title)
        } catch (_: IllegalArgumentException) {
        } catch (_: NeedsPasswordError) {
        }
    }

    @After fun restore() {
        Primitives.argon2Engine = BouncyCastleArgon2
        Primitives.argon2dEngine = BouncyCastleArgon2d
        Kdbx.memoryLimit = Kdbx.MAX_MEMORY
    }

    private val nope = Argon2Engine { _, _, _, _, _, _ -> throw AssertionError("The KDF ran") }

    private fun byTitle(r: ImportResult) = r.items.associateBy { it.body.title }

    // ---- CSV ----

    @Test fun lastPassKeepsItsSecureNotes() {
        val r = Importers.importFile("lastpass.csv", ImportFixtures.bytes("lastpass.csv"))
        assertEquals("LastPass", r.format)
        assertEquals(4, r.items.size)
        assertEquals("Work", r.items[0].folder)
        assertEquals("login", r.items[0].body.kind)
        assertTrue(r.items[0].body.favorite)
        assertEquals("JBSWY3DPEHPK3PXP", r.items[0].body.totp!!.secret)
        assertEquals("note", r.items[1].body.kind)
        assertTrue(r.items[1].body.urls.isEmpty())
        assertEquals("NoteType:Note\\nhello", r.items[1].body.notes)
        assertEquals("Private", r.items[3].folder)
        assertFalse("Web's note drops the flag", r.items[3].body.favorite)
        assertEquals("note", Importers.fromLastPassCsv("url,name\nhttp://sn,x\n").items[0].body.kind)
    }

    @Test fun lastPassGoesByTheRowEachItemCameFromNotItsPosition() {
        // A row with only a name makes no item. The web counts rows, so after one of those it
        // turns the item after a secure note into the note, which loses that login's password.
        val r = readText("lp.csv", "url,username,password,totp,extra,name,grouping,fav\n,,,,,Only a name,,0\nhttp://sn,,,,text,A note,,0\nhttps://a.example,u,keep-this,,,Real login,,0\n")
        assertEquals(listOf("A note", "Real login"), r.items.map { it.body.title })
        assertEquals("note", r.items[0].body.kind)
        assertEquals("login", r.items[1].body.kind)
        assertEquals("keep-this", r.items[1].body.password)
        assertEquals(1, r.warnings.size)
    }

    @Test fun csvDetectionFollowsTheHeader() {
        assertEquals("Firefox", Importers.importFile("x", ImportFixtures.bytes("firefox.csv")).format)
        assertEquals("Apple Passwords", Importers.importFile("x", ImportFixtures.bytes("apple.csv")).format)
        assertEquals("Browser", Importers.importFile("x", ImportFixtures.bytes("chrome.csv")).format)
        assertEquals("CSV", Importers.importFile("x", ImportFixtures.bytes("odd-columns.csv")).format)
    }

    // ---- JSON formats ----

    @Test fun bitwardensPasskeyIdsBecomeWhatSitesUse() {
        // The web test's values: the GUID's sixteen bytes, and "b64." taken off.
        val r = Importers.importFile("b.json", ImportFixtures.bytes("bitwarden.json"))
        val ids = r.items.flatMap { it.body.passkeys }.map { it.credentialId }
        assertEquals(listOf("abc", "sM8vCxorTD2OnwobLD1OXw", "AQIDBAUG"), ids)
    }

    @Test fun protonPass() {
        val r = Importers.importFile("proton.json", ImportFixtures.bytes("proton.json"))
        assertEquals("Proton Pass", r.format)
        val t = byTitle(r)
        assertFalse("Trashed" in t)
        assertEquals("Personal", t.getValue("A").folder)
        val a = t.getValue("A").body
        assertEquals("u", a.username)
        assertEquals("JBSWY3DPEHPK3PXP", a.totp!!.secret)
        assertEquals(listOf("https://a.example", "https://a2.example/x"), a.urls.map { it.url })
        assertEquals("hidden", a.customFields.first { it.name == "k" }.type)
        assertEquals("", a.customFields.first { it.name == "Field" }.value)
        val c = t.getValue("C").body
        assertEquals("card", c.kind)
        assertEquals("05", c.str("cardExpMonth"))
        assertEquals("2030", c.str("cardExpYear"))
        assertEquals("note", t.getValue("N").body.kind)
        assertEquals("note", t.getValue("An alias").body.kind)
        assertEquals("Work", t.getValue("An alias").folder)
        assertEquals("identity", t.getValue("I").body.kind)
        assertEquals("R", t.getValue("I").body.str("country"))
        assertEquals("only@e.example", t.getValue("Email only").body.username)
        assertTrue(r.warnings.single().startsWith("Email only:"))
        assertNull(t.getValue("Short date").body.str("cardExpMonth"))
        assertEquals("2030", t.getValue("Short date").body.str("cardExpYear"))
    }

    @Test fun credentialExchange() {
        val r = Importers.importFile("export.json", ImportFixtures.bytes("cxf.json"))
        assertEquals("Credential Exchange", r.format)
        val t = byTitle(r)
        val login = t.getValue("Login")
        assertEquals("Work", login.folder)
        assertEquals("ana", login.body.username)
        assertEquals("pw", login.body.password)
        assertTrue(login.body.favorite)
        assertEquals(listOf("t1", "t2"), login.body.tags)
        assertEquals("SHA256", login.body.totp!!.algorithm)
        assertEquals("a.example", login.body.passkeys.single().rpId)
        assertEquals("note", t.getValue("Note").body.kind)
        assertEquals("hello\n\nand more", t.getValue("Note").body.notes)
        val card = t.getValue("Card").body
        assertEquals("2031", card.str("cardExpYear"))
        assertEquals("07", card.str("cardExpMonth"))
        assertEquals("apikey", t.getValue("Key").body.kind)
        assertEquals(listOf("Hidden one", "Field", "A number"), t.getValue("Key").body.customFields.map { it.name })
        assertEquals("12", t.getValue("Key").body.customFields[2].value)
        assertEquals("wifi", t.getValue("Wifi").body.kind)
        assertEquals("ssh", t.getValue("Ssh").body.kind)
        assertEquals("login", t.getValue("Note after login").body.kind)
        assertTrue(r.warnings.single().contains("something-new"))
        val strings = t.getValue("Imported item").body.totp!!
        assertEquals(60, strings.period)
        assertEquals(8, strings.digits)
        assertEquals("SHA1", strings.algorithm)
        assertTrue(ImportFormats.fromCxf(obj("{\"accounts\":[]}")).items.isEmpty())
    }

    @Test fun aegisAndTwoFasRefusingEncryptedOnes() {
        val a = Importers.importFile("aegis.json", ImportFixtures.bytes("aegis.json"))
        assertEquals("Aegis", a.format)
        assertEquals(3, a.items.size)
        assertEquals("A: me", a.items[0].body.title)
        assertEquals("totp", a.items[0].body.kind)
        assertEquals(8, a.items[0].body.totp!!.digits)
        assertEquals(60, a.items[0].body.totp!!.period)
        assertTrue(a.items[1].body.totp!!.steam)
        assertEquals("Imported code", a.items[2].body.title)
        assertEquals("SHA1", a.items[2].body.totp!!.algorithm)
        assertTrue(a.warnings[0].contains("1"))
        refusedSaying("encrypted") { ImportFormats.fromAegisJson(obj("{\"db\":\"base64stuff\",\"header\":{\"slots\":[{}]}}")) }
        refusedSaying("encrypted") { readText("a.json", "{\"db\":{},\"header\":{\"slots\":[]}}") }

        val t = Importers.importFile("2fas.json", ImportFixtures.bytes("twofas.json"))
        assertEquals("2FAS", t.format)
        assertEquals(3, t.items.size)
        assertEquals("me", t.items[0].body.totp!!.label)
        assertTrue(t.items[1].body.totp!!.steam)
        assertEquals("Valve", t.items[1].body.title)
        assertEquals("Imported code", t.items[2].body.title)
        assertEquals("1 counter-based codes weren't imported.", t.warnings.single())
        refusedSaying("encrypted") { ImportFormats.from2fasJson(obj("{\"services\":[],\"servicesEncrypted\":\"x\"}")) }
        refusedSaying("encrypted") { readText("t.json", "{\"services\":[],\"reference\":\"x\"}") }
    }

    @Test fun googleMigrationLinksInAFile() {
        val r = Importers.importFile("codes.txt", ImportFixtures.bytes("google-migration.txt"))
        assertEquals("Google Authenticator", r.format)
        assertEquals(3, r.items.size)
        assertEquals("ana!", r.items[0].body.title)
        assertEquals("Acme: bob", r.items[1].body.title)
        assertEquals("SHA256", r.items[1].body.totp!!.algorithm)
        assertEquals(8, r.items[1].body.totp!!.digits)
        assertEquals("Beta: carol", r.items[2].body.title)
        assertEquals("1 counter-based codes weren't imported.", r.warnings.single())
        assertEquals(6, Totp.code(r.items[0].body.totp!!).length)
        // The web test's own payload.
        val payload = byteArrayOf(10, 13, 10, 5, 1, 2, 3, 4, 5, 18, 4, 0x61, 0x6e, 0x61, 0x21)
        assertEquals(1, readText("x.txt", "otpauth-migration://offline?data=" + java.net.URLEncoder.encode(java.util.Base64.getEncoder().encodeToString(payload), "UTF-8")).items.size)
        refuses { readText("x.txt", "otpauth-migration://offline?data=bm90IHByb3RvYnVm\nnot a link\n") }
    }

    // ---- Zips ----

    @Test fun onePassword1pux() {
        val r = Importers.importFile("backup.1pux", ImportFixtures.onePux())
        assertEquals("1Password", r.format)
        val t = byTitle(r)
        assertFalse("Gone" in t)
        val login = t.getValue("Login")
        assertEquals("Private", login.folder)
        assertEquals("ana", login.body.username)
        assertEquals("pw", login.body.password)
        assertEquals("n", login.body.notes)
        assertEquals("JBSWY3DPEHPK3PXP", login.body.totp!!.secret)
        assertEquals(listOf("https://a.example", "https://b.example"), login.body.urls.map { it.url })
        assertEquals(listOf("old" to "1970-01-01T00:16:40.000Z"), login.body.passwordHistory)
        assertEquals(listOf("pin", "by-id", "Field", "mail", "tel", "expiry"), login.body.customFields.map { it.name })
        assertEquals("note", t.getValue("A note").body.kind)
        val card = t.getValue("A card").body
        assertEquals("card", card.kind)
        assertEquals("4111", card.str("cardNumber"))
        assertEquals(listOf("cardBrand"), card.customFields.map { it.name })
        val old = t.getValue("Old one").body
        assertEquals("login", old.kind)
        assertTrue(old.archived)
        assertEquals("https://old.example", old.urls.single().url)
        assertNull(t.getValue("Imported item").folder)
    }

    @Test fun whatAZipIsGoesByItsContents() {
        assertEquals("1Password", Importers.importFile("renamed.zip", ImportFixtures.onePux()).format)
        assertEquals("1Password", Importers.importFile("x.1PUX", ImportFixtures.zip("export.data" to utf8("{}"))).format)
        assertEquals("Dashlane", Importers.importFile("anything", ImportFixtures.dashlane()).format)
        refusedSaying("no export.data") { Importers.importFile("empty.1pux", ImportFixtures.zip("a.txt" to utf8("x"))) }
    }

    @Test fun dashlaneZip() {
        val r = Importers.importFile("dashlane.zip", ImportFixtures.dashlane())
        assertEquals("Dashlane", r.format)
        val t = byTitle(r)
        assertEquals("ana", t.getValue("Site").body.username)
        assertEquals("pw", t.getValue("Site").body.password)
        assertEquals("Work", t.getValue("Site").folder)
        assertEquals("text", t.getValue("Notey").body.notes)
        assertEquals("no title", t.getValue("Imported note").body.notes)
        val card = t.getValue("Card").body
        assertEquals("card", card.kind)
        assertEquals("12345", card.str("cardNumber"))
        assertEquals("Ana", card.str("cardholder"))
        assertEquals("1", card.str("cardCvv"))
        assertEquals("identity", t.getValue("Ana Bee").body.kind)
        assertEquals("AU", t.getValue("Ana Bee").body.str("country"))
        assertEquals("other.csv: not something we can read yet.", r.warnings.single())
    }

    // ---- KeePass XML ----

    @Test fun keepassXml() {
        val r = Importers.importFile("k.xml", ImportFixtures.bytes("keepass.xml"))
        assertEquals("KeePass", r.format)
        val t = byTitle(r)
        val a = t.getValue("A")
        assertNull(a.folder)
        assertEquals("u", a.body.username)
        assertEquals("p&w!", a.body.password)
        assertEquals("JBSWY3DPEHPK3PXP", a.body.totp!!.secret)
        assertEquals(listOf("Extra"), a.body.customFields.map { it.name })
        assertEquals("Sub", t.getValue("B").folder)
        assertEquals("line one\nline two\nline three", t.getValue("B").body.notes)
        val c = t.getValue("C & <d>")
        assertEquals("Sub/Deep <er>", c.folder)
        assertEquals(8, c.body.totp!!.digits)
        assertTrue("A seed that wasn't used goes, as on the web", c.body.customFields.isEmpty())
        val seeded = t.getValue("Imported login").body
        assertEquals("JBSWY3DP", seeded.totp!!.secret)
        assertEquals(listOf("TimeOtp-Secret-Base32"), seeded.customFields.map { it.name })
    }

    @Test fun theWebTestsKeePassXml() {
        val xml = """<?xml version="1.0"?><KeePassFile><Root><Group><Name>Root</Name>
    <Entry><String><Key>Title</Key><Value>A</Value></String><String><Key>UserName</Key><Value>u</Value></String><String><Key>Password</Key><Value>p&amp;w</Value></String><String><Key>URL</Key><Value>https://a.example</Value></String><String><Key>Extra</Key><Value>e</Value></String><String><Key>TimeOtp-Secret-Base32</Key><Value>JBSWY3DPEHPK3PXP</Value></String></Entry>
    <Group><Name>Sub</Name><Entry><String><Key>Title</Key><Value>B</Value></String></Entry></Group>
  </Group></Root></KeePassFile>"""
        val r = ImportFormats.fromKeepassXml(xml)
        assertEquals(2, r.items.size)
        assertEquals("p&w", r.items[0].body.password)
        assertEquals("Sub", r.items[1].folder)
        val deep = "<KeePassFile><Root>" + "<Group><Name>x</Name>".repeat(100) + "</Group>".repeat(100) + "</Root></KeePassFile>"
        refusedSaying("deeply") { ImportFormats.fromKeepassXml(deep) }
        refuses { ImportFormats.fromKeepassXml("<html></html>") }
        refuses { ImportFormats.fromKeepassXml("<<<not xml") }
        val script = ImportFormats.fromKeepassXml("<KeePassFile><Root><Group><Entry><String><Key>Title</Key><Value>&lt;script&gt;alert(1)&lt;/script&gt;</Value></String></Entry></Group></Root></KeePassFile>")
        assertEquals("<script>alert(1)</script>", script.items[0].body.title)
    }

    @Test fun theXmlReaderReadsWhatXmlAllows() {
        val doc = SafeXml.parse("\uFEFF<?xml version='1.0'?>\r\n<!-- c --><a x='1' y=\"&lt;2\" ><b>one<c>two</c>&#x1F600;&#65;</b>\r\n<d/><![CDATA[<raw>&amp;]]><?pi data?></a>\n<!-- after -->\n")
        assertEquals("a", doc.name)
        assertEquals("1", doc.attributes["x"])
        assertEquals("<2", doc.attributes["y"])
        val b = doc.child("b")!!
        assertEquals("onetwo\uD83D\uDE00A", b.textContent())
        assertEquals("onetwo\uD83D\uDE00A\n<raw>&amp;", doc.textContent())
    }

    @Test fun theXmlReaderRefusesWhatIsntXml() {
        for (bad in listOf(
            "", "text", "<a>", "<a></b>", "<a><b></a></b>", "<a/><b/>", "<a/>text", "text<a/>", "<a x=1/>", "<a x='1' x='2'/>", "<a x='<'/>", "<a x='1'y='2'/>", "<a>&</a>", "<a>&nope;</a>", "<a>&#0;</a>",
            "<a>&#xFFFFFFFFF;</a>", "<a>\u0001</a>", "<a>]]></a>", "<a><![CDATA[x</a>", "<a><!-- x -- y --></a>", "<a><?pi</a>", " <?xml version='1.0'?><a/>", "<![CDATA[x]]><a/>", "<a", "<1a/>", "</a>", "<a><!ELEMENT x></a>",
        )) {
            assertThrows("Should refuse: $bad", IllegalArgumentException::class.java) { SafeXml.parse(bad) }
        }
    }

    // ---- XXE and friends ----

    @Test fun xmlCantReachForAFile() {
        val secret = Files.createTempFile("xxe-canary", ".txt").toFile()
        try {
            val canary = "CANARY-" + System.nanoTime()
            secret.writeText(canary)
            val url = secret.toURI().toString()
            val entry = "<KeePassFile><Root><Group><Entry><String><Key>Title</Key><Value>&xxe;</Value></String></Entry></Group></Root></KeePassFile>"
            for (file in listOf(
                "<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY xxe SYSTEM \"$url\">]>$entry",
                "<?xml version=\"1.0\"?><!DOCTYPE x SYSTEM \"$url\">$entry",
                "<!DOCTYPE x [<!ENTITY % p SYSTEM \"$url\"> %p;]>$entry",
                "<!DOCTYPE x PUBLIC \"-//X//EN\" \"$url\"><KeePassFile/>",
                "<!DOCTYPE KeePassFile><KeePassFile><Root/></KeePassFile>",
                entry,
            )) {
                val said = refuses { readText("x.xml", file) }
                assertFalse(said, said.contains(canary))
            }
            refusedSaying("entities") { readText("x.xml", "<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY xxe SYSTEM \"$url\">]>$entry") }
            refusedSaying("DOCTYPE") { readText("x.xml", "<!DOCTYPE KeePassFile><KeePassFile><Root/></KeePassFile>") }
        } finally {
            secret.delete()
        }
    }

    @Test(timeout = 20_000) fun xmlCantReachForTheNetwork() {
        ServerSocket(0).use { server ->
            server.soTimeout = 1500
            val url = "http://127.0.0.1:${server.localPort}/evil.dtd"
            refuses { readText("x.xml", "<!DOCTYPE x SYSTEM \"$url\"><KeePassFile><Root/></KeePassFile>") }
            refuses { readText("x.xml", "<!DOCTYPE x [<!ENTITY e SYSTEM \"$url\">]><KeePassFile><Root><Group><Entry><String><Key>Title</Key><Value>&e;</Value></String></Entry></Group></Root></KeePassFile>") }
            assertThrows("Something connected", SocketTimeoutException::class.java) { server.accept() }
        }
    }

    @Test(timeout = 20_000) fun billionLaughsAndItsCousins() {
        val laughs = StringBuilder("<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY a0 \"ha\">")
        for (i in 1..30) laughs.append("<!ENTITY a$i \"" + "&a${i - 1};".repeat(10) + "\">")
        laughs.append("]><KeePassFile><Root><Group><Entry><String><Key>Title</Key><Value>&a30;</Value></String></Entry></Group></Root></KeePassFile>")
        refusedSaying("entities") { readText("x.xml", laughs.toString()) }
        // In a comment it's still refused, as by the web's check.
        refusedSaying("entities") { readText("x.xml", "<KeePassFile><!-- <!ENTITY a \"b\"> --><Root/></KeePassFile>") }
        // Very deep, and very many.
        refusedSaying("couldn't be read") { readText("x.xml", "<a>".repeat(100_000) + "</a>".repeat(100_000)) }
        refusedSaying("couldn't be read|too large") { readText("x.xml", "<a>" + "<b/>".repeat(SafeXml.MAX_NODES + 1) + "</a>") }
    }

    // ---- KDBX 4 ----

    @Test fun kdbxReadsWhatPykeepassWrote() {
        val r = Kdbx.read(ImportFixtures.kdbx, PASSWORD)
        assertEquals("KeePass", r.format)
        assertEquals(3, r.items.size)
        val t = byTitle(r)
        val mail = t.getValue("Mail")
        assertEquals("Work", mail.folder)
        assertEquals("ana@example.com", mail.body.username)
        assertEquals("History comes earlier in the stream, and has to be stepped over", "changed-password-2", mail.body.password)
        assertEquals("line one\nline two", mail.body.notes)
        assertEquals(listOf("https://mail.example.com"), mail.body.urls.map { it.url })
        assertEquals("JBSWY3DPEHPK3PXP", mail.body.totp!!.secret)
        assertEquals(listOf(org.promptly.sync.passwords.core.CustomField("Pin", "1234", "text")), mail.body.customFields)
        assertEquals("Work/Deep", t.getValue("Nested").folder)
        assertEquals("nested-pass", t.getValue("Nested").body.password)
        assertNull(t.getValue("Root Entry").folder)
        assertEquals("root-pass", t.getValue("Root Entry").body.password)
    }

    @Test fun kdbxWantsAPasswordAndRefusesTheWrongOne() {
        assertEquals("KeePass", assertThrows(NeedsPasswordError::class.java) { Importers.importFile("x.kdbx", ImportFixtures.kdbx) }.format)
        assertThrows(NeedsPasswordError::class.java) { Importers.importFile("x.kdbx", ImportFixtures.kdbx, "") }
        refusedSaying("didn't open") { Importers.importFile("x.kdbx", ImportFixtures.kdbx, "wrong") }
        assertEquals(3, Importers.importFile("no-extension", ImportFixtures.kdbx, PASSWORD).items.size)
    }

    @Test fun kdbxOverFourKilobytesOfProtectedValues() {
        // 300 entries written by pykeepass. The stream has to run on over all of them.
        val r = Kdbx.read(ImportFixtures.bytes("large.kdbx"), PASSWORD)
        assertEquals(300, r.items.size)
        for ((i, item) in r.items.sortedBy { it.body.title }.withIndex()) {
            val n = i.toString().padStart(3, '0')
            assertEquals("Entry $n", item.body.title)
            assertEquals("Bulk", item.folder)
            assertEquals("bulk-test-password-$n-with-some-length", item.body.password)
        }
    }

    @Test fun kdbxWithChaChaAndArgon2idFromPykeepass() {
        val r = Kdbx.read(ImportFixtures.bytes("chacha-argon2id.kdbx"), PASSWORD)
        val t = byTitle(r)
        assertEquals("pw-chacha-argon2id.kdbx-1", t.getValue("Alpha").body.password)
        assertEquals("1234", t.getValue("Alpha").body.customFields.single().value)
        assertEquals("pw-beta-2", t.getValue("Beta").body.password)
    }

    @Test fun kdbxWithEveryCipherAndKdf() {
        for (kdf in listOf(KdbxWriter.Argon2(id = true), KdbxWriter.Argon2(id = false), KdbxWriter.Argon2(id = true, wide = false), KdbxWriter.AesRounds(6000))) {
            for (cipher in listOf(KdbxWriter.AES, KdbxWriter.CHACHA)) {
                for (compress in listOf(true, false)) {
                    val r = Kdbx.read(KdbxWriter.write(kdf, cipher, compress), PASSWORD)
                    assertEquals("pw-alpha-1", r.items.single().body.password)
                }
            }
        }
        refusedSaying("didn't open") { Kdbx.read(KdbxWriter.write(KdbxWriter.AesRounds(100)), "wrong") }
    }

    @Test fun kdbxPasswordIsNormalizedToNfc() {
        val composed = "p\u00E4ss"
        val file = KdbxWriter.write(password = composed)
        assertEquals(1, Kdbx.read(file, "pa\u0308ss").items.size)
    }

    @Test(timeout = 30_000) fun oversizedKdfSettingsAreRefusedBeforeAnyWork() {
        Primitives.argon2Engine = nope
        Primitives.argon2dEngine = nope
        val gib = 1024L * 1024 * 1024
        for (id in listOf(true, false)) {
            // Over kdbx.ts's own ceilings.
            refusedSaying("Unusual KDF") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Argon2(id, m = 8 * gib + 1)), PASSWORD) }
            refusedSaying("Unusual KDF") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Argon2(id, t = 100_001)), PASSWORD) }
            refusedSaying("Unusual KDF") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Argon2(id, p = 65)), PASSWORD) }
            refusedSaying("Unusual KDF") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Argon2(id, m = -1L)), PASSWORD) }
            refusedSaying("Unusual KDF") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Argon2(id, t = Long.MAX_VALUE)), PASSWORD) }
            // Under them, and still more than a phone should spend.
            refusedSaying("this phone") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Argon2(id, m = 8 * gib)), PASSWORD) }
            refusedSaying("this phone") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Argon2(id, m = gib + 1)), PASSWORD) }
            refusedSaying("this phone") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Argon2(id, m = 64L * 1024 * 1024, t = 513)), PASSWORD) }
            // Nothing Argon2 can do.
            refusedSaying("Unusual KDF") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Argon2(id, t = 0)), PASSWORD) }
            refusedSaying("Unusual KDF") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Argon2(id, p = 0)), PASSWORD) }
            refusedSaying("Unusual KDF") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Argon2(id, m = 1024, p = 2)), PASSWORD) }
            refusedSaying("Unusual KDF") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Argon2(id, salt = ByteArray(4))), PASSWORD) }
        }
        refusedSaying("Unusual KDF") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.AesRounds(200_000_001)), PASSWORD) }
        refusedSaying("this phone") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.AesRounds(Kdbx.MAX_ROUNDS + 1)), PASSWORD) }
        refusedSaying("key setting we don't know") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Unknown("00000000000000000000000000000000")), PASSWORD) }
    }

    @Test fun theLimitsAreWhatWasAgreed() {
        assertEquals(8L * 1024 * 1024 * 1024, Kdbx.WEB_MAX_MEMORY)
        assertEquals(100_000L, Kdbx.WEB_MAX_PASSES)
        assertEquals(64L, Kdbx.WEB_MAX_LANES)
        assertEquals(200_000_000L, Kdbx.WEB_MAX_ROUNDS)
        assertTrue(Kdbx.MAX_MEMORY < Kdbx.WEB_MAX_MEMORY)
        assertTrue(Kdbx.MAX_ROUNDS < Kdbx.WEB_MAX_ROUNDS)
    }

    @Test(timeout = 30_000) fun thePhonesFreeMemoryIsALimitToo() {
        Kdbx.memoryLimit = 1024 * 1024
        refusedSaying("this phone") { Kdbx.read(ImportFixtures.kdbx, PASSWORD) }
        Kdbx.memoryLimit = Kdbx.MAX_MEMORY
        // BouncyCastle needs it on the heap, so half the heap is the most it gets.
        val max = Runtime.getRuntime().maxMemory()
        if (max / 2 < Kdbx.MAX_MEMORY) refusedSaying("this phone") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Argon2(m = max / 2 + 1024)), PASSWORD) }
    }

    // ---- Small files that ask for a lot of time ----

    /** Each row used to look through every column of the header: 100,000 by 190,000, in under a MiB. */
    @Test(timeout = 15_000) fun aHugeCsvHeaderCantTimeManyRows() {
        val header = "password," + (0 until 100_000).joinToString(",") { "c$it" }
        refusedSaying("too many columns") { Importers.importFile("a.csv", (header + "\n" + "x\n".repeat(190_000)).toByteArray()) }
    }

    @Test fun anOrdinaryWideCsvStillImports() {
        val header = "password," + (0 until 200).joinToString(",") { "c$it" }
        assertEquals(1, Importers.importFile("a.csv", (header + "\nx,y\n").toByteArray()).items.size)
    }

    private fun aegis(digits: String) = """{"version":1,"header":{},"db":{"version":2,"entries":[{"type":"totp","name":"x","issuer":"y","info":{"secret":"JBSWY3DPEHPK3PXP","digits":"$digits","period":30}}]}}""".toByteArray()

    @Test(timeout = 15_000) fun aHugeHexNumberCantHangAnImport() {
        runCatching { Importers.importFile("a.json", aegis("0x" + "F".repeat(8_000_000))) }
    }

    /** The regex for a decimal backtracks on the last character, the same size of problem. */
    @Test(timeout = 15_000) fun aHugeDecimalNumberCantHangAnImport() {
        runCatching { Importers.importFile("a.json", aegis("1".repeat(2_000_000) + "x")) }
    }

    @Test fun anOrdinaryNumberInTextStillReads() {
        assertEquals(8, Importers.importFile("a.json", aegis("0x8")).items.single().body.totp!!.digits)
        assertEquals(8, Importers.importFile("a.json", aegis("8")).items.single().body.totp!!.digits)
    }

    // ---- Bitwarden's password-protected file chooses its own cost too ----

    private fun bitwarden(kdfType: Int, iterations: Long, memory: Int? = null, lanes: Int? = null) = """{"encrypted":true,"passwordProtected":true,"salt":"c2FsdHNhbHRzYWx0","kdfType":$kdfType,"kdfIterations":$iterations,${memory?.let { "\"kdfMemory\":$it," } ?: ""}${lanes?.let { "\"kdfParallelism\":$it," } ?: ""}"encKeyValidation_DO_NOT_EDIT":"2.AAAAAAAAAAAAAAAAAAAAAA==|AAAA|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","data":"2.AAAAAAAAAAAAAAAAAAAAAA==|AAAA|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}""".toByteArray()

    /** Refused at once, on a timeout a real KDF at these settings couldn't begin to meet. */
    @Test(timeout = 5_000) fun aBitwardenFileCantAskForTooMuchWork() {
        Primitives.argon2Engine = nope
        refusedSaying("ask more than this phone") { Importers.importFile("b.json", bitwarden(0, 100_000_000), PASSWORD) }
        refusedSaying("ask more than this phone") { Importers.importFile("b.json", bitwarden(0, Importers.BITWARDEN_MAX_PBKDF2 + 1L), PASSWORD) }
        // The review's file: 4 GiB, 100 million passes.
        refusedSaying("Unusual KDF") { Importers.importFile("b.json", bitwarden(1, 100_000_000, 4096, 4), PASSWORD) }
        refusedSaying("ask more than this phone") { Importers.importFile("b.json", bitwarden(1, 3, 4096, 4), PASSWORD) }
        // Memory times passes, on a memory it could spare. Kdbx's own ceiling.
        refusedSaying("ask more than this phone") { Importers.importFile("b.json", bitwarden(1, Kdbx.MAX_WORK / (64L * 1024 * 1024) + 1, 64, 4), PASSWORD) }
        refusedSaying("Unusual KDF") { Importers.importFile("b.json", bitwarden(0, 0), PASSWORD) }
        refusedSaying("Unusual KDF") { Importers.importFile("b.json", bitwarden(1, 3, 64, 17), PASSWORD) }
    }

    @Test(timeout = 5_000) fun aBitwardenFileObeysThePhonesFreeMemory() {
        Primitives.argon2Engine = nope
        Kdbx.memoryLimit = 32L * 1024 * 1024
        refusedSaying("ask more than this phone") { Importers.importFile("b.json", bitwarden(1, 3, 64, 4), PASSWORD) }
    }

    /** Settings an ordinary export uses get past the check, to the hash. */
    @Test(timeout = 5_000) fun aBitwardenFilesOrdinarySettingsGetAsFarAsTheHash() {
        var ran = 0
        val memory = minOf(64L * 1024 * 1024, Runtime.getRuntime().maxMemory() / 4)
        Primitives.argon2Engine = Argon2Engine { _, _, m, t, p, _ ->
            ran++
            assertEquals(memory / 1024, m.toLong())
            assertEquals(3, t)
            assertEquals(4, p)
            ByteArray(32)
        }
        refusedSaying("didn't open") { Importers.importFile("b.json", bitwarden(1, 3, (memory / (1024 * 1024)).toInt(), 4), PASSWORD) }
        assertEquals("Its salt's text, then its bytes", 2, ran)
    }

    /** Leaving the screen forgets a hash is running, and it can't be stopped. A second one has to wait its turn. */
    @Test(timeout = 20_000) fun hashesFromAnImportCantStack() {
        val started = java.util.concurrent.CountDownLatch(1)
        val finish = java.util.concurrent.CountDownLatch(1)
        Primitives.argon2Engine = Argon2Engine { _, _, _, _, _, _ ->
            started.countDown()
            finish.await()
            ByteArray(32)
        }
        val first = kotlin.concurrent.thread { runCatching { Importers.importFile("b.json", bitwarden(1, 1, 1, 1), PASSWORD) } }
        started.await()
        // Another file entirely, of another kind, with a password. The same gate.
        refusedSaying("still opening") { Importers.importFile("b.json", bitwarden(1, 1, 1, 1), PASSWORD) }
        refusedSaying("still opening") { Kdbx.memoryLimit = Kdbx.MAX_MEMORY; Importers.importFile("x.kdbx", ImportFixtures.kdbx, PASSWORD) }
        // Nothing with no password can be waiting on a hash.
        assertEquals("LastPass", Importers.importFile("lastpass.csv", ImportFixtures.bytes("lastpass.csv")).format)
        finish.countDown()
        first.join()
        // And it's open again, whichever way that went.
        Primitives.argon2Engine = Argon2Engine { _, _, _, _, _, _ -> ByteArray(32) }
        refusedSaying("didn't open") { Importers.importFile("b.json", bitwarden(1, 1, 1, 1), PASSWORD) }
    }

    @Test fun anEngineThatFailsIsAnError() {
        Primitives.argon2Engine = Argon2Engine { _, _, _, _, _, _ -> throw OutOfMemoryError("no") }
        refusedSaying("this phone") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Argon2()), PASSWORD) }
        Primitives.argon2Engine = Argon2Engine { _, _, _, _, _, _ -> throw IllegalStateException("no") }
        refusedSaying("this phone") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Argon2()), PASSWORD) }
    }

    @Test(timeout = 60_000) fun aGzipBombInsideAValidFile() {
        val inner = ByteArray(100 * 1024 * 1024)
        val file = KdbxWriter.write(KdbxWriter.AesRounds(10), rawXml = inner)
        assertTrue("The file itself is small: ${file.size}", file.size < 2 * 1024 * 1024)
        refusedSaying("expands") { Kdbx.read(file, PASSWORD) }
    }

    @Test fun hostileContentsInAValidFile() {
        val quick = KdbxWriter.AesRounds(10)
        refusedSaying("entities") {
            Kdbx.read(KdbxWriter.write(quick, xml = { "<!DOCTYPE x [<!ENTITY e SYSTEM \"file:///etc/passwd\">]><KeePassFile><Root><Group><Entry><String><Key>Title</Key><Value>&e;</Value></String></Entry></Group></Root></KeePassFile>" }), PASSWORD)
        }
        refusedSaying("couldn't be read") { Kdbx.read(KdbxWriter.write(quick, xml = { "<!DOCTYPE KeePassFile><KeePassFile><Root/></KeePassFile>" }), PASSWORD) }
        refusedSaying("couldn't be read") { Kdbx.read(KdbxWriter.write(quick, xml = { "<KeePassFile><Root>" }), PASSWORD) }
        refusedSaying("couldn't be read") { Kdbx.read(KdbxWriter.write(quick, xml = { "<NotKeePass/>" }), PASSWORD) }
        val tooDeep = "<KeePassFile><Root>" + "<Group>".repeat(100) + "</Group>".repeat(100) + "</Root></KeePassFile>"
        refusedSaying("deeply") { Kdbx.read(KdbxWriter.write(quick, xml = { tooDeep }), PASSWORD) }
        refusedSaying("isn't ChaCha20") { Kdbx.read(KdbxWriter.write(quick, innerId = 2), PASSWORD) }
        val badValue = "<KeePassFile><Root><Group><Entry><String><Key>Title</Key><Value Protected=\"True\">!!!</Value></String></Entry></Group></Root></KeePassFile>"
        refusedSaying("couldn't be read") { Kdbx.read(KdbxWriter.write(quick, xml = { badValue }), PASSWORD) }
        // Bad UTF-8 and script stay data.
        val script = KdbxWriter.write(quick, xml = { p -> KdbxWriter.entryXml(p, "&lt;img src=x&gt;", "u", "\u00FC") })
        assertEquals("<img src=x>", Kdbx.read(script, PASSWORD).items.single().body.title)
    }

    @Test fun kdbxOfOtherVersionsAndNotKdbxAtAll() {
        refusedSaying("older KeePass") { Kdbx.read(KdbxWriter.headerOnly(KdbxWriter.Argon2(), major = 3), PASSWORD) }
        refusedSaying("isn't a KeePass") { Kdbx.read(ByteArray(11), PASSWORD) }
        refusedSaying("isn't a KeePass") { Importers.importFile("x.kdbx", byteArrayOf(3, 0xd9.toByte(), 0xa2.toByte(), 0x9a.toByte()), PASSWORD) }
        val badCipher = KdbxWriter.write(KdbxWriter.AesRounds(10), cipher = "00112233445566778899aabbccddeeff")
        refusedSaying("cipher") { Kdbx.read(badCipher, PASSWORD) }
    }

    @Test(timeout = 120_000) fun aTruncatedKdbxIsAnError() {
        val file = KdbxWriter.write(KdbxWriter.AesRounds(10))
        for (cut in 0 until file.size step 7) refuses { Importers.importFile("x.kdbx", file.copyOf(cut).let { if (it.size < 4) byteArrayOf(3, 0xd9.toByte(), 0xa2.toByte(), 0x9a.toByte()) else it }, PASSWORD) }
    }

    @Test(timeout = 120_000) fun aDamagedKdbxIsAnError() {
        val bad = ImportFixtures.kdbx
        bad[bad.size - 60] = (bad[bad.size - 60].toInt() xor 1).toByte()
        refuses { Kdbx.read(bad, PASSWORD) }
        val header = ImportFixtures.kdbx
        header[40] = (header[40].toInt() xor 1).toByte()
        refuses { Kdbx.read(header, PASSWORD) }
        val rnd = Random(7)
        repeat(15) {
            val b = ImportFixtures.kdbx
            val at = rnd.nextInt(181)
            b[at] = (b[at].toInt() xor (1 + rnd.nextInt(255))).toByte()
            refuses { Kdbx.read(b, PASSWORD) }
        }
        val quick = KdbxWriter.write(KdbxWriter.AesRounds(10))
        for (at in 0 until quick.size step 11) {
            val b = quick.copyOf()
            b[at] = (b[at].toInt() xor 0x41).toByte()
            refuses { Kdbx.read(b, PASSWORD) }
        }
    }

    // ---- Zip bombs and broken zips ----

    private val MIB = 1024L * 1024

    @Test(timeout = 20_000) fun aBombThatSaysHowBigItIs() {
        val hundred = deflate(ByteArray((100 * MIB).toInt()))
        assertTrue(hundred.size < MIB)
        val zip = rawZip(listOf(Raw("export.attributes", deflate(utf8("{}")), declaredSize = 2), Raw("export.data", hundred, declaredSize = 100 * MIB)))
        refusedSaying("too large") { Importers.importFile("x.1pux", zip) }
        val allAtOnce = rawZip(listOf(Raw("a.csv", deflate(ByteArray(10)), declaredSize = 0xFFFFFFF0L)))
        refusedSaying("too large") { Importers.importFile("x.zip", allAtOnce) }
    }

    @Test(timeout = 20_000) fun aBombThatLiesAboutItsSize() {
        val hundred = deflate(ByteArray((100 * MIB).toInt()))
        val zip = rawZip(listOf(Raw("export.data", hundred, declaredSize = 100)))
        refusedSaying("too large") { Importers.importFile("x.1pux", zip) }
        val shorter = rawZip(listOf(Raw("export.data", deflate(utf8("{}")), declaredSize = 100)))
        refusedSaying("damaged") { Importers.importFile("x.1pux", shorter) }
    }

    @Test(timeout = 30_000) fun aBombOfOverlappingEntries() {
        // One small deflate stream, and a directory that names it over and over.
        val kernel = deflate(ByteArray(MIB.toInt()))
        val entries = ArrayList<Raw>()
        entries += Raw("f0.csv", kernel, declaredSize = MIB)
        for (i in 1..200) entries += Raw("f$i.csv", kernel, declaredSize = MIB, sameDataAs = 0)
        val zip = rawZip(entries)
        assertTrue(zip.size < MIB)
        refusedSaying("too large") { Importers.importFile("x.zip", zip) }
    }

    @Test(timeout = 30_000) fun aZipWithTooManyEntries() {
        val small = deflate(utf8("x"))
        val entries = (0..SafeZip.MAX_ENTRIES).map { Raw("f$it.txt", small, declaredSize = 1) }
        refusedSaying("too many") { Importers.importFile("x.zip", rawZip(entries)) }
        val atTheLimit = (0 until SafeZip.MAX_ENTRIES).map { Raw("f$it.txt", small, declaredSize = 1) }
        assertEquals(0, Importers.importFile("x.zip", rawZip(atTheLimit)).items.size)
    }

    @Test(timeout = 60_000) fun aTruncatedZipIsAnErrorNotAPartialImport() {
        for (zip in listOf(ImportFixtures.onePux(), ImportFixtures.dashlane())) {
            for (cut in 2 until zip.size) {
                val part = zip.copyOf(cut)
                // A prefix that happens to end in a whole directory is a different question: none here.
                refuses { Importers.importFile("x.1pux", part) }
                refuses { Importers.importFile("x.zip", part) }
            }
        }
    }

    @Test fun otherBrokenZips() {
        val good = deflate(utf8("{}"))
        refusedSaying("encrypted") { Importers.importFile("x.1pux", rawZip(listOf(Raw("export.data", good, declaredSize = 2, flags = 1)))) }
        refusedSaying("compression") { Importers.importFile("x.1pux", rawZip(listOf(Raw("export.data", good, method = 12, declaredSize = 2)))) }
        refusedSaying("damaged") { Importers.importFile("x.1pux", rawZip(listOf(Raw("export.data", good, method = 0, declaredSize = 3)))) }
        refusedSaying("damaged") { Importers.importFile("x.1pux", rawZip(listOf(Raw("export.data", good, declaredSize = 2, declaredCompressed = 1L shl 20)))) }
        refusedSaying("damaged") { Importers.importFile("x.1pux", rawZip(listOf(Raw("export.data", good, declaredSize = 2, localOverride = 1L shl 20)))) }
        refusedSaying("damaged") { Importers.importFile("x.1pux", rawZip(listOf(Raw("export.data", good, declaredSize = 2)), countOverride = 5)) }
        refusedSaying("damaged") { Importers.importFile("x.1pux", rawZip(listOf(Raw("export.data", utf8("not deflate at all"), declaredSize = 50)))) }
        refusedSaying("damaged") { Importers.importFile("x.zip", byteArrayOf(0x50, 0x4b)) }
        refusedSaying("damaged") { Importers.importFile("x.zip", byteArrayOf(0x50, 0x4b, 3, 4) + ByteArray(100)) }
        refusedSaying("damaged") { Importers.importFile("x.1pux", rawZip(listOf(Raw("export.data", good, declaredSize = 2))) + ByteArray(70_000)) }
        refusedSaying("damaged .1pux|is damaged") { Importers.importFile("x.1pux", ImportFixtures.zip("export.data" to utf8("{not json"))) }
    }

    @Test fun whatZipsCanBeWithoutBeingBad() {
        val stored = rawZip(listOf(Raw("export.data", utf8("{\"accounts\":[]}"), method = 0, declaredSize = 15)))
        assertEquals("1Password", Importers.importFile("x.1pux", stored).format)
        val commented = rawZip(listOf(Raw("export.data", deflate(utf8("{}")), declaredSize = 2)), comment = utf8("a comment"))
        assertEquals("1Password", Importers.importFile("x.1pux", commented).format)
        val wide = rawZip(listOf(Raw("export.data", deflate(utf8("{}")), declaredSize = 2)), zip64 = true)
        assertEquals("1Password", Importers.importFile("x.1pux", wide).format)
        // Attachments are left alone, however big they say they are.
        val attachments = rawZip(listOf(Raw("export.data", deflate(utf8("{}")), declaredSize = 2), Raw("files/huge.bin", deflate(ByteArray(10)), declaredSize = 0xFFFFFFF0L)))
        assertEquals("1Password", Importers.importFile("x.1pux", attachments).format)
        assertEquals(setOf("export.data"), SafeZip.read(attachments).keys)
        assertFalse(ImportFormats.isOnePux(ByteArray(10)))
    }

    // ---- Malformed JSON ----

    private val NOT_JSON = listOf(
        "{\"services\":[{\"secret\":AAAA}]}",
        "{\"services\":[{\"secret\":tru}]}",
        "{\"services\":[{\"secret\":nul}]}",
        "{\"services\":[{\"secret\":NaN}]}",
        "{\"services\":[{\"otp\":{\"digits\":06}}]}",
        "{\"services\":[{\"otp\":{\"digits\":+6}}]}",
        "{\"services\":[{\"otp\":{\"digits\":6.}}]}",
        "{\"services\":[{\"otp\":{\"digits\":.5}}]}",
        "{\"services\":[{\"otp\":{\"digits\":1e}}]}",
        "{\"services\":[{\"otp\":{\"digits\":0x10}}]}",
        "{\"services\":[],}",
        "{\"services\":[1,]}",
        "{\"services\":[,1]}",
        "{'services':[]}",
        "{services:[]}",
        "{\"services\":[{\"secret\":'AAAA'}]}",
        "{\"services\":[]} trailing",
        "{\"services\":[]}{}",
        "{\"services\":[{\"secret\":\"a\nb\"}]}",
        "{\"services\":[{\"secret\":\"a\tb\"}]}",
        "{\"services\":[{\"secret\":\"a\\qb\"}]}",
        "{\"services\":[{\"secret\":\"a\\u12\"}]}",
        "{\"services\":[{\"secret\":\"a}]}",
    )

    @Test fun malformedJson() {
        for (bad in listOf(
            "{", "[", "{\"a\":", "{\"vaults\":", "{\"items\":[}", "[1,2", "{\"db\":{},\"header\":", "{\"services\":[", "{\"accounts\":[],\"exporterRpId\"",
            "{\"format\":\"promptly-pw-plain\"", "{\"vaults\":{\"a\":{\"items\":[{\"state\":}]}}}",
        )) {
            refusedSaying("damaged") { readText("x.json", bad) }
        }
        // What JSON.parse refuses and a lenient reader lets through as if it meant something.
        for (bad in NOT_JSON) refusedSaying("damaged") { readText("x.json", bad) }
        refusedSaying("recognise") { readText("x.json", "{}") }
        refusedSaying("recognise") { readText("x.json", "[1,2]") }
        // Everything JSON allows, including where the reader above could get it wrong.
        val fine = " {\"services\" : [ {\"name\":\"a\\u00e9\\n\\\"\\\\\\/\", \"secret\":\"AA\", \"otp\":{\"digits\":-0.5e+1, \"period\":0, \"x\":[], \"y\":{}, \"z\":[[null,true,false,1E3,{\"a\":[]}]]}} ] }\r\n\t"
        assertEquals("a\u00e9\n\"\\/", readText("x.json", fine).items.single().body.title)
        refusedSaying("damaged") { Importers.importFile("x.1pux", ImportFixtures.zip("export.data" to utf8("{\"accounts\":[{\"vaults\":bare}]}"))) }
        refusedSaying("recognise") { readText("x.json", "{\"vaults\":1}") }
    }

    @Test fun wrongTypesInsideRealShapes() {
        // Where JavaScript's property reads give undefined, the same item comes out.
        assertEquals("Imported item", readText("x.json", "{\"vaults\":{\"a\":{\"items\":[{\"data\":\"s\"}]}}}").items.single().body.title)
        assertEquals("note", readText("x.json", "{\"vaults\":{\"a\":{\"items\":[5]}}}").items.single().body.kind)
        assertEquals("totp", readText("x.json", "{\"db\":{\"entries\":[{\"type\":\"totp\",\"info\":\"s\"}]},\"header\":{}}").items.single().body.kind)
        assertEquals("Imported code", readText("x.json", "{\"services\":[{\"otp\":\"s\"}]}").items.single().body.title)
        assertEquals("[object Object]", readText("x.json", "{\"vaults\":{\"a\":{\"items\":[{\"data\":{\"extraFields\":[{\"data\":{\"content\":{}}}]}}]}}}").items.single().body.customFields.single().value)
        assertEquals("12", readText("x.json", "{\"vaults\":{\"a\":{\"items\":[{\"data\":{\"extraFields\":[{\"data\":{\"content\":12.0}}]}}]}}}").items.single().body.customFields.single().value)
        // Where it throws, so does this.
        refusedSaying("empty entry") { readText("x.json", "{\"vaults\":{\"a\":{\"items\":[null]}}}") }
        refusedSaying("empty entry") { readText("x.json", "{\"vaults\":{\"a\":null}}") }
        refusedSaying("empty entry") { readText("x.json", "{\"accounts\":[null],\"exporterRpId\":1}") }
        refusedSaying("empty entry") { readText("x.json", "{\"db\":{\"entries\":[null]},\"header\":{}}") }
        refusedSaying("empty entry") { readText("x.json", "{\"services\":[null]}") }
        // A date that's out of range.
        val badDate = """{"accounts":[{"vaults":[{"items":[{"categoryUuid":"001","details":{"passwordHistory":[{"value":"x","time":1e300}]}}]}]}]}"""
        refusedSaying("date") { Importers.importFile("x.1pux", ImportFixtures.zip("export.data" to utf8(badDate))) }
        // A digit count from a bad file doesn't throw until the code is asked for, on any client.
        val digits = readText("x.json", "{\"services\":[{\"secret\":\"AAAA\",\"otp\":{\"digits\":\"abc\",\"period\":1.5}}]}").items.single().body.totp!!
        assertNull(digits.digits)
        assertNull(digits.period)
    }

    @Test(timeout = 60_000) fun deepJsonDoesntBlowTheStack() {
        refuses { readText("d.json", "[".repeat(100_000)) }
        refuses { readText("d.json", "{\"a\":".repeat(100_000)) }
        // Deep where a value gets turned into text: either answer, as long as it's an answer.
        val deepField = "[".repeat(50_000) + "]".repeat(50_000)
        readOrRefuse("x.json", utf8("{\"vaults\":{\"a\":{\"items\":[{\"data\":{\"extraFields\":[{\"data\":{\"content\":$deepField}}]}}]}}}"))
    }

    @Test(timeout = 60_000) fun aHugeCsvStopsAtTheLimit() {
        val big = "name,password\n" + "a,b\n".repeat(250_000)
        refusedSaying("too many") { readText("x.csv", big) }
    }

    @Test fun oversizedFilesAreRefusedBeforeReadingThem() {
        refusedSaying("too large") { Importers.importFile("x.csv", ByteArray(Importers.MAX_BYTES + 1)) }
    }

    // ---- Fuzz ----

    @Test(timeout = 120_000) fun randomBytesNeverCrash() {
        val rnd = Random(20261107)
        val names = listOf("x.csv", "x.json", "x.xml", "x.1pux", "x.zip", "x.kdbx", "x.txt")
        val starts = listOf(byteArrayOf(), byteArrayOf(0x50, 0x4b, 3, 4), byteArrayOf(3, 0xd9.toByte(), 0xa2.toByte(), 0x9a.toByte()), utf8("{"), utf8("["), utf8("<"), utf8("otpauth-migration://"), utf8("name,url,username,password\n"))
        repeat(1500) { i ->
            val rest = ByteArray(rnd.nextInt(2000)).also { rnd.nextBytes(it) }
            readOrRefuse(names[i % names.size], starts[i % starts.size] + rest)
        }
    }

    @Test(timeout = 120_000) fun randomStringsShapedLikeEachFormat() {
        val rnd = Random(424242)
        val alphabet = "{}[]\",:<>&;#xX!-_ \n\r\t\\/=+%0123456789abcXYZnull\u00FC\uD83D\uDE00"
        fun js(s: String) = Json.encodeToString(kotlinx.serialization.json.JsonPrimitive.serializer(), kotlinx.serialization.json.JsonPrimitive(s))
        val shapes = listOf<(String) -> String>(
            { s -> "name,url,username,password\n$s\n" },
            { s -> "url,username,password,totp,extra,name,grouping,fav\n$s\n" },
            { s -> "{\"encrypted\":false,\"items\":[{\"type\":1,\"name\":${js(s)},\"login\":{\"uris\":${js(s)}}}]}" },
            { s -> "{\"accounts\":[{\"items\":[{\"credentials\":[{\"type\":${js(s)}}]}]}],\"exporterRpId\":${js(s)}}" },
            { s -> "{\"vaults\":{\"a\":{\"items\":[{\"data\":${js(s)}}]}}}" },
            { s -> "{\"db\":{\"entries\":[{\"type\":\"totp\",\"info\":${js(s)}}]},\"header\":{}}" },
            { s -> "{\"services\":[{\"otp\":${js(s)}}]}" },
            { s -> "otpauth-migration://offline?data=$s" },
            { s -> "<KeePassFile><Root><Group><Entry><String><Key>Title</Key><Value>$s</Value></String></Entry></Group></Root></KeePassFile>" },
            { s -> "<KeePassFile>$s</KeePassFile>" },
            { s -> "{\"vaults\":{$s}}" },
        )
        repeat(3000) { i ->
            val s = String(CharArray(rnd.nextInt(200)) { alphabet[rnd.nextInt(alphabet.length)] })
            readOrRefuse("f.txt", utf8(shapes[i % shapes.size](s)))
        }
    }

    @Test(timeout = 120_000) fun damagedCopiesOfRealFilesNeverCrash() {
        val rnd = Random(99)
        val files = listOf("lastpass.csv", "proton.json", "cxf.json", "aegis.json", "twofas.json", "keepass.xml", "google-migration.txt").map { it to ImportFixtures.bytes(it) } +
            listOf("x.1pux" to ImportFixtures.onePux(), "x.zip" to ImportFixtures.dashlane(), "x.kdbx" to KdbxWriter.write(KdbxWriter.AesRounds(10)))
        repeat(2000) { i ->
            val (name, good) = files[i % files.size]
            val b = good.copyOf()
            repeat(1 + rnd.nextInt(8)) { b[rnd.nextInt(b.size)] = rnd.nextInt(256).toByte() }
            readOrRefuse(name, if (rnd.nextBoolean()) b else b.copyOf(rnd.nextInt(b.size)), PASSWORD)
        }
    }

    // ---- What a file can't bring in ----

    private fun rich(kind: String, extra: String = "") = "{\"v\":1,\"kind\":\"$kind\",\"title\":\"t\",\"createdAt\":\"2026-01-01\",\"updatedAt\":\"2026-01-01\"$extra}"

    @Test fun systemKindsAndInternalFieldsAreRefused() {
        val login = rich("login", ",\"password\":\"p\",\"trustBook\":{\"contacts\":[\"mallory\"]},\"conflicts\":[{}],\"seq\":99,\"pendingPassword\":\"x\",\"sendId\":\"s\",\"urls\":[{\"url\":\"https://a.example/\"}]")
        val items = (listOf("trust", "site_rule", "folder", "prefs", "send", "bookmark", "made-up").map { rich(it, ",\"trustBook\":{\"contacts\":[\"mallory\"]}") } + login).joinToString(",")
        val r = readText("x.json", "{\"format\":\"promptly-pw-plain\",\"items\":[$items]}")
        assertEquals(1, r.items.size)
        val b = r.items.single().body
        for (field in listOf("trustBook", "conflicts", "seq", "pendingPassword", "sendId")) assertNull(field, b[field])
        assertEquals("p", b.password)
    }

    @Test fun whatIsntAWebsiteGetsNoWebsiteMatch() {
        fun url(u: String, match: String? = null) = Importers.sanitize(ImportResult("x", listOf(Imported(newBody("login", "t").withUrls(listOf(org.promptly.sync.passwords.core.LoginUrl(u, match))))), emptyList())).items.single().body.urls.single()
        for (fine in listOf("https://a.example/", "http://a.example", "a.example", "a.example:8443/x", "localhost", "HTTPS://A.EXAMPLE", "host/path", "192.168.1.1:8080")) {
            assertNull(fine, url(fine).match)
            assertEquals(fine, url(fine).url)
        }
        assertEquals("host", url("https://a.example", "host").match)
        for (not in listOf("javascript:alert(1)", "ftp://a.example", "file:///etc/passwd", "data:text/html,x", "chrome://settings", "https://x://y", "about:blank", "", ":", "ssh://me@h", "http\u017F://a.example")) {
            assertEquals(not, "never", url(not).match)
        }
        // Android's own rule goes further than the web's for an app: the app's id is kept, as an app.
        assertEquals(org.promptly.sync.passwords.core.LoginUrl("androidapp://com.acme.app", "never"), url("android://H==@com.acme.app/"))
    }

    @Test fun theRulesApplyToEveryFormat() {
        val zip = ImportFixtures.zip("export.data" to utf8("{\"accounts\":[{\"vaults\":[{\"items\":[{\"categoryUuid\":\"001\",\"overview\":{\"title\":\"X\",\"url\":\"javascript:alert(1)\"}}]}]}]}"))
        assertEquals("never", Importers.importFile("x.1pux", zip).items.single().body.urls.single().match)
        val proton = readText("x.json", "{\"vaults\":{\"a\":{\"items\":[{\"data\":{\"type\":\"login\",\"content\":{\"urls\":[\"ftp://a.example\"]}}}]}}}")
        assertEquals("never", proton.items.single().body.urls.single().match)
        val cxf = readText("x.json", "{\"accounts\":[{\"items\":[{\"scope\":{\"urls\":[\"file:///x\"]}}]}],\"exporterRpId\":\"a\"}")
        assertEquals("never", cxf.items.single().body.urls.single().match)
        val xml = readText("x.xml", "<KeePassFile><Root><Group><Entry><String><Key>URL</Key><Value>javascript:alert(1)</Value></String></Entry></Group></Root></KeePassFile>")
        assertEquals("never", xml.items.single().body.urls.single().match)
    }

    @Test fun importedCodesWork() {
        // Whatever came in, the screen can show a code from it.
        val aegis = Importers.importFile("a.json", ImportFixtures.bytes("aegis.json"))
        assertEquals(8, Totp.code(aegis.items[0].body.totp!!).length)
        assertEquals(5, Totp.code(aegis.items[1].body.totp!!).length)
    }

    @Test fun itemsGoThroughDedupe() {
        val r = Importers.importFile("k.xml", ImportFixtures.bytes("keepass.xml"))
        val (fresh, dups) = Importers.dedupe(r.items, r.items.map { it.body })
        assertTrue(fresh.isEmpty())
        assertEquals(r.items.size, dups)
    }

    @Test
    fun aPasskeyAlreadyStoredWithBitwardensIdStillMatchesAndAnswersWithTheSitesId() {
        val guid = "b0cf2f0b-1a2b-4c3d-8e9f-0a1b2c3d4e5f"
        val site = org.promptly.sync.passwords.core.Passkeys.siteCredentialId(guid)
        val pair = java.security.KeyPairGenerator.getInstance("EC").apply { initialize(java.security.spec.ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val key = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(pair.private.encoded)
        val stored = org.promptly.sync.passwords.core.Passkey(guid, "example.com", null, "dQ", "ana", null, key, 0, "2026-01-01T00:00:00Z", null, true)
        val all = listOf(org.promptly.sync.passwords.core.Passkeys.Usable("item", stored, "Site"))
        assertEquals(1, org.promptly.sync.passwords.core.Passkeys.usable(all, "example.com", listOf(site)).size)
        assertEquals(0, org.promptly.sync.passwords.core.Passkeys.usable(all, "example.com", listOf(guid + "x")).size)
        val answer = org.promptly.sync.passwords.core.Passkeys.getAssertion(stored, "AAAA", "https://example.com", false)
        assertEquals(site, answer.credentialId)
    }
}
