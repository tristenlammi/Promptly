// Which vaults are really this person's, and who their emergency contacts are, decided on their
// own devices. The Kotlin twin of ownership.ts. See CRYPTO_SPEC.md section 6 ("Your own vault").
package org.promptly.sync.passwords.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

object Ownership {
    /** "This vault is my own", signed with the identity key and bound to the vault's id. */
    fun homeInput(userId: String, vaultId: String): ByteArray = signingInput("personal_vault", listOf(utf8(userId), utf8(vaultId)))

    fun signHome(ed25519Seed: ByteArray, userId: String, vaultId: String): String = b64u(Primitives.ed25519Sign(ed25519Seed, homeInput(userId, vaultId)))

    fun verifyHome(sig: String?, userId: String, vaultId: String, ed25519Pub: ByteArray): Boolean {
        if (sig.isNullOrEmpty()) return false
        return runCatching { Primitives.ed25519Verify(fromB64u(sig), homeInput(userId, vaultId), ed25519Pub) }.getOrDefault(false)
    }

    // Per emergency contact: odd means named, even means removed, and the higher number wins, so a
    // removal on one device isn't undone by another device's older list.

    fun counters(e: JsonElement?): Map<String, Int> = (e as? JsonObject)?.mapNotNull { (k, v) ->
        (v as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toDoubleOrNull()?.takeIf { it.isFinite() && it > 0 }?.let { k to it.toInt() }
    }?.toMap() ?: emptyMap()

    fun merge(into: MutableMap<String, Int>, from: Map<String, Int>) {
        for ((k, n) in from) if (n > 0) into[k] = maxOf(into[k] ?: 0, n)
    }

    /** A contact from a plain list with no counter is an old entry: named, once. */
    fun withListed(into: MutableMap<String, Int>, listed: Collection<String>) {
        for (id in listed) into.putIfAbsent(id, 1)
    }

    fun isNamed(state: Map<String, Int>, id: String) = (state[id] ?: 0) % 2 == 1

    fun named(state: Map<String, Int>): List<String> = state.keys.filter { isNamed(state, it) }.sorted()

    fun name(state: MutableMap<String, Int>, id: String) {
        val n = state[id] ?: 0
        if (n % 2 == 0) state[id] = n + 1
    }

    fun remove(state: MutableMap<String, Int>, id: String) {
        val n = state[id] ?: 1
        state[id] = if (n % 2 == 1) n + 1 else n
    }
}

/** Synced beside the trust book, in the same item: older clients rebuild `trustBook` from the
 *  fields they know and would drop anything new in it. The same JSON as `TrustState` in
 *  ownership.ts. */
class TrustState(
    val contacts: MutableMap<String, Int> = java.util.concurrent.ConcurrentHashMap(),
    val made: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet(),
    val shared: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet(),
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("contacts", JsonObject(contacts.toSortedMap().mapValues { JsonPrimitive(it.value) }))
        put("made", TrustBook.stringArray(made.sorted()))
        put("shared", TrustBook.stringArray(shared.sorted()))
    }

    /** Adds what `e` holds to this one. */
    fun absorb(e: JsonElement?) {
        val o = e as? JsonObject ?: return
        Ownership.merge(contacts, Ownership.counters(o["contacts"]))
        made += TrustBook.strings(o["made"])
        shared += TrustBook.strings(o["shared"])
    }
}
