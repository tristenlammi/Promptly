// One proof per passkey (A74), with a real fingerprint: the real Keystore key, the system's own
// prompt, the real Credential Manager sheet and a separate calling app. Needs a screen lock, an
// enrolled emulator fingerprint and the host touching the sensor while it runs:
// android/run-biometric-test.ps1 does all three. Skipped otherwise.
package org.promptly.sync.passwords

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.passwords.Harness.TEST_APP
import org.promptly.sync.passwords.Harness.certOf
import org.promptly.sync.passwords.Harness.ctx
import org.promptly.sync.passwords.Harness.has
import org.promptly.sync.passwords.Harness.launch
import org.promptly.sync.passwords.Harness.tap
import org.promptly.sync.passwords.Harness.waitFor
import org.promptly.sync.passwords.core.PasskeyPin
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.b64u
import org.promptly.sync.passwords.core.fromB64u
import org.promptly.sync.passwords.core.hex
import org.promptly.sync.passwords.core.utf8
import org.promptly.sync.passwords.ui.PasswordsActivity
import java.net.ServerSocket
import kotlin.concurrent.thread

@RunWith(AndroidJUnit4::class)
class PasskeyBiometricE2ETest {
    private var server: ServerSocket? = null
    private val pin = "482913"
    private val createJson = """{"rp":{"id":"passkey-test.promptly.test","name":"Passkey Test"},"user":{"id":"${b64u(utf8("user-1"))}","name":"ana@passkey.test","displayName":"Ana"},"challenge":"${b64u(utf8("challenge-create"))}","pubKeyCredParams":[{"type":"public-key","alg":-7}],"authenticatorSelection":{"residentKey":"required","userVerification":"required"}}"""
    private val getJson = """{"rpId":"passkey-test.promptly.test","challenge":"${b64u(utf8("challenge-get"))}","userVerification":"required"}"""

    private fun serveAssetLinks() {
        val fp = hex(fromB64u(certOf(TEST_APP))).uppercase().chunked(2).joinToString(":")
        val body = """[{"relation":["delegate_permission/common.get_login_creds"],"target":{"namespace":"android_app","package_name":"$TEST_APP","sha256_cert_fingerprints":["$fp"]}}]"""
        val s = ServerSocket(18765, 8, java.net.InetAddress.getByName("localhost"))
        server = s
        thread(isDaemon = true) {
            while (!s.isClosed) {
                val c = runCatching { s.accept() }.getOrNull() ?: break
                runCatching {
                    c.getInputStream().bufferedReader().let { r -> while (r.readLine()?.isNotEmpty() == true) Unit }
                    val bytes = body.toByteArray()
                    c.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                    c.getOutputStream().write(bytes)
                    c.getOutputStream().flush()
                }
                runCatching { c.close() }
            }
        }
    }

    private fun provider(on: Boolean) {
        if (on) {
            Harness.shell("settings put secure credential_service ${Harness.CREDENTIAL}")
            Harness.shell("settings put secure credential_service_primary ${Harness.CREDENTIAL}")
            Pw.prefs.prefs.edit().remove("dal_sealed").commit()
            org.promptly.sync.passwords.autofill.AssetLinks.forgetMemory()
        } else {
            Harness.shell("settings delete secure credential_service")
            Harness.shell("settings delete secure credential_service_primary")
        }
    }

    @After fun tearDown() {
        runCatching { server?.close() }
        if (Harness.device.currentPackageName == "com.google.android.gms") Harness.device.pressBack()
        Harness.shell("am force-stop $TEST_APP")
        Harness.home()
        provider(false)
    }

    private fun start(action: String, extras: String = "") {
        Harness.home()
        launch(TEST_APP, "CredActivity", "--es action $action $extras")
        waitFor(By.desc("go")).click()
    }

    private fun result(ms: Long = 60_000): String {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) {
            val t = Harness.device.findObject(By.desc("result"))?.text
            if (t != null && t != "waiting") return t
            Thread.sleep(200)
        }
        throw AssertionError("No result from Credential Manager.\nWindow:\n${Harness.dumpWindow()}")
    }

    private fun pickOurEntry(vararg texts: String) {
        val end = System.currentTimeMillis() + 25_000
        var tapped = false
        while (System.currentTimeMillis() < end) {
            for (t in texts) {
                if (Harness.device.findObject(By.textContains(t)) != null) {
                    Thread.sleep(1200)
                    runCatching { Harness.device.findObject(By.textContains(t))?.click() }
                    tapped = true
                    break
                }
            }
            if (tapped) {
                Thread.sleep(2500)
                if (texts.none { Harness.device.findObject(By.textContains(it)) != null }) return
            }
            Thread.sleep(250)
        }
        if (!tapped) throw AssertionError("The sheet didn't offer ${texts.toList()}.\nWindow:\n${Harness.dumpWindow()}")
    }

    private fun userVerified(got: String): Boolean {
        val auth = Json.parseToJsonElement(got.removePrefix("got:")).jsonObject.getValue("response").jsonObject
        return (fromB64u(auth.getValue("authenticatorData").jsonPrimitive.content)[32].toInt() and 0x04) != 0
    }

    private fun open() {
        ctx.startActivity(Intent(ctx, PasswordsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
    }

    /** No box may be on screen: the answer comes with nothing typed. */
    private fun nothingToType() {
        assertFalse("a passkey PIN box showed", has(By.res("passkey-pin"), 300))
        assertFalse("a master password box showed", has(By.res("confirm-password"), 300))
    }

    /**
     * The whole of A74 on one enrolment: the once-only offer after a master password turns the
     * fingerprint on; then a passkey is made, used with the vault open, used with it locked, used on
     * an "ask again" item, all with one touch and nothing typed; and after five wrong PINs a
     * fingerprint is refused and the master password alone signs in.
     */
    @Test fun passkeysTakeOneFingerprint() {
        Pw.init(ctx)
        assumeTrue("Needs an enrolled fingerprint", Biometrics.available(ctx))
        assumeTrue("Needs Android 14", android.os.Build.VERSION.SDK_INT >= 34)
        val client: VaultClient = Harness.seedOffline()
        Pw.prefs.lockOnScreenOff = false
        provider(true)
        serveAssetLinks()

        // The offer, once: lock, unlock with the master password in the app, say yes, touch.
        Pw.prefs.biometricOffered = false
        client.lock()
        open()
        Harness.fill("master-password", Harness.MASTER)
        tap("unlock")
        waitFor(By.res("bio-offer"), 30_000)
        tap("bio-offer-on")
        val enrolBy = System.currentTimeMillis() + 30_000
        while (!Biometrics.enrolled && System.currentTimeMillis() < enrolBy) Thread.sleep(250)
        assertTrue("Turning the fingerprint on never finished", Biometrics.enrolled)
        assertTrue(Pw.prefs.biometricOffered)
        waitFor(By.res("search"), 30_000)
        Harness.note("offer: fingerprint turned on from the unlock screen")

        // (h) Making a passkey, vault open: one touch. No PIN is asked for, so none is chosen.
        start("createPasskey", "--es json64 ${b64u(utf8(createJson))}")
        pickOurEntry("Continue", "Save passkey to Passwords", "Create")
        val created = result()
        assertTrue(created, created.startsWith("created:"))
        nothingToType()
        assertNull(PasskeyPin.of(client))
        Harness.note("create: one fingerprint, no PIN")

        // (b) Vault open: one touch.
        start("getPasskey", "--es json64 ${b64u(utf8(getJson))}")
        pickOurEntry("ana@passkey.test")
        var got = result()
        assertTrue(got, got.startsWith("got:"))
        assertTrue("UV", userVerified(got))
        nothingToType()
        Harness.note("get, open: one fingerprint")

        // (a) Vault locked: the touch that unlocks it is the proof, and the pick just signs.
        client.lock()
        assertFalse(client.unlocked)
        start("getPasskey", "--es json64 ${b64u(utf8(getJson))}")
        pickOurEntry("Unlock Passwords")
        pickOurEntry("ana@passkey.test")
        got = result()
        assertTrue(got, got.startsWith("got:"))
        assertTrue("UV", userVerified(got))
        nothingToType()
        assertFalse(Pw.proofGrants.waiting)
        Harness.note("get, locked: one fingerprint")

        // (f) An "ask again" item, vault open: still one touch, and never the PIN.
        val item = client.allItems().first { it.body.kind == "passkey" }
        client.update(item.id, item.body.withFlag("reprompt", true))
        start("getPasskey", "--es json64 ${b64u(utf8(getJson))}")
        pickOurEntry("ana@passkey.test")
        got = result()
        assertTrue(got, got.startsWith("got:"))
        nothingToType()
        client.update(item.id, client.get(item.id)!!.body.withFlag("reprompt", false))
        Harness.note("get, ask-again item: one fingerprint")

        // (e) Five wrong PINs (D88): locked, and a fingerprint is refused however often it's touched.
        client.store.setMeta(PasskeyPin.TRIES_META, JsonPrimitive(PasskeyPin.TRIES))
        client.lock()
        start("getPasskey", "--es json64 ${b64u(utf8(getJson))}")
        pickOurEntry("Unlock Passwords")
        waitFor(By.textContains("Five wrong passkey PINs in a row"), 25_000)
        assertFalse(has(By.res("use-biometric"), 500))
        Thread.sleep(3000)
        assertFalse("A fingerprint opened a vault locked out by wrong PINs", client.unlocked)
        Harness.fill("master-password", Harness.MASTER)
        tap("unlock")
        pickOurEntry("ana@passkey.test")
        got = result()
        assertTrue(got, got.startsWith("got:"))
        assertEquals(0, PasskeyPin.tries(client.store))
        Harness.note("locked out by PINs: fingerprint refused, master password alone signed in")
    }

    /** Run after the host has enrolled another fingerprint: the key is dead (A30). A passkey then
     *  says so and takes the PIN, and the fingerprint can be turned on again. */
    @Test fun aNewFingerprintGoesBackToThePin() {
        Pw.init(ctx)
        val args = androidx.test.platform.app.InstrumentationRegistry.getArguments()
        assumeTrue("Run by the script, after enrolling another finger", args.getString("pwAfterNewFinger") == "1")
        assertTrue("The first test's enrolment should still be saved", Biometrics.enrolled)
        val client = Pw.client()!!
        if (!client.unlocked) client.unlock(Harness.MASTER)
        Pw.touch()
        Pw.prefs.lockOnScreenOff = false
        provider(true)
        serveAssetLinks()

        start("getPasskey", "--es json64 ${b64u(utf8(getJson))}")
        pickOurEntry("ana@passkey.test")
        waitFor(By.textContains("biometric unlock was turned off"), 30_000)
        assertFalse(Biometrics.enrolled)
        assertFalse(has(By.res("passkey-biometric"), 300))
        tap("passkey-use-pin")
        // None was ever chosen on this vault, so it's chosen here.
        waitFor(By.res("pin-choose"), 25_000)
        Harness.fill("passkey-pin", pin)
        Harness.fill("passkey-pin-again", pin)
        tap("passkey-pin-go")
        val got = result()
        assertTrue(got, got.startsWith("got:"))
        assertTrue("UV", userVerified(got))

        // And on again, in Settings, with the master password first.
        open()
        tap("tab-more", 30_000)
        tap("open-settings")
        Harness.scrollTap("biometric")
        Harness.fill("confirm-password", Harness.MASTER)
        tap("confirm")
        val end = System.currentTimeMillis() + 30_000
        while (!Biometrics.enrolled && System.currentTimeMillis() < end) Thread.sleep(250)
        assertTrue("The fingerprint couldn't be turned on again", Biometrics.enrolled)
    }
}
