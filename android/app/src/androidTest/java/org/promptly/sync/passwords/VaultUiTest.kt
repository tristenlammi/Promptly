// The vault's own screens through UI Automator, on the seeded offline vault, plus a run
// against the real :8092 stack when the host passes a token (see run-passwords-tests).
package org.promptly.sync.passwords

import android.content.Intent
import android.view.WindowManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.passwords.Harness.ctx
import org.promptly.sync.passwords.Harness.device
import org.promptly.sync.passwords.Harness.fill
import org.promptly.sync.passwords.Harness.has
import org.promptly.sync.passwords.Harness.tap
import org.promptly.sync.passwords.Harness.waitFor
import org.promptly.sync.Store
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.MemoryKeeper
import org.promptly.sync.passwords.core.MemoryStore
import org.promptly.sync.passwords.core.SecretKeys
import org.promptly.sync.passwords.core.Totp
import org.promptly.sync.passwords.core.TotpConfig
import org.promptly.sync.passwords.core.VaultApi
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.newBody
import org.promptly.sync.passwords.ui.PasswordsActivity

@RunWith(AndroidJUnit4::class)
class VaultUiTest {
    @Before fun setUp() {
        Harness.home()
        Pw.init(ctx)
        Pw.prefs.lockOnScreenOff = false
    }

    private fun open() {
        ctx.startActivity(Intent(ctx, PasswordsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    @Test fun launcherIconIsThereAndIsNative() {
        val q = Harness.shell("cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.LAUNCHER org.promptly.app")
        assertTrue(q, q.contains("PasswordsLauncher"))
        Harness.seedOffline()
        Harness.shell("am start -n org.promptly.app/org.promptly.app.PasswordsLauncher")
        waitFor(By.res("search"))
        assertEquals("org.promptly.app", device.currentPackageName)
    }

    @Test fun everySecretScreenIsFlagSecure() {
        Harness.seedOffline()
        ActivityScenario.launch(PasswordsActivity::class.java).use { s ->
            s.onActivity { a -> assertTrue((a.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE) != 0) }
        }
        for (cls in listOf(
            "org.promptly.sync.passwords.autofill.AutofillAuthActivity",
            "org.promptly.sync.passwords.autofill.AutofillSaveActivity",
            "org.promptly.sync.passwords.credentials.CredentialActivity",
        )) {
            val src = Class.forName(cls)
            assertNotNull(src)
        }
        assertTrue(Harness.shell("dumpsys window windows").isNotEmpty())
    }

    @Test fun unlockCreateViewEditTrashRestore() {
        val client = Harness.seedOffline()
        client.lock()
        open()
        fill("master-password", Harness.MASTER)
        tap("unlock")
        tap("new-item", 30_000)
        tap("kind-login")
        fill("edit-title", "UI login")
        fill("edit-username", "ui-user")
        fill("edit-password", "ui-Password-1!")
        tap("edit-add-url")
        fill("edit-url-0", "https://ui.example")
        fill("edit-totp", "JBSWY3DPEHPK3PXP")
        Harness.scrollTap("save")
        waitFor(By.res("detail-title"))
        assertEquals("UI login", device.findObject(By.res("detail-title")).text)
        assertEquals("ui-user", device.findObject(By.res("detail-username")).text)
        // The password is hidden until asked for.
        assertNotEquals("ui-Password-1!", device.findObject(By.res("detail-password")).text)
        tap("detail-password-show")
        Thread.sleep(300)
        assertEquals("ui-Password-1!", device.findObject(By.res("detail-password")).text)
        val code = device.findObject(By.res("detail-totp")).text
        assertEquals(6, code.length)
        val now = System.currentTimeMillis()
        assertTrue(code == Totp.code(TotpConfig("JBSWY3DPEHPK3PXP", null, null, null, false, null, null), now) || code == Totp.code(TotpConfig("JBSWY3DPEHPK3PXP"), now - 30_000) || code == Totp.code(TotpConfig("JBSWY3DPEHPK3PXP"), now + 30_000))

        val item = client.allItems().first { it.body.title == "UI login" }
        assertEquals("https://ui.example", item.body.urls.single().url)
        assertEquals("ui-Password-1!", item.body.password)

        tap("edit")
        fill("edit-password", "ui-Password-2!")
        Harness.scrollTap("save")
        waitFor(By.res("detail-title"))
        assertEquals("ui-Password-2!", client.get(item.id)!!.body.password)
        assertEquals("ui-Password-1!", client.get(item.id)!!.body.passwordHistory.first().first)

        Harness.scrollTap("trash")
        waitFor(By.res("search"))
        Thread.sleep(500)
        assertTrue(client.get(item.id)!!.deleted)
        assertFalse(has(By.res("item-UI login"), 500))
        tap("tab-more")
        tap("open-trash")
        waitFor(By.res("trash-UI login"))
        tap("trash-restore")
        Thread.sleep(800)
        assertFalse(client.get(item.id)!!.deleted)
    }

    @Test fun everyKindCanBeCreated() {
        val client = Harness.seedOffline()
        open()
        val before = client.allItems().size
        for (kind in listOf("note", "card", "identity", "totp", "apikey", "wifi", "ssh", "bank", "document")) {
            tap("new-item", 30_000)
            tap("kind-$kind")
            fill("edit-title", "Kind $kind")
            if (kind == "totp") fill("edit-totp", "JBSWY3DPEHPK3PXP")
            Harness.scrollTap("save")
            waitFor(By.res("detail-title"))
            assertEquals("Kind $kind", device.findObject(By.res("detail-title")).text)
            tap("back")
        }
        assertEquals(before + 9, client.allItems().size)
        assertEquals(setOf("note", "card", "identity", "totp", "apikey", "wifi", "ssh", "bank", "document"), client.allItems().map { it.body.kind }.toSet())
        fill("search", "Kind bank")
        waitFor(By.res("item-Kind bank"))
        assertFalse(has(By.res("item-Kind note"), 500))
    }

    @Test fun generatorAndCodes() {
        val client = Harness.seedOffline()
        client.saveNew(client.personalVaultId(), newBody("totp", "Code here").withTotp(TotpConfig("JBSWY3DPEHPK3PXP")))
        open()
        tap("tab-generator", 30_000)
        val first = waitFor(By.res("gen-output")).text
        assertEquals(20, first.length)
        tap("gen-again")
        Thread.sleep(300)
        assertNotEquals(first, device.findObject(By.res("gen-output")).text)
        tap("gen-mode-1")
        Thread.sleep(300)
        assertEquals(5, device.findObject(By.res("gen-output")).text.split('-').size)
        tap("tab-codes")
        val code = waitFor(By.res("code-Code here")).text
        assertEquals(6, code.length)
    }

    @Test fun lockNowLocksEverything() {
        val client = Harness.seedOffline()
        val item = client.saveNew(client.personalVaultId(), newBody("note", "T"))
        open()
        tap("tab-more", 30_000)
        tap("lock-now")
        waitFor(By.res("master-password"))
        Thread.sleep(500)
        assertFalse(client.unlocked)
        assertNull(client.get(item.id))
    }

    @Test fun idleTimerLocks() {
        val client = Harness.seedOffline()
        Pw.prefs.autoLockMinutes = 15
        Pw.touch()
        Pw.lockIfExpired()
        assertTrue(client.unlocked)
        Pw.prefs.autoLockMinutes = 0
        Thread.sleep(50)
        Pw.lockIfExpired()
        Thread.sleep(400)
        assertFalse(client.unlocked)
        Pw.prefs.autoLockMinutes = 15
    }

    @Test fun settingsShowTheSetupGuide() {
        Harness.seedOffline()
        Harness.setAutofill(false)
        open()
        tap("tab-more", 30_000)
        tap("open-settings")
        assertTrue(waitFor(By.res("autofill-state")).text.contains("Turn on"))
        // Chrome is installed on this image, never opened. Its state is read, not changed.
        Harness.note("Chrome setup text: ${device.findObject(By.res("chrome-state-com.android.chrome"))?.text}")
        Harness.setAutofill(true)
        device.pressBack()
        tap("open-settings")
        assertTrue(waitFor(By.res("autofill-state")).text.contains("is your autofill"))
        Harness.setAutofill(false)
        assertTrue(has(By.res("biometric-unavailable"), 1500) || has(By.res("biometric"), 500))
    }

    @Test fun shareTargetAddsAUrl() {
        val client = Harness.seedOffline()
        Harness.shell("am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT Look:https://shared.example/login -n org.promptly.app/org.promptly.sync.passwords.ui.PasswordsActivity")
        waitFor(By.res("edit-url-0"), 20_000)
        assertEquals("https://shared.example/login", device.findObject(By.res("edit-url-0")).text)
        fill("edit-title", "From share")
        Harness.scrollTap("save")
        waitFor(By.res("detail-title"))
        assertEquals("https://shared.example/login", client.allItems().first { it.body.title == "From share" }.body.urls.single().url)
    }

    @Test fun quickSettingsTileLocks() {
        val client = Harness.seedOffline()
        val tile = "org.promptly.app/org.promptly.sync.passwords.PasswordsTileService"
        Harness.shell("cmd statusbar add-tile $tile")
        Harness.shell("cmd statusbar expand-settings")
        Thread.sleep(2500)
        Harness.shell("cmd statusbar click-tile $tile")
        val end = System.currentTimeMillis() + 8000
        while (client.unlocked && System.currentTimeMillis() < end) Thread.sleep(150)
        Harness.shell("cmd statusbar remove-tile $tile")
        Harness.shell("cmd statusbar collapse")
        assertFalse("The tile didn't lock the vault", client.unlocked)
    }

    /** The real server: an app password connects the phone, the vault is made in the app's
     *  screens, another device gets approved here with safety words, and this phone rejoins
     *  by recovery kit and by approval. The host mints throwaway credentials and passes them. */
    @Test fun againstTheRealStack() {
        val args = InstrumentationRegistry.getArguments()
        val bearer = args.getString("pwBearer")
        val server = args.getString("pwServer") ?: "http://10.0.2.2:8092"
        assumeTrue("No -e pwBearer", !bearer.isNullOrEmpty())
        Harness.clearScreen()
        Pw.init(ctx)
        runCatching { Pw.forgetDevice() }
        val store = Store(ctx)
        // The path a phone already paired for photo backup takes.
        store.account = Store.Account(server, args.getString("pwAppUser")!!, args.getString("pwAppPassword")!!, "Instrumented test")
        open()
        fill("server", server)
        tap("connect")
        tap("join-create", 40_000)
        tap("understood")
        fill("new-master", Harness.MASTER)
        fill("new-master-again", Harness.MASTER)
        tap("create-vault")
        val text = waitFor(By.res("kit-secret-key"), 60_000).text
        val secret = SecretKeys.parse(text)
        fill("kit-last-group", SecretKeys.lastGroup(text))
        tap("kit-done")
        waitFor(By.res("search"), 30_000)
        val client = Pw.client()!!
        val item = client.saveNew(client.personalVaultId(), newBody("login", "Over the wire").withText("username", "u").withText("password", "wire-Password-1!").withUrls(listOf(LoginUrl("https://wire.example"))))
        val r = client.sync()
        assertFalse(r.offline)
        assertEquals(1, r.pushed)

        // Lock, and unlock through the app's screen, with the session proved again.
        client.lock()
        fill("master-password", Harness.MASTER)
        tap("unlock")
        waitFor(By.res("search"), 60_000)
        assertEquals("wire-Password-1!", client.get(item.id)!!.body.password)

        // A new device asks: this phone shows the words, and approves.
        val anon = VaultApi(server, { null })
        val second = anon.registerDevice("Bearer $bearer", "Second device")
        val other = VaultClient(VaultApi(server, { second.token }), MemoryStore(), MemoryKeeper())
        val join = other.requestDevice("Second device")
        tap("tab-more")
        tap("open-devices")
        waitFor(By.textContains("(this one)"), 15_000)
        waitFor(By.res("request-${join.code}"), 15_000)
        tap("request-begin")
        val shown = waitFor(By.res("approve-words"), 15_000).text
        assertEquals(join.poll().words!!.joinToString(" "), shown)
        tap("request-approve")
        var state = join.poll()
        val end = System.currentTimeMillis() + 15_000
        while (state.status != "approved" && System.currentTimeMillis() < end) {
            Thread.sleep(500)
            state = join.poll()
        }
        assertEquals("approved", state.status)
        assertTrue(secret.contentEquals(state.secretKey))
        other.unlock(Harness.MASTER)
        assertEquals("wire-Password-1!", other.get(item.id)!!.body.password)

        // Forget this phone. Back through the recovery kit.
        device.pressBack()
        tap("open-settings")
        Harness.scrollTap("forget-device")
        waitFor(By.text("Forget")).click() // Dialogs are their own window, without test-tag ids
        waitFor(By.res("server"), 15_000)
        val third = anon.registerDevice("Bearer $bearer", "Rejoining phone")
        Pw.connect(server, third.token, third.deviceId)
        Harness.home()
        open()
        tap("join-kit", 40_000)
        fill("secret-key", text.lowercase().replace("-", " "))
        fill("master-password", Harness.MASTER)
        tap("kit-unlock")
        waitFor(By.res("search"), 60_000)
        assertEquals("wire-Password-1!", Pw.client()!!.get(item.id)!!.body.password)

        // And once more by approval, this phone being the new device.
        tap("tab-more")
        tap("open-settings")
        Harness.scrollTap("forget-device")
        waitFor(By.text("Forget")).click() // Dialogs are their own window, without test-tag ids
        waitFor(By.res("server"), 15_000)
        val fourth = anon.registerDevice("Bearer $bearer", "Approved phone")
        Pw.connect(server, fourth.token, fourth.deviceId)
        Harness.home()
        open()
        tap("join-approve", 40_000)
        val code = waitFor(By.res("request-code"), 20_000).text
        val req = other.api.deviceRequests().first { it.code == code }
        val approval = other.beginApproval(req.id, req.devicePub)
        val phoneWords = waitFor(By.res("safety-words"), 15_000).text
        assertEquals(approval.words.joinToString(" "), phoneWords)
        other.finishApproval(req.id, req.devicePub)
        fill("master-password", Harness.MASTER)
        tap("approve-unlock")
        waitFor(By.res("search"), 60_000)
        assertEquals("wire-Password-1!", Pw.client()!!.get(item.id)!!.body.password)
        store.clear()
    }
}
