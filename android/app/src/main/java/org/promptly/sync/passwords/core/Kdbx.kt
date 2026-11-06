// KeePass KDBX 4 reader. Mirrors kdbx.ts, from the format's public documentation. Read-only.
// A file chooses its own KDF cost, so the limits come before any of the work. kdbx.ts's are
// here too, but 8 GiB and 200 million rounds are a desktop's numbers: a phone gets its own, and
// the same goes for how far the contents can expand, where kdbx.ts has no limit. Pure JVM.
package org.promptly.sync.passwords.core

import org.bouncycastle.crypto.engines.AESEngine
import org.bouncycastle.crypto.engines.ChaCha7539Engine
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.ParametersWithIV
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.GeneralSecurityException
import java.security.MessageDigest
import java.text.Normalizer
import java.util.Base64
import java.util.zip.GZIPInputStream
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

object Kdbx {
    private const val AES_KDF = "c9d9f39a628a4460bf740d08c18a4fea"
    private const val ARGON2D = "ef636ddf8c29444b91f7a9a403e30a0c"
    private const val ARGON2ID = "9e298b1956db4773b23dfc3ec6f0a1e6"
    private const val CIPHER_AES = "31c1f2e6bf714350be5805216afc5aff"
    private const val CIPHER_CHACHA = "d6038a2b8b6f4cb5a524339a31dbb59a"

    // kdbx.ts's ceilings.
    const val WEB_MAX_MEMORY = 8L * 1024 * 1024 * 1024
    const val WEB_MAX_PASSES = 100_000L
    const val WEB_MAX_LANES = 64L
    const val WEB_MAX_ROUNDS = 200_000_000L

    // A phone's. Memory is the most a file can ask for even with plenty free.
    const val MAX_MEMORY = 1024L * 1024 * 1024

    /** Memory times passes. About a minute's work at most on an ordinary phone. */
    const val MAX_WORK = 32L * 1024 * 1024 * 1024
    const val MAX_ROUNDS = 60_000_000L

    /** What the decrypted contents may grow to. kdbx.ts has no limit on this. */
    const val MAX_EXPANDED = Importers.MAX_BYTES.toLong()

    /** Lowered by the screen to what this phone can spare right now. */
    @Volatile
    var memoryLimit: Long = MAX_MEMORY

    private const val UNUSUAL = "Unusual KDF settings in that file"
    private const val TOO_HEAVY = "That file's key settings ask more than this phone should give. Open it on a computer, lower them or export KeePass XML, and try again."
    private const val DAMAGED_HEADER = "Damaged KeePass header"
    private const val DAMAGED = "That KeePass file is damaged"

    private fun u32(b: ByteArray, at: Long, whenBad: String): Long {
        if (at < 0 || at + 4 > b.size) throw IllegalArgumentException(whenBad)
        val i = at.toInt()
        return (b[i].toLong() and 255) or ((b[i + 1].toLong() and 255) shl 8) or ((b[i + 2].toLong() and 255) shl 16) or ((b[i + 3].toLong() and 255) shl 24)
    }

    private fun u64le(v: Long) = ByteArray(8) { i -> (v ushr (i * 8)).toByte() }

    private fun sha256(d: ByteArray) = MessageDigest.getInstance("SHA-256").digest(d)
    private fun sha512(d: ByteArray) = MessageDigest.getInstance("SHA-512").digest(d)

    private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val m = Mac.getInstance("HmacSHA256")
        m.init(SecretKeySpec(key, "HmacSHA256"))
        return m.doFinal(data)
    }

    /** As fflate's strFromU8: bad UTF-8 becomes U+FFFD, and a leading BOM goes. */
    private fun text(b: ByteArray) = String(b, Charsets.UTF_8).removePrefix("﻿")

    /** KDBX's variant dictionary. */
    private fun variantDict(b: ByteArray): Map<String, ByteArray> {
        val out = HashMap<String, ByteArray>()
        var i = 2L
        while (i < b.size) {
            val type = b[i.toInt()].toInt()
            i++
            if (type == 0) break
            val keyLength = u32(b, i, DAMAGED_HEADER)
            i += 4
            if (keyLength > 1024 || i + keyLength > b.size) throw IllegalArgumentException(DAMAGED_HEADER)
            val key = text(b.copyOfRange(i.toInt(), (i + keyLength).toInt()))
            i += keyLength
            val valueLength = u32(b, i, DAMAGED_HEADER)
            i += 4
            if (i + valueLength > b.size) throw IllegalArgumentException(DAMAGED_HEADER)
            out[key] = b.copyOfRange(i.toInt(), (i + valueLength).toInt())
            i += valueLength
        }
        return out
    }

    private fun num(v: ByteArray?): Long {
        if (v == null || v.size < 4) throw IllegalArgumentException(DAMAGED_HEADER)
        if (v.size != 8) return u32(v, 0, DAMAGED_HEADER)
        val n = u32(v, 0, DAMAGED_HEADER) or (u32(v, 4, DAMAGED_HEADER) shl 32)
        return if (n < 0) Long.MAX_VALUE else n
    }

    private fun aesKdf(key: ByteArray, seed: ByteArray?, rounds: Long): ByteArray {
        if (rounds > WEB_MAX_ROUNDS) throw IllegalArgumentException(UNUSUAL)
        if (rounds > MAX_ROUNDS) throw IllegalArgumentException(TOO_HEAVY)
        if (seed == null || seed.size !in setOf(16, 24, 32) || key.size != 32) throw IllegalArgumentException(DAMAGED_HEADER)
        val aes = AESEngine.newInstance()
        aes.init(true, KeyParameter(seed))
        val block = key.copyOf()
        var i = 0L
        while (i < rounds) {
            aes.processBlock(block, 0, block, 0)
            aes.processBlock(block, 16, block, 16)
            i++
        }
        return sha256(block)
    }

    private fun argon2(composite: ByteArray, kdf: Map<String, ByteArray>, id: Boolean): ByteArray {
        val m = num(kdf["M"])
        val t = num(kdf["I"])
        val p = num(kdf["P"])
        if (m > WEB_MAX_MEMORY || t > WEB_MAX_PASSES || p > WEB_MAX_LANES) throw IllegalArgumentException(UNUSUAL)
        val engine = if (id) Primitives.argon2Engine else Primitives.argon2dEngine
        // BouncyCastle needs all of it on the Java heap, which is much smaller than the phone.
        val onHeap = engine === BouncyCastleArgon2 || engine === BouncyCastleArgon2d
        val limit = minOf(MAX_MEMORY, memoryLimit, if (onHeap) Runtime.getRuntime().maxMemory() / 2 else Long.MAX_VALUE)
        if (m > limit || m * t > MAX_WORK) throw IllegalArgumentException(TOO_HEAVY)
        val salt = kdf["S"] ?: throw IllegalArgumentException(DAMAGED_HEADER)
        val kib = m / 1024
        if (t < 1 || p < 1 || kib < 8 * p || salt.size < 8) throw IllegalArgumentException(UNUSUAL)
        return try {
            engine.hash(composite, salt, kib.toInt(), t.toInt(), p.toInt(), 32)
        } catch (_: OutOfMemoryError) {
            throw IllegalArgumentException(TOO_HEAVY)
        } catch (_: RuntimeException) {
            throw IllegalArgumentException(TOO_HEAVY)
        }
    }

    private fun decrypt(cipher: String, key: ByteArray, iv: ByteArray, ct: ByteArray): ByteArray = when (cipher) {
        CIPHER_AES -> {
            if (iv.size != 16) throw IllegalArgumentException(DAMAGED)
            try {
                Cipher.getInstance("AES/CBC/PKCS5Padding").run {
                    init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
                    doFinal(ct)
                }
            } catch (_: GeneralSecurityException) {
                throw IllegalArgumentException(DAMAGED)
            }
        }
        CIPHER_CHACHA -> {
            if (iv.size != 12) throw IllegalArgumentException(DAMAGED)
            val out = ByteArray(ct.size)
            chacha(key, iv).processBytes(ct, 0, ct.size, out, 0)
            out
        }
        else -> throw IllegalArgumentException("That file uses a cipher we don't know")
    }

    private fun chacha(key: ByteArray, nonce: ByteArray) = ChaCha7539Engine().apply { init(true, ParametersWithIV(KeyParameter(key), nonce)) }

    private fun gunzip(data: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(minOf(data.size.toLong() * 4, MAX_EXPANDED).toInt().coerceAtLeast(1024))
        try {
            GZIPInputStream(ByteArrayInputStream(data)).use { gz ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val n = gz.read(buffer)
                    if (n < 0) break
                    if (out.size() + n > MAX_EXPANDED) throw IllegalArgumentException("That KeePass file expands to more than this phone can read")
                    out.write(buffer, 0, n)
                }
            }
        } catch (_: java.io.IOException) {
            throw IllegalArgumentException(DAMAGED)
        }
        return out.toByteArray()
    }

    /** atob: ASCII whitespace ignored, anything else that isn't base64 refused. */
    private fun decodeBase64(s: String): ByteArray {
        val clean = s.filterNot { it == ' ' || it == '\t' || it == '\n' || it == '\r' || it == '\u000C' }
        return try {
            Base64.getDecoder().decode(clean)
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("That file's contents couldn't be read")
        }
    }

    fun read(file: ByteArray, password: String): ImportResult {
        if (file.size < 12 || u32(file, 0, DAMAGED) != 0x9AA2D903L || u32(file, 4, DAMAGED) != 0xB54BFB67L) throw IllegalArgumentException("That isn't a KeePass database")
        val major = (file[10].toInt() and 255) or ((file[11].toInt() and 255) shl 8)
        if (major != 4) throw IllegalArgumentException("That's an older KeePass format. Open it in KeePass, save as KDBX 4 or export XML, and try again.")

        var at = 12L
        var cipher = ""
        var compression = 0L
        var masterSeed: ByteArray? = null
        var iv: ByteArray? = null
        var kdf: Map<String, ByteArray>? = null
        while (true) {
            if (at >= file.size) throw IllegalArgumentException(DAMAGED_HEADER)
            val id = file[at.toInt()].toInt() and 255
            at++
            val length = u32(file, at, DAMAGED_HEADER)
            at += 4
            if (at + length > file.size) throw IllegalArgumentException(DAMAGED_HEADER)
            val v = file.copyOfRange(at.toInt(), (at + length).toInt())
            at += length
            if (id == 0) break
            when (id) {
                2 -> cipher = hex(v)
                3 -> compression = u32(v, 0, DAMAGED_HEADER)
                4 -> masterSeed = v
                7 -> iv = v
                11 -> kdf = variantDict(v)
            }
        }
        val seed = masterSeed ?: throw IllegalArgumentException(DAMAGED_HEADER)
        val nonce = iv ?: throw IllegalArgumentException(DAMAGED_HEADER)
        val settings = kdf ?: throw IllegalArgumentException(DAMAGED_HEADER)
        if (cipher.isEmpty()) throw IllegalArgumentException(DAMAGED_HEADER)
        val headerEnd = at.toInt()
        if (at + 64 > file.size) throw IllegalArgumentException(DAMAGED)
        val header = file.copyOfRange(0, headerEnd)
        val headerHash = file.copyOfRange(headerEnd, headerEnd + 32)
        val headerMac = file.copyOfRange(headerEnd + 32, headerEnd + 64)
        at += 64
        if (!equalBytes(sha256(header), headerHash)) throw IllegalArgumentException(DAMAGED)

        val composite = sha256(sha256(utf8(Normalizer.normalize(password, Normalizer.Form.NFC))))
        val transformed = when (hex(settings["\$UUID"] ?: ByteArray(0))) {
            ARGON2D -> argon2(composite, settings, id = false)
            ARGON2ID -> argon2(composite, settings, id = true)
            AES_KDF -> aesKdf(composite, settings["S"], num(settings["R"]))
            else -> throw IllegalArgumentException("That file uses a key setting we don't know")
        }

        val encKey = sha256(concat(seed, transformed))
        val hmacBase = sha512(concat(seed, transformed, byteArrayOf(1)))
        fun blockKey(index: Long) = sha512(concat(u64le(index), hmacBase))
        // The header's MAC says whether the password was right, before anything else.
        if (!equalBytes(hmacSha256(blockKey(-1L), header), headerMac)) throw IllegalArgumentException("That password didn't open the file")

        val ct = ByteArrayOutputStream()
        var index = 0L
        while (true) {
            val length = u32(file, at + 32, DAMAGED)
            if (at + 36 + length > file.size) throw IllegalArgumentException(DAMAGED)
            val mac = file.copyOfRange(at.toInt(), (at + 32).toInt())
            val data = file.copyOfRange((at + 36).toInt(), (at + 36 + length).toInt())
            val expected = hmacSha256(blockKey(index), concat(u64le(index), ByteArray(4) { i -> (length ushr (i * 8)).toByte() }, data))
            if (!equalBytes(expected, mac)) throw IllegalArgumentException(DAMAGED)
            at += 36 + length
            if (length == 0L) break
            ct.write(data)
            index++
        }

        var plain = decrypt(cipher, encKey, nonce, ct.toByteArray())
        if (compression == 1L) plain = gunzip(plain)

        // Inner header: the inner stream's key.
        var p = 0L
        var innerId = 0L
        var innerKey: ByteArray? = null
        while (true) {
            if (p >= plain.size) throw IllegalArgumentException(DAMAGED)
            val id = plain[p.toInt()].toInt() and 255
            p++
            val length = u32(plain, p, DAMAGED)
            p += 4
            if (p + length > plain.size) throw IllegalArgumentException(DAMAGED)
            val v = plain.copyOfRange(p.toInt(), (p + length).toInt())
            p += length
            if (id == 0) break
            if (id == 1) innerId = u32(v, 0, DAMAGED)
            else if (id == 2) innerKey = v
        }
        val keyOfStream = innerKey
        if (innerId != 3L || keyOfStream == null) throw IllegalArgumentException("That file's inner protection isn't ChaCha20, which we need.")
        val inner = sha512(keyOfStream)
        // One keystream, running on over every protected value in document order.
        val stream = chacha(inner.copyOfRange(0, 32), inner.copyOfRange(32, 44))

        val xml = text(plain.copyOfRange(p.toInt(), plain.size))
        if (xml.contains("<!ENTITY", ignoreCase = true)) throw IllegalArgumentException("That file defines its own XML entities, which we don't accept.")
        val doc = try {
            SafeXml.parse(xml)
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("That file's contents couldn't be read")
        }
        val root = SafeXml.keepassRoot(doc) ?: throw IllegalArgumentException("That file's contents couldn't be read")

        fun protectedValue(value: XmlElement): String {
            val raw = decodeBase64(value.textContent())
            val out = ByteArray(raw.size)
            stream.processBytes(raw, 0, raw.size, out, 0)
            return text(out)
        }

        val items = ArrayList<Imported>()

        // Depth first in document order, because of the stream.
        fun walk(el: XmlElement, path: List<String>, depth: Int, record: Boolean) {
            if (depth > 64) throw IllegalArgumentException("Those groups nest too deeply")
            for (child in el.children) {
                if (child.name == "Group") {
                    val name = child.child("Name")?.textContent() ?: ""
                    walk(child, if (depth == 0) emptyList() else path + name, depth + 1, record)
                } else if (child.name == "Entry") {
                    val strings = LinkedHashMap<String, String>()
                    for (c in child.children) {
                        if (c.name == "String") {
                            val key = c.child("Key")?.textContent() ?: ""
                            val value = c.child("Value") ?: continue
                            strings[key] = if (value.attributes["Protected"] == "True") protectedValue(value) else value.textContent()
                        } else if (c.name == "History") {
                            // History entries use up the stream but aren't imported.
                            walk(c, path, depth + 1, false)
                        }
                    }
                    if (record) items += ImportFormats.keepassItem(strings, path.joinToString("/").ifEmpty { null })
                }
            }
        }
        walk(root, emptyList(), 0, true)
        return ImportResult("KeePass", items, emptyList())
    }
}
