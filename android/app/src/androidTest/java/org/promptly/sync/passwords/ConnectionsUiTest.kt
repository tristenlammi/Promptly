// Where the vault meets the rest of Promptly, through the real screens and the real autofill
// service. A small server on the phone gives the answers a test needs, hostile ones included. The
// same endpoints against the real stack are in StackTests and MailRealStackTest.
package org.promptly.sync.passwords

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.Store
import org.promptly.sync.passwords.Harness.ctx
import org.promptly.sync.passwords.Harness.has
import org.promptly.sync.passwords.Harness.tap
import org.promptly.sync.passwords.Harness.waitFor
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.ui.PasswordsActivity

@RunWith(AndroidJUnit4::class)
class ConnectionsUiTest {
    private var server: TinyServer? = null

    @Before fun setUp() {
        Harness.home()
        Pw.init(ctx)
        Pw.prefs.lockOnScreenOff = false
        Pw.prefs.setupGuideDone = true
    }

    @After fun tearDown() {
        server?.close()
        Links.opener = null
        Pw.prefs.mailCodes = false
        Harness.shell("am force-stop ${Harness.TEST_BROWSER}")
        Harness.shell("am force-stop ${Harness.TEST_APP}")
        Harness.setAutofill(false)
        Harness.home()
    }

    private fun open() {
        ctx.startActivity(Intent(ctx, PasswordsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun seed(): Pair<VaultClient, TinyServer> {
        Harness.seedOffline(TinyServer.URL)
        val s = TinyServer(HashMap())
        server = s
        return Pw.client()!! to s
    }

    private fun waitUntil(what: String, ms: Long = 20_000, check: () -> Boolean) {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) {
            if (check()) return
            Thread.sleep(200)
        }
        throw AssertionError("$what\nWindow:\n${Harness.dumpWindow()}")
    }

    // ---- Mail codes: the real autofill service ---------------------------------------------------

    private fun mail(domain: String, code: String?, link: String? = null, ago: Long = 40): String {
        val c = code?.let { "\"$it\"" } ?: "null"
        val l = link?.let { "\"$it\"" } ?: "null"
        return """{"id":"${java.util.UUID.randomUUID()}","from_name":"Anything at all","from_domain":"$domain","at":"${java.time.Instant.now().minusSeconds(ago)}","code":$c,"link":$l}"""
    }

    private fun seedMail(vararg rows: String): TinyServer {
        val (_, s) = seed()
        s.json("/mail/codes", "[${rows.joinToString(",")}]")
        Harness.setAutofill(true)
        Pw.prefs.mailCodes = true
        Links.opener = { _, url -> opened += url }
        return s
    }

    private val opened = java.util.concurrent.CopyOnWriteArrayList<String>()

    private fun browser(url: String, form: String) {
        Harness.launch(Harness.TEST_BROWSER, "WebActivity", "--es url $url --es form $form")
    }

    @Test fun aCodeFromTheSiteIsOfferedAndOnlyFillsWhenTapped() {
        seedMail(mail("promptlybank.com", "482913"))
        browser("https://promptlybank.com/verify", "otp")
        Harness.tapWebField("code")
        Harness.suggestion(By.textContains("Code from email")).click()
        val row = waitFor(By.res("mail-code-promptlybank.com"), 15_000)
        assertTrue(Harness.dumpWindow(), has(By.textContains("promptlybank.com: 482913")))
        assertTrue(has(By.textContains("s ago")))
        // It stays here until someone picks it, even though it's the only thing it could be.
        Thread.sleep(1_500)
        assertTrue("Still waiting", has(By.res("mail-code-promptlybank.com")))
        row.click()
        Harness.waitText("web-user-echo", "482913", 15_000)
    }

    @Test fun anotherSendersCodeGetsNoRowOnlyAWarningThatHoldsNoCode() {
        seedMail(mail("evil.example", "999111"), mail("promptlybank.com.evil.example", "777222"))
        browser("https://promptlybank.com/verify", "otp")
        Harness.tapWebField("code")
        Harness.suggestion(By.textContains("Code from email")).click()
        waitFor(By.res("mail-none"), 15_000)
        waitFor(By.res("mail-other-evil.example"))
        waitFor(By.res("mail-other-promptlybank.com.evil.example"))
        assertFalse(has(By.textContains("999111"), 300))
        assertFalse(has(By.textContains("777222"), 300))
        assertFalse(has(By.res("mail-code-evil.example"), 300))
        tap("mail-close")
        waitFor(By.desc("web-user-echo"), 15_000)
        assertEquals("", Harness.textOf("web-user-echo"))
    }

    /** Two Unicode-free lookalikes and a wrong page: it's the page the sender has to be, not the reverse. */
    @Test fun aLookalikePageGetsNoMailRowAtAll() {
        val s = seedMail(mail("promptlybank.com", "482913"))
        val client = Pw.client()!!
        client.saveNew(client.personalVaultId(), org.promptly.sync.passwords.core.newBody("login", "Real bank").withText("username", "ana").withText("password", "pw-Real-1!").withUrls(listOf(org.promptly.sync.passwords.core.LoginUrl("https://promptlybank.com"))))
        Harness.rebuildIndex()
        browser("https://promptlybnk.com/login", "email")
        Harness.tapWebField("email")
        Harness.suggestion(By.textContains("Looks like promptlybank.com"))
        assertFalse(has(By.textContains("from email"), 500))
        assertFalse("Nothing's asked for just by looking", s.calls.any { it.contains("/mail/codes") })
    }

    @Test fun offMeansNoRowAndNothingAsked() {
        val s = seedMail(mail("promptlybank.com", "482913"))
        Pw.prefs.mailCodes = false
        val client = Pw.client()!!
        client.saveNew(client.personalVaultId(), org.promptly.sync.passwords.core.newBody("login", "Bank").withText("password", "pw-1!").withUrls(listOf(org.promptly.sync.passwords.core.LoginUrl("https://promptlybank.com"))).withTotp(org.promptly.sync.passwords.core.TotpConfig("JBSWY3DPEHPK3PXP")))
        Harness.rebuildIndex()
        browser("https://promptlybank.com/verify", "otp")
        Harness.tapWebField("code")
        Harness.suggestion(By.textContains("2FA code"))
        assertFalse(has(By.textContains("from email"), 500))
        assertFalse(s.calls.any { it.contains("/mail/codes") })
    }

    @Test fun aLockedVaultUnlocksFirstThenShowsTheCode() {
        seedMail(mail("promptlybank.com", "482913"))
        Pw.client()!!.lock()
        assertFalse(Pw.unlocked)
        browser("https://promptlybank.com/verify", "otp")
        Harness.tapWebField("code")
        Harness.suggestion(By.textContains("Code from email")).click()
        Harness.fill("master-password", Harness.MASTER)
        tap("unlock")
        tap("mail-code-promptlybank.com", 30_000)
        Harness.waitText("web-user-echo", "482913", 15_000)
    }

    /** What the page's own box gets is always the code. Anything odd about it never gets a row. */
    @Test fun aCodeOfTheWrongShapeIsntShown() {
        val rows = """{"id":"a","from_domain":"promptlybank.com","at":"${java.time.Instant.now()}","code":"<b>1</b>"},{"id":"b","from_domain":"promptlybank.com/x","at":"${java.time.Instant.now()}","code":"111222"}"""
        seedMail(rows)
        browser("https://promptlybank.com/verify", "otp")
        Harness.tapWebField("code")
        Harness.suggestion(By.textContains("Code from email")).click()
        waitFor(By.res("mail-none"), 15_000)
        assertFalse(has(By.textContains("<b>"), 300))
        assertFalse(has(By.textContains("111222"), 300))
    }

    @Test fun anOldPhoneIsToldWhereToGoFromTheFillSheet() {
        val s = seedMail()
        s.answersFor403("GET /api/passwords/mail/codes")
        browser("https://promptlybank.com/verify", "otp")
        Harness.tapWebField("code")
        Harness.suggestion(By.textContains("Code from email")).click()
        waitFor(By.textContains("isn't connected for email codes"), 15_000)
        tap("mail-close")
    }

    /** A sign-in link goes somewhere at once: it asks, with the safe choice first and the other held back. */
    @Test fun aSignInLinkAsksFirstWithTheSafeChoiceOnTop() {
        seedMail(mail("promptlybank.com", null, "https://promptlybank.com/magic/abcdefghijklmnopqrstuvwxyz"), mail("promptlybank.com", null, "https://evil.example/magic/abcdefghijklmnopqrstuvwxyz"))
        browser("https://promptlybank.com/signin", "email")
        Harness.tapWebField("email")
        Harness.suggestion(By.textContains("Sign-in link from email")).click()
        // Only the one that goes where its sender is.
        assertEquals(1, waitFor(By.res("mail-link-promptlybank.com"), 15_000).parent.findObjects(By.res("mail-link-promptlybank.com")).size)
        tap("mail-link-promptlybank.com")
        waitFor(By.res("mail-link-confirm"))
        waitFor(By.textContains("It opens promptlybank.com in your browser"))
        val no = waitFor(By.res("mail-link-no"))
        val yes = waitFor(By.res("mail-link-yes"))
        assertTrue("The safe choice comes first", no.visibleBounds.top < yes.visibleBounds.top)
        no.click()
        waitFor(By.res("mail-link-promptlybank.com"))
        assertTrue("Nothing's opened", opened.isEmpty())

        tap("mail-link-promptlybank.com")
        Thread.sleep(800)
        tap("mail-link-yes")
        val end = System.currentTimeMillis() + 10_000
        while (opened.isEmpty() && System.currentTimeMillis() < end) Thread.sleep(100)
        assertEquals(listOf("https://promptlybank.com/magic/abcdefghijklmnopqrstuvwxyz"), opened.toList())
    }

    /** An app has no page: its site is the one saved on the login linked to it. */
    @Test fun anAppGetsTheCodeForTheSiteOnItsLinkedLoginAndNoOtherApp() {
        seedMail(mail("promptlybank.com", "482 913"), mail("evil.example", "999111"))
        val client = Pw.client()!!
        val link = org.promptly.sync.passwords.core.Match.appUrl(Harness.TEST_APP, Harness.certOf(Harness.TEST_APP))
        val item = client.saveNew(client.personalVaultId(), org.promptly.sync.passwords.core.newBody("login", "App login").withText("password", "pw-1!").withUrls(listOf(link, org.promptly.sync.passwords.core.LoginUrl("https://promptlybank.com"))))
        Harness.rebuildIndex()
        Harness.launch(Harness.TEST_APP, "OtpActivity")
        Harness.tapField("otp")
        Harness.suggestion(By.textContains("Code from email")).click()
        tap("mail-code-promptlybank.com", 15_000)
        assertFalse(has(By.textContains("999111"), 300))
        Harness.waitText("otp-echo", "482913", 15_000)

        // Take the link away, and there's nothing to say which site this app is.
        client.update(item.id, item.body.withUrls(listOf(org.promptly.sync.passwords.core.LoginUrl("https://promptlybank.com"))))
        Harness.rebuildIndex()
        Harness.launch(Harness.TEST_APP, "OtpActivity")
        Harness.tapField("otp")
        assertFalse(has(By.textContains("Code from email"), 2_500))
    }

    // ---- Mail codes: the setting ---------------------------------------------------------------

    private fun settings() {
        open()
        tap("tab-more", 30_000)
        tap("open-settings")
        Harness.scrollToTag("mail-codes")
    }

    @Test fun theSettingIsOffByDefaultAndJustTurnsOnWithTheScope() {
        val (_, s) = seed()
        s.json("/devices", """[{"id":"device-1","name":"This","platform":"android","scopes":["mail_codes","vault"],"last_seen_at":null,"created_at":"2026-11-07T00:00:00Z","revoked_at":null,"current":true}]""")
        assertFalse(Pw.prefs.mailCodes)
        settings()
        tap("mail-codes")
        val end = System.currentTimeMillis() + 15_000
        while (!Pw.prefs.mailCodes && System.currentTimeMillis() < end) Thread.sleep(100)
        assertTrue(Pw.prefs.mailCodes)
        assertFalse(has(By.res("mail-scope"), 300))
        tap("mail-codes")
        Thread.sleep(300)
        assertFalse(Pw.prefs.mailCodes)
    }

    @Test fun anOldPhoneIsOfferedAWayToAddTheScopeAndStaysAsItWasUntilThen() {
        val (client, s) = seed()
        s.json("/devices", """[{"id":"device-1","name":"This","platform":"android","scopes":["vault"],"last_seen_at":null,"created_at":"2026-11-07T00:00:00Z","revoked_at":null,"current":true}]""")
        Store(ctx).account = null
        settings()
        tap("mail-codes")
        waitFor(By.res("mail-scope-add"), 15_000)
        assertFalse("Not on until it can be", Pw.prefs.mailCodes)
        assertTrue("And nothing's changed", client.unlocked)
        assertEquals("device-1", Pw.prefs.deviceId)
    }

    // ---- Activity ---------------------------------------------------------------------------

    @Test fun theActivityScreenShowsTheLogAsPlainWords() {
        val (_, s) = seed()
        s.json("/activity", """[{"event":"unlocked","at":"2026-11-07T01:02:03Z"},{"event":"bad","at":"not a time"},{"event":"odd_event‮gnp","at":"2026-11-06T01:02:03Z"}]""")
        open()
        tap("tab-more", 30_000)
        tap("open-activity")
        waitFor(By.text("Unlocked"), 15_000)
        waitFor(By.text("odd_eventgnp"))
        assertFalse("A row with no real time isn't shown", has(By.text("bad"), 300))
    }

    // ---- Today ------------------------------------------------------------------------------

    /** Nothing goes out until the switch is on, what goes out is four numbers, and off takes them back. */
    @Test fun todayIsOffUntilAskedAndOnlyEverCounts() {
        val (client, s) = seed()
        client.saveNew(client.personalVaultId(), org.promptly.sync.passwords.core.newBody("login", "Secret title").withText("username", "ana").withText("password", "aaaaaa").withUrls(listOf(org.promptly.sync.passwords.core.LoginUrl("https://bank.example"))))
        open()
        tap("tab-more", 30_000)
        tap("open-security")
        waitFor(By.res("health-checked"), 30_000)
        waitFor(By.res("health-optin-why"))
        assertFalse(s.calls.contains("PUT /api/passwords/health"))

        tap("health-optin")
        waitUntil("It posts once turned on") { s.calls.contains("PUT /api/passwords/health") }
        val body = s.bodies[s.calls.indexOf("PUT /api/passwords/health")]
        assertEquals("""{"weak":1,"reused":0,"breached":0,"old":0}""", body)
        assertTrue(Pw.prefs.healthOptIn)

        // Each check after that posts again.
        val before = s.calls.count { it == "PUT /api/passwords/health" }
        Harness.scrollTap("health-again")
        waitUntil("Check again posts") { s.calls.count { it == "PUT /api/passwords/health" } > before }

        Harness.device.swipe(Harness.device.displayWidth / 2, Harness.device.displayHeight * 25 / 100, Harness.device.displayWidth / 2, Harness.device.displayHeight * 90 / 100, 60)
        Thread.sleep(600)
        Harness.device.swipe(Harness.device.displayWidth / 2, Harness.device.displayHeight * 25 / 100, Harness.device.displayWidth / 2, Harness.device.displayHeight * 90 / 100, 60)
        Thread.sleep(1200)
        tap("health-optin")
        waitUntil("Off takes them back") { s.calls.contains("DELETE /api/passwords/health") }
        assertFalse(Pw.prefs.healthOptIn)
    }
}
