// SMS User Consent through Google Play services. The host sends the text a few seconds in:
//   adb emu sms send 5551234 "Your code is 482913"
// Skipped unless run with -e pwSms 1, since nothing else on the emulator can send one.
package org.promptly.sync.passwords

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.passwords.Harness.ctx
import org.promptly.sync.passwords.Harness.tap
import org.promptly.sync.passwords.Harness.waitFor
import org.promptly.sync.passwords.ui.PasswordsActivity

@RunWith(AndroidJUnit4::class)
class SmsConsentTest {
    @Test fun aCodeComesFromTheConsentSheet() {
        assumeTrue("Run with -e pwSms 1", InstrumentationRegistry.getArguments().getString("pwSms") == "1")
        Harness.seedOffline()
        Pw.prefs.lockOnScreenOff = false
        ctx.startActivity(Intent(ctx, PasswordsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        tap("tab-codes", 30_000)
        tap("codes-sms")
        Harness.note("Waiting for the host's SMS")
        // Android's sheet: "Allow" lets this app read that one message.
        waitFor(By.text("Allow"), 60_000).click()
        val code = waitFor(By.res("sms-code"), 15_000).text
        assertEquals("From SMS, copied: 482913", code)
    }
}
