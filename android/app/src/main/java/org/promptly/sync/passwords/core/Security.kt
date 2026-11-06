// The Security check (mirrors health.ts) and its strength estimate, computed on the device.
// All that ever leaves is the first five characters of a password's SHA-1, through your
// server, with padded replies.
//
// Strength is a small port of the approach in zxcvbn: find the parts of a password an
// attacker would try first (common passwords, words, sequences, repeats, keyboard runs,
// dates, your own name), and take the cheapest way to cover it. Its word list is smaller
// than zxcvbn's, so it can call something Fair that zxcvbn calls Weak. The scores use
// zxcvbn's own thresholds, and a test compares them with the web client's on a fixed list.
package org.promptly.sync.passwords.core

import java.security.MessageDigest
import java.time.Instant

data class Strength(val score: Int, val guesses: Double) {
    val label: String get() = LABELS[score]

    companion object {
        val LABELS = listOf("Very weak", "Weak", "Fair", "Good", "Strong")
    }
}

object StrengthCheck {
    /** The most used passwords, in rough order of use. */
    private val COMMON = (
        "123456 password 123456789 12345678 12345 qwerty 1234567 111111 1234567890 123123 abc123 1234 password1 iloveyou 1q2w3e4r 000000 qwerty123 zaq12wsx dragon " +
            "sunshine princess letmein 654321 monkey 27653 1qaz2wsx 123321 qwertyuiop superman asdfghjkl trustno1 baseball football shadow master michael jennifer " +
            "jordan hunter2 hunter ranger buster soccer harley batman andrew tigger charlie robert thomas hockey daniel starwars klaster george computer michelle " +
            "jessica pepper zxcvbnm 555555 fuckyou 121212 maggie 159753 aaaaaa ginger joshua cheese amanda summer love ashley nicole chelsea biteme matthew access " +
            "yankees dallas austin thunder taylor matrix mobilemail minecraft welcome admin login passw0rd p@ssw0rd p@ssword secret freedom whatever nothing internet " +
            "killer hello flower lovely 7777777 888888 666666 112233 google samsung apple pokemon naruto liverpool arsenal chelsea cookie orange purple secret123 " +
            "welcome1 admin123 root toor changeme test test123 guest default qazwsx asdf1234 abcd1234 a1b2c3 abc passwd pass correct horse battery staple " +
            "mypassword mypass london paris berlin madrid rome tokyo sydney melbourne brisbane perth auckland toronto chicago boston seattle houston miami " +
            "john james david william richard joseph christopher sarah emma olivia sophia emily hannah laura anna maria lisa kevin brian steven peter paul mark " +
            "scott eric adam alex sam ben jack harry oliver lucas liam noah jacob ethan"
        ).split(' ').filter { it.isNotEmpty() }.distinct()

    private val COMMON_RANK: Map<String, Int> = COMMON.withIndex().associate { (i, w) -> w to i + 1 }

    private val KEYBOARD = listOf("qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890", "qazwsxedcrfvtgbyhnujmikolp", "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p", "!@#$%^&*()")
    private val LEET = mapOf('4' to 'a', '@' to 'a', '8' to 'b', '(' to 'c', '3' to 'e', '6' to 'g', '1' to 'i', '!' to 'i', '|' to 'i', '0' to 'o', '$' to 's', '5' to 's', '7' to 't', '+' to 't', '2' to 'z')

    private const val MIN_GUESSES_SINGLE = 10.0
    private const val MIN_GUESSES_MULTI = 50.0
    private const val BRUTEFORCE = 10.0

    private fun caseFactor(part: String): Double {
        val uppers = part.count { it.isUpperCase() }
        val lowers = part.count { it.isLowerCase() }
        if (uppers == 0) return 1.0
        if (lowers == 0 || (uppers == 1 && (part.first().isUpperCase() || part.last().isUpperCase()))) return 2.0
        var ways = 0.0
        for (i in 1..minOf(uppers, lowers)) ways += choose(uppers + lowers, i)
        return maxOf(ways, 2.0)
    }

    private fun choose(n: Int, k: Int): Double {
        var r = 1.0
        for (i in 1..k) r = r * (n - k + i) / i
        return r
    }

    private fun wordRank(lower: String, inputs: Map<String, Int>): Int? {
        inputs[lower]?.let { return it }
        COMMON_RANK[lower]?.let { return it }
        val list = runCatching { WORDS() }.getOrNull() ?: return null
        return if (lower in list) 2000 else null
    }

    /** A rank stands for how many guesses it takes. EFF's list has no order, so its words
     *  all count the same: about as hard as a mid-table word in zxcvbn's lists. */
    @Volatile
    private var wordSet: Set<String>? = null

    private fun WORDS(): Set<String> = wordSet ?: Wordlist.words.toHashSet().also { wordSet = it }

    private fun unleet(s: String): String? {
        if (s.none { it in LEET }) return null
        return buildString { for (c in s) append(LEET[c] ?: c) }
    }

    /** The cheapest way an attacker would cover [i, j), or null if nothing special fits. */
    private fun matchGuesses(pw: String, i: Int, j: Int, inputs: Map<String, Int>): Double? {
        val part = pw.substring(i, j)
        val lower = part.lowercase()
        val n = part.length
        var best: Double? = null
        fun offer(g: Double) {
            if (best == null || g < best!!) best = g
        }
        if (n >= 3 || lower in inputs) {
            wordRank(lower, inputs)?.let { offer(it * caseFactor(part)) }
            wordRank(lower.reversed(), inputs)?.let { offer(it * caseFactor(part) * 2) }
            unleet(lower)?.let { clean -> wordRank(clean, inputs)?.let { offer(it * caseFactor(part) * 4.0) } }
        }
        if (n >= 3) {
            // abc, 321, aceg: a constant step.
            val step = part[1] - part[0]
            if (kotlin.math.abs(step) in 1..5 && (1 until n).all { part[it] - part[it - 1] == step }) {
                val base = when {
                    part[0] in "aAzZ019" -> 4.0
                    part[0].isDigit() -> 10.0
                    else -> 26.0
                }
                offer(base * n * (if (step < 0) 2 else 1))
            }
            // A keyboard run, either way along a row.
            for (row in KEYBOARD) {
                if (row.contains(lower) || row.reversed().contains(lower)) offer(50.0 * n * (if (part != lower) 2 else 1))
            }
            // A repeated block: aaaa, abab.
            for (len in 1..n / 2) {
                if (n % len == 0 && part == part.substring(0, len).repeat(n / len)) {
                    val blockGuesses = if (len == 1) 10.0 else minGuesses(part.substring(0, len), inputs)
                    offer(blockGuesses * (n / len))
                }
            }
        }
        // Years and dates.
        if (n == 4 && part.all { it.isDigit() } && part.toInt() in 1900..2049) offer(maxOf(kotlin.math.abs(part.toInt() - 2026), 20).toDouble())
        if ((n == 6 || n == 8) && part.all { it.isDigit() }) {
            val hit = if (n == 8) listOf(part.substring(0, 2) to part.substring(2, 4), part.substring(4, 6) to part.substring(6, 8)) else listOf(part.substring(0, 2) to part.substring(2, 4), part.substring(2, 4) to part.substring(4, 6))
            if (hit.any { (a, b) -> (a.toInt() in 1..31 && b.toInt() in 1..12) || (a.toInt() in 1..12 && b.toInt() in 1..31) }) offer(365.0 * 100)
        }
        return best?.let { maxOf(it, if (n == 1) MIN_GUESSES_SINGLE else MIN_GUESSES_MULTI) }
    }

    /** zxcvbn's search: fewest guesses across every way to split the password, with a cost
     *  for each extra part. Bruteforce is 10 per character, whatever the characters. */
    private fun minGuesses(pw: String, inputs: Map<String, Int>): Double {
        val n = pw.length
        if (n == 0) return 1.0
        // best[j][k]: fewest guesses to cover the first j characters with k parts.
        val maxParts = minOf(n, 8)
        val best = Array(n + 1) { DoubleArray(maxParts + 1) { Double.POSITIVE_INFINITY } }
        best[0][0] = 1.0
        for (j in 1..n) {
            for (i in maxOf(0, j - 32) until j) {
                val whole = Math.pow(BRUTEFORCE, (j - i).toDouble()).let { if (j - i == 1) MIN_GUESSES_SINGLE else maxOf(it, MIN_GUESSES_MULTI) }
                val g = minOf(matchGuesses(pw, i, j, inputs) ?: whole, whole)
                for (k in 1..maxParts) {
                    val prior = best[i][k - 1]
                    if (prior != Double.POSITIVE_INFINITY && prior * g < best[j][k]) best[j][k] = prior * g
                }
            }
        }
        var out = Double.POSITIVE_INFINITY
        var fact = 1.0
        for (k in 1..maxParts) {
            fact *= k
            val g = best[n][k]
            if (g == Double.POSITIVE_INFINITY) continue
            out = minOf(out, fact * g + Math.pow(10000.0, (k - 1).toDouble()))
        }
        return out
    }

    fun check(password: String, inputs: List<String> = emptyList()): Strength {
        val pw = password.take(100)
        if (pw.isEmpty()) return Strength(0, 1.0)
        val mine = HashMap<String, Int>()
        for ((i, s) in inputs.withIndex()) {
            for (w in s.lowercase().split(Regex("[^\\p{L}\\p{N}]+"))) if (w.length >= 3 && w !in mine) mine[w] = i + 1
            val whole = s.lowercase()
            if (whole.length >= 3 && whole !in mine) mine[whole] = i + 1
        }
        val g = minGuesses(pw, mine)
        val score = when {
            g < 1e3 + 5 -> 0
            g < 1e6 + 5 -> 1
            g < 1e8 + 5 -> 2
            g < 1e10 + 5 -> 3
            else -> 4
        }
        return Strength(score, g)
    }
}

class HealthReport(
    val weak: List<Item>,
    val reused: List<List<Item>>,
    val old: List<Item>,
    val http: List<Item>,
    val breached: List<Pair<Item, Int>>,
    /** Saved with no 2FA, on a site the directory says supports it. The doc is its how-to. */
    val no2fa: List<Pair<Item, String?>>,
    /** Saved with no 2FA, on a site the directory says nothing about. */
    val noTotp: List<Item>,
    val checked: Int,
    /** The breach service couldn't be asked, or it's off on this server. */
    val breachSkipped: String?,
    /** Saved with no passkey, on a site the directory says supports them. */
    val noPasskey: List<Item> = emptyList(),
) {
    val reusedCount: Int get() = reused.sumOf { it.size }
}

/** The only thing about a vault that goes to the Today card. Counts, never names. */
data class CoarseCounts(val weak: Int, val reused: Int, val breached: Int, val old: Int)

object Health {
    fun coarseCounts(r: HealthReport) = CoarseCounts(r.weak.size, r.reused.sumOf { it.size }, r.breached.size, r.old.size)

    private const val OLD_MS = 365L * 24 * 3600 * 1000
    private val LOCAL_HTTP = Regex("^http://(localhost|127\\.|192\\.168\\.|10\\.|\\[?::1)")

    fun sha1Hex(s: String): String = hex(MessageDigest.getInstance("SHA-1").digest(utf8(s))).uppercase()

    /** Padding entries come back with a count of 0 and are ignored. */
    fun breachCount(password: String, range: (String) -> String): Int {
        val h = sha1Hex(password)
        val suffix = h.substring(5)
        for (line in range(h.substring(0, 5)).lineSequence()) {
            val parts = line.trim().split(':')
            if (parts.size == 2 && parts[0] == suffix) return parts[1].toIntOrNull() ?: 0
        }
        return 0
    }

    fun supports2fa(host: String, dir: Map<String, String?>): Boolean {
        val d = Match.baseDomain(host) ?: host
        return d in dir || host in dir
    }

    fun run(
        items: Collection<Item>,
        range: ((String) -> String)? = null,
        twofa: Map<String, String?> = emptyMap(),
        now: Long = System.currentTimeMillis(),
        passkeys: Set<String> = emptySet(),
        onProgress: (Int, Int) -> Unit = { _, _ -> },
    ): HealthReport {
        val logins = items.filter { it.body.kind == "login" && !it.body.password.isNullOrEmpty() && !it.deleted && !it.body.archived }
        val reused = logins.groupBy { it.body.password!! }.values.filter { it.size > 1 }
        val weak = ArrayList<Item>()
        val old = ArrayList<Item>()
        val http = ArrayList<Item>()
        val no2fa = ArrayList<Pair<Item, String?>>()
        val noTotp = ArrayList<Item>()
        val noPasskey = ArrayList<Item>()
        val strength = HashMap<String, Int>()
        for ((done, i) in logins.withIndex()) {
            val pw = i.body.password!!
            val s = strength.getOrPut(pw) { StrengthCheck.check(pw, listOf(i.body.username ?: "", i.body.title)).score }
            if (s <= 1) weak += i
            val changed = i.body.str("passwordChangedAt") ?: i.body.str("createdAt")
            val at = changed?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
            if (at != null && now - at > OLD_MS) old += i
            if (i.body.urls.any { it.url.startsWith("http://") && !LOCAL_HTTP.containsMatchIn(it.url) }) http += i
            val host = i.body.urls.firstOrNull()?.url?.let { Match.hostOf(it) }
            if (i.body.totp == null) {
                if (host != null && supports2fa(host, twofa)) {
                    val d = Match.baseDomain(host) ?: host
                    no2fa += i to (twofa[d] ?: twofa[host])
                } else {
                    noTotp += i
                }
            }
            if (host != null && i.body.passkeys.isEmpty() && (Match.baseDomain(host) ?: host) in passkeys) noPasskey += i
            onProgress(done + 1, logins.size)
        }
        val breached = ArrayList<Pair<Item, Int>>()
        var skipped: String? = null
        if (range != null) {
            val seen = HashMap<String, Int>()
            try {
                for (i in logins) {
                    val pw = i.body.password!!
                    val c = seen.getOrPut(pw) { breachCount(pw, range) }
                    if (c > 0) breached += i to c
                }
            } catch (e: ApiError) {
                skipped = e.detail ?: "The breach check didn't work."
            } catch (e: OfflineError) {
                skipped = "The server can't be reached, so breaches weren't checked."
            }
        } else {
            skipped = "Breaches weren't checked."
        }
        return HealthReport(weak, reused, old, http, breached, no2fa, noTotp, logins.size, skipped, noPasskey)
    }
}
