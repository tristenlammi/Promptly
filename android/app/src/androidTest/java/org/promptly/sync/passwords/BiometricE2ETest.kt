// Biometric unlock with the real Keystore key and the system's own prompt. Needs a screen lock
// and an enrolled emulator fingerprint, and the host to keep touching the sensor while this
// runs (adb emu finger touch 1): android/run-biometric-test.ps1 sets that up. Skipped otherwise.
package org.promptly.sync.passwords

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.passwords.Harness.ctx
import org.promptly.sync.passwords.Harness.fill
import org.promptly.sync.passwords.Harness.tap
import org.promptly.sync.passwords.Harness.waitFor
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.newBody
import org.promptly.sync.passwords.ui.PasswordsActivity

@RunWith(AndroidJUnit4::class)
class BiometricE2ETest {
    private fun open() {
        ctx.startActivity(Intent(ctx, PasswordsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun enableInSettings() {
        tap("tab-more", 30_000)
        tap("open-settings")
        Harness.scrollTap("biometric")
        Harness.fill("confirm-password", Harness.MASTER)
        tap("confirm")
        // The system prompt: the host's finger touches answer it.
        val end = System.currentTimeMillis() + 30_000
        while (!Biometrics.enrolled && System.currentTimeMillis() < end) Thread.sleep(250)
        assertTrue("The biometric enrolment never finished", Biometrics.enrolled)
    }

    @Test fun enrolUnlockAndFillBehindAFingerprint() {
        Pw.init(ctx)
        assumeTrue("Needs an enrolled fingerprint", Biometrics.available(ctx))
        val client = Harness.seedOffline()
        Pw.prefs.lockOnScreenOff = false
        val item = client.saveNew(client.personalVaultId(), newBody("login", "Bio login").withText("username", "ana-bio").withText("password", "pw-Bio-1!").withUrls(listOf(Match.appUrl(Harness.TEST_APP, Harness.certOf(Harness.TEST_APP)))))
        Harness.rebuildIndex()
        open()
        enableInSettings()
        // What's stored is ciphertext under the biometric key, not the keys themselves.
        val blob = Pw.prefs.biometricBlob
        assertNotNull(blob)
        val secret = client.currentUnlockSecret()
        assertNotEquals(org.promptly.sync.passwords.core.b64u(secret), blob)
        assertEquals(64 + 16, org.promptly.sync.passwords.core.fromB64u(blob!!).size)

        // Lock, then the app's own unlock asks for the fingerprint by itself.
        tap("back")
        tap("lock-now")
        val deadline = System.currentTimeMillis() + 30_000
        waitFor(By.res("use-biometric"), 30_000)
        while (!client.unlocked && System.currentTimeMillis() < deadline) Thread.sleep(250)
        assertTrue("A fingerprint should have unlocked the vault", client.unlocked)
        assertEquals("pw-Bio-1!", client.get(item.id)!!.body.password)

        // The same from an autofill suggestion, with the vault locked.
        Harness.home()
        Harness.setAutofill(true)
        client.lock()
        assertFalse(client.unlocked)
        Harness.launch(Harness.TEST_APP, "LoginActivity")
        Harness.tapField("username")
        Harness.pick("Bio login")
        Harness.waitText("password-echo", "pw-Bio-1!", 30_000)
        Harness.setAutofill(false)
        Harness.shell("am force-stop ${Harness.TEST_APP}")
    }

    /** Run after the host has enrolled another fingerprint: the key must be dead. Keystore's
     *  own check, with the master password still working. */
    @Test fun aNewFingerprintKillsTheKey() {
        Pw.init(ctx)
        val args = androidx.test.platform.app.InstrumentationRegistry.getArguments()
        assumeTrue("Run by the script, after enrolling a second finger", args.getString("pwAfterNewFinger") == "1")
        assertTrue("The first test's enrolment should still be saved", Biometrics.enrolled)
        val client = Pw.client()!!
        if (client.unlocked) client.lock()
        open()
        waitFor(By.textContains("biometric unlock was turned off"), 30_000)
        assertFalse(Biometrics.enrolled)
        fill("master-password", Harness.MASTER)
        tap("unlock")
        waitFor(By.res("search"), 30_000)
        assertTrue(client.unlocked)
    }
}
