// Wire formats (CRYPTO_SPEC.md sections 3 and 4). Mirrors format.ts byte for byte.
package org.promptly.sync.passwords.core

const val FORMAT_VERSION = 1
const val ALG_AES_GCM = 1
const val ALG_SEALED = 2
private const val NONCE = 12
private const val TAG = 16
private const val SEAL_INFO = "promptly-pw/v1/seal"

/** Ties a ciphertext to exactly one place in the vault. */
fun aad(scope: String, itemId: String, field: String): ByteArray =
    concat(byteArrayOf(0x50, 0x57, 0x41, 0x44, FORMAT_VERSION.toByte()), lp(scope), lp(itemId), lp(field))

fun sealWithNonce(key: ByteArray, nonce: ByteArray, plain: ByteArray, ad: ByteArray): ByteArray =
    concat(byteArrayOf(FORMAT_VERSION.toByte(), ALG_AES_GCM.toByte()), nonce, Primitives.aesGcmEncrypt(key, nonce, plain, ad))

fun seal(key: ByteArray, plain: ByteArray, ad: ByteArray): ByteArray = sealWithNonce(key, randomBytes(NONCE), plain, ad)

fun open(key: ByteArray, blob: ByteArray, ad: ByteArray): ByteArray {
    require(blob.size >= 2 + NONCE + TAG) { "blob too short" }
    require(blob[0].toInt() == FORMAT_VERSION) { "unknown format version" }
    require(blob[1].toInt() == ALG_AES_GCM) { "unknown algorithm" }
    return Primitives.aesGcmDecrypt(key, blob.copyOfRange(2, 2 + NONCE), blob.copyOfRange(2 + NONCE, blob.size), ad)
}

fun sealToWith(ephSk: ByteArray, nonce: ByteArray, recipientPub: ByteArray, plain: ByteArray, ad: ByteArray): ByteArray {
    val ephPub = Primitives.x25519Public(ephSk)
    val key = Primitives.hkdf(Primitives.x25519Shared(ephSk, recipientPub), concat(ephPub, recipientPub), SEAL_INFO)
    return concat(byteArrayOf(FORMAT_VERSION.toByte(), ALG_SEALED.toByte()), ephPub, nonce, Primitives.aesGcmEncrypt(key, nonce, plain, ad))
}

fun sealTo(recipientPub: ByteArray, plain: ByteArray, ad: ByteArray): ByteArray =
    sealToWith(randomBytes(32), randomBytes(NONCE), recipientPub, plain, ad)

fun openSealed(sk: ByteArray, blob: ByteArray, ad: ByteArray): ByteArray {
    require(blob.size >= 2 + 32 + NONCE + TAG) { "blob too short" }
    require(blob[0].toInt() == FORMAT_VERSION) { "unknown format version" }
    require(blob[1].toInt() == ALG_SEALED) { "unknown algorithm" }
    val ephPub = blob.copyOfRange(2, 34)
    val key = Primitives.hkdf(Primitives.x25519Shared(sk, ephPub), concat(ephPub, Primitives.x25519Public(sk)), SEAL_INFO)
    return Primitives.aesGcmDecrypt(key, blob.copyOfRange(34, 34 + NONCE), blob.copyOfRange(34 + NONCE, blob.size), ad)
}

private const val MIN_BUCKET = 256
private const val LINEAR_FROM = 1 shl 20
private const val LINEAR_STEP = 1 shl 18

/** The padded size for a payload: powers of two to 1 MiB, then 256 KiB steps. */
fun bucketFor(payload: Int): Int {
    val need = payload + 4
    if (need > LINEAR_FROM) return ((need + LINEAR_STEP - 1) / LINEAR_STEP) * LINEAR_STEP
    var size = MIN_BUCKET
    while (size < need) size *= 2
    return size
}

fun pad(data: ByteArray): ByteArray {
    val out = ByteArray(bucketFor(data.size))
    out[0] = (data.size ushr 24).toByte()
    out[1] = (data.size ushr 16).toByte()
    out[2] = (data.size ushr 8).toByte()
    out[3] = data.size.toByte()
    data.copyInto(out, 4)
    return out
}

fun unpad(padded: ByteArray): ByteArray {
    require(padded.size >= 4) { "bad padding" }
    val n = ((padded[0].toLong() and 255) shl 24) or ((padded[1].toLong() and 255) shl 16) or
        ((padded[2].toLong() and 255) shl 8) or (padded[3].toLong() and 255)
    require(n <= padded.size - 4) { "bad padding" }
    for (i in (4 + n.toInt()) until padded.size) require(padded[i] == 0.toByte()) { "bad padding" }
    return padded.copyOfRange(4, 4 + n.toInt())
}

/** Bytes an Ed25519 signature covers: a purpose label plus length-prefixed fields. */
fun signingInput(purpose: String, fields: List<ByteArray>): ByteArray {
    val parts = ArrayList<ByteArray>(fields.size + 3)
    parts += utf8("promptly-pw/v1/sig")
    parts += byteArrayOf(0)
    parts += lp(purpose)
    fields.forEach { parts += lp(it) }
    return concat(*parts.toTypedArray())
}
