// The real AutofillService, chosen in the real system setting, driving a separate test app
// through UI Automator: the dropdown, the gated dataset, the unlock screen, the save prompt.
package org.promptly.sync.passwords

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.passwords.Harness.TEST_APP
import org.promptly.sync.passwords.Harness.TEST_BROWSER
import org.promptly.sync.passwords.Harness.certOf
import org.promptly.sync.passwords.Harness.device
import org.promptly.sync.passwords.Harness.has
import org.promptly.sync.passwords.Harness.launch
import org.promptly.sync.passwords.Harness.tap
import org.promptly.sync.passwords.Harness.tapField
import org.promptly.sync.passwords.Harness.waitFor
import org.promptly.sync.passwords.Harness.waitText
import org.promptly.sync.passwords.autofill.AutofillAuthActivity
import org.promptly.sync.passwords.autofill.AutofillIndex
import org.promptly.sync.passwords.autofill.FillTarget
import org.promptly.sync.passwords.autofill.IndexEntry
import org.promptly.sync.passwords.autofill.IndexLookup
import org.promptly.sync.passwords.autofill.ParsedForm
import org.promptly.sync.passwords.autofill.PromptlyAutofillService
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.Totp
import org.promptly.sync.passwords.core.TotpConfig
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.newBody

@RunWith(AndroidJUnit4::class)
class AutofillE2ETest {
    private lateinit var client: VaultClient

    private fun login(title: String, user: String, pw: String, vararg urls: LoginUrl, reprompt: Boolean = false, totp: TotpConfig? = null): Item {
        var b = newBody("login", title).withText("username", user).withText("password", pw).withUrls(urls.toList())
        if (reprompt) b = b.withFlag("reprompt", true)
        if (totp != null) b = b.withTotp(totp)
        return client.saveNew(client.personalVaultId(), b).also { Harness.rebuildIndex() }
    }

    private fun appLink() = Match.appUrl(TEST_APP, certOf(TEST_APP))

    @Before fun setUp() {
        client = Harness.seedOffline()
        Harness.setAutofill(true)
        Pw.prefs.neverSave = emptySet()
        Pw.prefs.lockOnScreenOff = false
    }

    @After fun tearDown() {
        Harness.shell("am force-stop $TEST_APP")
        Harness.shell("am force-stop $TEST_BROWSER")
        Harness.home()
        Harness.setAutofill(false)
    }

    /** The fill request's answer only ever holds labels: the value arrives on selection. */
    @Test fun linkedAppFillsThroughTheDropdown() {
        login("Linked login", "ana-linked", "pw-Linked-1!", appLink())
        launch(TEST_APP, "LoginActivity")
        tapField("username")
        Harness.pick("Linked login")
        waitText("username-echo", "ana-linked")
        waitText("password-echo", "pw-Linked-1!")
    }

    @Test fun lockedVaultShowsTheDatasetThenAsksForTheMasterPassword() {
        login("Locked login", "ana-locked", "pw-Locked-1!", appLink())
        Pw.client()!!.lock()
        assertFalse(Pw.unlocked)
        launch(TEST_APP, "LoginActivity")
        tapField("username")
        Harness.pick("Locked login")
        // The gated dataset opened our activity. Nothing was filled yet.
        waitFor(By.res("master-password"))
        Harness.fill("master-password", Harness.MASTER)
        tap("unlock")
        waitText("username-echo", "ana-locked", 30_000)
        waitText("password-echo", "pw-Locked-1!")
        assertTrue(Pw.unlocked)
    }

    /** The idle timer doesn't tick in deep sleep, so the fill itself checks the clock. */
    @Test fun anExpiredSessionAsksAgainAtFillTime() {
        login("Expired login", "ana-expired", "pw-Expired-1!", appLink())
        launch(TEST_APP, "LoginActivity")
        tapField("username")
        val chip = Harness.suggestion(By.text("Expired login"))
        assertTrue(Pw.unlocked)
        Pw.prefs.autoLockMinutes = 0
        try {
            chip.click()
            waitFor(By.res("master-password"))
            assertFalse(Pw.unlocked)
            tap("unlock-cancel")
            assertEquals("", Harness.textOf("password-echo"))
        } finally {
            Pw.prefs.autoLockMinutes = 15
        }
    }

    @Test fun wrongMasterPasswordDoesNotFill() {
        login("Wrong pw login", "ana-wrong", "pw-Wrong-1!", appLink())
        Pw.client()!!.lock()
        launch(TEST_APP, "LoginActivity")
        tapField("username")
        Harness.pick("Wrong pw login")
        Harness.fill("master-password", "not the password")
        tap("unlock")
        waitFor(By.res("error"), 30_000)
        assertFalse(Pw.unlocked)
        tap("unlock-cancel")
        waitFor(By.desc("password-echo"))
        assertEquals("", Harness.textOf("password-echo"))
    }

    @Test fun anAppWithTheRightNameButWrongCertificateGetsNothing() {
        login("Impostor target", "ana-cert", "pw-Cert-1!", Match.appUrl(TEST_APP, "c29tZS1vdGhlci1jZXJ0"))
        launch(TEST_APP, "LoginActivity")
        tapField("username")
        // "Search Passwords" is always there, the login isn't.
        Harness.waitSuggestion("Search Passwords")
        assertFalse(has(By.text("Impostor target"), 800))
    }

    @Test fun searchingForALoginAsksBeforeTrustingAnUnknownApp() {
        login("Site login", "ana-site", "pw-Site-1!", LoginUrl("https://some-other-site.example"))
        launch(TEST_APP, "LoginActivity")
        tapField("username")
        Harness.suggestion(By.textContains("Search Passwords")).click()
        tap("pick-Site login")
        // No link and no asset links (the site isn't reachable): it says so, and asks.
        waitFor(By.res("confirm-remember"), 25_000).click()
        waitText("username-echo", "ana-site")
        // Remembered: offered next time, by package and certificate.
        val item = client.allItems().first { it.body.title == "Site login" }
        val ref = item.body.urls.mapNotNull { Match.parseAppUrl(it.url) }.single()
        assertEquals(TEST_APP, ref.pkg)
        assertEquals(certOf(TEST_APP), ref.cert)
        Harness.rebuildIndex()
        launch(TEST_APP, "LoginActivity")
        tapField("username")
        Harness.suggestion(By.text("Site login"))
    }

    @Test fun anUntrustedAppsWebViewCantClaimASite() {
        login("Bank", "ana-bank", "pw-Bank-1!", LoginUrl("https://pwtest.promptly.test"))
        launch(TEST_APP, "WebActivity")
        Harness.tapWebField("user")
        Harness.waitSuggestion("Search Passwords")
        assertFalse("Offered a site login to an app that only claims the site", has(By.text("Bank"), 800))
    }

    /** AutoSpill: a login linked to this app, and its WebView showing someone else's page. */
    @Test fun aLinkedAppsWebViewAsksBeforeFillingAnotherSite() {
        login("Linked web", "ana-spill", "pw-Spill-1!", appLink())
        launch(TEST_APP, "WebActivity")
        Harness.tapWebField("user")
        Harness.pick("Linked web")
        waitFor(By.textContains("showing a page from pwtest.promptly.test"), 20_000)
        waitFor(By.textContains(TEST_APP))
        tap("confirm-cancel")
        Thread.sleep(500)
        assertEquals("", waitFor(By.desc("web-pass-echo")).text ?: "")
    }

    @Test fun aLoginSavedForThePageItsWebViewShowsFillsWithoutAsking() {
        login("Linked and saved", "ana-saved", "pw-Saved-1!", appLink(), LoginUrl("https://pwtest.promptly.test"))
        launch(TEST_APP, "WebActivity")
        Harness.tapWebField("user")
        Harness.pick("Linked and saved")
        waitText("web-pass-echo", "pw-Saved-1!", 20_000)
    }

    /** "Lock after: Leaving" with nothing of ours in the foreground. */
    @Test fun aFillUnlockedWithLeavingSetLocksAfterwards() {
        login("Leaving login", "ana-leave", "pw-Leave-1!", appLink())
        Pw.prefs.autoLockMinutes = 0
        try {
            client.lock()
            launch(TEST_APP, "LoginActivity")
            tapField("username")
            Harness.pick("Leaving login")
            Harness.fill("master-password", Harness.MASTER)
            tap("unlock")
            waitText("password-echo", "pw-Leave-1!", 30_000)
            val end = System.currentTimeMillis() + 8_000
            while (client.unlocked && System.currentTimeMillis() < end) Thread.sleep(200)
            assertFalse("Still unlocked after the fill", client.unlocked)
        } finally {
            Pw.prefs.autoLockMinutes = 15
        }
    }

    private fun openCardWarning(): Item {
        login("Real shop", "ana-shop", "pw-Shop-1!", LoginUrl("https://promptlyshop.com"))
        val card = client.saveNew(client.personalVaultId(), org.promptly.sync.passwords.core.newBody("card", "A card").withText("cardNumber", "4111111111111111"))
        Harness.rebuildIndex()
        val intent = AutofillAuthActivity.intent(Harness.ctx, AutofillAuthActivity.MODE_CARD, card.id, FillTarget.Web("promptlyshap.com", "https", TEST_BROWSER), ParsedForm(), false)
        Harness.ctx.startActivity(intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
        waitFor(By.res("lookalike"), 15_000)
        return card
    }

    /** "Fill anyway" fills from what's held on the sheet, which is why it can't outlast a lock. */
    @Test fun aLockWhileTheSheetIsOpenDropsItBackToUnlocking() {
        openCardWarning()
        Thread.sleep(800)
        Pw.lock("test")
        waitFor(By.res("master-password"), 15_000)
        assertFalse("Nothing from the vault behind it", has(By.res("lookalike"), 300))
        assertFalse(has(By.res("lookalike-yes"), 300))
        // From the top: having said yes before the lock doesn't count.
        Harness.fill("master-password", Harness.MASTER)
        tap("unlock")
        waitFor(By.res("lookalike"), 30_000)
        tap("lookalike-no")
    }

    /** The finding as it was found: "Lock after: Leaving", away from the sheet, and back. */
    @Test fun leavingTheSheetLocksItAndComingBackAsksToUnlock() {
        try {
            // Set once it's open: on "Leaving", opening a sheet locks too, which isn't this bug.
            openCardWarning()
            Pw.prefs.autoLockMinutes = 0
            Harness.device.pressHome()
            val end = System.currentTimeMillis() + 8_000
            while (client.unlocked && System.currentTimeMillis() < end) Thread.sleep(200)
            assertFalse("Leaving locks it", client.unlocked)
            val am = Harness.ctx.getSystemService(android.app.ActivityManager::class.java)
            am.appTasks.first { it.taskInfo?.topActivity?.className?.endsWith("AutofillAuthActivity") == true }.moveToFront()
            waitFor(By.res("master-password"), 15_000)
            assertFalse(has(By.res("lookalike-yes"), 300))
            Harness.fill("master-password", Harness.MASTER)
            tap("unlock")
            waitFor(By.res("lookalike"), 30_000)
            tap("lookalike-no")
        } finally {
            Pw.prefs.autoLockMinutes = 15
        }
    }

    @Test fun lockingClearsWhatTheIndexHeldInMemory() {
        login("In memory", "ana-mem", "pw-Mem-1!", appLink())
        val memory = AutofillIndex::class.java.getDeclaredField("memory").apply { isAccessible = true }
        assertTrue(memory.get(null) != null)
        client.lock()
        val end = System.currentTimeMillis() + 3_000
        while (memory.get(null) != null && System.currentTimeMillis() < end) Thread.sleep(100)
        assertEquals(null, memory.get(null))
        // Answers still come, read fresh from the sealed copy, and nothing stays.
        assertEquals(1, AutofillIndex.lookup(Harness.ctx).entries.size)
        assertEquals(null, memory.get(null))
    }

    @Test fun anAllowlistedBrowsersWebDomainIsBelieved() {
        login("Browser site", "ana-browser", "pw-Browser-1!", LoginUrl("https://pwtest.promptly.test"))
        login("Other site", "ana-other", "pw-Other-1!", LoginUrl("https://elsewhere.example"))
        launch(TEST_BROWSER, "WebActivity")
        Harness.tapWebField("user")
        Harness.suggestion(By.text("Browser site")).click()
        waitText("web-user-echo", "ana-browser", 15_000)
        waitText("web-pass-echo", "pw-Browser-1!")
        assertFalse(has(By.text("Other site"), 500))
    }

    @Test fun lookalikeDomainInAnAllowlistedBrowserGetsNothing() {
        login("Real bank", "ana-real", "pw-Real-1!", LoginUrl("https://bank.example.com"))
        launch(TEST_BROWSER, "WebActivity", "--es url https://bank.example.com.evil.test/login")
        Harness.tapWebField("user")
        Harness.suggestion(By.textContains("Search Passwords"))
        assertFalse(has(By.text("Real bank"), 800))
    }

    /** WebView gives no form at all on an http page (as Chrome does without a flag), so this
     *  opens the sheet the way the service would: a saved https login on an http page. */
    @Test fun httpPageAsksBeforeFillingAnHttpsLogin() {
        val item = login("Secure site", "ana-http", "pw-Http-1!", LoginUrl("https://downgrade.promptly.test"))
        val hit = AutofillIndex.matches(AutofillIndex.lookup(Harness.ctx), FillTarget.Web("downgrade.promptly.test", "http", TEST_BROWSER), emptyMap()) { false }.single()
        assertTrue(hit.downgrade)
        val intent = AutofillAuthActivity.intent(Harness.ctx, AutofillAuthActivity.MODE_LOGIN, item.id, FillTarget.Web("downgrade.promptly.test", "http", TEST_BROWSER), ParsedForm(), true)
        Harness.ctx.startActivity(intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
        waitFor(By.textContains("Not a secure page"))
        tap("confirm-cancel")
    }

    @Test fun aFormInAFrameFromAnotherSiteAsks() {
        val item = login("Framed site", "ana-frame", "pw-Frame-1!", LoginUrl("https://pay.promptly.test"))
        val form = ParsedForm<android.view.autofill.AutofillId>().apply { frameDomain = "pay.promptly.test" }
        val intent = AutofillAuthActivity.intent(Harness.ctx, AutofillAuthActivity.MODE_LOGIN, item.id, FillTarget.Web("pay.promptly.test", "https", TEST_BROWSER), form, false)
        Harness.ctx.startActivity(intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
        waitFor(By.textContains("from pay.promptly.test"))
        tap("confirm-cancel")
    }

    @Test fun inlineSuggestionsAreOfferedWhenTheKeyboardAsks() {
        login("Inline login", "ana-inline", "pw-Inline-1!", appLink())
        launch(TEST_APP, "LoginActivity")
        tapField("username")
        val chip = Harness.suggestion(By.text("Inline login"))
        Harness.note("Suggestion drawn by ${chip.applicationPackage}; inline presentations in the last answer: ${PromptlyAutofillService.lastInlineCount}")
        assertTrue("Gboard on this image supports inline, so the answer should carry them", PromptlyAutofillService.lastInlineCount > 0)
        chip.click()
        waitText("password-echo", "pw-Inline-1!")
    }

    @Test fun repromptItemAsksAgainEvenWhenUnlocked() {
        login("Reprompt login", "ana-again", "pw-Again-1!", appLink(), reprompt = true)
        launch(TEST_APP, "LoginActivity")
        tapField("username")
        Harness.pick("Reprompt login")
        Harness.fill("confirm-password", Harness.MASTER)
        tap("confirm")
        waitText("password-echo", "pw-Again-1!", 30_000)
    }

    @Test fun copiesTheTwoFactorCodeAfterFilling() {
        val cfg = TotpConfig("JBSWY3DPEHPK3PXP")
        login("With 2FA", "ana-2fa", "pw-2fa-1!", appLink(), totp = cfg)
        launch(TEST_APP, "LoginActivity")
        tapField("username")
        Harness.pick("With 2FA")
        waitText("password-echo", "pw-2fa-1!")
        // The app can't read the clipboard from the background: the toast's text is the check.
        assertTrue(Pw.prefs.copyTotpAfterFill)
    }

    @Test fun fillsATwoFactorField() {
        val cfg = TotpConfig("JBSWY3DPEHPK3PXP")
        login("OTP login", "ana-otp", "pw-Otp-1!", appLink(), totp = cfg)
        launch(TEST_APP, "OtpActivity")
        tapField("otp")
        Harness.pick("OTP login")
        val end = System.currentTimeMillis() + 8000
        var filled = ""
        while (System.currentTimeMillis() < end) {
            filled = device.findObject(By.desc("otp-echo"))?.text ?: ""
            if (filled.length == 6) break
            Thread.sleep(150)
        }
        assertEquals(6, filled.length)
        val now = System.currentTimeMillis()
        assertTrue(filled == Totp.code(cfg, now) || filled == Totp.code(cfg, now - 30_000))
    }

    @Test fun cardsAlwaysConfirmFirst() {
        client.saveNew(client.personalVaultId(), newBody("card", "Test card").withText("cardNumber", "4111111111111111").withText("cardCvv", "123"))
        Harness.rebuildIndex()
        launch(TEST_APP, "CardActivity")
        tapField("cardnumber")
        Harness.pick("Test card")
        waitFor(By.textContains("Fill this card?"))
        tap("confirm-fill")
        waitText("cardnumber-echo", "4111111111111111")
        waitText("cvv-echo", "123")
    }

    @Test fun savesANewLoginAndTiesItToTheApp() {
        launch(TEST_APP, "LoginActivity")
        tapField("username")
        Thread.sleep(800)
        waitFor(By.desc("username")).text = "new-user"
        waitFor(By.desc("password")).text = "pw-New-1!"
        waitFor(By.desc("Sign in")).click()
        // Android's own save sheet, then ours.
        waitFor(By.textContains("Save").pkg("android"), 15_000)
        (device.findObject(By.res("android:id/autofill_save_yes")) ?: device.findObject(By.text("Save"))).click()
        tap("save-confirm", 30_000)
        val deadline = System.currentTimeMillis() + 8000
        var saved: Item? = null
        while (saved == null && System.currentTimeMillis() < deadline) {
            saved = client.allItems().firstOrNull { it.body.username == "new-user" }
            Thread.sleep(150)
        }
        assertNotNull(saved)
        assertEquals("pw-New-1!", saved!!.body.password)
        assertEquals(certOf(TEST_APP), saved.body.urls.mapNotNull { Match.parseAppUrl(it.url) }.single().cert)
    }

    @Test fun twoStepSignInSavesBothPages() {
        launch(TEST_APP, "TwoStepActivity")
        tapField("email")
        Thread.sleep(800)
        waitFor(By.desc("email")).text = "first@step.example"
        waitFor(By.desc("Next")).click()
        waitFor(By.desc("password")).click()
        Thread.sleep(800)
        waitFor(By.desc("password")).text = "pw-Step-1!"
        waitFor(By.desc("Sign in")).click()
        waitFor(By.textContains("Save").pkg("android"), 15_000)
        (device.findObject(By.res("android:id/autofill_save_yes")) ?: device.findObject(By.text("Save"))).click()
        tap("save-confirm", 30_000)
        val deadline = System.currentTimeMillis() + 8000
        var saved: Item? = null
        while (saved == null && System.currentTimeMillis() < deadline) {
            saved = client.allItems().firstOrNull { it.body.password == "pw-Step-1!" }
            Thread.sleep(150)
        }
        assertNotNull(saved)
        assertEquals("first@step.example", saved!!.body.username)
    }

    @Test fun neverForThisSiteStopsAsking() {
        launch(TEST_APP, "LoginActivity")
        tapField("username")
        Thread.sleep(800)
        waitFor(By.desc("username")).text = "never-user"
        waitFor(By.desc("password")).text = "pw-Never-1!"
        waitFor(By.desc("Sign in")).click()
        waitFor(By.textContains("Save").pkg("android"), 15_000)
        (device.findObject(By.res("android:id/autofill_save_yes")) ?: device.findObject(By.text("Save"))).click()
        tap("save-never", 30_000)
        assertTrue("app:$TEST_APP" in Pw.prefs.neverSave)
        assertTrue(client.allItems().none { it.body.username == "never-user" })
    }

    /** Measured, not assumed: 5,000 items, two sites each, on this emulator. */
    @Test fun answerFromAFiveThousandItemIndexIsQuick() {
        val entries = (1..5000).map { i ->
            IndexEntry("id$i", "login", "Site $i", "user$i", listOf(LoginUrl("https://www.site$i.com/login"), LoginUrl("https://other$i.co.uk")), false, false)
        }
        val text = AutofillIndex.encode(entries)
        val t0 = System.nanoTime()
        val decoded = AutofillIndex.decode(text)
        val lookup = IndexLookup(decoded)
        Harness.note("5000-item index: load and arrange ${(System.nanoTime() - t0) / 1_000_000} ms, ${text.length / 1024} KB")
        val runs = (1..50).map {
            val t = System.nanoTime()
            val hits = AutofillIndex.matches(lookup, FillTarget.Web("www.site77.com", "https", "x"), emptyMap()) { false }
            assertTrue(hits.isNotEmpty())
            (System.nanoTime() - t) / 1000
        }.sorted()
        Harness.note("5000-item web match: median ${runs[25]} us, worst ${runs.last()} us")
        val app = (1..50).map {
            val t = System.nanoTime()
            AutofillIndex.matches(lookup, FillTarget.App("com.x", "c", null), emptyMap()) { false }
            (System.nanoTime() - t) / 1000
        }.sorted()
        Harness.note("5000-item app match: median ${app[25]} us, worst ${app.last()} us")
        assertTrue("median ${runs[25]} us", runs[25] < 50_000)
    }
}
