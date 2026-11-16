// One proof per passkey (A74 and D138, replacing A72 on Android and D86's "PIN every time" there): which
// single thing a person is asked for before a passkey is used or made, or a login marked "ask
// again" is handed over. Pure, so the rule is tested on the JVM.
package org.promptly.sync.passwords.core

/** How someone just showed it was them. */
enum class ProofKind {
    /** A strong biometric that opened what's sealed under the Keystore key. */
    BIOMETRIC,

    /** The master password. */
    MASTER,
}

/** What to ask for next. */
enum class ProofAsk {
    /** A proof was given a moment ago, in this same request: ask for nothing more. */
    NOTHING,

    /** One biometric. Its fallback is the passkey PIN, or the master password for an "ask again" item. */
    BIOMETRIC,

    /** The passkey PIN: the vault's already open and this phone has no biometric unlock. */
    PIN,

    /** The master password: an "ask again" item on a phone with no biometric unlock. */
    MASTER,
}

object PasskeyProof {
    /**
     * `just`: a biometric or the master password given moments ago for this same request (it
     * unlocked the vault). `biometricReady`: biometric unlock is set up on this phone, usable right
     * now, and the vault isn't locked out by wrong PINs. `reprompt`: the item is marked "ask again".
     *
     * Never two asks: the proof that opened the vault is the proof. A PIN never stands in for
     * "ask again", which wants a biometric or the master password.
     */
    fun next(just: ProofKind?, biometricReady: Boolean, reprompt: Boolean): ProofAsk = when {
        just != null -> ProofAsk.NOTHING
        biometricReady -> ProofAsk.BIOMETRIC
        reprompt -> ProofAsk.MASTER
        else -> ProofAsk.PIN
    }
}

/**
 * A proof given on Credential Manager's "Unlock Passwords" step, kept in memory for the pick that
 * follows it. Picking the passkey opens a new window; without this it would ask again, which is
 * the "unlock, then the PIN" people met.
 *
 * It's for one use, by the app that asked, for a site named in that same request, and for a
 * minute. A lock throws it away.
 */
class ProofGrants(private val lifeMs: Long = 60_000L) {
    private data class Grant(val kind: ProofKind, val pkg: String?, val rpIds: Set<String>, val passwords: Boolean, val until: Long)

    private var held: Grant? = null

    @Synchronized
    fun give(kind: ProofKind, pkg: String?, rpIds: Collection<String>, passwords: Boolean, now: Long) {
        held = Grant(kind, pkg, rpIds.toSet(), passwords, now + lifeMs)
    }

    /** For a passkey of `rpId`, or (rpId null) a saved password. Gone once taken, right or wrong app. */
    @Synchronized
    fun take(pkg: String, rpId: String?, now: Long): ProofKind? {
        val g = held ?: return null
        held = null
        if (now >= g.until) return null
        // The app has to be the one that asked. A request that didn't say who asked proves nothing.
        if (g.pkg == null || g.pkg != pkg) return null
        val covered = if (rpId == null) g.passwords else rpId in g.rpIds
        return if (covered) g.kind else null
    }

    @Synchronized
    fun clear() {
        held = null
    }

    @get:Synchronized
    val waiting: Boolean get() = held != null
}
