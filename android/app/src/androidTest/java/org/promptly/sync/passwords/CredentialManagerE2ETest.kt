// The real CredentialProviderService, picked as the provider in the system setting, called by
// a separate app through the real Credential Manager API and the system's own sheet. The asset
// links file comes from a small server in this test, through a debug-only address override.
package org.promptly.sync.passwords

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.passwords.Harness.TEST_APP
import org.promptly.sync.passwords.Harness.certOf
import org.promptly.sync.passwords.Harness.has
import org.promptly.sync.passwords.Harness.launch
import org.promptly.sync.passwords.Harness.tap
import org.promptly.sync.passwords.Harness.waitFor
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.Primitives
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.b64u
import org.promptly.sync.passwords.core.fromB64u
import org.promptly.sync.passwords.core.hex
import org.promptly.sync.passwords.core.newBody
import org.promptly.sync.passwords.core.utf8
import java.net.ServerSocket
import kotlin.concurrent.thread

@RunWith(AndroidJUnit4::class)
class CredentialManagerE2ETest {
    private lateinit var client: VaultClient
    private var server: ServerSocket? = null

    /** Port 18765 on the phone: what `passkey-test.promptly.test` resolves to in a debug build. */
    private fun serveAssetLinks(body: String) {
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

    private fun assetLinksFor(pkg: String, certB64u: String): String {
        val fp = hex(fromB64u(certB64u)).uppercase().chunked(2).joinToString(":")
        return """[{"relation":["delegate_permission/common.get_login_creds"],"target":{"namespace":"android_app","package_name":"$pkg","sha256_cert_fingerprints":["$fp"]}}]"""
    }

    private val createJson = """{"rp":{"id":"passkey-test.promptly.test","name":"Passkey Test"},"user":{"id":"${b64u(utf8("user-1"))}","name":"ana@passkey.test","displayName":"Ana"},"challenge":"${b64u(utf8("challenge-create"))}","pubKeyCredParams":[{"type":"public-key","alg":-7}],"authenticatorSelection":{"residentKey":"required","userVerification":"required"},"attestation":"none"}"""
    private val getJson = """{"rpId":"passkey-test.promptly.test","challenge":"${b64u(utf8("challenge-get"))}","userVerification":"required"}"""

    @Before fun setUp() {
        client = Harness.seedOffline()
        Pw.prefs.lockOnScreenOff = false
        val sdk = android.os.Build.VERSION.SDK_INT
        assumeTrue("Needs Android 14", sdk >= 34)
        // The two settings Android reads: enabled providers and the primary one.
        Harness.shell("settings put secure credential_service ${Harness.CREDENTIAL}")
        Harness.shell("settings put secure credential_service_primary ${Harness.CREDENTIAL}")
        // AssetLinks caches per package and site across runs.
        Pw.prefs.prefs.edit().apply { Pw.prefs.prefs.all.keys.filter { it.startsWith("dal|") }.forEach { remove(it) } }.apply()
    }

    @After fun tearDown() {
        runCatching { server?.close() }
        // A sheet left up would sit over the next test.
        if (Harness.device.currentPackageName == "com.google.android.gms") Harness.device.pressBack()
        Harness.shell("am force-stop $TEST_APP")
        Harness.home()
        Harness.shell("settings delete secure credential_service")
        Harness.shell("settings delete secure credential_service_primary")
    }

    private fun start(action: String, extras: String = "") {
        Harness.home()
        launch(TEST_APP, "CredActivity", "--es action $action $extras")
        waitFor(By.desc("go")).click()
    }

    private fun result(ms: Long = 40_000): String {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) {
            val t = Harness.device.findObject(By.desc("result"))?.text
            if (t != null && t != "waiting") return t
            Thread.sleep(200)
        }
        throw AssertionError("No result from Credential Manager.\nWindow:\n${Harness.dumpWindow()}")
    }

    /** The sheet animates in, and swallows a tap made too soon: wait, tap, and tap again if
     *  it's still there after a moment. */
    private fun pickOurEntry(vararg texts: String) {
        val end = System.currentTimeMillis() + 25_000
        var tapped = false
        while (System.currentTimeMillis() < end) {
            for (t in texts) {
                val hit = Harness.device.findObject(By.textContains(t))
                if (hit != null) {
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

    @Test fun savesAPasswordFromAnApp() {
        start("createPassword", "--es id cred-user --es pw cred-Password-1!")
        // Google Play services draws the sheet on this image; our description is on it.
        waitFor(By.textContains("End-to-end encrypted on your own server"), 25_000)
        pickOurEntry("Continue", "Save password to Passwords")
        tap("credential-confirm", 25_000)
        assertEquals("created-password", result())
        val item = client.allItems().first { it.body.username == "cred-user" }
        assertEquals("cred-Password-1!", item.body.password)
        assertEquals(certOf(TEST_APP), item.body.urls.mapNotNull { Match.parseAppUrl(it.url) }.single().cert)
    }

    @Test fun answersAPasswordRequestOnlyForTheLinkedApp() {
        val linked = client.saveNew(client.personalVaultId(), newBody("login", "Cred linked").withText("username", "linked-user").withText("password", "cred-Linked-1!").withUrls(listOf(Match.appUrl(TEST_APP, certOf(TEST_APP)))))
        client.saveNew(client.personalVaultId(), newBody("login", "Not linked").withText("username", "other-user").withText("password", "nope").withUrls(listOf(LoginUrl("https://elsewhere.example"))))
        start("getPassword")
        pickOurEntry("linked-user")
        assertEquals("password:linked-user:cred-Linked-1!", result())
        assertFalse(has(By.text("other-user"), 300))
        assertEquals("Cred linked", client.get(linked.id)!!.body.title)
    }

    @Test fun createsAndUsesAPasskeyWithAssetLinks() {
        serveAssetLinks(assetLinksFor(TEST_APP, certOf(TEST_APP)))
        val pkgOrigin = "android:apk-key-hash:${certOf(TEST_APP)}"

        start("createPasskey", "--es json64 ${b64u(utf8(createJson))}")
        pickOurEntry("Continue", "Save passkey to Passwords", "Create")
        // No biometric on this phone, so the master password stands in for it.
        Harness.fill("confirm-password", Harness.MASTER)
        tap("confirm")
        val created = result()
        assertTrue(created, created.startsWith("created:"))
        val reg = Json.parseToJsonElement(created.removePrefix("created:")).jsonObject
        val response = reg.getValue("response").jsonObject
        val clientData = Json.parseToJsonElement(String(fromB64u(response.getValue("clientDataJSON").jsonPrimitive.content))).jsonObject
        assertEquals("webauthn.create", clientData.getValue("type").jsonPrimitive.content)
        assertEquals(pkgOrigin, clientData.getValue("origin").jsonPrimitive.content)
        assertEquals(b64u(utf8("challenge-create")), clientData.getValue("challenge").jsonPrimitive.content)
        val publicKey = fromB64u(response.getValue("publicKey").jsonPrimitive.content)

        val item = client.allItems().first { it.body.kind == "passkey" }
        val saved = item.body.passkeys.single()
        assertEquals("passkey-test.promptly.test", saved.rpId)
        assertEquals("ana@passkey.test", saved.userName)

        start("getPasskey", "--es json64 ${b64u(utf8(getJson))}")
        pickOurEntry("ana@passkey.test")
        Harness.fill("confirm-password", Harness.MASTER)
        tap("confirm")
        val got = result()
        assertTrue(got, got.startsWith("got:"))
        val auth = Json.parseToJsonElement(got.removePrefix("got:")).jsonObject.getValue("response").jsonObject
        val authData = fromB64u(auth.getValue("authenticatorData").jsonPrimitive.content)
        val cd = fromB64u(auth.getValue("clientDataJSON").jsonPrimitive.content)
        assertTrue(String(cd).contains(pkgOrigin))
        val v = java.security.Signature.getInstance("SHA256withECDSA")
        v.initVerify(java.security.KeyFactory.getInstance("EC").generatePublic(java.security.spec.X509EncodedKeySpec(publicKey)))
        v.update(authData)
        v.update(Primitives.sha256(cd))
        assertTrue(v.verify(fromB64u(auth.getValue("signature").jsonPrimitive.content)))
        assertEquals(b64u(utf8("user-1")), auth.getValue("userHandle").jsonPrimitive.content)
    }

    @Test fun refusesAPasskeyWhenTheSiteDoesntListTheApp() {
        serveAssetLinks(assetLinksFor("com.someone.else", certOf(TEST_APP)))
        start("createPasskey", "--es json64 ${b64u(utf8(createJson))}")
        pickOurEntry("Continue", "Save passkey to Passwords", "Create")
        waitFor(By.textContains("doesn't list this app"), 25_000)
        tap("credential-close")
        assertTrue(result().startsWith("error:"))
        assertTrue(client.allItems().none { it.body.kind == "passkey" })
    }

    @Test fun lockedVaultOffersOnlyAnUnlock() {
        client.saveNew(client.personalVaultId(), newBody("login", "Locked cred").withText("username", "locked-user").withText("password", "cred-Locked-1!").withUrls(listOf(Match.appUrl(TEST_APP, certOf(TEST_APP)))))
        client.lock()
        start("getPassword")
        pickOurEntry("Unlock Passwords")
        Harness.fill("master-password", Harness.MASTER)
        tap("unlock")
        pickOurEntry("locked-user")
        assertEquals("password:locked-user:cred-Locked-1!", result())
    }
}
