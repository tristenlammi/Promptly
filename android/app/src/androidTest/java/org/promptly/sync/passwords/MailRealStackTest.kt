// The real :8092 stack, with real mail in a throwaway user's Mail: run-passwords-tests.ps1 seeds it
// right before this class, since mail only counts for ten minutes. Chrome is never opened: the browser
// leg of adding the scope is approved through the same API the browser's page calls.
package org.promptly.sync.passwords

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.Store
import org.promptly.sync.passwords.Harness.ctx
import org.promptly.sync.passwords.Harness.has
import org.promptly.sync.passwords.Harness.tap
import org.promptly.sync.passwords.Harness.waitFor
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.VaultApi
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.newBody
import org.promptly.sync.passwords.ui.PasswordsActivity
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(AndroidJUnit4::class)
class MailRealStackTest {
    private val args get() = InstrumentationRegistry.getArguments()
    private val server get() = args.getString("pwServer") ?: "http://10.0.2.2:8092"
    private val opened = CopyOnWriteArrayList<String>()

    @Before fun setUp() {
        Harness.home()
        Pw.init(ctx)
        runCatching { Pw.forgetDevice() }
        Pw.prefs.lockOnScreenOff = false
        Pw.prefs.setupGuideDone = true
        Links.opener = { _, url -> opened += url }
    }

    @After fun tearDown() {
        Links.opener = null
        Pw.prefs.mailCodes = false
        Store(ctx).account = null
        Harness.shell("am force-stop ${Harness.TEST_BROWSER}")
        Harness.setAutofill(false)
        Harness.home()
    }

    private fun open() {
        ctx.startActivity(Intent(ctx, PasswordsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** A phone connected before email codes, as every one out there was. */
    private fun oldPhone(bearer: String): VaultClient {
        val t = Harness.retrying429 { VaultApi(server, { null }).registerDevice("Bearer $bearer", "Old phone", scopes = listOf("vault")) }
        Pw.connect(server, t.token, t.deviceId)
        val client = Pw.client()!!
        assumeTrue("Needs a fresh user", !Harness.retrying429 { client.api.prelogin() }.exists)
        Harness.retrying429 { client.setup(Harness.MASTER, org.promptly.sync.passwords.core.calibrateKdf(900L)) }
        client.api.confirmKit()
        Pw.touch()
        return client
    }

    private fun waitUntil(what: String, ms: Long = 30_000, check: () -> Boolean) {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) {
            if (check()) return
            Thread.sleep(250)
        }
        throw AssertionError("$what\nWindow:\n${Harness.dumpWindow()}")
    }

    private fun toggleInSettings() {
        open()
        tap("tab-more", 30_000)
        tap("open-settings")
        Harness.scrollToTag("mail-codes")
        tap("mail-codes")
        waitFor(By.res("mail-scope-add"), 20_000)
    }

    /** All of it, for real: refused, offered, connected again with the app password, nothing lost, then a
     *  real seeded message read by the real server, matched here, and filled with a tap. */
    @Test fun anOldPhoneAddsTheScopeThenFillsARealCode() {
        val bearer = args.getString("pwBearer7")
        val user = args.getString("pwAppUser7")
        val app = args.getString("pwAppPassword7")
        assumeTrue("No -e pwBearer7", !bearer.isNullOrEmpty() && !user.isNullOrEmpty() && !app.isNullOrEmpty())
        val client = oldPhone(bearer!!)
        val before = Pw.prefs.deviceId
        val item = client.saveNew(client.personalVaultId(), newBody("login", "Bank").withText("username", "ana").withText("password", "pw-Real-1!").withUrls(listOf(LoginUrl("https://promptlyrealbank.com"))))
        client.sync()
        Harness.retrying429 { assertEquals(403, runCatching { client.api.mailCodes() }.exceptionOrNull().let { (it as org.promptly.sync.passwords.core.ApiError).status }) }

        Store(ctx).account = Store.Account(server, user!!, app!!, "Instrumented test")
        toggleInSettings()
        assertFalse(Pw.prefs.mailCodes)
        tap("mail-scope-add")
        waitUntil("It's on once the phone has the scope") { Pw.prefs.mailCodes }

        assertTrue("The vault stayed open", client.unlocked)
        assertTrue("A new device", Pw.prefs.deviceId != before)
        val devices = Harness.retrying429 { client.api.devices() }
        assertEquals("The old one's gone, and this is the only one", listOf(Pw.prefs.deviceId), devices.map { it.id })
        assertEquals(listOf("mail_codes", "vault"), devices.single().scopes.sorted())
        assertEquals("And it still syncs", "pw-Real-1!", client.get(item.id)!!.body.password)
        assertFalse(client.sync().offline)
        assertTrue(Harness.retrying429 { client.api.mailCodes() }.isNotEmpty())

        // The real fill, on the seeded sender's own page.
        Harness.home()
        Harness.setAutofill(true)
        Harness.rebuildIndex()
        Harness.launch(Harness.TEST_BROWSER, "WebActivity", "--es url https://promptlyrealbank.com/verify --es form otp")
        Harness.tapWebField("code")
        Harness.suggestion(By.textContains("Code from email")).click()
        val row = waitFor(By.res("mail-code-promptlyrealbank.com"), 20_000)
        // The seeded mail that says it's for this site from somewhere else.
        waitFor(By.res("mail-other-evil.example"))
        assertFalse(has(By.textContains("999111"), 300))
        row.click()
        Harness.waitText("web-user-echo", "730194", 15_000)

        // The real security email, against the real login, and the real label in Mail.
        Harness.home()
        open()
        // Back where it was left, in Settings.
        tap("back", 30_000)
        tap("tab-more", 30_000)
        tap("open-security")
        waitFor(By.res("mail-alerts"), 30_000)
        assertTrue(waitFor(By.res("mail-alert-text")).text.contains("says your password changed"))
        tap("back")
        tap("tab-generator", 15_000)
        tap("gen-mode-3")
        Harness.fill("plus-email", "ana@example.com")
        Harness.fill("plus-tag", "shop")
        Harness.waitTextRes("gen-output", "ana+shop@example.com")
        Harness.scrollTap("plus-label")
        waitFor(By.res("plus-result"), 20_000)
        assertTrue(has(By.textContains("labelled Plus addresses/shop")))
    }

    /** A real file in the real Files, moved through the real screens. */
    @Test fun aDocumentMovesFromFilesThroughTheScreens() {
        val bearer = args.getString("pwBearer9")
        assumeTrue("No -e pwBearer9", !bearer.isNullOrEmpty())
        val t = Harness.retrying429 { VaultApi(server, { null }).registerDevice("Bearer $bearer", "Docs phone") }
        Pw.connect(server, t.token, t.deviceId)
        val client = Pw.client()!!
        assumeTrue("Needs a fresh user", !Harness.retrying429 { client.api.prelogin() }.exists)
        Harness.retrying429 { client.setup(Harness.MASTER, org.promptly.sync.passwords.core.calibrateKdf(900L)) }
        client.api.confirmKit()
        Pw.touch()
        val scan = "A throwaway scan. ".repeat(4000).toByteArray()
        val upload = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("file", "licence-scan.txt", scan.toRequestBody("text/plain".toMediaType())).build()
        OkHttpClient().newCall(Request.Builder().url("$server/api/files/").header("Authorization", "Bearer $bearer").post(upload).build()).execute().use { assertTrue(it.body.string(), it.isSuccessful) }
        val doc = client.saveNew(client.personalVaultId(), newBody("document", "Driver licence").withText("expiresOn", "2031-05-01"))
        client.sync()

        open()
        tap("item-Driver licence", 30_000)
        Harness.scrollTap("attachment-from-files")
        waitFor(By.res("files-row-licence-scan.txt"), 20_000)
        Harness.fill("files-search", "nothing called this")
        waitFor(By.res("files-empty"), 15_000)
        Harness.fill("files-search", "LICENCE")
        tap("files-row-licence-scan.txt", 20_000)
        waitFor(By.res("files-moved"), 60_000)
        waitFor(By.res("files-remind-why"))
        assertEquals("It starts from the document's own date", "2031-05-01", waitFor(By.res("files-remind")).text)

        // Sealed: the ref's on the item, and it opens again.
        val ref = client.get(doc.id)!!.body.attachments.single()
        assertEquals("licence-scan.txt", ref.name)
        val out = java.io.ByteArrayOutputStream()
        org.promptly.sync.passwords.core.Attachments.download(client.api, doc.vaultId, doc.id, ref, { out.write(it) })
        assertTrue(scan.contentEquals(out.toByteArray()))

        assertEquals("The original's still there until asked", 1, client.api.driveFiles("licence").size)
        tap("files-trash")
        waitFor(By.res("files-trashed"), 20_000)
        assertTrue(client.api.driveFiles("licence").isEmpty())

        Harness.fill("files-remind", "not a day")
        assertFalse(waitFor(By.res("files-remind-add")).isEnabled)
        Harness.fill("files-remind", "2031-04-01")
        tap("files-remind-add")
        waitFor(By.res("files-reminded"), 20_000)
        // The keyboard goes first, here: a Back that lands just after it's gone would leave the item.
        Harness.dismissKeyboard()
        Thread.sleep(1_000)
        tap("files-done")
        waitFor(By.res("attachment-licence-scan.txt"), 15_000)
        Thread.sleep(1_000)

        // The one on the item itself, which then says it's done.
        Harness.scrollTap("reminder-add")
        waitFor(By.res("reminder-set"), 20_000)
        assertTrue(client.get(doc.id)!!.body.bool("remindExpiry"))

        // What happened shows in the log, from the real server.
        Harness.device.pressBack()
        tap("tab-more", 15_000)
        tap("open-activity")
        waitFor(By.text("Vault created"), 20_000)
    }

    /** With no app password: a code, a page opened in the browser and approved there, and the same result.
     *  The page itself isn't opened, since it would be Chrome. It's the browser's own API call. */
    @Test fun anOldPhoneWithNoAppPasswordAddsTheScopeThroughTheBrowser() {
        val bearer = args.getString("pwBearer8")
        assumeTrue("No -e pwBearer8", !bearer.isNullOrEmpty())
        val client = oldPhone(bearer!!)
        val before = Pw.prefs.deviceId
        Store(ctx).account = null
        toggleInSettings()
        tap("mail-scope-add")
        val code = waitFor(By.res("mail-scope-code"), 20_000).text
        waitUntil("The browser would have been sent to approve it") { opened.isNotEmpty() }
        assertEquals("$server/passwords/connect?code=$code", opened.single())
        assertFalse("Nothing's changed until it's approved", Pw.prefs.mailCodes)

        val req = Request.Builder().url("$server/api/passwords/connect/code/$code/approve").header("Authorization", "Bearer $bearer").post(ByteArray(0).toRequestBody(null)).build()
        OkHttpClient().newCall(req).execute().use { assertEquals(204, it.code) }
        waitUntil("It's on once the phone has the scope") { Pw.prefs.mailCodes }
        assertTrue(client.unlocked)
        assertTrue(Pw.prefs.deviceId != before)
        assertEquals(listOf("mail_codes", "vault"), Harness.retrying429 { client.api.devices() }.single().scopes.sorted())
    }
}
