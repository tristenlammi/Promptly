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

    // ---- Security emails ------------------------------------------------------------------------

    private fun event(id: String, kind: String, name: String, domain: String, subject: String) =
        """{"id":"$id","kind":"$kind","from_name":"$name","from_domain":"$domain","subject":"$subject","at":"${java.time.Instant.now().minusSeconds(3600)}"}"""

    private fun login(client: VaultClient, title: String, pw: String, url: String) =
        client.saveNew(client.personalVaultId(), org.promptly.sync.passwords.core.newBody("login", title).withText("username", "ana").withText("password", pw).withUrls(listOf(org.promptly.sync.passwords.core.LoginUrl(url))))

    private fun security() {
        open()
        tap("tab-more", 30_000)
        tap("open-security")
    }

    @Test fun aSecurityEmailIsRaisedAgainstItsLoginMatchedHere() {
        val (client, s) = seed()
        val insta = login(client, "Instagram", "Long-Passphrase-For-Instagram-1", "https://www.instagram.com")
        login(client, "Other", "Long-Passphrase-For-Other-2", "https://other.example")
        s.json("/mail/security-events", "[" + listOf(
            event("real", "password_changed", "Insta\u202Egram", "mail.instagram.com", "Your password was changed"),
            event("fake", "new_signin", "Instagram", "instagram.com.evil.example", "New sign-in"),
            event("nobody", "new_signin", "Elsewhere", "elsewhere.example", "New sign-in"),
            event("odd", "steal_things", "Instagram", "instagram.com", "New sign-in"),
        ).joinToString(",") + "]")
        security()
        waitFor(By.res("mail-alert-real"), 20_000)
        assertEquals("Instagram says your password changed. Was that you?", waitFor(By.res("mail-alert-text")).text)
        waitFor(By.textContains("Your password was changed"))
        for (id in listOf("fake", "nobody", "odd")) assertFalse(id, has(By.res("mail-alert-$id"), 300))

        // Not me leads to changing it, and the login's untouched until a step there says otherwise.
        tap("alert-change")
        waitFor(By.res("change-start"), 15_000)
        assertEquals("Instagram", waitFor(By.res("change-title")).text)
        assertEquals("Long-Passphrase-For-Instagram-1", client.get(insta.id)!!.body.password)
        tap("back")

        // That was me: gone, and it stays gone on this phone.
        tap("tab-more", 30_000)
        tap("open-security")
        tap("alert-dismiss", 20_000)
        assertTrue(Harness.gone(By.res("mail-alert-real")))
        waitUntil("It's remembered") { client.store.getMeta("alerts_dismissed").toString().contains("real") }
        tap("back")
        tap("open-security")
        waitFor(By.res("health-checked"), 30_000)
        assertFalse(has(By.res("mail-alert-real"), 500))
    }

    @Test fun aPhoneWithoutTheScopeGetsNoAlertsAndAWayToAddIt() {
        val (client, s) = seed()
        login(client, "Instagram", "Long-Passphrase-For-Instagram-1", "https://www.instagram.com")
        s.answersFor403("GET /api/passwords/mail/security-events")
        security()
        tap("mail-alerts-add", 20_000)
        waitFor(By.res("mail-scope-add"), 15_000)
        assertFalse(has(By.res("mail-alerts"), 300))
    }

    // ---- Changing a password --------------------------------------------------------------------

    @Test fun theHelperWorksThroughAQueueOneStepAtATime() {
        val (client, s) = seed()
        val first = login(client, "First weak", "aaaaaa", "https://first.example/login")
        val second = login(client, "Second weak", "bbbbbb", "https://www.23andme.com/login")
        val third = login(client, "Third weak", "cccccc", "https://third.example")
        Links.opener = { _, url -> opened += url }
        s.answersFor("POST /api/passwords/vaults", "application/json", "{}".toByteArray())
        security()
        tap("change-queue", 30_000)

        // The first: made and saved first, with the old one still the password.
        Harness.waitTextRes("change-position", "1 of 3", 15_000)
        tap("change-start")
        waitFor(By.res("change-waiting"), 15_000)
        val pending = client.get(first.id)!!.body.str("pendingPassword")!!
        assertTrue(pending.length >= 16)
        assertEquals("aaaaaa", client.get(first.id)!!.body.password)
        assertTrue("Nothing's offered on the page's behalf", opened.isEmpty())
        tap("change-open")
        assertEquals("https://first.example/.well-known/change-password", opened.single())
        waitFor(By.res("change-copy-current"))
        waitFor(By.res("change-copy-new"))
        waitFor(By.res("change-note"))
        tap("change-yes")

        // Saved with history, and on to the next, whose page is known.
        Harness.waitTextRes("change-position", "2 of 3", 15_000)
        val done = client.get(first.id)!!.body
        assertEquals(pending, done.password)
        assertEquals(null, done.str("pendingPassword"))
        assertEquals("aaaaaa", done.passwordHistory.first().first)
        tap("change-start")
        waitFor(By.res("change-waiting"), 15_000)
        tap("change-open")
        assertEquals("https://you.23andme.com/user/edit/password/", opened[1])
        tap("change-no")

        // A no leaves it as it was.
        Harness.waitTextRes("change-position", "3 of 3", 15_000)
        assertEquals("bbbbbb", client.get(second.id)!!.body.password)
        assertEquals(null, client.get(second.id)!!.body.str("pendingPassword"))
        assertTrue(client.get(second.id)!!.body.passwordHistory.isEmpty())
        tap("change-skip")

        waitFor(By.res("change-all-done"), 15_000)
        assertEquals("cccccc", client.get(third.id)!!.body.password)
        tap("change-close")
        waitFor(By.res("tab-more"), 15_000)
        assertFalse(ChangeQueue.active)
    }

    @Test fun aChangeInProgressOutlastsTheVaultLocking() {
        val (client, _) = seed()
        val item = login(client, "Weak one", "aaaaaa", "https://first.example/login")
        Links.opener = { _, url -> opened += url }
        security()
        tap("change-queue", 30_000)
        tap("change-start", 15_000)
        waitFor(By.res("change-waiting"), 15_000)
        Pw.lock("test")
        Harness.fill("master-password", Harness.MASTER)
        tap("unlock")
        tap("change-yes", 30_000)
        waitFor(By.res("tab-more"), 15_000)
        assertEquals("aaaaaa", Pw.client()!!.get(item.id)!!.body.passwordHistory.first().first)
    }

    @Test fun aLoginSaysWhenAChangeIsWaitingAndCanFinishIt() {
        val (client, _) = seed()
        val item = login(client, "Waiting one", "Old-Password-1!", "https://first.example")
        client.update(item.id, org.promptly.sync.passwords.core.PasswordChange.withPending(item.body, "New-Password-2!"))
        open()
        tap("item-${item.body.title}", 30_000)
        waitFor(By.res("detail-pending"), 15_000)
        tap("detail-change")
        waitFor(By.res("change-waiting"), 15_000)
        tap("change-no")
        waitFor(By.res("tab-more"), 15_000)
        assertEquals("Old-Password-1!", client.get(item.id)!!.body.password)
    }

    /** The extension does this from its fill path. On Android it's the system's own sheet, on the real page. */
    @Test fun autofillOnAChangePageFillsTheCurrentPasswordAndTheNewOne() {
        val (client, _) = seed()
        Harness.setAutofill(true)
        val item = login(client, "Change me", "Old-Password-1!", "https://first.example")
        client.update(item.id, org.promptly.sync.passwords.core.PasswordChange.withPending(item.body, "New-Password-2!"))
        Harness.rebuildIndex()
        browser("https://first.example/account/password", "change")
        Harness.tapWebField("current")
        Harness.pick("Change me")
        Harness.waitText("web-pass-echo", "Old-Password-1!", 15_000)
        Harness.waitText("web-new-echo", "New-Password-2!", 15_000)
        assertEquals("Filling it doesn't decide anything", "Old-Password-1!", client.get(item.id)!!.body.password)
        assertEquals("New-Password-2!", client.get(item.id)!!.body.str("pendingPassword"))
    }

    @Test fun anOrdinarySignInStillOnlyGetsTheCurrentPassword() {
        val (client, _) = seed()
        Harness.setAutofill(true)
        val item = login(client, "Sign in", "Old-Password-1!", "https://first.example")
        client.update(item.id, org.promptly.sync.passwords.core.PasswordChange.withPending(item.body, "New-Password-2!"))
        Harness.rebuildIndex()
        browser("https://first.example/login", "login")
        Harness.tapWebField("user")
        Harness.pick("Sign in")
        Harness.waitText("web-pass-echo", "Old-Password-1!", 15_000)
    }

    /** Typed or pasted, Android's own "save?" comes up. It's the change finishing, not a new login. */
    @Test fun savingTheWaitingPasswordFinishesTheChange() {
        val (client, _) = seed()
        val item = login(client, "Change me", "Old-Password-1!", "https://first.example")
        client.update(item.id, org.promptly.sync.passwords.core.PasswordChange.withPending(item.body, "New-Password-2!"))
        val id = org.promptly.sync.passwords.autofill.PendingSaves.put(org.promptly.sync.passwords.autofill.PendingSaves.Save(org.promptly.sync.passwords.autofill.FillTarget.Web("first.example", "https", Harness.TEST_BROWSER), null, "New-Password-2!"))
        ctx.startActivity(Intent(ctx, org.promptly.sync.passwords.autofill.AutofillSaveActivity::class.java).putExtra(org.promptly.sync.passwords.autofill.AutofillSaveActivity.EXTRA_ID, id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        tap("save-commit", 15_000)
        waitUntil("It's the password now") { client.get(item.id)!!.body.password == "New-Password-2!" }
        assertEquals(null, client.get(item.id)!!.body.str("pendingPassword"))
        assertEquals("Old-Password-1!", client.get(item.id)!!.body.passwordHistory.first().first)
        assertEquals("No second login", 1, client.allItems().size)
    }

    // ---- Plus addresses ---------------------------------------------------------------------------

    @Test fun theGeneratorMakesAPlusAddressAndAsksMailToLabelIt() {
        val (_, s) = seed()
        s.answersFor("POST /api/passwords/mail/plus-rule", "application/json", """{"label":"Plus addresses/shopnow"}""".toByteArray())
        open()
        tap("tab-generator", 30_000)
        tap("gen-mode-3")
        Harness.scrollToTag("plus-tag")
        assertFalse(has(By.res("plus-label"), 300))
        Harness.fill("plus-email", "me+old@example.com")
        Harness.fill("plus-tag", "Shop Now!")
        Harness.waitTextRes("gen-output", "me+shopnow@example.com")
        Harness.scrollTap("plus-label")
        waitFor(By.res("plus-result"), 15_000)
        assertTrue(has(By.textContains("labelled Plus addresses/shopnow")))
        assertEquals("""{"address":"me+shopnow@example.com"}""", s.bodies[s.calls.indexOf("POST /api/passwords/mail/plus-rule")])
    }

    @Test fun aPlusRuleSaysWhatTheServerSays() {
        val (_, s) = seed()
        s.answersFor("POST /api/passwords/mail/plus-rule", "application/json", "not json".toByteArray())
        open()
        tap("tab-generator", 30_000)
        tap("gen-mode-3")
        Harness.fill("plus-email", "not an address")
        Harness.fill("plus-tag", "shop")
        Harness.waitTextRes("gen-output", "That isn't an email address")
        assertFalse(has(By.res("plus-label"), 300))
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
