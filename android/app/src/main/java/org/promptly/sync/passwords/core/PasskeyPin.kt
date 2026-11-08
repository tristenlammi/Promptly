// The passkey PIN: asked before every passkey sign-in and every new passkey (DECISIONS D86).
// Mirrors passkeypin.ts, so a PIN set on one client works on all. One per account, synced: only a
// verifier is kept, in a "prefs" system item in the personal vault, encrypted like any item. It's
// a check that the person is there and means it while the vault is unlocked, not encryption.
// Wrong tries are counted on this phone, in the vault's local store, where no app or page can
// reach them.
package org.promptly.sync.passwords.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

data class PinVerifier(val kdf: KdfParams, val salt: String, val check: String, val setAt: String) {
    fun toJson(): JsonObject = JsonObject(linkedMapOf(
        "v" to JsonPrimitive(1),
        "kdf" to JsonObject(linkedMapOf("alg" to JsonPrimitive(kdf.alg), "m" to JsonPrimitive(kdf.m), "t" to JsonPrimitive(kdf.t), "p" to JsonPrimitive(kdf.p))),
        "salt" to JsonPrimitive(salt),
        "check" to JsonPrimitive(check),
        "setAt" to JsonPrimitive(setAt),
    ))
}

sealed class PinCheck {
    data object Ok : PinCheck()
    /** `left` 0 means locked out: the caller locks the vault. */
    data class Wrong(val left: Int) : PinCheck()
}

object PasskeyPin {
    const val MIN = 4
    const val MAX = 12
    /** Wrong PINs in a row before the vault locks and needs the master password. */
    const val TRIES = 5
    /** The system item's title. Its kind is "prefs", so every client already hides it. */
    const val TITLE = "passkey-pin"
    /** Where this phone counts wrong tries. Never synced. */
    const val TRIES_META = "passkey_pin_tries"
    private const val INFO = "promptly-pw/v1/passkey-pin"
    const val LOCKED_TEXT = "Five wrong passkey PINs in a row, so your vault is locked. Unlock it with your master password."

    /** Ones people pick first. Runs, repeats and patterns are caught by the rules below. */
    private val COMMON = setOf("2580", "0852", "8520", "0258", "1004", "2000", "6969", "1122", "2468", "1357", "5683", "1998", "1999", "2001", "1984")

    /** Why a PIN can't be used, or null if it can. Same words as the web and the extension. */
    fun problem(pin: String): String? {
        if (pin.length !in MIN..MAX || pin.any { it !in '0'..'9' }) return "Use $MIN to $MAX digits."
        if (pin in COMMON || isRun(pin) || isRepeat(pin)) return "That PIN is too easy to guess. Try another."
        return null
    }

    /** 1234, 6789, 8901, 4321, 0987: each digit one up, or one down, from the last. */
    private fun isRun(pin: String): Boolean {
        val steps = (1 until pin.length).map { ((pin[it] - pin[it - 1]) + 10) % 10 }.toSet()
        return steps.size == 1 && (1 in steps || 9 in steps)
    }

    /** 0000, 1212, 123123, 4545: a shorter group said again and again. */
    private fun isRepeat(pin: String): Boolean =
        (1..pin.length / 2).any { n -> pin.length % n == 0 && pin.substring(0, n).repeat(pin.length / n) == pin }

    private fun checkValue(pin: String, salt: ByteArray, kdf: KdfParams): ByteArray {
        val stretched = Primitives.argon2(utf8(pin), salt, kdf)
        try {
            return Primitives.hkdf(stretched, salt, INFO)
        } finally {
            stretched.fill(0)
        }
    }

    fun make(pin: String, kdf: KdfParams = KdfParams.FLOOR, salt: ByteArray = randomBytes(16), setAt: String = isoNow()): PinVerifier {
        problem(pin)?.let { throw IllegalArgumentException(it) }
        checkKdf(kdf)
        return PinVerifier(kdf, b64u(salt), b64u(checkValue(pin, salt, kdf)), setAt)
    }

    /** Only what our clients write. Anything else counts as no PIN, never as a match. */
    fun read(raw: Any?): PinVerifier? {
        val o = raw as? JsonObject ?: return null
        if ((o["v"] as? JsonPrimitive)?.intOrNull != 1) return null
        val salt = o.str("salt") ?: return null
        val check = o.str("check") ?: return null
        val setAt = o.str("setAt") ?: return null
        val k = o["kdf"] as? JsonObject ?: return null
        val kdf = KdfParams(k.str("alg") ?: return null, k.int("m") ?: return null, k.int("t") ?: return null, k.int("p") ?: return null)
        return runCatching {
            checkKdf(kdf)
            if (fromB64u(salt).size < 16 || fromB64u(check).size != 32) return null
            PinVerifier(kdf, salt, check, setAt)
        }.getOrNull()
    }

    fun matches(v: PinVerifier, typed: String): Boolean {
        if (typed.isEmpty() || typed.length > 64 || typed.any { it !in '0'..'9' }) return false
        return equalBytes(checkValue(typed, fromB64u(v.salt), v.kdf), fromB64u(v.check))
    }

    /** The personal vault's only: a member of a shared vault could plant one anywhere else. Two
     *  phones can each set one while offline, and then the newest counts. */
    fun itemsOf(items: Collection<Item>, personalVaultId: String): List<Item> =
        items.filter { it.vaultId == personalVaultId && !it.deleted && it.body.kind == "prefs" && it.body.title == TITLE && read(it.body["passkeyPin"]) != null }
            .sortedByDescending { read(it.body["passkeyPin"])!!.setAt }

    fun verifierOf(items: Collection<Item>, personalVaultId: String): PinVerifier? =
        itemsOf(items, personalVaultId).firstOrNull()?.let { read(it.body["passkeyPin"]) }

    fun of(client: VaultClient): PinVerifier? {
        if (!client.unlocked) return null
        val personal = runCatching { client.personalVaultId() }.getOrNull() ?: return null
        return verifierOf(client.allItems(includeSystem = true), personal)
    }

    /** Saves a new verifier over the old one, and syncs if it can. Checking who's asking is the caller's job. */
    fun save(client: VaultClient, v: PinVerifier) {
        val personal = client.personalVaultId()
        val rows = itemsOf(client.allItems(includeSystem = true), personal)
        if (rows.isEmpty()) client.saveNew(personal, newBody("prefs", TITLE, "passkeyPin" to v.toJson()))
        // Copies from two offline phones: one is enough.
        for (row in rows) client.update(row.id, row.body.with("passkeyPin" to v.toJson()))
        runCatching { client.sync() }
    }

    // ---- Counting wrong tries ----

    fun tries(store: LocalStore): Int {
        val n = (store.getMeta(TRIES_META) as? JsonPrimitive)?.intOrNull ?: return 0
        return n.coerceIn(0, TRIES)
    }

    /** Five wrong in a row: until the master password is typed, nothing shorter unlocks here. */
    fun lockedOut(store: LocalStore): Boolean = tries(store) >= TRIES

    fun clearTries(store: LocalStore) = store.deleteMeta(TRIES_META)

    private val lock = Any()

    /** Counts the try before checking it, so stopping the check halfway can't save a guess, and
     *  takes one at a time. A right PIN puts the count back to nought. */
    fun check(store: LocalStore, v: PinVerifier, typed: String): PinCheck = synchronized(lock) {
        val before = tries(store)
        if (before >= TRIES) return PinCheck.Wrong(0)
        store.setMeta(TRIES_META, JsonPrimitive(before + 1))
        if (matches(v, typed)) {
            clearTries(store)
            PinCheck.Ok
        } else {
            PinCheck.Wrong(TRIES - (before + 1))
        }
    }

    fun triesText(left: Int): String =
        if (left <= 1) "That PIN isn't right. One more wrong and your vault locks." else "That PIN isn't right. $left tries left."
}
