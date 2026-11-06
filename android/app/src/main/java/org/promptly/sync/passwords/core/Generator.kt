// Password, passphrase, PIN and username generators. Mirrors generator.ts. Site rules use
// the same Apple password-manager-resources file as the web client (copied at build time).
package org.promptly.sync.passwords.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

object Generator {
    private const val LOWER = "abcdefghijklmnopqrstuvwxyz"
    private const val UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    private const val DIGIT = "0123456789"
    private const val SYMBOL = "!@#$%^&*-_=+?.,:;"
    private const val AMBIGUOUS = "O0oIl1|`'\""

    data class PasswordOptions(
        val length: Int = 20,
        val lower: Boolean = true,
        val upper: Boolean = true,
        val digits: Boolean = true,
        val symbols: Boolean = true,
        val avoidAmbiguous: Boolean = true,
    )

    private fun pick(s: String): Char = s[randomInt(s.length)]

    private fun shuffled(chars: MutableList<Char>): String {
        for (i in chars.size - 1 downTo 1) {
            val j = randomInt(i + 1)
            val t = chars[i]
            chars[i] = chars[j]
            chars[j] = t
        }
        return String(chars.toCharArray())
    }

    private fun hasRun(s: String, max: Int): Boolean {
        var run = 1
        for (i in 1 until s.length) {
            run = if (s[i] == s[i - 1]) run + 1 else 1
            if (run > max) return true
        }
        return false
    }

    private fun assemble(length: Int, required: List<String>, allowed: String, maxConsecutive: Int?): String {
        require(allowed.isNotEmpty()) { "No characters allowed" }
        repeat(200) {
            val chars = required.map { pick(it) }.toMutableList()
            while (chars.size < length) chars += pick(allowed)
            val out = shuffled(chars)
            if (maxConsecutive == null || maxConsecutive == 0 || !hasRun(out, maxConsecutive)) return out
        }
        throw IllegalStateException("Couldn't satisfy those password rules")
    }

    fun password(o: PasswordOptions = PasswordOptions()): String {
        fun clean(s: String) = if (o.avoidAmbiguous) s.filter { it !in AMBIGUOUS } else s
        val required = ArrayList<String>()
        if (o.lower) required += clean(LOWER)
        if (o.upper) required += clean(UPPER)
        if (o.digits) required += clean(DIGIT)
        if (o.symbols) required += clean(SYMBOL)
        require(required.isNotEmpty()) { "Pick at least one kind of character" }
        return assemble(maxOf(o.length, required.size), required, required.joinToString(""), null)
    }

    fun pin(length: Int = 6): String = String(CharArray(length) { '0' + randomInt(10) })

    fun passphrase(words: Int = 5, separator: String = "-", capitalize: Boolean = false, includeNumber: Boolean = false): String {
        val list = Wordlist.words
        val out = ArrayList<String>()
        repeat(maxOf(3, words)) {
            var w = list[randomInt(list.size)]
            if (capitalize) w = w.replaceFirstChar { it.uppercase() }
            out += w
        }
        if (includeNumber) {
            val at = randomInt(out.size)
            out[at] = out[at] + randomInt(10)
        }
        return out.joinToString(separator)
    }

    fun username(random: Boolean = false): String {
        if (random) return String(CharArray(12) { pick(LOWER + DIGIT) })
        val list = Wordlist.words
        return "${list[randomInt(list.size)]}.${list[randomInt(list.size)]}${randomInt(100)}".replace("-", "")
    }

    /** "me@x.com" + "shop" = "me+shop@x.com". Only works where the provider allows it. */
    fun plusAddress(email: String, tag: String): String {
        val at = email.indexOf('@')
        if (at < 1) throw IllegalArgumentException("That isn't an email address")
        val clean = tag.lowercase().replace(Regex("[^a-z0-9]+"), "").take(24).ifEmpty { username(true).take(6) }
        return "${email.substring(0, at).split('+')[0]}+$clean${email.substring(at)}"
    }

    // ---- Site rules ----

    data class SiteRules(val minLength: Int?, val maxLength: Int?, val required: List<String>, val allowed: String, val maxConsecutive: Int?)

    private fun classOf(token: String): String {
        val t = token.trim()
        return when {
            t == "lower" -> LOWER
            t == "upper" -> UPPER
            t == "digit" -> DIGIT
            t == "special" -> "-~!@#$%^&*_+=`|(){}[:;\"'<>,.?/ ]".filter { it !in " \"'`\\" }
            t == "ascii-printable" || t == "unicode" -> LOWER + UPPER + DIGIT + SYMBOL
            t.startsWith("[") && t.endsWith("]") -> t.substring(1, t.length - 1)
            else -> ""
        }
    }

    private fun splitOutside(text: String, sep: Char): List<String> {
        val out = ArrayList<String>()
        val at = StringBuilder()
        var depth = 0
        for (c in text) {
            if (c == '[') depth = 1 else if (c == ']') depth = 0
            if (c == sep && depth == 0) {
                out += at.toString()
                at.clear()
            } else {
                at.append(c)
            }
        }
        out += at.toString()
        return out
    }

    fun parseRules(text: String): SiteRules {
        var min: Int? = null
        var max: Int? = null
        var consecutive: Int? = null
        val required = ArrayList<String>()
        val allowed = LinkedHashSet<Char>()
        val clean = text.replace("&quot;", "\"").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        for (part in splitOutside(clean, ';')) {
            val colon = part.indexOf(':')
            if (colon < 0) continue
            val name = part.substring(0, colon).trim().lowercase()
            val value = part.substring(colon + 1).trim()
            when (name) {
                "minlength" -> min = value.toIntOrNull()
                "maxlength" -> max = value.toIntOrNull()
                "max-consecutive" -> consecutive = value.toIntOrNull()
                "required", "allowed" -> {
                    val union = splitOutside(value, ',').joinToString("") { classOf(it) }
                    if (union.isEmpty()) continue
                    if (name == "required") required += union
                    allowed += union.toList()
                }
            }
        }
        return SiteRules(min, max, required, String(allowed.toCharArray()), consecutive)
    }

    @Volatile
    private var table: JsonObject? = null

    @Volatile
    var rulesLoader: (() -> String)? = null

    fun rulesForHost(host: String): SiteRules? {
        val t = table ?: rulesLoader?.invoke()?.let { (Json.parseToJsonElement(it) as JsonObject).also { o -> table = o } } ?: return null
        val parts = host.lowercase().split('.')
        for (i in 0 until parts.size - 1) {
            val hit = t[parts.subList(i, parts.size).joinToString(".")] as? JsonObject ?: continue
            return hit.str("password-rules")?.let { parseRules(it) }
        }
        return null
    }

    fun forRules(r: SiteRules, wanted: Int = 20): String {
        val min = r.minLength ?: 1
        val max = r.maxLength ?: 64
        val length = minOf(maxOf(wanted, min), max)
        val allowed = r.allowed.ifEmpty { LOWER + UPPER + DIGIT + SYMBOL }
        return assemble(maxOf(length, r.required.size), r.required, allowed, r.maxConsecutive)
    }

    fun forSite(host: String?, o: PasswordOptions = PasswordOptions()): String {
        val rules = host?.let { rulesForHost(it) }
        return if (rules != null) forRules(rules, o.length) else password(o)
    }

    /** A rough estimate for the generator's own output: bits of entropy from its options. */
    fun entropyBits(o: PasswordOptions): Int {
        var pool = 0
        fun size(s: String) = if (o.avoidAmbiguous) s.count { it !in AMBIGUOUS } else s.length
        if (o.lower) pool += size(LOWER)
        if (o.upper) pool += size(UPPER)
        if (o.digits) pool += size(DIGIT)
        if (o.symbols) pool += size(SYMBOL)
        return if (pool <= 1) 0 else (o.length * Math.log(pool.toDouble()) / Math.log(2.0)).toInt()
    }
}
