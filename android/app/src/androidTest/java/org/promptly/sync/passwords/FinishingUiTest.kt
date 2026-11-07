// What finished the client, through the real screens. Three settings: the seeded offline vault; a
// small server in this test, on the phone, for answers the real stack can't be made to give (an old
// kit date, a known directory, an icon); and the real :8092 stack with throwaway users the host
// passes in. Chrome is never opened: its row in the guide is looked at, and its button isn't tapped.
package org.promptly.sync.passwords

import android.content.ContentValues
import android.content.Intent
import android.os.Environment
import android.provider.MediaStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.passwords.Harness.TEST_BROWSER
import org.promptly.sync.passwords.Harness.ctx
import org.promptly.sync.passwords.Harness.device
import org.promptly.sync.passwords.Harness.fill
import org.promptly.sync.passwords.Harness.has
import org.promptly.sync.passwords.Harness.launch
import org.promptly.sync.passwords.Harness.tap
import org.promptly.sync.passwords.Harness.waitFor
import org.promptly.sync.passwords.Harness.waitText
import org.promptly.sync.passwords.autofill.AutofillAuthActivity
import org.promptly.sync.passwords.autofill.AutofillIndex
import org.promptly.sync.passwords.autofill.FillTarget
import org.promptly.sync.passwords.autofill.IndexEntry
import org.promptly.sync.passwords.autofill.IndexLookup
import org.promptly.sync.passwords.autofill.ParsedForm
import org.promptly.sync.passwords.core.Attachments
import org.promptly.sync.passwords.core.Importers
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.MemoryKeeper
import org.promptly.sync.passwords.core.MemoryStore
import org.promptly.sync.passwords.core.SecureSend
import org.promptly.sync.passwords.core.VaultApi
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.newBody
import org.promptly.sync.passwords.ui.PasswordsActivity
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/** A server on the phone, for answers the stack can't give on demand. It knows a few paths and says
 *  503 to the rest, which the client takes as the server being down. */
internal class TinyServer(private val answers: MutableMap<String, Pair<String, ByteArray>>) {
    val calls = CopyOnWriteArrayList<String>()
    val bodies = CopyOnWriteArrayList<String>()
    private val socket = ServerSocket(PORT, 16, InetAddress.getByName("localhost"))

    init {
        thread(isDaemon = true) {
            while (!socket.isClosed) {
                val c = runCatching { socket.accept() }.getOrNull() ?: break
                thread(isDaemon = true) { runCatching { serve(c) } }
            }
        }
    }

    private fun serve(c: java.net.Socket) = c.use {
        val input = c.getInputStream().buffered()
        fun line(): String {
            val b = StringBuilder()
            while (true) {
                val ch = input.read()
                if (ch < 0 || ch == '\n'.code) return b.toString().trimEnd('\r')
                b.append(ch.toChar())
            }
        }
        val request = line().split(' ')
        var length = 0
        while (true) {
            val h = line()
            if (h.isEmpty()) break
            if (h.startsWith("content-length:", true)) length = h.substringAfter(':').trim().toIntOrNull() ?: 0
        }
        val body = ByteArray(length)
        var got = 0
        while (got < length) {
            val n = input.read(body, got, length - got)
            if (n < 0) break
            got += n
        }
        val key = "${request[0]} ${request[1].substringBefore('?')}"
        calls += key
        bodies += String(body)
        val answer = answers[key]
        if (slowMs > 0) Thread.sleep(slowMs)
        val out = c.getOutputStream()
        val bytes = answer?.second ?: "{\"detail\":\"down\"}".toByteArray()
        out.write("HTTP/1.1 ${if (key in refusing) "403 No" else if (answer == null) "503 Down" else "200 OK"}\r\nContent-Type: ${answer?.first ?: "application/json"}\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
        out.write(bytes)
        out.flush()
    }

    fun json(path: String, text: String) { answers["GET /api/passwords$path"] = "application/json" to text.toByteArray() }

    fun answersFor(key: String, type: String, bytes: ByteArray) { answers[key] = type to bytes }

    private val refusing = HashSet<String>()

    /** Says 403 to this, as a server does to a device token without the scope. */
    fun answersFor403(key: String) { refusing += key }

    /** How long each answer takes, for a request caught in flight. */
    @Volatile
    var slowMs = 0L

    fun close() = runCatching { socket.close() }

    companion object {
        const val PORT = 18766
        const val URL = "http://localhost:$PORT"
    }
}

/** A real 2x2 PNG, so the system's own decoder has something to read. */
private val PNG: ByteArray by lazy {
    val bmp = android.graphics.Bitmap.createBitmap(2, 2, android.graphics.Bitmap.Config.ARGB_8888)
    bmp.eraseColor(android.graphics.Color.RED)
    java.io.ByteArrayOutputStream().also { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
}

@RunWith(AndroidJUnit4::class)
class FinishingUiTest {
    private var server: TinyServer? = null

    @Before fun setUp() {
        Harness.home()
        Pw.init(ctx)
        Pw.prefs.lockOnScreenOff = false
        Pw.prefs.setupGuideDone = true
    }

    @After fun tearDown() {
        server?.close()
        Harness.shell("am force-stop $TEST_BROWSER")
        Harness.shell("settings delete secure autofill_service")
        Harness.shell("settings delete secure credential_service")
        Harness.shell("settings delete secure credential_service_primary")
        Harness.home()
    }

    private fun open() {
        ctx.startActivity(Intent(ctx, PasswordsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** The seeded vault with its server pointed here: unlocked already, so nothing needs a login. */
    private fun seedWithServer(): Pair<VaultClient, TinyServer> {
        Harness.seedOffline(TinyServer.URL)
        val client = Pw.client()!!
        val s = TinyServer(HashMap())
        server = s
        return client to s
    }

    private fun waitUntil(what: String, ms: Long = 20_000, check: () -> Boolean) {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) {
            if (check()) return
            Thread.sleep(200)
        }
        throw AssertionError("$what\nWindow:\n${Harness.dumpWindow()}")
    }

    private fun fileInDownloads(name: String, bytes: ByteArray) {
        val r = ctx.contentResolver
        r.delete(MediaStore.Downloads.EXTERNAL_CONTENT_URI, "${MediaStore.Downloads.DISPLAY_NAME}=?", arrayOf(name))
        val uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream")
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        })!!
        r.openOutputStream(uri)!!.use { it.write(bytes) }
    }

    private fun pickFromSystem(name: String) {
        waitFor(By.pkg("com.google.android.documentsui"), 20_000)
        var hit = device.wait(Until.findObject(By.text(name)), 4_000)
        if (hit == null) {
            device.findObject(By.desc("Show roots"))?.click()
            Thread.sleep(800)
            device.findObject(By.text("Downloads"))?.click()
            hit = waitFor(By.text(name), 10_000)
        }
        hit.click()
    }

    // ---- Folders, tags, icons ----------------------------------------------------------

    @Test fun filterByTag() {
        val client = Harness.seedOffline()
        val vault = client.personalVaultId()
        fun tagged(title: String, vararg tags: String) = client.saveNew(vault, newBody("login", title).with("tags" to kotlinx.serialization.json.JsonArray(tags.map { JsonPrimitive(it) })))
        tagged("Work one", "work")
        tagged("Both", "work", "home")
        tagged("Home one", "home")
        client.saveNew(vault, newBody("login", "No tags"))
        open()
        waitFor(By.res("tag-work"), 30_000)
        waitFor(By.res("tag-home"))
        tap("tag-work")
        waitFor(By.res("item-Work one"))
        waitFor(By.res("item-Both"))
        assertTrue(Harness.gone(By.res("item-Home one")))
        assertFalse(has(By.res("item-No tags"), 300))
        // Picking the other one swaps; picking it again clears.
        tap("tag-home")
        waitFor(By.res("item-Home one"))
        waitFor(By.res("item-Both"))
        assertTrue(Harness.gone(By.res("item-Work one")))
        tap("tag-home")
        waitFor(By.res("item-No tags"))
        // The last item with a tag going takes the chip, and the filter, with it.
        tap("tag-work")
        waitFor(By.res("item-Both"))
        val both = client.allItems().first { it.body.title == "Both" }
        val one = client.allItems().first { it.body.title == "Work one" }
        client.update(both.id, both.body.with("tags" to kotlinx.serialization.json.JsonArray(listOf(JsonPrimitive("home")))))
        client.update(one.id, one.body.with("tags" to null))
        assertTrue(Harness.gone(By.res("tag-work"), 10_000))
        waitFor(By.res("item-No tags"))
    }

    @Test fun renameAndDeleteAFolder() {
        val client = Harness.seedOffline()
        val vault = client.personalVaultId()
        val folder = client.saveNew(vault, newBody("folder", "Old name"))
        val inside = client.saveNew(vault, newBody("login", "In it").with("folderId" to JsonPrimitive(folder.id)))
        val archived = client.saveNew(vault, newBody("login", "Archived in it").with("folderId" to JsonPrimitive(folder.id)).withFlag("archived", true))
        val outside = client.saveNew(vault, newBody("login", "Elsewhere"))
        open()
        tap("folder-Old name", 30_000)
        waitFor(By.res("item-In it"))
        assertTrue(Harness.gone(By.res("item-Elsewhere")))
        tap("folder-rename")
        fill("folder-name", "New name")
        tap("folder-name-save")
        waitFor(By.res("folder-New name"), 15_000)
        assertEquals("New name", client.get(folder.id)!!.body.title)
        // Still filtering on it, under its new name.
        assertFalse(has(By.res("item-Elsewhere"), 300))
        // Keep it: nothing happens.
        tap("folder-delete")
        waitFor(By.textContains("What's in it stays"))
        device.pressBack()
        assertEquals("new", false, client.get(folder.id)!!.deleted)
        tap("folder-delete")
        tap("folder-delete-confirm")
        assertTrue(Harness.gone(By.res("folder-New name"), 15_000))
        // The filter's gone with it, and everything in it stays, out of the folder, as on the web.
        waitFor(By.res("item-In it"))
        waitFor(By.res("item-Elsewhere"))
        assertTrue(client.get(folder.id)!!.deleted)
        assertEquals(JsonNull, client.get(inside.id)!!.body["folderId"])
        assertEquals(JsonNull, client.get(archived.id)!!.body["folderId"])
        assertNull(client.get(outside.id)!!.body["folderId"])
        assertFalse(client.get(inside.id)!!.deleted)
    }

    @Test fun iconsStayOffUntilThisVaultSaysYes() {
        val (client, s) = seedWithServer()
        s.answerIcon()
        val vault = client.personalVaultId()
        client.saveNew(vault, newBody("login", "With a site").withUrls(listOf(LoginUrl("https://www.icon-test.example/login"))))
        client.saveNew(vault, newBody("login", "An IP").withUrls(listOf(LoginUrl("http://192.168.1.10"))))
        open()
        waitFor(By.res("item-With a site"), 30_000)
        Thread.sleep(1500)
        assertTrue("Off by default, nothing goes out: ${s.calls}", s.calls.none { it.endsWith("/icon") })
        assertFalse(has(By.res("site-icon-www.icon-test.example"), 300))
        tap("tab-more")
        Harness.scrollTap("open-settings")
        Harness.scrollTap("icons-personal")
        waitUntil("The toggle didn't save") { vault in client.iconVaults() }
        // The same row and value the web's toggle writes.
        val row = client.allItems(includeSystem = true).single { it.body.kind == "prefs" }
        assertEquals("vault-prefs", row.body.title)
        assertTrue(row.body.bool("icon"))
        device.pressBack()
        tap("tab-items")
        waitFor(By.res("site-icon-www.icon-test.example"), 20_000)
        val asked = s.calls.count { it.endsWith("/icon") }
        assertEquals("Only the one that's a real domain, and nothing about who's asking", 1, asked)
        assertTrue(s.bodies.first { it.contains("domain") }.contains("www.icon-test.example"))
        // Back off, and it's gone from the list.
        tap("tab-more")
        Harness.scrollTap("open-settings")
        Harness.scrollTap("icons-personal")
        waitUntil("The toggle didn't save") { vault !in client.iconVaults() }
        device.pressBack()
        tap("tab-items")
        assertTrue(Harness.gone(By.res("site-icon-www.icon-test.example"), 10_000))
    }

    private fun TinyServer.answerIcon() {
        answersFor("POST /api/passwords/icon", "image/png", PNG)
    }

    /** Whatever comes back as an icon, the real decoder decides. */
    @Test fun bytesThatArentAnImageDecodeToNothing() {
        assertNull(SiteIconCache.decode(ByteArray(0)))
        assertNull(SiteIconCache.decode("<svg onload=alert(1)>".toByteArray()))
        assertNull(SiteIconCache.decode(org.promptly.sync.passwords.core.randomBytes(4096)))
        assertNotNull(SiteIconCache.decode(PNG))
        // A huge picture isn't taken in at its size, whatever a site sends.
        val big = android.graphics.Bitmap.createBitmap(2048, 2048, android.graphics.Bitmap.Config.ARGB_8888)
        val bytes = java.io.ByteArrayOutputStream().also { big.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        assertTrue(SiteIconCache.decode(bytes)!!.width <= 192)
    }

    // ---- Duplicates and the Security check ------------------------------------------------

    @Test fun duplicatesMergeFromTheSecurityCheck() {
        val client = Harness.seedOffline()
        val vault = client.personalVaultId()
        val older = client.saveNew(vault, newBody("login", "Same site").withText("username", "ana").withText("password", "pw-Older-1!").withText("notes", "older note").withUrls(listOf(LoginUrl("https://www.dup.example"), LoginUrl("https://other.dup2.example"))))
        Thread.sleep(10)
        val newer = client.saveNew(vault, newBody("login", "Same site").withText("username", "ANA").withText("password", "pw-Newer-1!").withUrls(listOf(LoginUrl("https://dup.example"))))
        client.saveNew(vault, newBody("login", "Someone else").withText("username", "bob").withText("password", "pw-Bob-1!").withUrls(listOf(LoginUrl("https://dup.example"))))
        open()
        tap("tab-more", 30_000)
        tap("open-security")
        waitFor(By.res("duplicates"), 15_000)
        assertTrue(waitFor(By.res("duplicate-Same site")).findObject(By.textContains("2 copies")) != null)
        tap("duplicate-merge")
        assertTrue(Harness.gone(By.res("duplicates"), 15_000))
        val kept = client.get(newer.id)!!
        assertEquals("The newest stays", "pw-Newer-1!", kept.body.password)
        assertEquals("pw-Older-1!", kept.body.passwordHistory.single().first)
        assertEquals(listOf("https://dup.example", "https://www.dup.example", "https://other.dup2.example"), kept.body.urls.map { it.url })
        assertEquals("older note", kept.body.notes)
        assertTrue("The other's in Trash", client.get(older.id)!!.deleted)
        // It's back from the Trash if wanted, like anything else.
        device.pressBack()
        tap("open-trash")
        waitFor(By.res("trash-Same site"), 10_000)
    }

    @Test fun passkeyDirectorySitsBesideTheTwoFactorOne() {
        val (client, s) = seedWithServer()
        s.json("/directory", """{"twofa":{"tfa-site.example":{"documentation":"https://doc"}},"passkeys":{"pk-site.example":true}}""")
        val vault = client.personalVaultId()
        client.saveNew(vault, newBody("login", "Passkey site").withText("password", "kX9!vQ2#mL7pR4zQ").withUrls(listOf(LoginUrl("https://pk-site.example"))))
        client.saveNew(vault, newBody("login", "Second factor site").withText("password", "kX9!vQ2#mL7pR4zQa").withUrls(listOf(LoginUrl("https://tfa-site.example"))))
        open()
        tap("tab-more", 30_000)
        tap("open-security")
        assertEquals("Checked 2 logins.", waitFor(By.res("health-checked"), 30_000).text)
        Harness.scrollTap("health-nopasskey")
        assertEquals("1", waitFor(By.res("health-count-nopasskey")).text)
        waitFor(By.textContains("Passkey site"))
        Harness.scrollTap("health-no2fa")
        assertEquals("1", waitFor(By.res("health-count-no2fa")).text)
        Harness.scrollToTag("health-credit")
        assertTrue(waitFor(By.res("health-credit")).text.contains("Passkeys Directory by 2factorauth"))
    }

    // ---- Guided setup ----------------------------------------------------------------------

    /** Wait for the app to come back in front after a system screen. */
    private fun backToGuide() {
        var tries = 0
        while (!has(By.res("setup-guide"), 1_500) && tries++ < 4) device.pressBack()
        waitFor(By.res("setup-guide"), 5_000)
    }

    @Test fun guidedSetupLeadsThroughAndDoesntComeBack() {
        Harness.seedOffline()
        Harness.shell("settings delete secure autofill_service")
        Harness.shell("settings delete secure credential_service")
        Harness.shell("settings delete secure credential_service_primary")
        Pw.prefs.setupGuideDone = false
        open()
        waitFor(By.res("setup-guide"), 30_000)
        assertFalse("The vault waits behind it", has(By.res("search"), 300))

        // Step one: the real system screen, and back here with it not done.
        assertFalse(waitFor(By.res("setup-autofill-state")).text == "Done.")
        tap("setup-autofill-open")
        waitFor(By.pkg("com.android.settings"), 15_000)
        backToGuide()
        assertFalse(waitFor(By.res("setup-autofill-state")).text == "Done.")
        // Turned on from outside, as Android's own screen would do, and it notices on return.
        Harness.shell("settings put secure autofill_service ${Harness.AUTOFILL}")
        device.pressHome()
        Thread.sleep(500)
        open()
        waitFor(By.res("setup-guide"), 15_000)
        waitFor(By.res("setup-autofill-state")).also { assertEquals("Done.", it.text) }
        assertFalse(has(By.res("setup-autofill-open"), 300))

        if (android.os.Build.VERSION.SDK_INT >= 34) {
            tap("setup-credential-open")
            waitFor(By.pkg("com.android.settings"), 15_000)
            backToGuide()
            Harness.shell("settings put secure credential_service ${Harness.CREDENTIAL}")
            Harness.shell("settings put secure credential_service_primary ${Harness.CREDENTIAL}")
            device.pressHome()
            Thread.sleep(500)
            open()
            waitFor(By.res("setup-guide"), 15_000)
            assertEquals("Done.", waitFor(By.res("setup-credential-state")).text)
        }

        // Chrome's step shows if it's installed. Its button isn't tapped: Chrome stays unopened here.
        ChromeSetup.installedChannels(ctx).forEach { pkg ->
            Harness.scrollToTag("setup-chrome-$pkg-state")
            val text = waitFor(By.res("setup-chrome-$pkg-state")).text
            assertTrue(text, text.contains("Autofill using another service") || text.contains("doesn't report") || text == "Done.")
        }

        Harness.scrollTap("setup-finish")
        waitFor(By.res("search"), 20_000)
        assertTrue(Pw.prefs.setupGuideDone)

        // Not again: not in a new window, and not after a lock.
        device.pressBack()
        Thread.sleep(500)
        open()
        waitFor(By.res("search"), 20_000)
        assertFalse(has(By.res("setup-guide"), 500))
        Pw.client()!!.lock()
        Thread.sleep(500)
        fill("master-password", Harness.MASTER)
        tap("unlock")
        waitFor(By.res("search"), 30_000)
        assertFalse(has(By.res("setup-guide"), 500))
    }

    @Test fun guidedSetupCanBeSkippedForGood() {
        Harness.seedOffline()
        Harness.shell("settings delete secure autofill_service")
        Pw.prefs.setupGuideDone = false
        open()
        waitFor(By.res("setup-guide"), 30_000)
        Harness.scrollTap("setup-skip")
        waitFor(By.res("search"), 20_000)
        assertTrue(Pw.prefs.setupGuideDone)
        device.pressHome()
        open()
        waitFor(By.res("search"), 20_000)
        assertFalse(has(By.res("setup-guide"), 500))
        // What's in it lives on in Settings.
        tap("tab-more")
        Harness.scrollTap("open-settings")
        waitFor(By.res("autofill-enable"), 15_000)
        // Forgetting a vault doesn't start it over: the phone's settings are what it's about.
        Pw.forgetDevice()
        assertTrue(Pw.prefs.setupGuideDone)
    }

    // ---- Survival -------------------------------------------------------------------------

    private fun survival(kit: Boolean, kitAt: String = "2026-11-01T00:00:00Z", offsite: Boolean = true, age: String = "1", admin: Boolean = false) =
        """{"is_admin":$admin,"kit_confirmed":$kit,"kit_confirmed_at":${if (kit) "\"$kitAt\"" else "null"},"offsite_configured":$offsite,"last_backup_at":null,"backup_age_days":$age}"""

    private val ageOld: String get() = java.time.Instant.now().minusSeconds(200L * 86400).toString()

    @Test fun theSurvivalWarningsShowOnTheSecurityCheck() {
        val (client, s) = seedWithServer()
        s.json("/survival", survival(true, offsite = false, age = "null"))
        open()
        tap("tab-more", 30_000)
        tap("open-security")
        waitFor(By.res("survival"), 20_000)
        waitFor(By.res("survival-offsite"))
        waitFor(By.textContains("Whoever runs this server"))
        waitFor(By.res("survival-backup"))
        waitFor(By.text("This server hasn't made a backup yet."))
        assertFalse(has(By.res("survival-kit"), 300))
        // The export it points at.
        tap("survival-export")
        waitFor(By.res("import-pick"), 10_000)
        device.pressBack()
        device.waitForIdle()
        client.hashCode()
    }

    @Test fun anAdminIsToldAboutBackupsDifferently() {
        val (_, s) = seedWithServer()
        s.json("/survival", survival(true, offsite = false, age = "40", admin = true))
        open()
        tap("tab-more", 30_000)
        tap("open-security")
        waitFor(By.textContains("No off-site backup is set up"), 20_000)
        waitFor(By.textContains("The last backup on this server was 40 days ago."))
    }

    @Test fun beingCutOffFromTheServerForDaysIsSaidOutLoud() {
        val client = Harness.seedOffline()
        client.store.setMeta("last_sync", JsonPrimitive(System.currentTimeMillis() - 5 * 86_400_000L))
        open()
        tap("tab-more", 30_000)
        tap("open-security")
        waitFor(By.res("survival-unreachable"), 20_000)
        waitFor(By.textContains("hasn't reached your server for 5 days"))
    }

    @Test fun anUnconfirmedKitBlocksUntilTheLastGroupIsTyped() {
        val (client, s) = seedWithServer()
        s.json("/survival", survival(false))
        s.answersFor("POST /api/passwords/account/kit", "application/json", "{}".toByteArray())
        s.json("/device-requests", "[]")
        open()
        waitFor(By.res("kit-gate"), 30_000)
        assertFalse("Nothing else on screen but this", has(By.res("search"), 300))
        val key = waitFor(By.res("kit-gate-key")).text
        assertEquals(org.promptly.sync.passwords.core.SecretKeys.encode(client.keeper.load()!!), key)
        fill("kit-gate-typed", "WRONG")
        tap("kit-gate-done")
        waitFor(By.textContains("That's not the last group"))
        assertTrue(s.calls.none { it.endsWith("/account/kit") })
        s.json("/survival", survival(true))
        fill("kit-gate-typed", org.promptly.sync.passwords.core.SecretKeys.lastGroup(key))
        tap("kit-gate-done")
        waitFor(By.res("search"), 20_000)
        assertTrue(s.calls.any { it == "POST /api/passwords/account/kit" })
    }

    /** A row whose contact isn't compared, as a server that's swapped in its own key would want it:
     *  accepted, and the screen looking every five seconds. It only asks for the words. */
    @Test fun aContactWhoseWordsArentComparedGetsNothingSealedUntilTheyAre() {
        val (client, s) = seedWithServer()
        s.json("/survival", survival(true))
        s.json("/device-requests", "[]")
        s.json("/people", "[]")
        val id = java.util.UUID.randomUUID().toString()
        val keys = org.promptly.sync.passwords.core.Keyset.random()
        val row = """{"id":"e1","grantor_id":"${client.userId}","grantor":"me","grantee_id":"$id","grantee":"contact","wait_days":3,"state":"accepted","wrapped":{},"opened_vaults":[]}"""
        s.json("/users/$id/keys", """{"user_id":"$id","username":"contact","x25519_pub":"${org.promptly.sync.passwords.core.b64u(keys.x25519Pub)}","ed25519_pub":"${org.promptly.sync.passwords.core.b64u(keys.ed25519Pub)}"}""")
        s.answersFor("POST /api/passwords/emergency", "application/json", row.toByteArray())
        s.answersFor("PUT /api/passwords/emergency/e1/wrap", "application/json", "{}".toByteArray())
        s.json("/emergency", "[$row]")
        client.emergencyInvite(id, 3)
        open()
        tap("tab-more", 30_000)
        tap("open-emergency")
        waitFor(By.res("emergency-compare"), 20_000)
        assertEquals(org.promptly.sync.passwords.core.EmergencyText.COMPARE, waitFor(By.res("emergency-state")).text)
        val looks = s.calls.count { it == "GET /api/passwords/emergency" }
        waitUntil("The screen should keep looking") { s.calls.count { it == "GET /api/passwords/emergency" } >= looks + 2 }
        assertFalse("Sealed on the server's word", s.calls.any { it.endsWith("/wrap") })

        tap("emergency-compare")
        assertEquals(client.identityWordsFor(id).joinToString(" "), waitFor(By.res("emergency-words"), 15_000).text)
        tap("emergency-not-now")
        assertTrue(Harness.gone(By.res("emergency-words"), 10_000))
        assertEquals(false, client.trustEntries()[id]?.verified)
        assertFalse(s.calls.any { it.endsWith("/wrap") })

        tap("emergency-compare")
        waitFor(By.res("emergency-words"), 15_000)
        tap("emergency-match")
        waitUntil("Sealed once they match") { s.calls.any { it == "PUT /api/passwords/emergency/e1/wrap" } }
        assertEquals(true, client.trustEntries()[id]?.verified)
        waitFor(By.text("Finishing on this device."), 20_000)
        assertFalse(has(By.res("emergency-compare"), 300))
    }

    /** A server that can't or won't take the answer doesn't get to shut anyone out of this phone. */
    @Test fun aServerThatWontTakeTheKitAnswerCantWallOffTheVault() {
        val (_, s) = seedWithServer()
        s.json("/survival", survival(false))
        s.json("/device-requests", "[]")
        // No answer for POST /account/kit: every try's a 503.
        open()
        waitFor(By.res("kit-gate"), 30_000)
        assertFalse("Not until they've tried", has(By.res("kit-gate-later"), 300))
        val key = waitFor(By.res("kit-gate-key")).text
        fill("kit-gate-typed", org.promptly.sync.passwords.core.SecretKeys.lastGroup(key))
        tap("kit-gate-done")
        waitUntil("It should have tried") { s.calls.any { it == "POST /api/passwords/account/kit" } }
        waitFor(By.res("error"), 20_000)
        Harness.scrollTap("kit-gate-later")
        waitFor(By.res("search"), 20_000)
        // It keeps saying no, and the next look a minute later doesn't take the screen back.
        val looks = s.calls.count { it.endsWith("/survival") }
        waitUntil("It looks again each minute", 75_000) { s.calls.count { it.endsWith("/survival") } > looks }
        Thread.sleep(1_000)
        assertFalse(has(By.res("kit-gate"), 500))
        waitFor(By.res("search"), 5_000)
    }

    /** An answer that comes with something open waits for the list. */
    @Test fun theKitGateDoesntTakeOverAScreenThatsOpen() {
        val (client, s) = seedWithServer()
        val item = client.saveNew(client.personalVaultId(), newBody("login", "Open one").withText("password", "pw-Open-1!"))
        s.json("/survival", survival(false))
        s.json("/device-requests", "[]")
        s.slowMs = 3_000
        open()
        tap("item-${item.body.title}", 30_000)
        // The second of the two calls behind it, and then its slow answer.
        waitUntil("The answer should be on its way", 30_000) { s.calls.any { it.endsWith("/device-requests") } }
        Thread.sleep(4_000)
        assertFalse(has(By.res("kit-gate"), 300))
        waitFor(By.text("Open one"), 5_000)
        s.slowMs = 0
        device.pressBack()
        waitFor(By.res("kit-gate"), 15_000)
    }

    /** A record in your own vault can hold anything, and might be the secret itself. */
    @Test fun aSendsRecordThatIsntItsLinkOffersNothingToCopy() {
        val (client, s) = seedWithServer()
        s.json("/survival", survival(true))
        s.json("/device-requests", "[]")
        val id = "11111111-2222-4333-8444-555555555555"
        s.json("/sends", """[{"id":"$id","expires_at":"2099-01-01T00:00:00Z","views_left":null,"has_password":false,"disabled":false,"created_at":"2026-11-07T00:00:00Z"}]""")
        client.saveNew(client.personalVaultId(), org.promptly.sync.passwords.core.SendRecords.body("Not a link", "the wifi password is hunter2", id))
        open()
        tap("tab-more", 30_000)
        tap("open-sends")
        waitFor(By.res("send-bad-record"), 20_000)
        assertFalse(has(By.res("send-copy-again"), 300))
        assertFalse(has(By.res("send-rooms"), 300))
    }

    @Test fun rubbishFromTheServerDoesntPopUpTheKit() {
        val (_, s) = seedWithServer()
        s.json("/survival", """{"kit_confirmed":"no","offsite_configured":"maybe"}""")
        open()
        waitFor(By.res("search"), 30_000)
        waitUntil("It should have asked by now") { s.calls.any { it.endsWith("/survival") } }
        Thread.sleep(800)
        assertFalse(has(By.res("kit-gate"), 300))
    }

    @Test fun mainNoticesLeadToWhatNeedsALook() {
        val (client, s) = seedWithServer()
        s.json("/survival", survival(true, ageOld))
        s.json("/device-requests", """[{"id":"r1","name":"A laptop","platform":"web","code":"ABC","device_pub":"${org.promptly.sync.passwords.core.b64u(ByteArray(32))}","approver_pub":null,"status":"pending","created_at":"2026-11-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}]""")
        s.json("/devices", "[]")
        open()
        waitFor(By.res("notice-request"), 30_000)
        waitFor(By.res("notice-recovery"))
        tap("notice-request-review")
        waitFor(By.res("request-ABC"), 15_000)
        assertFalse("Not on the screen it points at", has(By.res("notice-request"), 300))
        device.pressBack()
        // The recovery check: a wrong password says so, and the right one puts it off six months.
        tap("notice-recovery-check")
        tap("survival-check-kit", 20_000)
        fill("recovery-password", "not the master password")
        tap("recovery-confirm")
        waitFor(By.textContains("isn't right"), 20_000)
        fill("recovery-password", Harness.MASTER)
        tap("recovery-confirm")
        // The dialog first: the card behind it is in another window, so it looks gone already.
        assertTrue(Harness.gone(By.res("recovery-confirm"), 20_000))
        assertTrue(Harness.gone(By.res("survival-recovery"), 20_000))
        assertNotNull(client.recoveryChecked())
    }

    // ---- The export reminder ----------------------------------------------------------------

    @Test fun anExportReminderLeadsToAnEncryptedExportRightThere() {
        val client = Harness.seedOffline()
        client.saveNew(client.personalVaultId(), newBody("login", "To keep").withText("password", "pw-Keep-1!"))
        val name = "promptly-passwords-export.json"
        Harness.shell("rm -f /sdcard/Download/$name")
        Pw.prefs.exportSince = System.currentTimeMillis() - 91 * 86_400_000L
        Pw.prefs.exportNotifiedAt = 0
        // Seen on a locked phone too, from the same check that looks for alerts.
        AlertsCheck.run(ctx)
        device.openNotification()
        waitFor(By.text("Time for an encrypted export"), 10_000)
        device.pressBack()
        assertTrue(Pw.prefs.exportNotifiedAt > 0)
        open()
        waitFor(By.res("notice-export"), 30_000)
        waitFor(By.textContains("hasn't made an encrypted export"))
        // Later: it goes for a fortnight.
        tap("notice-export-later")
        assertTrue(Harness.gone(By.res("notice-export"), 10_000))
        assertTrue(Pw.prefs.exportSnoozedUntil > System.currentTimeMillis() + 13 * 86_400_000L)
        // And when it's back, it does the job here.
        Pw.prefs.exportSnoozedUntil = 0
        device.pressBack()
        Thread.sleep(500)
        open()
        tap("notice-export-now", 30_000)
        waitFor(By.res("export-now"), 10_000)
        assertFalse("Not while you're doing it", has(By.res("notice-export"), 300))
        fill("reminder-master", "not the master password")
        fill("reminder-password", "export-file-password")
        fill("reminder-again", "export-file-password")
        tap("reminder-save")
        waitFor(By.textContains("master password isn't right"), 20_000)
        fill("reminder-master", Harness.MASTER)
        fill("reminder-password", "export-file-password")
        fill("reminder-again", "export-file-password")
        tap("reminder-save")
        waitFor(By.pkg("com.google.android.documentsui"), 30_000)
        Thread.sleep(800)
        (device.findObject(By.text("SAVE")) ?: device.findObject(By.text("Save")) ?: device.findObject(By.res("android:id/button1"))).click()
        waitFor(By.res("search"), 30_000)
        assertTrue("A plain file wouldn't count, this does", Pw.prefs.exportLast > 0)
        assertFalse("It's stopped asking", has(By.res("notice-export"), 500))
        val text = Harness.shell("cat /sdcard/Download/$name")
        assertTrue(text.take(100), text.contains("promptly-pw-export"))
        assertFalse(text.contains("pw-Keep-1!"))
        assertEquals("pw-Keep-1!", Importers.importFile(name, text.toByteArray(), "export-file-password").items.single().body.password)
        Harness.shell("rm -f /sdcard/Download/$name")
    }

    // ---- Lookalikes ---------------------------------------------------------------------------

    private fun loginFor(client: VaultClient, title: String, url: String): Item {
        val item = client.saveNew(client.personalVaultId(), newBody("login", title).withText("username", "ana-real").withText("password", "pw-Real-1!").withUrls(listOf(LoginUrl(url))))
        Harness.rebuildIndex()
        return item
    }

    @Test fun aLookalikePageGetsAWarningWithTheSafeChoiceFirst() {
        val client = Harness.seedOffline()
        Harness.setAutofill(true)
        val real = loginFor(client, "Real bank", "https://promptlybank.com")
        val before = real.body.urls
        launch(TEST_BROWSER, "WebActivity", "--es url https://promptlybnk.com/login")
        Harness.tapWebField("user")
        val row = Harness.suggestion(By.textContains("Looks like promptlybank.com"))
        // Not offered as an ordinary suggestion: no login, no search, and nothing to pick by mistake.
        assertFalse(has(By.text("Real bank"), 300))
        assertFalse(has(By.textContains("Search Passwords"), 300))
        row.click()
        waitFor(By.res("lookalike"), 15_000)
        waitFor(By.textContains("promptlybnk.com looks like promptlybank.com"))
        val no = waitFor(By.res("lookalike-no"))
        val yes = waitFor(By.res("lookalike-yes"))
        assertTrue("The safe choice comes first", no.visibleBounds.top < yes.visibleBounds.top)
        // The safe choice leaves the page empty.
        no.click()
        waitFor(By.desc("web-user-echo"), 15_000)
        assertEquals("", Harness.textOf("web-user-echo"))

        // Going on anyway takes a second, deliberate step, and isn't remembered.
        Harness.tapWebField("user")
        Harness.suggestion(By.textContains("Looks like promptlybank.com")).click()
        Thread.sleep(800)
        tap("lookalike-yes")
        tap("pick-Real bank", 15_000)
        waitText("web-user-echo", "ana-real", 15_000)
        waitText("web-pass-echo", "pw-Real-1!")
        assertEquals("Filling once doesn't make it a known site", before.map { it.url }, client.get(real.id)!!.body.urls.map { it.url })
        assertFalse(has(By.res("confirm-remember"), 300))
    }

    @Test fun aRealMatchIsntWarnedAbout() {
        val client = Harness.seedOffline()
        Harness.setAutofill(true)
        loginFor(client, "Near one", "https://promptlybank.com")
        loginFor(client, "This one", "https://promptlybnk.com")
        launch(TEST_BROWSER, "WebActivity", "--es url https://promptlybnk.com/login")
        Harness.tapWebField("user")
        Harness.suggestion(By.text("This one")).click()
        waitText("web-user-echo", "ana-real", 15_000)
        assertFalse(has(By.res("lookalike"), 300))
    }

    /** The screen checks for itself, from the decrypted vault, whatever the service offered: a
     *  card's offered everywhere, and an index can be out of date. */
    @Test fun aCardOnALookalikePageIsWarnedAboutToo() {
        val client = Harness.seedOffline()
        loginFor(client, "Real shop", "https://promptlyshop.com")
        val card = client.saveNew(client.personalVaultId(), newBody("card", "A card").withText("cardNumber", "4111111111111111"))
        Harness.rebuildIndex()
        val intent = AutofillAuthActivity.intent(ctx, AutofillAuthActivity.MODE_CARD, card.id, FillTarget.Web("promptlyshap.com", "https", TEST_BROWSER), ParsedForm(), false)
        ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        waitFor(By.res("lookalike"), 15_000)
        waitFor(By.textContains("promptlyshap.com looks like promptlyshop.com"))
        tap("lookalike-no")
    }

    /** Past the warning it fills once: "Fill and remember" isn't offered, however the login got picked (A35). */
    @Test fun anAppClaimingALookalikeIsntOfferedRememberingPastTheWarning() {
        val client = Harness.seedOffline()
        loginFor(client, "Real bank", "https://promptlybank.com")
        val mine = loginFor(client, "Some login", "https://elsewhere.example")
        val intent = AutofillAuthActivity.intent(ctx, AutofillAuthActivity.MODE_PICK, null, FillTarget.App("com.example.app", "CERT", "promptlybnk.com"), ParsedForm(), false)
        ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        waitFor(By.res("lookalike"), 15_000)
        Thread.sleep(800)
        tap("lookalike-yes")
        tap("pick-Some login", 15_000)
        waitFor(By.res("confirm-fill"), 25_000)
        assertFalse(has(By.res("confirm-remember"), 300))
        tap("confirm-cancel")
        assertEquals(listOf("https://elsewhere.example"), client.get(mine.id)!!.body.urls.map { it.url })
    }

    @Test fun whatAChangeFormWouldFillIncludesTheNewPassword() {
        val client = Harness.seedOffline()
        loginFor(client, "Real bank", "https://promptlybank.com")
        val linked = client.saveNew(client.personalVaultId(), org.promptly.sync.passwords.core.PasswordChange.withPending(newBody("login", "App login").withText("username", "ana").withText("password", "pw-App-1!").withUrls(listOf(org.promptly.sync.passwords.core.Match.appUrl("com.example.app", "CERT"))), "pw-New-2!"))
        val form = ParsedForm<android.view.autofill.AutofillId>()
        form.passwords += android.view.View(ctx).autofillId!!
        form.newPasswords += android.view.View(ctx).autofillId!!
        val intent = AutofillAuthActivity.intent(ctx, AutofillAuthActivity.MODE_LOGIN, linked.id, FillTarget.App("com.example.app", "CERT", "promptlybnk.com"), form, false)
        ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        waitFor(By.res("lookalike"), 15_000)
        waitFor(By.text("It will fill: password, new password."), 10_000)
        tap("lookalike-no")
    }

    @Test fun anAppsWebViewClaimingALookalikeIsWarnedAbout() {
        val client = Harness.seedOffline()
        loginFor(client, "Real bank", "https://promptlybank.com")
        val mine = client.saveNew(client.personalVaultId(), newBody("login", "App login").withText("username", "ana").withText("password", "pw-App-1!").withUrls(listOf(org.promptly.sync.passwords.core.Match.appUrl("com.example.app", "CERT"))))
        val intent = AutofillAuthActivity.intent(ctx, AutofillAuthActivity.MODE_LOGIN, mine.id, FillTarget.App("com.example.app", "CERT", "promptlybnk.com"), ParsedForm(), false)
        ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        waitFor(By.res("lookalike"), 15_000)
        tap("lookalike-no")
    }

    /** A request as Credential Manager hands it over, made in this process: a real browser can't be
     *  driven here, and only a privileged app can name an origin. The screens are the real ones. */
    @Test fun credentialManagerWarnsBeforeAPasswordGoesToALookalike() {
        assumeTrue("Needs Android 14", android.os.Build.VERSION.SDK_INT >= 34)
        val client = Harness.seedOffline()
        loginFor(client, "Real site", "https://promptlybank.com")
        // Saved by pattern, so it matches this page, and nothing saved says this page is known.
        val patterned = client.saveNew(client.personalVaultId(), newBody("login", "By pattern").withText("username", "ana-pattern").withText("password", "pw-Pattern-1!").withUrls(listOf(LoginUrl("^https://promptlybnk\\.com", "regex"))))
        val pkg = TEST_BROWSER
        val signing = ctx.packageManager.getPackageInfo(pkg, android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES).signingInfo!!
        val calling = android.service.credentials.CallingAppInfo(pkg, signing, "https://promptlybnk.com")
        val asked = androidx.credentials.GetPasswordOption()
        val option = android.credentials.CredentialOption.Builder(asked.type, asked.requestData, asked.candidateQueryData).build()
        val request = android.service.credentials.GetCredentialRequest(calling, listOf(option))
        val intent = Intent(ctx, org.promptly.sync.passwords.credentials.CredentialActivity::class.java)
            .setAction(org.promptly.sync.passwords.credentials.PromptlyCredentialProviderService.ACTION_GET_PASSWORD)
            .putExtra(org.promptly.sync.passwords.credentials.PromptlyCredentialProviderService.EXTRA_ITEM, patterned.id)
            .putExtra(android.service.credentials.CredentialProviderService.EXTRA_GET_CREDENTIAL_REQUEST, request)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(intent)
        waitFor(By.res("lookalike"), 20_000)
        waitFor(By.textContains("promptlybnk.com looks like promptlybank.com"))
        // A lock while it's open: what it held goes, and the unlock starts this request from the top.
        Pw.lock("test")
        waitFor(By.res("master-password"), 15_000)
        assertFalse(has(By.res("lookalike"), 300))
        Harness.fill("master-password", Harness.MASTER)
        tap("unlock")
        waitFor(By.res("lookalike"), 30_000)
        val no = waitFor(By.res("lookalike-no"))
        assertTrue(no.visibleBounds.top < waitFor(By.res("lookalike-yes")).visibleBounds.top)
        no.click()
        assertTrue(Harness.gone(By.res("lookalike"), 10_000))
    }

    @Test fun answeringFromAFiveThousandItemIndexOnALookalikeMissIsQuick() {
        val entries = (1..5000).map { i ->
            IndexEntry("id$i", "login", "Site $i", "user$i", listOf(LoginUrl("https://www.site$i.com/login"), LoginUrl("https://other$i.co.uk")), false, false)
        }
        val runs = (1..5).map {
            val lookup = IndexLookup(entries)
            val t = System.nanoTime()
            AutofillIndex.lookalikeFor(lookup, FillTarget.Web("nothing-like-any.example", "https", "x"), emptyList())
            (System.nanoTime() - t) / 1000
        }.sorted()
        Harness.note("5000-item lookalike miss, index just read: median ${runs[2]} us, worst ${runs.last()} us")
        assertTrue("median ${runs[2]} us", runs[2] < 500_000)
    }

    // ---- The real stack -------------------------------------------------------------------------

    /** Sends in Rooms and Mail, a contact named and asked for, a vault's icons, and a dropped upload,
     *  each through the screen a person would use. */
    @Test fun sendEmergencyIconsAndResumeOnTheRealStack() {
        val args = InstrumentationRegistry.getArguments()
        val bearer = args.getString("pwBearer5")
        val otherBearer = args.getString("pwBearer6")
        val otherName = args.getString("pwUser6")
        val server = args.getString("pwServer") ?: "http://10.0.2.2:8092"
        assumeTrue("No -e pwBearer6", !bearer.isNullOrEmpty() && !otherBearer.isNullOrEmpty() && !otherName.isNullOrEmpty())
        Harness.clearScreen()
        runCatching { Pw.forgetDevice() }
        val t = Harness.retrying429 { VaultApi(server, { null }).registerDevice("Bearer $bearer", "Finishing test") }
        Pw.connect(server, t.token, t.deviceId)
        val client = Pw.client()!!
        assumeTrue("Needs a fresh user", !Harness.retrying429 { client.api.prelogin() }.exists)
        Harness.retrying429 { client.setup(Harness.MASTER, org.promptly.sync.passwords.core.calibrateKdf(900L)) }
        client.api.confirmKit()
        Pw.touch()
        val other =VaultClient(VaultApi(server, { otherBearer }), MemoryStore(), MemoryKeeper())
        assumeTrue("Needs a fresh second user", runCatching { Harness.retrying429 { other.setup(Harness.MASTER) } }.isSuccess)
        val otherId = other.userId!!

        // A Send: it's named in the list, its link's there again, and it goes to Rooms.
        open()
        tap("tab-more", 30_000)
        tap("open-sends")
        fill("send-title", "For a friend")
        fill("send-text", "the wifi is pw-Send-3!")
        Harness.scrollToTag("send-password")
        fill("send-password", "a password")
        Harness.scrollTap("send-create")
        val link = waitFor(By.res("send-link"), 30_000).text
        waitFor(By.res("send-password-note"))
        Harness.scrollTap("send-name")
        waitFor(By.text("For a friend"), 15_000)
        val row = client.sendRecords().values.single()
        assertEquals("For a friend", row.title)
        assertEquals(link, row.link)

        // Rooms: the warning first, then the link, and the person's DM holds it.
        Harness.scrollTap("send-rooms")
        waitFor(By.res("send-post-warning"), 15_000)
        assertFalse("Nothing to type a secret into", has(By.res("send-post-to"), 300))
        assertFalse(waitFor(By.res("send-post-go")).isEnabled)
        tap("send-post-who")
        waitFor(By.res("send-person-$otherName"), 15_000).click()
        tap("send-post-go")
        assertTrue("It closes once it's posted", Harness.gone(By.res("send-post-warning"), 20_000))

        // Mail: no Mail account on this user, and it says what to do.
        Harness.scrollTap("send-mail")
        fill("send-post-to", "someone@example.com")
        tap("send-post-go")
        waitFor(By.textContains("Set up Mail first"), 20_000)
        tap("send-post-cancel")
        // The keyboard goes a moment after its dialog. A Back now would leave this screen.
        Harness.gone(By.res("send-post-cancel"))
        Thread.sleep(1_000)

        // The link, again, whenever it's wanted. Android's clipboard preview sits in the corner for
        // a few seconds and takes taps meant for what's under it, so this comes after those.
        Harness.scrollTap("send-copy-again")
        Thread.sleep(400)
        val clip = ctx.getSystemService(android.content.ClipboardManager::class.java).primaryClipDescription
        assertTrue("A link holds the key, so it's copied as a secret", clip?.extras?.getBoolean(android.content.ClipDescription.EXTRA_IS_SENSITIVE) == true)
        Thread.sleep(7_000)

        // The record comes with a Send from elsewhere only once it's synced; one from nowhere isn't named.
        val elsewhere = SecureSend.create(client.api, SecureSend.textPayload("Other device", "x"), 1, null, null)
        device.pressBack()
        tap("open-sends", 15_000)
        waitFor(By.text("Sent from another device"), 20_000)
        client.deleteSend(elsewhere.id)
        device.pressBack()
        // Delete the named one: the record goes with it.
        tap("open-sends", 15_000)
        Harness.scrollTap("send-delete")
        val goneBy = System.currentTimeMillis() + 20_000
        while (client.sendRecords().isNotEmpty() && System.currentTimeMillis() < goneBy) Thread.sleep(200)
        assertTrue(client.sendRecords().isEmpty())
        device.pressBack()

        // Emergency: the warning shows, and a contact's named from here.
        tap("open-emergency", 15_000)
        waitFor(By.textContains("If you don't refuse before the wait runs out, it opens."), 15_000)
        waitFor(By.res("emergency-empty"))
        tap("emergency-person")
        waitFor(By.res("emergency-person-$otherName"), 15_000).click()
        Harness.scrollToTag("emergency-days")
        fill("emergency-days", "91")
        Harness.scrollToTag("emergency-add")
        assertFalse("Past 90 days isn't allowed", waitFor(By.res("emergency-add")).isEnabled)
        fill("emergency-days", "1")
        // Add asks first: their safety words, the ones their device shows.
        Harness.scrollTap("emergency-add")
        assertEquals(other.myIdentityWords().joinToString(" "), waitFor(By.res("emergency-words"), 20_000).text)
        // "Not now" is nothing at all: no row, nobody pinned, and the choice is still there to go on with.
        tap("emergency-not-now")
        assertTrue(Harness.gone(By.res("emergency-words"), 10_000))
        Thread.sleep(800)
        assertFalse(has(By.res("emergency-$otherName"), 300))
        assertTrue(client.api.emergencyList().isEmpty())
        assertFalse(otherId in client.trustEntries())
        Harness.scrollTap("emergency-add")
        waitFor(By.res("emergency-words"), 20_000)
        tap("emergency-match")
        waitFor(By.res("emergency-$otherName"), 20_000)
        assertEquals("Waiting for them to accept.", waitFor(By.res("emergency-state")).text)
        assertTrue("Named here, so in the trust book", otherId in client.trustEntries())
        assertEquals("And the words compared", true, client.trustEntries()[otherId]?.verified)

        // They accept: this screen seals the keys to them, since they're the one named, on the keys
        // pinned then. That's its five-second look, with nothing else asking it to.
        other.sync()
        val row2 = other.api.emergencyList().first { it.grantorId == client.userId }
        other.api.emergencyAct(row2.id, "accept")
        val sealedBy = System.currentTimeMillis() + 30_000
        while (client.api.emergencyList().first().state == "accepted" && System.currentTimeMillis() < sealedBy) Thread.sleep(500)
        val ready = client.api.emergencyList().first()
        assertEquals(mapOf(client.personalVaultId() to 1), ready.wrapped)
        // Its next look, and a request can sit on this emulator's network for a while.
        waitFor(By.text("Set up."), 60_000)
        // They ask; you see it, and can refuse.
        other.api.emergencyAct(row2.id, "request")
        waitFor(By.res("emergency-refuse"), 20_000).click()
        waitFor(By.text("Refused."), 20_000)
        assertEquals("refused", client.api.emergencyList().first().state)
        // Ending it takes them out of the trust book's contact list.
        tap("emergency-end")
        waitFor(By.res("emergency-empty"), 20_000)
        device.pressBack()

        // Now the other way round: someone's named this phone. Accept, then ask, from here.
        other.markVerified(client.userId!!)
        other.emergencyInvite(client.userId!!, 1)
        tap("open-emergency", 15_000)
        waitFor(By.res("emergency-accept"), 20_000).click()
        waitUntil("Their device hasn't sealed the keys") {
            runCatching { other.sync() }
            client.api.emergencyList().first().state == "ready"
        }
        waitFor(By.res("emergency-ask"), 20_000).click()
        waitFor(By.textContains("told straight away"), 10_000)
        tap("emergency-ask-confirm")
        waitFor(By.textContains("Asked. Opens"), 20_000)
        assertFalse("A day's wait isn't over", has(By.res("emergency-open"), 300))
        tap("emergency-stop")
        waitFor(By.res("emergency-empty"), 20_000)
        device.pressBack()

        // A vault's icons, on a shared vault this person manages, from its card.
        tap("open-shared", 15_000)
        tap("new-vault")
        fill("new-vault-name", "Icons vault")
        tap("new-vault-create")
        waitFor(By.res("vault-Icons vault"), 30_000)
        val iconsVault = client.vaults().first { it.displayName == "Icons vault" }.vault.id
        assertFalse(iconsVault in client.iconVaults())
        Harness.scrollTap("icons-Icons vault")
        val onBy = System.currentTimeMillis() + 15_000
        while (iconsVault !in client.iconVaults() && System.currentTimeMillis() < onBy) Thread.sleep(200)
        assertTrue(iconsVault in client.iconVaults())
        device.pressBack()

        // A dropped upload picks up when the same file's chosen again.
        val data = ByteArray(2_300_000) { (it * 31).toByte() }
        val name = "pwtest-resume-${System.currentTimeMillis()}.bin"
        val item = client.saveNew(client.personalVaultId(), newBody("note", "With a file"))
        client.sync()
        runCatching {
            client.addAttachment(item.id, name, null, data.size.toLong(), { off, len ->
                if (off > 0) throw java.io.IOException("the network went")
                data.copyOfRange(off.toInt(), off.toInt() + len)
            })
        }
        assertTrue("That one failed", client.get(item.id)!!.body.attachments.isEmpty())
        fileInDownloads(name, data)
        tap("tab-items")
        tap("item-With a file", 30_000)
        Harness.scrollTap("attachment-add")
        pickFromSystem(name)
        waitFor(By.res("attachment-$name"), 60_000)
        val ref = client.get(item.id)!!.body.attachments.single()
        val back = java.io.ByteArrayOutputStream()
        Attachments.download(client.api, client.personalVaultId(), item.id, ref, { back.write(it) })
        assertTrue("What came back is what went up", back.toByteArray().contentEquals(data))
        assertNull(client.store.getMeta("upload_resume:${item.id}:$name:${data.size}"))
        Harness.note("STORY-DONE finishing story reached its last line")
    }
}
