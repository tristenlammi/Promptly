// WebAuthn authenticator logic in plain functions: ES256 keys in portable PKCS#8 form,
// authenticator data, attestation "none", assertions. Mirrors passkey.ts, so a passkey
// made here works in the browser extension and the reverse.
package org.promptly.sync.passwords.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import org.bouncycastle.asn1.pkcs.PrivateKeyInfo
import org.bouncycastle.asn1.sec.ECPrivateKey
import org.bouncycastle.crypto.ec.CustomNamedCurves
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.time.Instant

object Passkeys {
    /** An RP ID must be the page's host, or a parent domain of it, and never a public suffix. */
    fun rpIdAllowed(rpId: String, origin: String): Boolean {
        val m = Regex("^(https?)://([^/:?#]+)(?::\\d+)?/?$", RegexOption.IGNORE_CASE).find(origin) ?: return false
        val scheme = m.groupValues[1].lowercase()
        val host = m.groupValues[2].lowercase()
        val rp = rpId.lowercase()
        val local = host == "localhost" || host.endsWith(".localhost")
        if (scheme != "https" && !(scheme == "http" && local)) return false
        if (rp.isEmpty() || rp.contains('/') || rp.contains(':') || rp.startsWith(".")) return false
        if (host != rp && !host.endsWith(".$rp")) return false
        if (local) return rp == host || rp == "localhost" || host.endsWith(".$rp")
        val registrable = Match.baseDomain(host) ?: return rp == host
        return rp == registrable || rp.endsWith(".$registrable")
    }

    // ---- A tiny CBOR writer: only what attestation objects and COSE keys need ----

    private fun head(major: Int, n: Int): ByteArray = when {
        n < 24 -> byteArrayOf(((major shl 5) or n).toByte())
        n < 256 -> byteArrayOf(((major shl 5) or 24).toByte(), n.toByte())
        n < 65536 -> byteArrayOf(((major shl 5) or 25).toByte(), (n shr 8).toByte(), n.toByte())
        else -> byteArrayOf(((major shl 5) or 26).toByte(), (n ushr 24).toByte(), (n ushr 16).toByte(), (n ushr 8).toByte(), n.toByte())
    }

    private fun cborInt(n: Int) = if (n >= 0) head(0, n) else head(1, -1 - n)
    private fun cborBytes(b: ByteArray) = concat(head(2, b.size), b)
    private fun cborText(s: String) = utf8(s).let { concat(head(3, it.size), it) }

    // ---- Keys ----

    class Es256(val pkcs8: ByteArray, val x: ByteArray, val y: ByteArray)

    private val PKCS8_HEAD = fromHex("308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420")
    private val PKCS8_PUB = fromHex("a144034200" + "04")

    private fun fixed(n: BigInteger): ByteArray {
        val raw = n.toByteArray()
        val out = ByteArray(32)
        val start = maxOf(0, raw.size - 32)
        raw.copyInto(out, 32 - (raw.size - start), start, raw.size)
        return out
    }

    /** Same layout WebCrypto exports, so every client's PKCS#8 parser takes it. */
    private fun encodePkcs8(d: ByteArray, x: ByteArray, y: ByteArray) = concat(PKCS8_HEAD, d, PKCS8_PUB, x, y)

    fun newKey(): Es256 {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val pub = pair.public as ECPublicKey
        val priv = pair.private as java.security.interfaces.ECPrivateKey
        val x = fixed(pub.w.affineX)
        val y = fixed(pub.w.affineY)
        return Es256(encodePkcs8(fixed(priv.s), x, y), x, y)
    }

    /** X and Y from a stored key, computed fresh rather than trusting what's in the blob. */
    fun publicOf(pkcs8: ByteArray): Pair<ByteArray, ByteArray> {
        val d = ECPrivateKey.getInstance(PrivateKeyInfo.getInstance(pkcs8).parsePrivateKey()).key
        val q = CustomNamedCurves.getByName("secp256r1").g.multiply(d).normalize()
        return fixed(q.affineXCoord.toBigInteger()) to fixed(q.affineYCoord.toBigInteger())
    }

    /** SubjectPublicKeyInfo for P-256, what `getPublicKey()` hands a relying party. */
    fun spki(x: ByteArray, y: ByteArray): ByteArray =
        concat(fromHex("3059301306072a8648ce3d020106082a8648ce3d030107034200" + "04"), x, y)

    private fun coseEs256(x: ByteArray, y: ByteArray) = concat(
        byteArrayOf(0xa5.toByte()), cborInt(1), cborInt(2), cborInt(3), cborInt(-7), cborInt(-1), cborInt(1),
        cborInt(-2), cborBytes(x), cborInt(-3), cborBytes(y),
    )

    private const val FLAG_UP = 0x01
    private const val FLAG_UV = 0x04
    private const val FLAG_BE = 0x08 // backup eligible: passkeys here sync
    private const val FLAG_BS = 0x10 // backed up
    private const val FLAG_AT = 0x40

    /** A passkey that syncs reports a counter of 0, as the spec expects of multi-device keys. */
    private fun authData(rpId: String, uv: Boolean, attested: ByteArray? = null): ByteArray {
        val flags = FLAG_UP or (if (uv) FLAG_UV else 0) or FLAG_BE or FLAG_BS or (if (attested != null) FLAG_AT else 0)
        return concat(Primitives.sha256(utf8(rpId)), byteArrayOf(flags.toByte(), 0, 0, 0, 0), attested ?: ByteArray(0))
    }

    /** Key order and shape as the spec's serialization asks. */
    fun clientDataJson(type: String, challenge: String, origin: String, crossOrigin: Boolean = false, topOrigin: String? = null): String {
        val parts = arrayListOf(
            "\"type\":${JsonPrimitive(type)}", "\"challenge\":${JsonPrimitive(challenge)}",
            "\"origin\":${JsonPrimitive(origin)}", "\"crossOrigin\":${if (crossOrigin) "true" else "false"}",
        )
        if (crossOrigin && topOrigin != null) parts += "\"topOrigin\":${JsonPrimitive(topOrigin)}"
        return parts.joinToString(",", "{", "}")
    }

    class MakeResult(
        val passkey: Passkey,
        val credentialId: String,
        val clientDataJSON: String,
        val attestationObject: String,
        val authenticatorData: String,
        val publicKey: String,
    )

    fun makeCredential(rpId: String, rpName: String?, userHandle: String, userName: String, userDisplayName: String?, challenge: String, origin: String, uv: Boolean, discoverable: Boolean, now: Instant = Instant.now()): MakeResult {
        val key = newKey()
        val credId = randomBytes(32)
        val attested = concat(ByteArray(16), byteArrayOf(0, credId.size.toByte()), credId, coseEs256(key.x, key.y))
        val auth = authData(rpId, uv, attested)
        val attestation = concat(
            byteArrayOf(0xa3.toByte()), cborText("fmt"), cborText("none"), cborText("attStmt"), byteArrayOf(0xa0.toByte()),
            cborText("authData"), cborBytes(auth),
        )
        val clientData = clientDataJson("webauthn.create", challenge, origin)
        return MakeResult(
            Passkey(b64u(credId), rpId, rpName, userHandle, userName, userDisplayName, b64u(key.pkcs8), 0, isoNow(now), null, discoverable),
            b64u(credId), b64u(utf8(clientData)), b64u(attestation), b64u(auth), b64u(spki(key.x, key.y)),
        )
    }

    class AssertResult(val credentialId: String, val clientDataJSON: String, val authenticatorData: String, val signature: String, val userHandle: String)

    /** The signature covers `authData || SHA-256(clientDataJSON)`. A privileged browser
     *  supplies its own hash, and the JSON we return is then only a placeholder. */
    fun getAssertion(p: Passkey, challenge: String, origin: String, uv: Boolean, clientDataHash: ByteArray? = null): AssertResult {
        val clientBytes = if (clientDataHash != null) utf8("<placeholder>") else utf8(clientDataJson("webauthn.get", challenge, origin))
        val hash = clientDataHash ?: Primitives.sha256(clientBytes)
        val auth = authData(p.rpId, uv)
        val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(fromB64u(p.key)))
        val sig = Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(auth)
            update(hash)
            sign()
        }
        return AssertResult(p.credentialId, b64u(clientBytes), b64u(auth), b64u(sig), p.userHandle)
    }

    data class Usable(val itemId: String, val passkey: Passkey, val title: String)

    fun allPasskeys(items: Collection<Item>): List<Usable> =
        items.filter { !it.deleted }.flatMap { i -> i.body.passkeys.map { Usable(i.id, it, i.body.title) } }

    /** Right RP, and on the allow list if given. With no list, only discoverable ones. */
    fun usable(all: List<Usable>, rpId: String, allow: List<String>): List<Usable> =
        all.filter { it.passkey.rpId == rpId && (if (allow.isEmpty()) it.passkey.discoverable else fromB64uSafe(it.passkey.credentialId) in allow.map(::fromB64uSafe)) }

    private fun fromB64uSafe(s: String) = runCatching { b64u(fromB64u(s)) }.getOrDefault(s)

    // ---- Request JSON, validated before anything else looks at it ----

    class BadRequest(message: String) : IllegalArgumentException(message)

    class CreateRequest(
        val rpId: String,
        val rpName: String?,
        val userHandle: String,
        val userName: String,
        val userDisplayName: String?,
        val challenge: String,
        val discoverable: Boolean,
        val excludeCredentials: List<String>,
    )

    class GetRequest(val rpId: String, val challenge: String, val allow: List<String>)

    private fun obj(json: String): JsonObject = runCatching { Json.parseToJsonElement(json) as JsonObject }.getOrElse { throw BadRequest("The request isn't valid JSON") }

    private fun b64Field(v: String?, what: String): String {
        if (v.isNullOrEmpty()) throw BadRequest("The request has no $what")
        val raw = runCatching { fromB64u(v) }.getOrElse { throw BadRequest("The request's $what isn't base64url") }
        return b64u(raw)
    }

    private fun ids(list: JsonElement?): List<String> =
        (list as? JsonArray)?.mapNotNull { ((it as? JsonObject)?.get("id") as? JsonPrimitive)?.contentOrNull }?.map { b64Field(it, "credential id") } ?: emptyList()

    private fun validRp(rp: String?): String {
        if (rp.isNullOrEmpty() || rp.length > 253 || rp.contains('/') || rp.contains(':') || rp.startsWith(".") || rp.contains(' ')) throw BadRequest("The request's RP ID isn't valid")
        return rp.lowercase()
    }

    fun parseCreate(json: String): CreateRequest {
        val o = obj(json)
        val rp = o["rp"] as? JsonObject ?: throw BadRequest("The request has no rp")
        val user = o["user"] as? JsonObject ?: throw BadRequest("The request has no user")
        val handle = b64Field(user.str("id"), "user id")
        val rawHandle = fromB64u(handle)
        if (rawHandle.isEmpty() || rawHandle.size > 64) throw BadRequest("The request's user id is the wrong size")
        val params = o["pubKeyCredParams"] as? JsonArray ?: throw BadRequest("The request has no key types")
        if (params.none { (it as? JsonObject)?.int("alg") == -7 }) throw BadRequest("This site doesn't accept ES256 passkeys")
        val sel = o["authenticatorSelection"] as? JsonObject
        val resident = sel?.str("residentKey") ?: if (sel?.bool("requireResidentKey") == true) "required" else "preferred"
        return CreateRequest(
            validRp(rp.str("id")), rp.str("name"), handle, user.str("name") ?: "", user.str("displayName"),
            b64Field(o.str("challenge"), "challenge"), resident != "discouraged", ids(o["excludeCredentials"]),
        )
    }

    fun parseGet(json: String): GetRequest {
        val o = obj(json)
        return GetRequest(validRp(o.str("rpId")), b64Field(o.str("challenge"), "challenge"), ids(o["allowCredentials"]))
    }

    // ---- Response JSON, as WebAuthn's toJSON() shapes it ----

    fun registrationJson(r: MakeResult, discoverable: Boolean): String = buildJsonObject {
        put("id", r.credentialId)
        put("rawId", r.credentialId)
        put("type", "public-key")
        put("authenticatorAttachment", "platform")
        put("response", buildJsonObject {
            put("clientDataJSON", r.clientDataJSON)
            put("attestationObject", r.attestationObject)
            put("authenticatorData", r.authenticatorData)
            put("publicKey", r.publicKey)
            put("publicKeyAlgorithm", -7)
            put("transports", JsonArray(listOf(JsonPrimitive("internal"), JsonPrimitive("hybrid"))))
        })
        put("clientExtensionResults", buildJsonObject {
            put("credProps", buildJsonObject { put("rk", discoverable) })
        })
    }.toString()

    fun assertionJson(a: AssertResult): String = buildJsonObject {
        put("id", a.credentialId)
        put("rawId", a.credentialId)
        put("type", "public-key")
        put("authenticatorAttachment", "platform")
        put("response", buildJsonObject {
            put("clientDataJSON", a.clientDataJSON)
            put("authenticatorData", a.authenticatorData)
            put("signature", a.signature)
            put("userHandle", a.userHandle)
        })
        put("clientExtensionResults", buildJsonObject { })
    }.toString()
}
