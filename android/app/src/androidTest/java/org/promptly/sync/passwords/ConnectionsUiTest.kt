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
