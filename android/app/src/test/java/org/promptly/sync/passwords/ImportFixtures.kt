// What the importer tests read: the files in src/test/cross/import-fixtures, which the TypeScript
// reads too, the web's own fixture.kdbx, zips of those files, and a KDBX 4 writer that will make
// a file as wrong as a test needs it. Test values only.
package org.promptly.sync.passwords

import org.bouncycastle.crypto.engines.ChaCha7539Engine
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.ParametersWithIV
import org.promptly.sync.passwords.core.BouncyCastleArgon2
import org.promptly.sync.passwords.core.BouncyCastleArgon2d
import org.promptly.sync.passwords.core.concat
import org.promptly.sync.passwords.core.utf8
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import java.util.zip.Deflater
import java.util.zip.GZIPOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

object ImportFixtures {
    const val KDBX_PASSWORD = "kdbx test password"

    val dir: File get() = File(Fixtures.frontend.parentFile, "android/app/src/test/cross/import-fixtures")
    fun bytes(name: String) = File(dir, name).readBytes()
    fun text(name: String) = String(bytes(name), Charsets.UTF_8)

    val kdbx: ByteArray get() = File(Fixtures.core, "testing/fixture.kdbx").readBytes()

    fun zip(vararg entries: Pair<String, ByteArray>): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { z ->
            for ((name, data) in entries) {
                z.putNextEntry(ZipEntry(name))
                z.write(data)
                z.closeEntry()
            }
        }
        return out.toByteArray()
    }

    fun onePux() = zip("export.attributes" to utf8("{\"version\":3}"), "export.data" to bytes("onepux-export.data.json"))

    fun dashlane() = zip(
        "credentials.csv" to bytes("dashlane-credentials.csv"),
        "securenotes.csv" to bytes("dashlane-securenotes.csv"),
        "payments.csv" to bytes("dashlane-payments.csv"),
        "ids.csv" to bytes("dashlane-ids.csv"),
        "other.csv" to bytes("dashlane-other.csv"),
    )

    fun deflate(data: ByteArray): ByteArray {
        val d = Deflater(9, true)
        d.setInput(data)
        d.finish()
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (!d.finished()) out.write(buffer, 0, d.deflate(buffer))
        d.end()
        return out.toByteArray()
    }

    private fun ByteArrayOutputStream.u16(v: Int) {
        write(v and 255)
        write((v ushr 8) and 255)
    }

    private fun ByteArrayOutputStream.u32(v: Long) {
        u16((v and 0xffff).toInt())
        u16(((v ushr 16) and 0xffff).toInt())
    }

    private fun ByteArrayOutputStream.u64(v: Long) {
        u32(v and 0xffffffffL)
        u32((v ushr 32) and 0xffffffffL)
    }

    /** One entry of a zip whose headers say whatever the test wants. */
    class Raw(
        val name: String,
        val data: ByteArray,
        val method: Int = 8,
        val declaredSize: Long = 0,
        val declaredCompressed: Long = data.size.toLong(),
        val flags: Int = 0,
        /** Points this entry at an earlier one's bytes instead of writing its own. */
        val sameDataAs: Int = -1,
        val localOverride: Long = -1,
    )

    fun rawZip(entries: List<Raw>, countOverride: Int = -1, comment: ByteArray = ByteArray(0), zip64: Boolean = false): ByteArray {
        val out = ByteArrayOutputStream()
        val offsets = ArrayList<Long>()
        for (e in entries) {
            if (e.sameDataAs >= 0) {
                offsets += offsets[e.sameDataAs]
                continue
            }
            offsets += out.size().toLong()
            val n = utf8(e.name)
            out.u32(0x04034B50L)
            out.u16(20)
            out.u16(e.flags)
            out.u16(e.method)
            out.u16(0)
            out.u16(0)
            out.u32(0)
            out.u32(if (zip64) 0xFFFFFFFFL else e.declaredCompressed)
            out.u32(if (zip64) 0xFFFFFFFFL else e.declaredSize)
            out.u16(n.size)
            out.u16(0)
            out.write(n)
            out.write(e.data)
        }
        val cd = out.size().toLong()
        for ((i, e) in entries.withIndex()) {
            val n = utf8(e.name)
            out.u32(0x02014B50L)
            out.u16(20)
            out.u16(20)
            out.u16(e.flags)
            out.u16(e.method)
            out.u16(0)
            out.u16(0)
            out.u32(0)
            out.u32(if (zip64) 0xFFFFFFFFL else e.declaredCompressed)
            out.u32(if (zip64) 0xFFFFFFFFL else e.declaredSize)
            out.u16(n.size)
            out.u16(if (zip64) 28 else 0)
            out.u16(0)
            out.u16(0)
            out.u16(0)
            out.u32(0)
            out.u32(if (zip64) 0xFFFFFFFFL else if (e.localOverride >= 0) e.localOverride else offsets[i])
            out.write(n)
            if (zip64) {
                out.u16(1)
                out.u16(24)
                out.u64(e.declaredSize)
                out.u64(e.declaredCompressed)
                out.u64(offsets[i])
            }
        }
        val cdSize = out.size().toLong() - cd
        val count = if (countOverride >= 0) countOverride else entries.size
        if (zip64) {
            val record = out.size().toLong()
            out.u32(0x06064B50L)
            out.u64(44)
            out.u16(45)
            out.u16(45)
            out.u32(0)
            out.u32(0)
            out.u64(count.toLong())
            out.u64(count.toLong())
            out.u64(cdSize)
            out.u64(cd)
            out.u32(0x07064B50L)
            out.u32(0)
            out.u64(record)
            out.u32(1)
        }
        out.u32(0x06054B50L)
        out.u16(0)
        out.u16(0)
        out.u16(if (zip64) 0xFFFF else count and 0xFFFF)
        out.u16(if (zip64) 0xFFFF else count and 0xFFFF)
        out.u32(cdSize)
        out.u32(if (zip64) 0xFFFFFFFFL else cd)
        out.u16(comment.size)
        out.write(comment)
        return out.toByteArray()
    }
}

/** A KDBX 4 file, written from the format's public documentation. A file that's meant to be
 *  refused at its key settings doesn't need the key: see [headerOnly]. */
object KdbxWriter {
    val AES = "31c1f2e6bf714350be5805216afc5aff"
    val CHACHA = "d6038a2b8b6f4cb5a524339a31dbb59a"
    private const val ARGON2D = "ef636ddf8c29444b91f7a9a403e30a0c"
    private const val ARGON2ID = "9e298b1956db4773b23dfc3ec6f0a1e6"
    private const val AES_KDF = "c9d9f39a628a4460bf740d08c18a4fea"

    sealed class Kdf
    class Argon2(val id: Boolean = true, val m: Long = 64 * 1024, val t: Long = 1, val p: Long = 1, val salt: ByteArray = ByteArray(32) { 3 }, val wide: Boolean = true) : Kdf()
    class AesRounds(val rounds: Long) : Kdf()
    class Unknown(val uuid: String) : Kdf()

    private fun hexBytes(s: String) = ByteArray(s.length / 2) { i -> s.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    private fun u32(v: Long) = ByteArray(4) { i -> (v ushr (i * 8)).toByte() }
    private fun u64(v: Long) = ByteArray(8) { i -> (v ushr (i * 8)).toByte() }
    private fun u16(v: Int) = byteArrayOf(v.toByte(), (v ushr 8).toByte())

    private fun dictEntry(type: Int, key: String, value: ByteArray) = concat(byteArrayOf(type.toByte()), u32(key.length.toLong()), utf8(key), u32(value.size.toLong()), value)

    private fun dict(kdf: Kdf): ByteArray {
        val seed = ByteArray(32) { 3 }
        val body = when (kdf) {
            is Argon2 -> concat(
                dictEntry(0x42, "\$UUID", hexBytes(if (kdf.id) ARGON2ID else ARGON2D)),
                dictEntry(if (kdf.wide) 5 else 4, "M", if (kdf.wide) u64(kdf.m) else u32(kdf.m)),
                dictEntry(5, "I", u64(kdf.t)),
                dictEntry(4, "P", u32(kdf.p)),
                dictEntry(0x42, "S", kdf.salt),
                dictEntry(4, "V", u32(0x13)),
            )
            is AesRounds -> concat(dictEntry(0x42, "\$UUID", hexBytes(AES_KDF)), dictEntry(5, "R", u64(kdf.rounds)), dictEntry(0x42, "S", seed))
            is Unknown -> dictEntry(0x42, "\$UUID", hexBytes(kdf.uuid))
        }
        return concat(u16(0x0100), body, byteArrayOf(0))
    }

    private fun field(id: Int, v: ByteArray) = concat(byteArrayOf(id.toByte()), u32(v.size.toLong()), v)

    private fun header(cipher: String, compress: Boolean, seed: ByteArray, iv: ByteArray, kdf: Kdf, major: Int) = concat(
        u32(0x9AA2D903L), u32(0xB54BFB67L), u16(0), u16(major),
        field(2, hexBytes(cipher)), field(3, u32(if (compress) 1 else 0)), field(4, seed), field(7, iv), field(11, dict(kdf)), field(0, byteArrayOf(13, 10, 13, 10)),
    )

    private fun sha256(d: ByteArray) = MessageDigest.getInstance("SHA-256").digest(d)
    private fun sha512(d: ByteArray) = MessageDigest.getInstance("SHA-512").digest(d)
    private fun hmac(k: ByteArray, d: ByteArray) = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(k, "HmacSHA256"))
        doFinal(d)
    }

    /** Good enough to get as far as the key settings, and no further. */
    fun headerOnly(kdf: Kdf, major: Int = 4): ByteArray {
        val h = header(AES, true, ByteArray(32) { 1 }, ByteArray(16) { 2 }, kdf, major)
        return concat(h, sha256(h), ByteArray(32))
    }

    private fun transform(composite: ByteArray, kdf: Kdf): ByteArray = when (kdf) {
        is Argon2 -> (if (kdf.id) BouncyCastleArgon2 else BouncyCastleArgon2d).hash(composite, kdf.salt, (kdf.m / 1024).toInt(), kdf.t.toInt(), kdf.p.toInt(), 32)
        is AesRounds -> {
            val c = Cipher.getInstance("AES/ECB/NoPadding").apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(ByteArray(32) { 3 }, "AES")) }
            var block = composite
            for (i in 0 until kdf.rounds) block = c.doFinal(block)
            sha256(block)
        }
        is Unknown -> ByteArray(32)
    }

    /** What the XML builder calls for each protected value, in document order. */
    fun interface Protect {
        operator fun invoke(plain: String): String
    }

    fun write(
        kdf: Kdf = Argon2(),
        cipher: String = AES,
        compress: Boolean = true,
        innerId: Int = 3,
        password: String = ImportFixtures.KDBX_PASSWORD,
        rawXml: ByteArray? = null,
        xml: (Protect) -> String = { p -> entryXml(p, "Alpha", "ana", "pw-alpha-1") },
    ): ByteArray {
        val seed = ByteArray(32) { 1 }
        val iv = if (cipher == CHACHA) ByteArray(12) { 2 } else ByteArray(16) { 2 }
        val h = header(cipher, compress, seed, iv, kdf, 4)
        val composite = sha256(sha256(utf8(password)))
        val transformed = transform(composite, kdf)
        val encKey = sha256(concat(seed, transformed))
        val hmacBase = sha512(concat(seed, transformed, byteArrayOf(1)))
        fun blockKey(i: Long) = sha512(concat(u64(i), hmacBase))

        val innerKey = ByteArray(64) { 9 }
        val inner = sha512(innerKey)
        val stream = ChaCha7539Engine().apply { init(true, ParametersWithIV(KeyParameter(inner.copyOfRange(0, 32)), inner.copyOfRange(32, 44))) }
        val protect = Protect { plain ->
            val raw = utf8(plain)
            val out = ByteArray(raw.size)
            stream.processBytes(raw, 0, raw.size, out, 0)
            Base64.getEncoder().encodeToString(out)
        }
        val payload = concat(field(1, u32(innerId.toLong())), field(2, innerKey), field(0, ByteArray(0)), rawXml ?: utf8(xml(protect)))
        val body = if (compress) ByteArrayOutputStream().also { o -> GZIPOutputStream(o).use { it.write(payload) } }.toByteArray() else payload
        val ct = if (cipher == CHACHA) {
            ByteArray(body.size).also { ChaCha7539Engine().apply { init(true, ParametersWithIV(KeyParameter(encKey), iv)) }.processBytes(body, 0, body.size, it, 0) }
        } else {
            Cipher.getInstance("AES/CBC/PKCS5Padding").run {
                init(Cipher.ENCRYPT_MODE, SecretKeySpec(encKey, "AES"), IvParameterSpec(iv))
                doFinal(body)
            }
        }

        val out = ByteArrayOutputStream()
        out.write(h)
        out.write(sha256(h))
        out.write(hmac(blockKey(-1L), h))
        var at = 0
        var index = 0L
        while (at < ct.size) {
            val data = ct.copyOfRange(at, minOf(at + 1024 * 1024, ct.size))
            val length = u32(data.size.toLong())
            out.write(hmac(blockKey(index), concat(u64(index), length, data)))
            out.write(length)
            out.write(data)
            at += data.size
            index++
        }
        out.write(hmac(blockKey(index), concat(u64(index), u32(0))))
        out.write(u32(0))
        return out.toByteArray()
    }

    fun entryXml(p: Protect, title: String, user: String, password: String) =
        "<KeePassFile><Meta/><Root><Group><Name>Root</Name><Entry><String><Key>Title</Key><Value>$title</Value></String><String><Key>UserName</Key><Value>$user</Value></String><String><Key>Password</Key><Value Protected=\"True\">${p(password)}</Value></String></Entry></Group></Root></KeePassFile>"
}
