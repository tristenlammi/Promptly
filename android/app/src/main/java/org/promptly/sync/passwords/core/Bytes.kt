// Byte helpers shared by the vault's Kotlin client. Pure JVM, no Android imports,
// so the JVM tests run these exact files. Mirrors frontend/src/passwords/core/bytes.ts.
package org.promptly.sync.passwords.core

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.SecureRandom

private val rng = SecureRandom()

fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

/** Strict: bad UTF-8 is an error, the same as the web client's fatal TextDecoder. */
fun fromUtf8(b: ByteArray): String =
    Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(b)).toString()

fun concat(vararg parts: ByteArray): ByteArray {
    val out = ByteArray(parts.sumOf { it.size })
    var at = 0
    for (p in parts) {
        p.copyInto(out, at)
        at += p.size
    }
    return out
}

private const val HEX = "0123456789abcdef"

fun hex(b: ByteArray): String {
    val out = StringBuilder(b.size * 2)
    for (x in b) {
        out.append(HEX[(x.toInt() shr 4) and 15]).append(HEX[x.toInt() and 15])
    }
    return out.toString()
}

fun fromHex(s: String): ByteArray {
    require(s.length % 2 == 0) { "bad hex" }
    return ByteArray(s.length / 2) { i ->
        val hi = Character.digit(s[i * 2], 16)
        val lo = Character.digit(s[i * 2 + 1], 16)
        require(hi >= 0 && lo >= 0) { "bad hex" }
        ((hi shl 4) or lo).toByte()
    }
}

private const val B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

fun b64u(b: ByteArray): String {
    val s = StringBuilder((b.size * 4 + 2) / 3)
    var i = 0
    while (i < b.size) {
        val b0 = b[i].toInt() and 255
        val b1 = if (i + 1 < b.size) b[i + 1].toInt() and 255 else 0
        val b2 = if (i + 2 < b.size) b[i + 2].toInt() and 255 else 0
        val n = (b0 shl 16) or (b1 shl 8) or b2
        s.append(B64URL[(n shr 18) and 63]).append(B64URL[(n shr 12) and 63])
        if (i + 1 < b.size) s.append(B64URL[(n shr 6) and 63])
        if (i + 2 < b.size) s.append(B64URL[n and 63])
        i += 3
    }
    return s.toString()
}

/** Accepts standard base64 as well: imports and QR payloads use it. */
fun fromB64u(input: String): ByteArray {
    val clean = input.trimEnd('=').replace('+', '-').replace('/', '_')
    require(clean.length % 4 != 1) { "bad base64" }
    val out = ByteArray(clean.length * 3 / 4)
    var bits = 0
    var value = 0
    var at = 0
    for (c in clean) {
        val v = B64URL.indexOf(c)
        require(v >= 0) { "bad base64" }
        value = ((value shl 6) or v) and 0xffff
        bits += 6
        if (bits >= 8) {
            bits -= 8
            out[at++] = ((value shr bits) and 255).toByte()
        }
    }
    return out
}

/** Length-prefixed (u16 big-endian) field. Refuses anything that wouldn't fit. */
fun lp(raw: ByteArray): ByteArray {
    require(raw.size <= 0xffff) { "field too long" }
    return concat(byteArrayOf((raw.size shr 8).toByte(), (raw.size and 255).toByte()), raw)
}

fun lp(field: String): ByteArray = lp(utf8(field))

fun equalBytes(a: ByteArray, b: ByteArray): Boolean = java.security.MessageDigest.isEqual(a, b)

fun randomBytes(n: Int): ByteArray = ByteArray(n).also { rng.nextBytes(it) }

fun randomUuid(): String {
    val b = randomBytes(16)
    b[6] = ((b[6].toInt() and 0x0f) or 0x40).toByte()
    b[8] = ((b[8].toInt() and 0x3f) or 0x80).toByte()
    val h = hex(b)
    return "${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}"
}

/** An unbiased random integer in [0, max). */
fun randomInt(max: Int): Int {
    require(max > 0) { "bad range" }
    return rng.nextInt(max)
}
