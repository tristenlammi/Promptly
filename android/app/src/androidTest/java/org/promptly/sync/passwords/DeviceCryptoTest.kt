// On the phone itself: the vectors under the engine the app really uses, the Argon2
// benchmark for the library choice, the Keystore, the SQLite copy, the assets.
package org.promptly.sync.passwords

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.passwords.autofill.TrustedBrowsers
import org.promptly.sync.passwords.autofill.signingCerts
import org.promptly.sync.passwords.core.BouncyCastleArgon2
import org.promptly.sync.passwords.core.CachedItem
import org.promptly.sync.passwords.core.Generator
import org.promptly.sync.passwords.core.ItemBody
import org.promptly.sync.passwords.core.KdfParams
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.Passkeys
import org.promptly.sync.passwords.core.Primitives
import org.promptly.sync.passwords.core.b64u
import org.promptly.sync.passwords.core.decryptItemJson
import org.promptly.sync.passwords.core.deriveRoot
import org.promptly.sync.passwords.core.deviceSafetyWords
import org.promptly.sync.passwords.core.fromB64u
import org.promptly.sync.passwords.core.fromHex
import org.promptly.sync.passwords.core.hex
import org.promptly.sync.passwords.core.identityWords
import org.promptly.sync.passwords.core.newBody
import org.promptly.sync.passwords.core.parseKdf
import org.promptly.sync.passwords.core.randomBytes
import org.promptly.sync.passwords.core.utf8

@RunWith(AndroidJUnit4::class)
class DeviceCryptoTest {
    private val vectors: JsonObject by lazy {
        val text = InstrumentationRegistry.getInstrumentation().context.assets.open("passwords/vectors.json").use { it.readBytes().decodeToString() }
        Json.parseToJsonElement(text) as JsonObject
    }

    @Before fun setUp() = Pw.init(Harness.ctx)

    private fun JsonObject.s(k: String) = this.getValue(k).jsonPrimitive.content

    @Test fun vectorsOnTheDeviceWithTheChosenEngine() {
        val native = Pw.nativeArgon2()
        assertNotNull("argon2kt didn't load on this ABI", native)
        assertTrue("The app should be using the native engine", Primitives.argon2Engine !== BouncyCastleArgon2)
        for (e in vectors.getValue("kat").jsonObject.getValue("argon2id").jsonArray) {
            val c = e.jsonObject
            val k = parseKdf(c["kdf"])!!
            val pw = fromHex(c.s("password_hex"))
            val salt = fromHex(c.s("salt_hex"))
            assertEquals(c.s("output_hex"), hex(native!!.hash(pw, salt, k.m, k.t, k.p, 32)))
            assertEquals(c.s("output_hex"), hex(BouncyCastleArgon2.hash(pw, salt, k.m, k.t, k.p, 32)))
        }
        val roots = vectors.getValue("root").jsonArray
        assertEquals(4, roots.size)
        for (e in roots) {
            val c = e.jsonObject
            val r = deriveRoot(c.s("password"), fromHex(c.s("secret_key_hex")), fromHex(c.s("salt_hex")), parseKdf(c["kdf"])!!)
            assertEquals(c.s("unlock_hex"), hex(r.unlock))
            assertEquals(c.s("auth_hex"), hex(r.auth))
        }
        for (e in vectors.getValue("item").jsonArray) {
            val c = e.jsonObject
            val json = decryptItemJson(fromHex(c.s("vault_key_hex")), c.s("vault_id"), c.s("item_id"), fromHex(c.s("blob_hex")))
            assertEquals(c.getValue("body").jsonObject, Json.parseToJsonElement(json))
        }
    }

    @Test fun safetyWordsFromTheBundledList() {
        for (e in vectors.getValue("safety_words").jsonArray) {
            val c = e.jsonObject
            val want = c.getValue("words").jsonArray.map { it.jsonPrimitive.content }
            val got = if (c.s("kind") == "device") deviceSafetyWords(fromHex(c.s("new_device_pub_hex")), fromHex(c.s("approver_pub_hex")))
            else identityWords(c.s("user_id"), fromHex(c.s("x25519_pub_hex")), fromHex(c.s("ed25519_pub_hex")))
            assertEquals(want, got)
        }
    }

    /** The library choice, measured here and logged. Five runs at the floor, on each engine. */
    @Test fun argon2Benchmark() {
        val native = Pw.nativeArgon2()!!
        val salt = randomBytes(16)
        val pw = utf8("benchmark password")
        fun time(engine: org.promptly.sync.passwords.core.Argon2Engine): List<Long> = (1..5).map {
            val t = System.nanoTime()
            engine.hash(pw, salt, KdfParams.FLOOR.m, KdfParams.FLOOR.t, KdfParams.FLOOR.p, 32)
            (System.nanoTime() - t) / 1_000_000
        }.sorted()
        val n = time(native)
        val b = time(BouncyCastleArgon2)
        Harness.note("Argon2id 64 MiB t=3 p=1. argon2kt median ${n[2]} ms (${n.first()}-${n.last()}). BouncyCastle median ${b[2]} ms (${b.first()}-${b.last()}).")
        assertArrayEquals(native.hash(pw, salt, KdfParams.FLOOR.m, 3, 1, 32), BouncyCastleArgon2.hash(pw, salt, KdfParams.FLOOR.m, 3, 1, 32))
    }

    @Test fun keystoreSealRoundTripsAndRefusesTampering() {
        val sealed = DeviceSeal.seal(utf8("secret"))
        assertEquals("secret", String(DeviceSeal.open(sealed)!!))
        assertFalse(sealed.contains("secret"))
        val (iv, ct) = sealed.split(":")
        val bad = fromB64u(ct).also { it[0] = (it[0] + 1).toByte() }
        assertNull(DeviceSeal.open(iv + ":" + b64u(bad)))
    }

    @Test fun secretKeyAndDeviceTokenAreSealedAtRest() {
        val client = Harness.seedOffline()
        val prefs = Pw.prefs.prefs.all
        val secret = client.keeper.load()!!
        assertEquals(16, secret.size)
        assertFalse(prefs.values.any { it.toString().contains(b64u(secret)) })
        assertFalse(prefs.values.any { it.toString().contains("pwd_offline") })
        assertEquals("pwd_offline", Pw.prefs.deviceToken)
    }

    @Test fun offlineCopyHoldsOnlyCiphertext() {
        val client = Harness.seedOffline()
        val item = client.saveNew(client.personalVaultId(), newBody("login", "CanaryTitleXYZ").withText("username", "canary-user-xyz").withText("password", "canary-password-xyz").withUrls(listOf(LoginUrl("https://canary-site-xyz.example"))))
        val raw = java.io.File(Harness.ctx.getDatabasePath("promptly_vault.db").path).readBytes().toString(Charsets.ISO_8859_1)
        val wal = java.io.File(Harness.ctx.getDatabasePath("promptly_vault.db").path + "-wal").takeIf { it.exists() }?.readBytes()?.toString(Charsets.ISO_8859_1) ?: ""
        for (canary in listOf("CanaryTitleXYZ", "canary-user-xyz", "canary-password-xyz", "canary-site-xyz")) {
            assertFalse(canary, raw.contains(canary))
            assertFalse(canary, wal.contains(canary))
        }
        val cached: CachedItem = Pw.db.getItem(item.id)!!
        assertTrue(cached.dirty)
        assertNotNull(cached.blob)
        // And it opens again from disk, after a lock.
        client.lock()
        client.unlock(Harness.MASTER)
        assertEquals("canary-password-xyz", client.get(item.id)!!.body.password)
    }

    @Test fun indexFileHoldsNoSecretAndIsSealed() {
        val client = Harness.seedOffline()
        client.saveNew(client.personalVaultId(), newBody("login", "IndexTitleXYZ").withText("password", "index-secret-xyz"))
        Harness.rebuildIndex()
        val raw = java.io.File(Harness.ctx.filesDir, "pw_autofill_index").readText()
        assertFalse(raw.contains("IndexTitleXYZ"))
        val plain = String(DeviceSeal.open(raw)!!)
        assertTrue(plain.contains("IndexTitleXYZ"))
        assertFalse(plain.contains("index-secret-xyz"))
    }

    @Test fun publicSuffixListWorksInTheRealApp() {
        assertEquals("example.co.uk", Match.baseDomain("a.b.example.co.uk"))
        assertEquals("alice.github.io", Match.baseDomain("alice.github.io"))
        assertNull(Match.baseDomain("localhost"))
        assertNull(Match.baseDomain("192.168.1.1"))
        assertTrue("audiojungle.net" in Match.sharedWith("3docean.net"))
    }

    @Test fun bundledFiles() {
        assertEquals(7776, org.promptly.sync.passwords.core.Wordlist.words.size)
        assertNotNull(Generator.rulesForHost("apple.com"))
        assertEquals(1, TrustedBrowsers.table(Harness.ctx)["com.android.chrome"]!!.size)
        // The Chrome on this image, if it has one, is signed with the key on the list.
        val chrome = signingCerts(Harness.ctx, "com.android.chrome")
        if (chrome.isNotEmpty()) {
            assertTrue(TrustedBrowsers.isTrusted(Harness.ctx, "com.android.chrome"))
            Harness.note("Chrome on this image passes the allowlist's certificate check")
        }
    }

    @Test fun passkeysSignWithThePlatformProvider() {
        val made = Passkeys.makeCredential("example.com", null, b64u(utf8("u")), "ana", null, "Yw", "https://example.com", true, true)
        val a = Passkeys.getAssertion(made.passkey, "Yw", "https://example.com", true)
        val v = java.security.Signature.getInstance("SHA256withECDSA")
        v.initVerify(java.security.KeyFactory.getInstance("EC").generatePublic(java.security.spec.X509EncodedKeySpec(fromB64u(made.publicKey))))
        v.update(fromB64u(a.authenticatorData))
        v.update(Primitives.sha256(fromB64u(a.clientDataJSON)))
        assertTrue(v.verify(fromB64u(a.signature)))
    }

    @Test fun bodyKeepsUnknownFieldsThroughTheStore() {
        val client = Harness.seedOffline()
        val body = ItemBody.parse("""{"v":1,"kind":"note","title":"T","createdAt":"a","updatedAt":"b","laterField":{"x":[1,2]}}""")
        val item = client.saveNew(client.personalVaultId(), body)
        client.lock()
        client.unlock(Harness.MASTER)
        assertEquals(body["laterField"], client.get(item.id)!!.body["laterField"])
    }
}
