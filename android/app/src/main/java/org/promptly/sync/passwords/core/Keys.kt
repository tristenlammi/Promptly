// The key hierarchy (CRYPTO_SPEC.md section 5): master password + Secret Key.
// Mirrors keys.ts and safety.ts.
package org.promptly.sync.passwords.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import java.text.Normalizer

private val EMPTY = ByteArray(0)
private const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

object SecretKeys {
    private fun base32(data: ByteArray): String {
        val out = StringBuilder()
        var value = 0
        var bits = 0
        for (b in data) {
            value = (value shl 8) or (b.toInt() and 255)
            bits += 8
            while (bits >= 5) {
                out.append(CROCKFORD[(value shr (bits - 5)) and 31])
                bits -= 5
            }
            value = value and ((1 shl bits) - 1)
        }
        if (bits > 0) out.append(CROCKFORD[(value shl (5 - bits)) and 31])
        return out.toString()
    }

    private fun check(raw: ByteArray): String {
        val d = Primitives.sha256(concat(utf8("promptly-pw/v1/sk"), raw))
        val ten = ((d[0].toInt() and 255) shl 2) or ((d[1].toInt() and 255) shr 6)
        return "${CROCKFORD[ten shr 5]}${CROCKFORD[ten and 31]}"
    }

    fun encode(raw: ByteArray): String {
        require(raw.size == 16) { "Secret Key is 16 bytes" }
        val b = base32(raw) + check(raw)
        return "PWK1-${b.substring(0, 7)}-${b.substring(7, 14)}-${b.substring(14, 21)}-${b.substring(21, 28)}"
    }

    /** Forgiving about case, spaces, dashes and look-alikes; strict about the check. */
    fun parse(text: String): ByteArray {
        var s = text.uppercase().replace(Regex("[\\s-]"), "")
        if (s.startsWith("PWK1")) s = s.substring(4)
        s = s.replace('O', '0').replace('I', '1').replace('L', '1')
        require(s.length == 28) { "That Secret Key is the wrong length" }
        val raw = ByteArray(16)
        var value = 0
        var bits = 0
        var at = 0
        for (c in s.substring(0, 26)) {
            val v = CROCKFORD.indexOf(c)
            require(v >= 0) { "That Secret Key has a character that isn't used" }
            value = (value shl 5) or v
            bits += 5
            if (bits >= 8) {
                raw[at++] = ((value shr (bits - 8)) and 255).toByte()
                bits -= 8
            }
            value = value and ((1 shl bits) - 1)
        }
        require(check(raw) == s.substring(26)) { "That Secret Key has a typo in it" }
        return raw
    }

    fun lastGroup(encoded: String) = encoded.substring(encoded.lastIndexOf('-') + 1)
}

/** What a recovery kit's QR carries: `promptly-kit:1?server=&user=&sk=`. */
data class KitQr(val serverUrl: String, val secretKey: String, val username: String)

fun parseKitQr(text: String): KitQr? {
    val head = "promptly-kit:1?"
    if (!text.startsWith(head)) return null
    val q = parseQuery(text.substring(head.length))
    val sk = q["sk"] ?: return null
    val server = q["server"] ?: return null
    return KitQr(server, sk, q["user"] ?: "")
}

/** URLSearchParams-style: `+` is a space; the first of a duplicate name wins. */
fun parseQuery(query: String): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    for (part in query.split('&')) {
        if (part.isEmpty()) continue
        val eq = part.indexOf('=')
        val k = if (eq < 0) part else part.substring(0, eq)
        val v = if (eq < 0) "" else part.substring(eq + 1)
        val name = runCatching { java.net.URLDecoder.decode(k, "UTF-8") }.getOrDefault(k)
        if (name !in out) out[name] = runCatching { java.net.URLDecoder.decode(v, "UTF-8") }.getOrDefault(v)
    }
    return out
}

class RootKeys(val unlock: ByteArray, val auth: ByteArray)

fun normalizePassword(password: String): ByteArray = utf8(Normalizer.normalize(password, Normalizer.Form.NFKC))

fun deriveRoot(password: String, secretKey: ByteArray, salt: ByteArray, params: KdfParams): RootKeys {
    checkKdf(params)
    require(salt.size == 16) { "KDF salt must be 16 bytes" }
    require(secretKey.size == 16) { "Secret Key is 16 bytes" }
    val stretched = Primitives.argon2(normalizePassword(password), salt, params)
    val joined = concat(stretched, secretKey)
    val ikm = Primitives.hkdf(joined, EMPTY, "promptly-pw/v1/root")
    stretched.fill(0)
    joined.fill(0)
    val keys = RootKeys(Primitives.hkdf(ikm, EMPTY, "promptly-pw/v1/unlock"), Primitives.hkdf(ikm, EMPTY, "promptly-pw/v1/auth"))
    ikm.fill(0)
    return keys
}

class Keyset(val x25519: ByteArray, val ed25519: ByteArray) {
    val x25519Pub: ByteArray get() = Primitives.x25519Public(x25519)
    val ed25519Pub: ByteArray get() = Primitives.ed25519Public(ed25519)
    fun wipe() {
        x25519.fill(0)
        ed25519.fill(0)
    }
    companion object {
        fun random() = Keyset(randomBytes(32), randomBytes(32))
    }
}

fun encodeKeyset(k: Keyset): ByteArray = concat(byteArrayOf(1), k.x25519, k.ed25519)

fun decodeKeyset(b: ByteArray): Keyset {
    require(b.size == 65 && b[0] == 1.toByte()) { "bad keyset" }
    return Keyset(b.copyOfRange(1, 33), b.copyOfRange(33, 65))
}

fun wrapKeyset(unlockKey: ByteArray, accountId: String, k: Keyset): ByteArray =
    seal(unlockKey, encodeKeyset(k), aad(accountId, "", "keyset"))

fun unwrapKeyset(unlockKey: ByteArray, accountId: String, blob: ByteArray): Keyset =
    decodeKeyset(open(unlockKey, blob, aad(accountId, "", "keyset")))

class MemberGrant(val wrapped: ByteArray, val signature: ByteArray, val grantedBy: String)

private fun vaultKeyAad(vaultId: String, userId: String) = aad(vaultId, "", "vault_key:$userId")

fun grantInput(vaultId: String, userId: String, generation: Int, wrapped: ByteArray): ByteArray =
    signingInput("vault_key", listOf(utf8(vaultId), utf8(userId), utf8(generation.toString()), wrapped))

fun grantVaultKey(grantorId: String, grantor: Keyset, vaultId: String, memberId: String, memberX25519: ByteArray, generation: Int, vaultKey: ByteArray): MemberGrant {
    val wrapped = sealTo(memberX25519, vaultKey, vaultKeyAad(vaultId, memberId))
    val signature = Primitives.ed25519Sign(grantor.ed25519, grantInput(vaultId, memberId, generation, wrapped))
    return MemberGrant(wrapped, signature, grantorId)
}

/** Sealed boxes are anonymous, so the signature is what stops a hostile server
 *  handing someone a vault key it knows. */
fun openVaultKey(myId: String, me: Keyset, vaultId: String, generation: Int, wrapped: ByteArray, signature: ByteArray, grantorEd25519: ByteArray): ByteArray {
    check(Primitives.ed25519Verify(signature, grantInput(vaultId, myId, generation, wrapped), grantorEd25519)) {
        "That vault key isn't signed by the person it claims to be from"
    }
    val raw = openSealed(me.x25519, wrapped, vaultKeyAad(vaultId, myId))
    check(raw.size == 32) { "bad vault key" }
    return raw
}

fun sealItem(vaultKey: ByteArray, vaultId: String, itemId: String, itemKey: ByteArray, bodyJson: String): ByteArray {
    val wrapped = seal(vaultKey, itemKey, aad(vaultId, itemId, "item_key"))
    val body = seal(itemKey, pad(utf8(bodyJson)), aad(vaultId, itemId, "body"))
    return concat(byteArrayOf(1), lp(wrapped), body)
}

fun encryptItem(vaultKey: ByteArray, vaultId: String, itemId: String, body: ItemBody): ByteArray {
    val itemKey = randomBytes(32)
    return sealItem(vaultKey, vaultId, itemId, itemKey, body.toJson()).also { itemKey.fill(0) }
}

fun decryptItemJson(vaultKey: ByteArray, vaultId: String, itemId: String, blob: ByteArray): String {
    require(blob.size >= 3 && blob[0] == 1.toByte()) { "unknown item format" }
    val n = ((blob[1].toInt() and 255) shl 8) or (blob[2].toInt() and 255)
    require(blob.size >= 3 + n) { "item blob too short" }
    val itemKey = open(vaultKey, blob.copyOfRange(3, 3 + n), aad(vaultId, itemId, "item_key"))
    val plain = open(itemKey, blob.copyOfRange(3 + n, blob.size), aad(vaultId, itemId, "body"))
    itemKey.fill(0)
    return fromUtf8(unpad(plain))
}

fun decryptItem(vaultKey: ByteArray, vaultId: String, itemId: String, blob: ByteArray): ItemBody =
    ItemBody.parse(decryptItemJson(vaultKey, vaultId, itemId, blob))

/** A small named value (a vault's name, say) directly under a key. */
fun sealField(key: ByteArray, scope: String, field: String, value: JsonElement): String =
    b64u(seal(key, pad(utf8(value.toString())), aad(scope, "", field)))

fun openField(key: ByteArray, scope: String, field: String, blob: String): JsonElement =
    Json.parseToJsonElement(fromUtf8(unpad(open(key, fromB64u(blob), aad(scope, "", field)))))

// ---- Safety words (CRYPTO_SPEC.md section 7) ----

/** The EFF large wordlist, loaded once by the platform (an asset, or a file in tests). */
object Wordlist {
    @Volatile
    private var loaded: List<String>? = null

    @Volatile
    var loader: (() -> String)? = null

    val words: List<String>
        get() = loaded ?: synchronized(this) {
            loaded ?: run {
                val text = loader?.invoke() ?: error("wordlist not available")
                (Json.parseToJsonElement(text) as JsonArray).map { (it as JsonPrimitive).content }.also { loaded = it }
            }
        }
}

fun wordsFromHash(digest: ByteArray, count: Int): List<String> {
    require(count * 2 <= digest.size) { "hash too short" }
    val list = Wordlist.words
    return (0 until count).map { i -> list[(((digest[i * 2].toInt() and 255) shl 8) or (digest[i * 2 + 1].toInt() and 255)) % list.size] }
}

fun deviceSafetyWords(newDevicePub: ByteArray, approverPub: ByteArray): List<String> =
    wordsFromHash(Primitives.sha256(concat(utf8("promptly-pw/v1/device-words"), byteArrayOf(0), lp(newDevicePub), lp(approverPub))), 5)

fun identityWords(userId: String, x25519Pub: ByteArray, ed25519Pub: ByteArray): List<String> =
    wordsFromHash(Primitives.sha256(concat(utf8("promptly-pw/v1/identity-words"), byteArrayOf(0), lp(userId), lp(x25519Pub), lp(ed25519Pub))), 6)
