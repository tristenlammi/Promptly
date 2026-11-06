// The shared vectors, read straight from frontend/src/passwords/core/vectors.json. Not
// forked: the same file the TypeScript and Rust suites run. Every section is exercised;
// countsCoverTheFile fails if a section appears that this file doesn't know.
package org.promptly.sync.passwords

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.promptly.sync.passwords.core.BouncyCastleArgon2
import org.promptly.sync.passwords.core.ItemBody
import org.promptly.sync.passwords.core.KdfParams
import org.promptly.sync.passwords.core.Primitives
import org.promptly.sync.passwords.core.SecretKeys
import org.promptly.sync.passwords.core.Totp
import org.promptly.sync.passwords.core.TotpConfig
import org.promptly.sync.passwords.core.aad
import org.promptly.sync.passwords.core.checkKdf
import org.promptly.sync.passwords.core.concat
import org.promptly.sync.passwords.core.decodeKeyset
import org.promptly.sync.passwords.core.decryptItemJson
import org.promptly.sync.passwords.core.deriveRoot
import org.promptly.sync.passwords.core.deviceSafetyWords
import org.promptly.sync.passwords.core.encodeKeyset
import org.promptly.sync.passwords.core.fromHex
import org.promptly.sync.passwords.core.hex
import org.promptly.sync.passwords.core.identityWords
import org.promptly.sync.passwords.core.lp
import org.promptly.sync.passwords.core.open
import org.promptly.sync.passwords.core.openSealed
import org.promptly.sync.passwords.core.pad
import org.promptly.sync.passwords.core.parseKdf
import org.promptly.sync.passwords.core.sealToWith
import org.promptly.sync.passwords.core.sealWithNonce
import org.promptly.sync.passwords.core.signingInput
import org.promptly.sync.passwords.core.unpad
import org.promptly.sync.passwords.core.utf8

class VectorsTest {
    private val v: JsonObject = Fixtures.vectors()
    private fun JsonObject.s(k: String) = this.getValue(k).jsonPrimitive.content
    private fun JsonObject.b(k: String) = fromHex(s(k))
    private fun section(k: String) = v.getValue(k).jsonArray.map { it.jsonObject }
    private fun kat(k: String) = v.getValue("kat").jsonObject.getValue(k).jsonArray.map { it.jsonObject }

    init {
        Fixtures.setup()
    }

    @Test fun countsCoverTheFile() {
        assertEquals(
            setOf("format", "note", "kat", "secret_key_note", "secret_key", "padding", "root", "seal", "sealed_box", "signature", "keyset", "item", "safety_words", "negative", "kdf_rejected"),
            v.keys,
        )
        assertEquals(setOf("hkdf", "aes_gcm", "x25519", "ed25519", "totp", "steam", "argon2id"), v.getValue("kat").jsonObject.keys)
        assertEquals(1, v.getValue("format").jsonPrimitive.int)
    }

    @Test fun katHkdf() {
        for (c in kat("hkdf")) {
            assertEquals(c.s("okm_hex"), hex(Primitives.hkdf(c.b("ikm_hex"), c.b("salt_hex"), c.b("info_hex"), c.getValue("length").jsonPrimitive.int)))
        }
    }

    @Test fun katAesGcm() {
        for (c in kat("aes_gcm")) {
            val out = Primitives.aesGcmEncrypt(c.b("key_hex"), c.b("nonce_hex"), c.b("plain_hex"), c.b("aad_hex"))
            assertEquals(c.s("ct_hex") + c.s("tag_hex"), hex(out))
            assertArrayEquals(c.b("plain_hex"), Primitives.aesGcmDecrypt(c.b("key_hex"), c.b("nonce_hex"), out, c.b("aad_hex")))
        }
    }

    @Test fun katX25519() {
        for (c in kat("x25519")) {
            assertEquals(c.s("alice_pub_hex"), hex(Primitives.x25519Public(c.b("alice_sk_hex"))))
            assertEquals(c.s("bob_pub_hex"), hex(Primitives.x25519Public(c.b("bob_sk_hex"))))
            assertEquals(c.s("shared_hex"), hex(Primitives.x25519Shared(c.b("alice_sk_hex"), c.b("bob_pub_hex"))))
            assertEquals(c.s("shared_hex"), hex(Primitives.x25519Shared(c.b("bob_sk_hex"), c.b("alice_pub_hex"))))
        }
        // The all-zero output (a low-order public key) is refused.
        assertThrows(IllegalStateException::class.java) { Primitives.x25519Shared(ByteArray(32) { 1 }, ByteArray(32)) }
    }

    @Test fun katEd25519() {
        for (c in kat("ed25519")) {
            assertEquals(c.s("pub_hex"), hex(Primitives.ed25519Public(c.b("seed_hex"))))
            assertEquals(c.s("sig_hex"), hex(Primitives.ed25519Sign(c.b("seed_hex"), c.b("msg_hex"))))
            assertTrue(Primitives.ed25519Verify(c.b("sig_hex"), c.b("msg_hex"), c.b("pub_hex")))
            assertFalse(Primitives.ed25519Verify(c.b("sig_hex"), byteArrayOf(0), c.b("pub_hex")))
        }
    }

    @Test fun katTotp() {
        val cases = kat("totp")
        assertEquals(9, cases.size)
        for (c in cases) {
            val secret = Totp.base32Encode(utf8(c.s("secret_ascii")))
            val cfg = TotpConfig(secret, c.s("algorithm"), c.getValue("digits").jsonPrimitive.int, c.getValue("period").jsonPrimitive.int)
            assertEquals(c.s("code"), Totp.code(cfg, c.getValue("time").jsonPrimitive.content.toLong() * 1000))
        }
        for (c in kat("steam")) {
            assertEquals(c.s("code"), Totp.code(TotpConfig(c.s("secret_base64"), steam = true), c.getValue("time").jsonPrimitive.content.toLong() * 1000))
        }
    }

    @Test fun katArgon2id() {
        for (c in kat("argon2id")) {
            val k = parseKdf(c["kdf"])!!
            assertEquals(c.s("output_hex"), hex(BouncyCastleArgon2.hash(c.b("password_hex"), c.b("salt_hex"), k.m, k.t, k.p, 32)))
        }
    }

    @Test fun secretKeyText() {
        for (c in section("secret_key")) {
            val raw = c.b("raw_hex")
            val text = c.s("encoded")
            assertEquals(text, SecretKeys.encode(raw))
            assertArrayEquals(raw, SecretKeys.parse(text))
            assertArrayEquals(raw, SecretKeys.parse(text.lowercase().replace("-", " ")))
            // A typo anywhere in the body is caught by the check characters or the alphabet.
            val flipped = text.substring(0, 6) + (if (text[6] == 'A') 'B' else 'A') + text.substring(7)
            assertThrows(IllegalArgumentException::class.java) { SecretKeys.parse(flipped) }
        }
    }

    @Test fun padding() {
        val cases = section("padding")
        assertEquals(12, cases.size)
        for (c in cases) {
            val data = ByteArray(c.getValue("len").jsonPrimitive.int) { 7 }
            val padded = pad(data)
            assertEquals(c.getValue("padded").jsonPrimitive.int, padded.size)
            assertArrayEquals(data, unpad(padded))
        }
        assertThrows(IllegalArgumentException::class.java) { unpad(ByteArray(256).also { it[3] = 1; it[10] = 1 }) }
        assertThrows(IllegalArgumentException::class.java) { unpad(ByteArray(256).also { it[1] = 1 }) }
    }

    @Test fun rootKeys() {
        val cases = section("root")
        assertEquals(4, cases.size)
        for (c in cases) {
            val r = deriveRoot(c.s("password"), c.b("secret_key_hex"), c.b("salt_hex"), parseKdf(c["kdf"])!!)
            assertEquals(c.s("unlock_hex"), hex(r.unlock))
            assertEquals(c.s("auth_hex"), hex(r.auth))
        }
        // NFKC: the ligature spelling and the plain one give the same keys.
        assertEquals(cases[1].s("unlock_hex"), cases[2].s("unlock_hex"))
    }

    @Test fun symmetricBlobs() {
        for (c in section("seal")) {
            val ad = aad(c.s("scope"), c.s("item"), c.s("field"))
            assertEquals(c.s("aad_hex"), hex(ad))
            val blob = sealWithNonce(c.b("key_hex"), c.b("nonce_hex"), c.b("plain_hex"), ad)
            assertEquals(c.s("blob_hex"), hex(blob))
            assertArrayEquals(c.b("plain_hex"), open(c.b("key_hex"), c.b("blob_hex"), ad))
        }
    }

    @Test fun sealedBoxes() {
        for (c in section("sealed_box")) {
            assertEquals(c.s("recipient_pub_hex"), hex(Primitives.x25519Public(c.b("recipient_sk_hex"))))
            val ad = aad(c.s("scope"), c.s("item"), c.s("field"))
            assertEquals(c.s("blob_hex"), hex(sealToWith(c.b("eph_sk_hex"), c.b("nonce_hex"), c.b("recipient_pub_hex"), c.b("plain_hex"), ad)))
            assertArrayEquals(c.b("plain_hex"), openSealed(c.b("recipient_sk_hex"), c.b("blob_hex"), ad))
            assertThrows(Exception::class.java) { openSealed(ByteArray(32) { 9 }, c.b("blob_hex"), ad) }
        }
    }

    @Test fun signatures() {
        for (c in section("signature")) {
            val fields = c.getValue("fields").jsonArray.map { f ->
                when (f) {
                    is JsonPrimitive -> utf8(f.content)
                    is JsonObject -> fromHex(f.getValue("hex").jsonPrimitive.content)
                    else -> error("bad field")
                }
            }
            val input = signingInput(c.s("purpose"), fields)
            assertEquals(c.s("input_hex"), hex(input))
            assertEquals(c.s("pub_hex"), hex(Primitives.ed25519Public(c.b("seed_hex"))))
            assertEquals(c.s("sig_hex"), hex(Primitives.ed25519Sign(c.b("seed_hex"), input)))
            assertTrue(Primitives.ed25519Verify(c.b("sig_hex"), input, c.b("pub_hex")))
            input[0] = (input[0] + 1).toByte()
            assertFalse(Primitives.ed25519Verify(c.b("sig_hex"), input, c.b("pub_hex")))
        }
    }

    @Test fun keyset() {
        val c = v.getValue("keyset").jsonObject
        val k = decodeKeyset(c.b("encoded_hex"))
        assertEquals(c.s("encoded_hex"), hex(encodeKeyset(k)))
        assertEquals(c.s("x25519_pub_hex"), hex(k.x25519Pub))
        assertEquals(c.s("ed25519_pub_hex"), hex(k.ed25519Pub))
        assertThrows(IllegalArgumentException::class.java) { decodeKeyset(ByteArray(64)) }
        assertThrows(IllegalArgumentException::class.java) { decodeKeyset(ByteArray(65)) }
    }

    @Test fun itemBlobs() {
        for (c in section("item")) {
            val vaultId = c.s("vault_id")
            val itemId = c.s("item_id")
            val json = decryptItemJson(c.b("vault_key_hex"), vaultId, itemId, c.b("blob_hex"))
            val body = ItemBody.parse(json)
            val want = c.getValue("body").jsonObject
            assertEquals(want, Json.parseToJsonElement(json))
            assertEquals("Example", body.title)
            assertEquals("s3cret", body.password)
            assertEquals("https://example.com", body.urls.single().url)
            // Byte for byte: rebuilt from the generator's inputs (see vectors.gen.test.ts).
            val seq = { n: Int, start: Int -> ByteArray(n) { i -> (start + i).toByte() } }
            val vaultKey = c.b("vault_key_hex")
            val itemKey = seq(32, 0xc0)
            val wrapped = sealWithNonce(vaultKey, seq(12, 6), itemKey, aad(vaultId, itemId, "item_key"))
            val bodyBlob = sealWithNonce(itemKey, seq(12, 7), pad(utf8(body.toJson())), aad(vaultId, itemId, "body"))
            assertEquals(c.s("blob_hex"), hex(concat(byteArrayOf(1), lp(wrapped), bodyBlob)))
        }
    }

    @Test fun safetyWords() {
        val cases = section("safety_words")
        assertEquals(2, cases.size)
        for (c in cases) {
            val want = c.getValue("words").jsonArray.map { it.jsonPrimitive.content }
            val got = when (c.s("kind")) {
                "device" -> deviceSafetyWords(c.b("new_device_pub_hex"), c.b("approver_pub_hex"))
                else -> identityWords(c.s("user_id"), c.b("x25519_pub_hex"), c.b("ed25519_pub_hex"))
            }
            assertEquals(want, got)
        }
    }

    @Test fun negativeCases() {
        val cases = section("negative")
        assertEquals(11, cases.size)
        for (c in cases) {
            val ad = aad(c.s("scope"), c.s("item"), c.s("field"))
            assertThrows(c.s("why"), Exception::class.java) { open(c.b("key_hex"), c.b("blob_hex"), ad) }
        }
    }

    @Test fun rejectedKdf() {
        val cases = v.getValue("kdf_rejected") as JsonArray
        assertEquals(7, cases.size)
        for (c in cases) {
            val k = parseKdf(c)!!
            assertThrows("$k", IllegalArgumentException::class.java) { checkKdf(k) }
            assertThrows("$k", IllegalArgumentException::class.java) { deriveRoot("x", ByteArray(16), ByteArray(16), k) }
        }
        checkKdf(KdfParams.FLOOR)
    }
}
