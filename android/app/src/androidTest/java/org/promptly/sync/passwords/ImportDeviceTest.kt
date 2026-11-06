// The other managers' files on the phone itself: through the real import screen and Android's
// own file picker, on the seeded offline vault, and on this runtime's inflater and native Argon2.
// The JVM tests in ImportersTest.kt go through the formats one by one. Test values only.
package org.promptly.sync.passwords

import android.content.ContentValues
import android.content.Intent
import android.os.Environment
import android.provider.MediaStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.passwords.Harness.ctx
import org.promptly.sync.passwords.Harness.device
import org.promptly.sync.passwords.Harness.fill
import org.promptly.sync.passwords.Harness.tap
import org.promptly.sync.passwords.Harness.waitFor
import org.promptly.sync.passwords.core.BouncyCastleArgon2d
import org.promptly.sync.passwords.core.ImportResult
import org.promptly.sync.passwords.core.Importers
import org.promptly.sync.passwords.core.Kdbx
import org.promptly.sync.passwords.core.NeedsPasswordError
import org.promptly.sync.passwords.core.Primitives
import org.promptly.sync.passwords.core.hex
import org.promptly.sync.passwords.ui.PasswordsActivity
import java.io.ByteArrayOutputStream
import java.util.zip.Deflater
import java.util.zip.DeflaterOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

@RunWith(AndroidJUnit4::class)
class ImportDeviceTest {
    private val password = "kdbx test password"

    @Before fun setUp() {
        Harness.home()
        Pw.init(ctx)
        Pw.prefs.lockOnScreenOff = false
        Pw.prefs.setupGuideDone = true
    }

    @After fun removeFiles() {
        ctx.contentResolver.delete(MediaStore.Downloads.EXTERNAL_CONTENT_URI, "${MediaStore.Downloads.DISPLAY_NAME} LIKE ?", arrayOf("pwtest-import-%"))
    }

    private fun fixtureKdbx() = InstrumentationRegistry.getInstrumentation().context.assets.open("passwords/fixture.kdbx").use { it.readBytes() }

    private fun zip(vararg entries: Pair<String, ByteArray>): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { z ->
            for ((name, data) in entries) {
                z.putNextEntry(ZipEntry(name))
                z.write(data)
                z.closeEntry()
            }
        }
        return out.toByteArray()
    }

    /** A real file in Downloads, for the system picker to find. */
    private fun fileInDownloads(name: String, data: ByteArray, mime: String) {
        val r = ctx.contentResolver
        r.delete(MediaStore.Downloads.EXTERNAL_CONTENT_URI, "${MediaStore.Downloads.DISPLAY_NAME}=?", arrayOf(name))
        val uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        })!!
        r.openOutputStream(uri)!!.use { it.write(data) }
    }

    /** Android's own file picker. It may open on Recent, or on the last folder. */
    private fun pickFromSystem(name: String) {
        waitFor(By.pkg("com.google.android.documentsui"), 20_000)
        var hit = device.wait(androidx.test.uiautomator.Until.findObject(By.text(name)), 4_000)
        if (hit == null) {
            device.findObject(By.desc("Show roots"))?.click()
            Thread.sleep(800)
            device.findObject(By.text("Downloads"))?.click()
            hit = waitFor(By.text(name), 10_000)
        }
        hit.click()
    }

    private fun openImport() {
        ctx.startActivity(Intent(ctx, PasswordsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        tap("tab-more", 30_000)
        tap("open-transfer")
    }

    @Test fun aKeePassFileThroughThePickerWithItsPasswordPrompt() {
        val client = Harness.seedOffline()
        val name = "pwtest-import-${System.currentTimeMillis()}.kdbx"
        fileInDownloads(name, fixtureKdbx(), "application/octet-stream")
        openImport()
        tap("import-pick")
        pickFromSystem(name)
        // The screen asks, as the file can't be read without it.
        waitFor(By.res("import-password"), 20_000)
        fill("import-password", "not the password")
        tap("import-open")
        assertTrue(waitFor(By.res("error"), 60_000).text.contains("didn't open"))
        fill("import-password", password)
        tap("import-open")
        assertEquals("KeePass: 3 to add, 0 duplicates left out", waitFor(By.res("import-summary"), 60_000).text)
        waitFor(By.res("import-row-Mail"))
        waitFor(By.res("import-row-Nested"))
        tap("import-confirm")
        waitFor(By.res("transfer-message"), 20_000)
        val mail = client.allItems().first { it.body.title == "Mail" }
        assertEquals("changed-password-2", mail.body.password)
        assertEquals("JBSWY3DPEHPK3PXP", mail.body.totp!!.secret)
        val folders = client.allItems(includeSystem = true).filter { it.body.kind == "folder" }.map { it.body.title }.toSet()
        assertEquals(setOf("Work", "Work/Deep"), folders)
    }

    @Test fun aOnePasswordFileThroughThePicker() {
        val client = Harness.seedOffline()
        val name = "pwtest-import-${System.currentTimeMillis()}.1pux"
        val data = """{"accounts":[{"vaults":[{"attrs":{"name":"Private"},"items":[{"categoryUuid":"001","overview":{"title":"From 1Password","url":"https://a.example"},"details":{"loginFields":[{"value":"ana","designation":"username"},{"value":"pw-1p-1","designation":"password"}]}},{"categoryUuid":"003","overview":{"title":"A note"},"details":{"notesPlain":"text"}}]}]}]}"""
        fileInDownloads(name, zip("export.attributes" to "{\"version\":3}".toByteArray(), "export.data" to data.toByteArray()), "application/octet-stream")
        openImport()
        tap("import-pick")
        pickFromSystem(name)
        assertEquals("1Password: 2 to add, 0 duplicates left out", waitFor(By.res("import-summary"), 20_000).text)
        tap("import-confirm")
        waitFor(By.res("transfer-message"), 20_000)
        assertEquals("pw-1p-1", client.allItems().first { it.body.title == "From 1Password" }.body.password)
        assertEquals("note", client.allItems().first { it.body.title == "A note" }.body.kind)
    }

    @Test fun aHostileFileThroughThePickerShowsAMessage() {
        Harness.seedOffline()
        val name = "pwtest-import-${System.currentTimeMillis()}.xml"
        fileInDownloads(name, "<!DOCTYPE x [<!ENTITY e SYSTEM \"file:///etc/hosts\">]><KeePassFile><Root/></KeePassFile>".toByteArray(), "text/xml")
        openImport()
        tap("import-pick")
        pickFromSystem(name)
        assertTrue(waitFor(By.res("error"), 20_000).text.contains("entities"))
    }

    /** Past the text check that refuses `<!ENTITY`: a DOCTYPE with no entity in it has to stop at the reader itself. */
    @Test fun aDoctypeReachesNothingOnThisRuntime() {
        java.net.ServerSocket(0).use { server ->
            server.soTimeout = 1500
            val url = "http://127.0.0.1:${server.localPort}/evil.dtd"
            for (xml in listOf("<!DOCTYPE KeePassFile SYSTEM \"$url\"><KeePassFile><Root/></KeePassFile>", "<!DOCTYPE KeePassFile SYSTEM \"file:///etc/hosts\"><KeePassFile><Root/></KeePassFile>")) {
                assertTrue(assertThrows(IllegalArgumentException::class.java) { Importers.importFile("x.xml", xml.toByteArray()) }.message!!.contains("DOCTYPE"))
            }
            assertThrows("Something connected", java.net.SocketTimeoutException::class.java) { server.accept() }
        }
    }

    /** What the KDF ceilings come to on this device, for ANDROID_NOTES. Shows the numbers, and checks nothing about speed. */
    @Test fun whatTheCeilingsCost() {
        fun millis(block: () -> Unit): Long {
            val start = System.nanoTime()
            block()
            return (System.nanoTime() - start) / 1_000_000
        }
        val megabytes = 256
        val passes = 4
        val argon = millis { Primitives.argon2dEngine.hash(ByteArray(32) { 1 }, ByteArray(32) { 2 }, megabytes * 1024, passes, 2, 32) }
        val rounds = 2_000_000
        val aes = org.bouncycastle.crypto.engines.AESEngine.newInstance()
        aes.init(true, org.bouncycastle.crypto.params.KeyParameter(ByteArray(32) { 3 }))
        val block = ByteArray(32)
        val roundsTook = millis {
            repeat(rounds) {
                aes.processBlock(block, 0, block, 0)
                aes.processBlock(block, 16, block, 16)
            }
        }
        val gib = 1024.0 * 1024 * 1024
        val workGib = (megabytes * passes) / 1024.0
        val report = "argon2d native $megabytes MiB x $passes passes, 2 lanes: $argon ms, so MAX_WORK (${(Kdbx.MAX_WORK / gib).toInt()} GiB) is about ${(argon / workGib * (Kdbx.MAX_WORK / gib) / 1000).toInt()} s. " +
            "AES $rounds rounds: $roundsTook ms, so MAX_ROUNDS (${Kdbx.MAX_ROUNDS}) is about ${(roundsTook.toDouble() / rounds * Kdbx.MAX_ROUNDS / 1000).toInt()} s."
        android.util.Log.i("PwImportCost", report)
        InstrumentationRegistry.getInstrumentation().sendStatus(0, android.os.Bundle().apply { putString("ceilings", report) })
    }

    @Test fun theNativeArgon2OpensAKeePassFile() {
        assertNotNull("argon2kt didn't load on this ABI", Pw.nativeArgon2d())
        assertTrue("The app should be using the native engine", Primitives.argon2dEngine !== BouncyCastleArgon2d)
        val salt = ByteArray(16) { 5 }
        assertEquals(hex(BouncyCastleArgon2d.hash("a".toByteArray(), salt, 256, 2, 2, 32)), hex(Primitives.argon2dEngine.hash("a".toByteArray(), salt, 256, 2, 2, 32)))
        // Argon2d, 64 MiB, 14 passes, 2 lanes, AES and gzip, from pykeepass.
        val r = Importers.importFile("fixture.kdbx", fixtureKdbx(), password)
        assertEquals(3, r.items.size)
        assertThrows(NeedsPasswordError::class.java) { Importers.importFile("fixture.kdbx", fixtureKdbx()) }
    }

    /** The files the JVM tests and the TypeScript read, on Android's regex engine, inflater and crypto
     *  providers. Every format, with something from inside each to show it was really read. */
    @Test fun everyFormatOnThisRuntime() {
        fun asset(name: String) = InstrumentationRegistry.getInstrumentation().context.assets.open("passwords/$name").use { it.readBytes() }
        fun check(name: String, bytes: ByteArray, format: String, count: Int, password: String? = null, inside: (ImportResult) -> Any?) {
            val r = Importers.importFile(name, bytes, password)
            assertEquals(name, format, r.format)
            assertEquals(name, count, r.items.size)
            assertEquals(name, true, inside(r))
        }
        fun ImportResult.titled(title: String) = items.first { it.body.title == title }.body

        check("lastpass.csv", asset("lastpass.csv"), "LastPass", 4) { it.items[1].body.kind == "note" && it.items[0].body.totp!!.secret == "JBSWY3DPEHPK3PXP" }
        check("chrome.csv", asset("chrome.csv"), "Browser", 2) { it.titled("GitHub").password == "pw1" && it.titled("x.org").username == "bob" }
        check("firefox.csv", asset("firefox.csv"), "Firefox", 1) { it.items[0].body.password == "p" }
        check("apple.csv", asset("apple.csv"), "Apple Passwords", 1) { it.titled("Example").totp!!.issuer == "E" }
        check("odd-columns.csv", asset("odd-columns.csv"), "CSV", 2) { it.items[0].body.tags == listOf("one", "two", "three") }
        check("bitwarden.json", asset("bitwarden.json"), "Bitwarden", 5) { it.titled("Card").kind == "card" && it.titled("SSH").kind == "ssh" }
        check("proton.json", asset("proton.json"), "Proton Pass", 7) { p -> p.titled("A").totp!!.secret == "JBSWY3DPEHPK3PXP" && p.items.none { it.body.title == "Trashed" } && p.titled("C").str("cardExpMonth") == "05" }
        check("cxf.json", asset("cxf.json"), "Credential Exchange", 9) { it.titled("Login").passkeys.single().rpId == "a.example" && it.titled("Wifi").kind == "wifi" }
        check("aegis.json", asset("aegis.json"), "Aegis", 3) { it.items[1].body.totp!!.steam }
        check("twofas.json", asset("twofas.json"), "2FAS", 3) { it.titled("Valve").totp!!.steam }
        check("google-migration.txt", asset("google-migration.txt"), "Google Authenticator", 3) { it.titled("Acme: bob").totp!!.algorithm == "SHA256" }
        check("keepass.xml", asset("keepass.xml"), "KeePass", 4) { it.titled("A").password == "p&w!" && it.items.first { i -> i.body.title == "C & <d>" }.folder == "Sub/Deep <er>" && it.titled("B").notes == "line one\nline two\nline three" }
        check("x.1pux", zip("export.attributes" to "{\"version\":3}".toByteArray(), "export.data" to asset("onepux-export.data.json")), "1Password", 5) { it.titled("Login").password == "pw" && it.titled("A card").kind == "card" }
        check(
            "dashlane.zip",
            zip("credentials.csv" to asset("dashlane-credentials.csv"), "securenotes.csv" to asset("dashlane-securenotes.csv"), "payments.csv" to asset("dashlane-payments.csv"), "ids.csv" to asset("dashlane-ids.csv"), "other.csv" to asset("dashlane-other.csv")),
            "Dashlane",
            5,
        ) { it.titled("Card").str("cardNumber") == "12345" && it.titled("Ana Bee").kind == "identity" }
        // ChaCha20 and Argon2id, then AES, Argon2d and 300 entries' worth of inner stream, both from pykeepass.
        check("chacha-argon2id.kdbx", asset("chacha-argon2id.kdbx"), "KeePass", 2, password) { it.titled("Alpha").password == "pw-chacha-argon2id.kdbx-1" && it.titled("Beta").password == "pw-beta-2" }
        check("large.kdbx", asset("large.kdbx"), "KeePass", 300, password) { it.titled("Entry 299").password == "bulk-test-password-299-with-some-length" }
        // What the sanitizer does has to come out the same on this regex engine.
        val odd = Importers.importFile("x.xml", "<KeePassFile><Root><Group><Entry><String><Key>URL</Key><Value>javascript:alert(1)</Value></String></Entry></Group></Root></KeePassFile>".toByteArray())
        assertEquals("never", odd.items.single().body.urls.single().match)
        val fine = Importers.importFile("x.xml", "<KeePassFile><Root><Group><Entry><String><Key>URL</Key><Value>a.example:8443/x</Value></String></Entry></Group></Root></KeePassFile>".toByteArray())
        assertEquals(null, fine.items.single().body.urls.single().match)
    }

    @Test(timeout = 30_000) fun bombsOnThisRuntimesInflater() {
        val kernel = Deflater(9, true).let { d ->
            val out = ByteArrayOutputStream()
            DeflaterOutputStream(out, d).use { it.write(ByteArray(100 * 1024 * 1024)) }
            d.end()
            out.toByteArray()
        }
        // A .1pux with a lying header: says 100 bytes, inflates to 100 MiB.
        val lying = onlyEntry("export.data", kernel, 100)
        assertTrue(assertThrows(IllegalArgumentException::class.java) { Importers.importFile("x.1pux", lying) }.message!!.contains("too large"))
        val honest = onlyEntry("export.data", kernel, 100L * 1024 * 1024)
        assertTrue(assertThrows(IllegalArgumentException::class.java) { Importers.importFile("x.1pux", honest) }.message!!.contains("too large"))
        val cut = zip("export.data" to "{}".toByteArray()).let { it.copyOf(it.size - 5) }
        assertThrows(IllegalArgumentException::class.java) { Importers.importFile("x.1pux", cut) }
    }

    @Test fun theLimitOnMemoryComesFromTheScreen() {
        Kdbx.memoryLimit = 1024
        try {
            assertTrue(assertThrows(IllegalArgumentException::class.java) { Importers.importFile("fixture.kdbx", fixtureKdbx(), password) }.message!!.contains("this phone"))
        } finally {
            Kdbx.memoryLimit = Kdbx.MAX_MEMORY
        }
    }

    private fun onlyEntry(name: String, deflated: ByteArray, declared: Long): ByteArray {
        val out = ByteArrayOutputStream()
        fun u16(v: Int) {
            out.write(v and 255)
            out.write((v ushr 8) and 255)
        }
        fun u32(v: Long) {
            u16((v and 0xffff).toInt())
            u16(((v ushr 16) and 0xffff).toInt())
        }
        val n = name.toByteArray()
        u32(0x04034B50L); u16(20); u16(0); u16(8); u16(0); u16(0); u32(0); u32(deflated.size.toLong()); u32(declared); u16(n.size); u16(0)
        out.write(n)
        out.write(deflated)
        val cd = out.size().toLong()
        u32(0x02014B50L); u16(20); u16(20); u16(0); u16(8); u16(0); u16(0); u32(0); u32(deflated.size.toLong()); u32(declared); u16(n.size); u16(0); u16(0); u16(0); u16(0); u32(0); u32(0)
        out.write(n)
        val size = out.size().toLong() - cd
        u32(0x06054B50L); u16(0); u16(0); u16(1); u16(1); u32(size); u32(cd); u16(0)
        return out.toByteArray()
    }
}
