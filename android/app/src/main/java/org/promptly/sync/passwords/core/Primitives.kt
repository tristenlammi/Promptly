// The only primitives the vault uses (CRYPTO_SPEC.md section 2): javax.crypto for
// AES-GCM and HMAC, BouncyCastle's lightweight API for HKDF, X25519 and Ed25519,
// and either argon2kt (JNI) or BouncyCastle for Argon2id. The floor applies to both.
package org.promptly.sync.passwords.core

import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.math.ec.rfc7748.X25519
import org.bouncycastle.math.ec.rfc8032.Ed25519
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

data class KdfParams(val alg: String, val m: Int, val t: Int, val p: Int) {
    companion object {
        /** Below this we refuse: a hostile server can't talk a client into a weak KDF. */
        val FLOOR = KdfParams("argon2id", 65536, 3, 1)
        const val CEILING_M = 4 * 1024 * 1024
        const val CEILING_T = 32
        const val CEILING_P = 8
    }
}

class KdfRangeError : IllegalArgumentException("KDF parameters outside the allowed range")

fun checkKdf(p: KdfParams) {
    val ok = p.alg == "argon2id" &&
        p.m >= KdfParams.FLOOR.m && p.t >= KdfParams.FLOOR.t && p.p >= KdfParams.FLOOR.p &&
        p.m <= KdfParams.CEILING_M && p.t <= KdfParams.CEILING_T && p.p <= KdfParams.CEILING_P
    if (!ok) throw KdfRangeError()
}

/** One Argon2id implementation. Whichever runs, it must give the same bytes. */
fun interface Argon2Engine {
    fun hash(password: ByteArray, salt: ByteArray, m: Int, t: Int, p: Int, length: Int): ByteArray
}

val BouncyCastleArgon2 = Argon2Engine { password, salt, m, t, p, length ->
    val params = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
        .withVersion(Argon2Parameters.ARGON2_VERSION_13)
        .withSalt(salt).withMemoryAsKB(m).withIterations(t).withParallelism(p)
        .build()
    val out = ByteArray(length)
    Argon2BytesGenerator().apply { init(params) }.generateBytes(password, out)
    out
}

object Primitives {
    /** Replaced at app start with the native engine, if its library loads. */
    @Volatile
    var argon2Engine: Argon2Engine = BouncyCastleArgon2

    fun argon2(password: ByteArray, salt: ByteArray, p: KdfParams, length: Int = 32): ByteArray =
        argon2Engine.hash(password, salt, p.m, p.t, p.p, length)

    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int = 32): ByteArray {
        val out = ByteArray(length)
        HKDFBytesGenerator(SHA256Digest()).apply { init(HKDFParameters(ikm, salt, info)) }.generateBytes(out, 0, length)
        return out
    }

    fun hkdf(ikm: ByteArray, salt: ByteArray, info: String, length: Int = 32) = hkdf(ikm, salt, utf8(info), length)

    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    fun aesGcmEncrypt(key: ByteArray, nonce: ByteArray, plain: ByteArray, aad: ByteArray): ByteArray {
        require(key.size == 32) { "AES-256 key must be 32 bytes" }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        if (aad.isNotEmpty()) c.updateAAD(aad)
        return c.doFinal(plain)
    }

    fun aesGcmDecrypt(key: ByteArray, nonce: ByteArray, ct: ByteArray, aad: ByteArray): ByteArray {
        require(key.size == 32) { "AES-256 key must be 32 bytes" }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        if (aad.isNotEmpty()) c.updateAAD(aad)
        return c.doFinal(ct)
    }

    fun x25519Public(sk: ByteArray): ByteArray {
        require(sk.size == 32) { "X25519 key is 32 bytes" }
        return ByteArray(32).also { X25519.scalarMultBase(sk, 0, it, 0) }
    }

    /** Refuses the all-zero output (low-order public keys). */
    fun x25519Shared(sk: ByteArray, pub: ByteArray): ByteArray {
        require(sk.size == 32 && pub.size == 32) { "X25519 keys are 32 bytes" }
        val out = ByteArray(32)
        X25519.scalarMult(sk, 0, pub, 0, out, 0)
        check(out.any { it != 0.toByte() }) { "low-order X25519 public key" }
        return out
    }

    fun ed25519Public(seed: ByteArray): ByteArray {
        require(seed.size == 32) { "Ed25519 seed is 32 bytes" }
        return ByteArray(32).also { Ed25519.generatePublicKey(seed, 0, it, 0) }
    }

    fun ed25519Sign(seed: ByteArray, msg: ByteArray): ByteArray {
        val sig = ByteArray(64)
        Ed25519.sign(seed, 0, msg, 0, msg.size, sig, 0)
        return sig
    }

    fun ed25519Verify(sig: ByteArray, msg: ByteArray, pub: ByteArray): Boolean =
        runCatching { sig.size == 64 && pub.size == 32 && Ed25519.verify(sig, 0, pub, 0, msg, 0, msg.size) }.getOrDefault(false)
}
