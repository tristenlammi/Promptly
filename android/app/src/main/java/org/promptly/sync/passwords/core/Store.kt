// The encrypted offline copy. Only ciphertext, wrapped keys and bookkeeping go in here,
// never a decrypted field. Mirrors store.ts. Android's copy is PasswordsDb (SQLite).
package org.promptly.sync.passwords.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class CachedAccount(
    val accountId: String,
    val userId: String,
    val kdf: KdfParams,
    val salt: String,
    val wrappedKeyset: String,
    val x25519Pub: String,
    val ed25519Pub: String,
    val kitConfirmed: Boolean,
    val kitCheckedAt: String?,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("accountId", accountId)
        put("userId", userId)
        put("kdf", kdfJson(kdf))
        put("salt", salt)
        put("wrappedKeyset", wrappedKeyset)
        put("x25519Pub", x25519Pub)
        put("ed25519Pub", ed25519Pub)
        put("kitConfirmed", kitConfirmed)
        put("kitCheckedAt", kitCheckedAt)
    }

    companion object {
        fun from(o: JsonObject) = CachedAccount(
            o.str("accountId")!!, o.str("userId")!!, parseKdf(o["kdf"])!!, o.str("salt")!!, o.str("wrappedKeyset")!!,
            o.str("x25519Pub")!!, o.str("ed25519Pub")!!, o.bool("kitConfirmed") ?: false, o.str("kitCheckedAt"),
        )
    }
}

fun kdfJson(k: KdfParams): JsonObject = buildJsonObject {
    put("alg", k.alg)
    put("m", k.m)
    put("t", k.t)
    put("p", k.p)
}

fun parseKdf(e: JsonElement?): KdfParams? {
    val o = e as? JsonObject ?: return null
    return KdfParams(o.str("alg") ?: return null, o.int("m") ?: return null, o.int("t") ?: return null, o.int("p") ?: return null)
}

data class CachedVault(
    val id: String,
    val kind: String,
    val revision: Int,
    /** The highest revision this device has ever seen. A lower one from the server
     *  is a rollback, and raises a warning instead of being accepted. */
    val highWater: Int,
    val generation: Int,
    val name: String,
    val role: String,
    val wrappedKey: String,
    val signature: String,
    val grantedBy: String?,
    val memberGeneration: Int,
    val accepted: Boolean,
    val memberCount: Int,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("kind", kind)
        put("revision", revision)
        put("highWater", highWater)
        put("generation", generation)
        put("name", name)
        put("role", role)
        put("wrappedKey", wrappedKey)
        put("signature", signature)
        put("grantedBy", grantedBy)
        put("memberGeneration", memberGeneration)
        put("accepted", accepted)
        put("memberCount", memberCount)
    }

    companion object {
        fun from(o: JsonObject) = CachedVault(
            o.str("id")!!, o.str("kind")!!, o.int("revision") ?: 0, o.int("highWater") ?: 0, o.int("generation") ?: 1,
            o.str("name") ?: "", o.str("role") ?: "view", o.str("wrappedKey") ?: "", o.str("signature") ?: "", o.str("grantedBy"),
            o.int("memberGeneration") ?: 1, o.bool("accepted") ?: false, o.int("memberCount") ?: 1,
        )
    }
}

data class CachedItem(
    val id: String,
    val vaultId: String,
    val revision: Int,
    val blob: String?,
    val deleted: Boolean,
    val purged: Boolean,
    val updatedAt: String,
    /** Local edits not yet on the server. */
    val dirty: Boolean = false,
    /** The blob this edit started from, for a three-way merge. */
    val baseBlob: String? = null,
    val purgeRequested: Boolean = false,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("vaultId", vaultId)
        put("revision", revision)
        put("blob", blob)
        put("deleted", deleted)
        put("purged", purged)
        put("updatedAt", updatedAt)
        put("dirty", dirty)
        put("baseBlob", baseBlob)
        put("purgeRequested", purgeRequested)
    }

    companion object {
        fun from(o: JsonObject) = CachedItem(
            o.str("id")!!, o.str("vaultId")!!, o.int("revision") ?: 0, o.str("blob"), o.bool("deleted") ?: false, o.bool("purged") ?: false,
            o.str("updatedAt") ?: "", o.bool("dirty") ?: false, o.str("baseBlob"), o.bool("purgeRequested") ?: false,
        )
    }
}

interface LocalStore {
    fun getMeta(key: String): JsonElement?
    fun setMeta(key: String, value: JsonElement)
    fun deleteMeta(key: String)
    fun getAccount(): CachedAccount?
    fun putAccount(a: CachedAccount)
    fun getVaults(): List<CachedVault>
    fun putVault(v: CachedVault)
    fun deleteVault(id: String)
    fun getItems(vaultId: String): List<CachedItem>
    fun getItem(id: String): CachedItem?
    fun putItems(items: List<CachedItem>)
    fun deleteItem(id: String)
    fun clear()
}

class MemoryStore : LocalStore {
    private val meta = HashMap<String, JsonElement>()
    private var account: CachedAccount? = null
    private val vaults = LinkedHashMap<String, CachedVault>()
    private val items = LinkedHashMap<String, CachedItem>()
    @Synchronized override fun getMeta(key: String) = meta[key]
    @Synchronized override fun setMeta(key: String, value: JsonElement) { meta[key] = value }
    @Synchronized override fun deleteMeta(key: String) { meta.remove(key) }
    @Synchronized override fun getAccount() = account
    @Synchronized override fun putAccount(a: CachedAccount) { account = a }
    @Synchronized override fun getVaults() = vaults.values.toList()
    @Synchronized override fun putVault(v: CachedVault) { vaults[v.id] = v }
    @Synchronized override fun deleteVault(id: String) {
        vaults.remove(id)
        items.values.removeAll { it.vaultId == id }
    }
    @Synchronized override fun getItems(vaultId: String) = items.values.filter { it.vaultId == vaultId }
    @Synchronized override fun getItem(id: String) = items[id]
    @Synchronized override fun putItems(items: List<CachedItem>) { for (i in items) this.items[i.id] = i }
    @Synchronized override fun deleteItem(id: String) { items.remove(id) }
    @Synchronized override fun clear() {
        meta.clear()
        account = null
        vaults.clear()
        items.clear()
    }
}

/** Holds the Secret Key at rest: the Android Keystore on a phone, memory in tests. */
interface SecretKeeper {
    fun save(raw: ByteArray)
    fun load(): ByteArray?
    fun has(): Boolean
    fun clear()
}

class MemoryKeeper : SecretKeeper {
    private var value: ByteArray? = null
    override fun save(raw: ByteArray) { value = raw.copyOf() }
    override fun load() = value?.copyOf()
    override fun has() = value != null
    override fun clear() { value = null }
}

internal fun jsonOrNull(s: String?): JsonElement = if (s == null) JsonNull else JsonPrimitive(s)
