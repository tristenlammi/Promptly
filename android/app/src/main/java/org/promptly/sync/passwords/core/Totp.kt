// TOTP (RFC 6238), Steam Guard, otpauth:// links and Google Authenticator's migration
// QR. Mirrors totp.ts.
package org.promptly.sync.passwords.core

import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object Totp {
    private const val B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    private const val STEAM = "23456789BCDFGHJKMNPQRTVWXY"

    fun base32Decode(input: String): ByteArray {
        val clean = input.uppercase().replace(Regex("[\\s-]"), "").trimEnd('=')
        require(clean.isNotEmpty()) { "That secret is empty" }
        val out = ByteArray(clean.length * 5 / 8)
        var bits = 0
        var value = 0
        var at = 0
        for (c in clean) {
            val v = B32.indexOf(c)
            require(v >= 0) { "That secret has characters base32 doesn't use" }
            value = ((value shl 5) or v) and 0xffff
            bits += 5
            if (bits >= 8) {
                bits -= 8
                out[at++] = ((value shr bits) and 255).toByte()
            }
        }
        return out
    }

    fun base32Encode(data: ByteArray): String {
        val out = StringBuilder()
        var bits = 0
        var value = 0
        for (b in data) {
            value = ((value shl 8) or (b.toInt() and 255)) and 0xffff
            bits += 8
            while (bits >= 5) {
                out.append(B32[(value shr (bits - 5)) and 31])
                bits -= 5
            }
        }
        if (bits > 0) out.append(B32[(value shl (5 - bits)) and 31])
        return out.toString()
    }

    private fun hmac(alg: String, key: ByteArray, msg: ByteArray): ByteArray {
        val mac = Mac.getInstance(alg)
        // An empty key can't make a SecretKeySpec; one zero byte is the same under HMAC.
        mac.init(SecretKeySpec(if (key.isEmpty()) ByteArray(1) else key, alg))
        return mac.doFinal(msg)
    }

    private fun counterBytes(counter: Long) = ByteArray(8) { i -> (counter ushr ((7 - i) * 8)).toByte() }

    private fun truncate(mac: ByteArray): Int {
        val o = mac[mac.size - 1].toInt() and 15
        return ((mac[o].toInt() and 0x7f) shl 24) or ((mac[o + 1].toInt() and 255) shl 16) or
            ((mac[o + 2].toInt() and 255) shl 8) or (mac[o + 3].toInt() and 255)
    }

    fun periodOf(cfg: TotpConfig): Int = if (cfg.steam) 30 else cfg.period?.takeIf { it > 0 } ?: 30

    fun secondsLeft(cfg: TotpConfig, nowMs: Long = System.currentTimeMillis()): Int {
        val p = periodOf(cfg)
        return p - ((nowMs / 1000) % p).toInt()
    }

    fun code(cfg: TotpConfig, nowMs: Long = System.currentTimeMillis()): String {
        val counter = nowMs / 1000 / periodOf(cfg)
        if (cfg.steam) {
            var n = truncate(hmac("HmacSHA1", base64Any(cfg.secret), counterBytes(counter)))
            val code = StringBuilder()
            repeat(5) {
                code.append(STEAM[n % STEAM.length])
                n /= STEAM.length
            }
            return code.toString()
        }
        val alg = when (cfg.algorithm ?: "SHA1") {
            "SHA256" -> "HmacSHA256"
            "SHA512" -> "HmacSHA512"
            else -> "HmacSHA1"
        }
        val digits = cfg.digits ?: 6
        require(digits in 6..8) { "TOTP digits must be 6 to 8" }
        val n = truncate(hmac(alg, base32Decode(cfg.secret), counterBytes(counter)))
        var mod = 1L
        repeat(digits) { mod *= 10 }
        return (n % mod).toString().padStart(digits, '0')
    }

    private val BASE32_SHAPE = Regex("^[A-Z2-7]+=*$")

    /** Steam secrets are base64; some exports give base32. Same test as totp.ts. */
    private fun base64Any(s: String): ByteArray {
        if (BASE32_SHAPE.matches(s) && s.trimEnd('=').length % 8 != 1 && s.length % 4 != 0) return base32Decode(s)
        return Base64.getDecoder().decode(s.replace('-', '+').replace('_', '/'))
    }

    private data class Uri(val scheme: String, val host: String, val path: String, val query: Map<String, String>)

    private fun parseUri(raw: String): Uri {
        val m = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*)://([^/?#]*)([^?#]*)(?:\\?([^#]*))?").find(raw)
            ?: throw IllegalArgumentException("That isn't a valid otpauth link")
        return Uri(m.groupValues[1].lowercase(), m.groupValues[2], m.groupValues[3], parseQuery(m.groupValues[4]))
    }

    private fun percent(s: String): String = runCatching { java.net.URLDecoder.decode(s.replace("+", "%2B"), "UTF-8") }.getOrDefault(s)

    fun parseOtpauth(uri: String): TotpConfig {
        val text = uri.trim()
        val u = parseUri(text)
        if (u.scheme == "steam") return TotpConfig(text.substring("steam://".length), steam = true, issuer = "Steam")
        require(u.scheme == "otpauth") { "That isn't an otpauth link" }
        val type = u.host.lowercase()
        require(type == "totp") { if (type == "hotp") "Counter-based (HOTP) codes aren't supported yet" else "Unknown code type" }
        val secret = u.query["secret"]?.takeIf { it.isNotEmpty() } ?: throw IllegalArgumentException("That link has no secret")
        base32Decode(secret)
        val label = percent(u.path.removePrefix("/"))
        val colon = label.indexOf(':')
        val issuer = u.query["issuer"]?.takeIf { it.isNotEmpty() } ?: if (colon > 0) label.substring(0, colon).trim() else null
        val alg = (u.query["algorithm"]?.takeIf { it.isNotEmpty() } ?: "SHA1").uppercase()
        val digits = (u.query["digits"]?.takeIf { it.isNotEmpty() } ?: "6").toIntOrNull()
        val period = (u.query["period"]?.takeIf { it.isNotEmpty() } ?: "30").toIntOrNull()
        require(alg in setOf("SHA1", "SHA256", "SHA512")) { "Unsupported algorithm" }
        require(digits != null && digits in 6..8) { "Unsupported number of digits" }
        require(period != null && period in 1..3600) { "Unsupported period" }
        return TotpConfig(
            secret.uppercase().replace(Regex("\\s"), ""), alg, digits, period, false, issuer,
            if (colon > 0) label.substring(colon + 1).trim() else label,
        )
    }

    fun toOtpauth(cfg: TotpConfig): String {
        fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
        val name = enc(listOfNotNull(cfg.issuer, cfg.label).filter { it.isNotEmpty() }.joinToString(":").ifEmpty { "code" })
        val q = ArrayList<String>()
        q += "secret=${enc(cfg.secret)}"
        cfg.issuer?.let { q += "issuer=${enc(it)}" }
        cfg.algorithm?.takeIf { it != "SHA1" }?.let { q += "algorithm=$it" }
        cfg.digits?.takeIf { it != 6 }?.let { q += "digits=$it" }
        cfg.period?.takeIf { it != 30 }?.let { q += "period=$it" }
        return "otpauth://totp/$name?${q.joinToString("&")}"
    }

    // ---- otpauth-migration:// (a small protobuf, read by hand) ----

    private class Field(val field: Int, val varint: Long?, val bytes: ByteArray?)

    private fun protoFields(data: ByteArray): List<Field> {
        val out = ArrayList<Field>()
        var i = 0
        fun varint(): Long {
            var shift = 0
            var v = 0L
            while (true) {
                require(i < data.size) { "Truncated migration data" }
                val b = data[i++].toInt() and 255
                v = v or ((b and 0x7f).toLong() shl shift)
                if (b and 0x80 == 0) return v
                shift += 7
                require(shift <= 63) { "Bad migration data" }
            }
        }
        while (i < data.size) {
            val tag = varint()
            val field = (tag ushr 3).toInt()
            when ((tag and 7).toInt()) {
                0 -> out += Field(field, varint(), null)
                2 -> {
                    val n = varint().toInt()
                    require(n >= 0 && i + n <= data.size) { "Truncated migration data" }
                    out += Field(field, null, data.copyOfRange(i, i + n))
                    i += n
                }
                1 -> i += 8
                5 -> i += 4
                else -> throw IllegalArgumentException("Bad migration data")
            }
        }
        return out
    }

    data class Migration(val codes: List<TotpConfig>, val skipped: Int)

    fun parseMigration(uri: String): Migration {
        val text = uri.trim()
        val head = text.indexOf('?')
        require(text.lowercase().startsWith("otpauth-migration:") && head > 0) { "That isn't a migration link" }
        // Not parseQuery: a `+` in the data is a base64 plus (the web client treats a space the same).
        val raw = text.substring(head + 1).split('&').firstOrNull { it.startsWith("data=") }?.substring(5)
            ?: throw IllegalArgumentException("That link has no data")
        val data = runCatching { java.net.URLDecoder.decode(raw.replace("+", "%2B"), "UTF-8") }.getOrDefault(raw)
        val payload = Base64.getDecoder().decode(data.replace(' ', '+').replace('-', '+').replace('_', '/'))
        val codes = ArrayList<TotpConfig>()
        var skipped = 0
        for (f in protoFields(payload)) {
            if (f.field != 1 || f.bytes == null) continue
            var secret: ByteArray? = null
            var name = ""
            var issuer = ""
            var algorithm = 1L
            var digits = 1L
            var type = 2L
            for (p in protoFields(f.bytes)) {
                when (p.field) {
                    1 -> if (p.bytes != null) secret = p.bytes
                    2 -> if (p.bytes != null) name = String(p.bytes)
                    3 -> if (p.bytes != null) issuer = String(p.bytes)
                    4 -> algorithm = p.varint ?: 1
                    5 -> digits = p.varint ?: 1
                    6 -> type = p.varint ?: 2
                }
            }
            val s = secret
            if (s == null || type != 2L) {
                skipped++
                continue
            }
            val colon = name.indexOf(':')
            codes += TotpConfig(
                base32Encode(s),
                when (algorithm) {
                    2L -> "SHA256"
                    3L -> "SHA512"
                    else -> "SHA1"
                },
                if (digits == 2L) 8 else 6,
                30,
                false,
                issuer.ifEmpty { if (colon > 0) name.substring(0, colon) else null },
                if (colon > 0) name.substring(colon + 1).trim() else name,
            )
        }
        return Migration(codes, skipped)
    }
}
