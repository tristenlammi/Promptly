// The vault client: the Kotlin twin of vault.ts. No Android imports. Keys live in this
// object's memory only; lock() drops them. See CRYPTO_SPEC.md. Writes hold the object's
// lock, and reads are lock-free so a sync can't stall a screen or an autofill answer.
package org.promptly.sync.passwords.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

data class SyncResult(var pulled: Int = 0, var pushed: Int = 0, var conflicts: Int = 0, var offline: Boolean = false, val rollback: MutableList<String> = ArrayList())

data class TrustEntry(val x25519: String, val ed25519: String, val firstSeen: String, val verified: Boolean = false, val username: String? = null)

class WrongPasswordError : Exception("That master password or Secret Key isn't right")

class KeyChangedError(val userId: String, val username: String) : Exception("$username's keys have changed since you last shared with them")

class VaultClient(val api: VaultApi, val store: LocalStore, val keeper: SecretKeeper, val platform: String = "android") {
    private class Unlocked(
        val keyset: Keyset,
        @Volatile var authKey: ByteArray,
        val unlockKey: ByteArray,
        val userId: String,
        val accountId: String,
    ) {
        val vaultKeys = ConcurrentHashMap<String, ByteArray>()
        val items = ConcurrentHashMap<String, Item>()
        val search = ConcurrentHashMap<String, String>()
    }

    @Volatile
    private var state: Unlocked? = null

    /** Called after anything changes what the vault holds (the autofill index listens). */
    @Volatile
    var onChange: (() -> Unit)? = null

    @Volatile
    var serverTimeOffsetMs = 0L

    @Volatile
    var lastSyncAt: Long? = null

    @Volatile
    var preview = true

    val rollbackWarnings: MutableList<String> = java.util.Collections.synchronizedList(ArrayList())
    val undecryptable: MutableSet<String> = ConcurrentHashMap.newKeySet()

    val unlocked: Boolean get() = state != null
    val userId: String? get() = state?.userId

    private fun need(): Unlocked = state ?: throw IllegalStateException("The vault is locked")

    // ---- Setup and unlock ----

    /** Create the account. Returns the Secret Key's raw bytes for the recovery kit. */
    @Synchronized
    fun setup(password: String, kdf: KdfParams = KdfParams.FLOOR): ByteArray {
        val secretKey = randomBytes(16)
        val salt = randomBytes(16)
        val accountId = randomUuid()
        val vaultId = randomUuid()
        val root = deriveRoot(password, secretKey, salt, kdf)
        val keyset = Keyset.random()
        val vaultKey = randomBytes(32)
        // The grant is bound to the user id, which prelogin tells us.
        val userId = api.prelogin().userId
        val grant = grantVaultKey(userId, keyset, vaultId, userId, keyset.x25519Pub, 1, vaultKey)
        val session = api.createAccount(buildJsonObject {
            put("account_id", accountId)
            put("kdf", kdfJson(kdf))
            put("salt", b64u(salt))
            put("auth_key", b64u(root.auth))
            put("wrapped_keyset", b64u(wrapKeyset(root.unlock, accountId, keyset)))
            put("x25519_pub", b64u(keyset.x25519Pub))
            put("ed25519_pub", b64u(keyset.ed25519Pub))
            put("personal_vault_id", vaultId)
            put("personal_vault_name", sealField(vaultKey, vaultId, "name", JsonPrimitive("Personal")))
            put("personal_vault_grant", buildJsonObject {
                put("wrapped_key", b64u(grant.wrapped))
                put("signature", b64u(grant.signature))
            })
        })
        api.session = session.token
        keeper.save(secretKey)
        cacheAccount(session)
        state = Unlocked(keyset, root.auth, root.unlock, userId, accountId)
        sync()
        return secretKey
    }

    private fun cacheAccount(s: SessionOut) {
        val prev = store.getAccount()
        // A different account signed in on this device: don't mix their data.
        if (prev != null && prev.accountId != s.accountId) store.clear()
        store.putAccount(CachedAccount(s.accountId, s.userId, s.kdf, s.salt, s.wrappedKeyset, s.x25519Pub, s.ed25519Pub, s.kitConfirmed, s.kitCheckedAt))
    }

    class UnlockResult(val offline: Boolean, val secret: ByteArray?)

    /** Unlock with the master password. Online, this also proves auth_key for a session;
     *  offline, the local copy opens with no server at all. */
    @Synchronized
    fun unlock(password: String, secretKeyOverride: ByteArray? = null, keepSecret: Boolean = false): UnlockResult {
        val secretKey = secretKeyOverride ?: keeper.load() ?: throw IllegalStateException("This device doesn't have your Secret Key yet")
        var cached = store.getAccount()
        var kdf = cached?.kdf
        var salt = cached?.salt
        var offline = false
        try {
            val pre = api.prelogin()
            serverTimeOffsetMs = runCatching { Instant.parse(pre.serverTime).toEpochMilli() - System.currentTimeMillis() }.getOrDefault(0L)
            preview = pre.preview
            if (!pre.exists) throw IllegalStateException("There's no vault on this account yet")
            if (pre.kdf != null && pre.salt != null) {
                kdf = pre.kdf
                salt = pre.salt
            }
        } catch (e: OfflineError) {
            offline = true
        } catch (e: ApiError) {
            if (e.status < 500) throw e
            offline = true
        }
        if (kdf == null || salt == null) throw IllegalStateException("This device has no offline copy, and the server can't be reached")
        val raw = deriveRoot(password, secretKey, fromB64u(salt), kdf)
        if (!offline) {
            try {
                val session = api.createSession(b64u(raw.auth))
                api.session = session.token
                cacheAccount(session)
                cached = store.getAccount()
            } catch (e: ApiError) {
                if (e.status == 401) throw WrongPasswordError()
                throw e
            } catch (e: OfflineError) {
                offline = true
            }
        }
        val account = cached ?: throw IllegalStateException("This device has no offline copy, and the server can't be reached")
        val keyset = try {
            unwrapKeyset(raw.unlock, account.accountId, fromB64u(account.wrappedKeyset))
        } catch (e: java.security.GeneralSecurityException) {
            throw WrongPasswordError()
        }
        if (secretKeyOverride != null) keeper.save(secretKey)
        state = Unlocked(keyset, raw.auth, raw.unlock, account.userId, account.accountId)
        loadLocal()
        if (!offline) sync()
        return UnlockResult(offline, if (keepSecret) concat(raw.unlock, raw.auth) else null)
    }

    /** For reprompt items, and the biometric enrolment: is this the master password? Local. */
    fun checkPassword(password: String): Boolean {
        val s = need()
        val secretKey = keeper.load() ?: return false
        val account = store.getAccount() ?: return false
        return runCatching {
            val r = deriveRoot(password, secretKey, fromB64u(account.salt), account.kdf)
            unwrapKeyset(r.unlock, s.accountId, fromB64u(account.wrappedKeyset))
            true
        }.getOrDefault(false)
    }

    /** The derived keys for the Keystore's biometric-gated wrap. Never the master password. */
    fun currentUnlockSecret(): ByteArray {
        val s = need()
        return concat(s.unlockKey, s.authKey)
    }

    /** Unlock with what the Keystore handed back after a biometric. */
    @Synchronized
    fun unlockWithSecret(secret: ByteArray): Boolean {
        require(secret.size == 64) { "bad unlock secret" }
        var cached = store.getAccount()
        val unlockKey = secret.copyOfRange(0, 32)
        val authKey = secret.copyOfRange(32, 64)
        var offline = false
        try {
            val session = api.createSession(b64u(authKey))
            api.session = session.token
            cacheAccount(session)
            cached = store.getAccount()
        } catch (e: ApiError) {
            if (e.status == 401) throw WrongPasswordError()
            if (e.status < 500) throw e
            offline = true
        } catch (e: OfflineError) {
            offline = true
        }
        val account = cached ?: throw IllegalStateException("This device has no offline copy")
        val keyset = try {
            unwrapKeyset(unlockKey, account.accountId, fromB64u(account.wrappedKeyset))
        } catch (e: java.security.GeneralSecurityException) {
            throw WrongPasswordError()
        }
        state = Unlocked(keyset, authKey, unlockKey, account.userId, account.accountId)
        loadLocal()
        if (!offline) sync()
        return offline
    }

    /** The session ended while we still hold the keys: prove again without the password. */
    fun reprove() {
        val s = need()
        val session = api.createSession(b64u(s.authKey))
        api.session = session.token
        cacheAccount(session)
    }

    /** Forget every key. The offline copy stays, encrypted. Waits for a running sync, which
     *  is still using those keys. Telling the server comes last, and can't hold anything up. */
    fun lock() {
        val session = synchronized(this) {
            val s = state
            state = null
            if (s != null) {
                s.keyset.wipe()
                s.authKey.fill(0)
                s.unlockKey.fill(0)
                s.vaultKeys.values.forEach { it.fill(0) }
                s.vaultKeys.clear()
                s.items.clear()
                s.search.clear()
            }
            api.session.also { api.session = null }
        }
        onChange?.invoke()
        if (session != null) runCatching { api.endSession(session) }
    }

    // ---- Change the master password ----

    @Synchronized
    fun changePassword(current: String, next: String, kdf: KdfParams? = null) {
        val s = need()
        val secretKey = keeper.load() ?: throw IllegalStateException("This device isn't set up")
        val account = store.getAccount() ?: throw IllegalStateException("This device isn't set up")
        val currentAuth = deriveRoot(current, secretKey, fromB64u(account.salt), account.kdf).auth
        val salt = randomBytes(16)
        val params = kdf ?: account.kdf
        val root = deriveRoot(next, secretKey, salt, params)
        val wrapped = wrapKeyset(root.unlock, s.accountId, s.keyset)
        api.rekey(buildJsonObject {
            put("auth_key", b64u(currentAuth))
            put("new_kdf", kdfJson(params))
            put("new_salt", b64u(salt))
            put("new_auth_key", b64u(root.auth))
            put("new_wrapped_keyset", b64u(wrapped))
        })
        store.putAccount(account.copy(kdf = params, salt = b64u(salt), wrappedKeyset = b64u(wrapped)))
        s.authKey = root.auth
    }

    // ---- Keys ----

    private fun trustMap(): MutableMap<String, TrustEntry> {
        val o = store.getMeta("trust") as? JsonObject ?: return LinkedHashMap()
        val out = LinkedHashMap<String, TrustEntry>()
        for ((k, v) in o) {
            val e = v as? JsonObject ?: continue
            out[k] = TrustEntry(e.str("x25519") ?: continue, e.str("ed25519") ?: continue, e.str("firstSeen") ?: "", e.bool("verified") ?: false, e.str("username"))
        }
        return out
    }

    private fun saveTrust(m: Map<String, TrustEntry>) {
        store.setMeta("trust", JsonObject(m.mapValues { (_, e) ->
            buildJsonObject {
                put("x25519", e.x25519)
                put("ed25519", e.ed25519)
                put("firstSeen", e.firstSeen)
                if (e.verified) put("verified", true)
                if (e.username != null) put("username", e.username)
            }
        }))
    }

    /** The key a grant must be signed with: ours, or one from the local trust store. A
     *  stranger is trusted on first use, and remembered. A changed key is refused. */
    private fun grantorKey(grantedBy: String?): ByteArray {
        val s = need()
        if (grantedBy == null || grantedBy == s.userId) return s.keyset.ed25519Pub
        val trust = trustMap()
        val known = trust[grantedBy]
        if (known != null) {
            try {
                val live = api.userKeys(grantedBy)
                if (live.ed25519Pub != known.ed25519 || live.x25519Pub != known.x25519) throw KeyChangedError(grantedBy, live.username)
            } catch (e: KeyChangedError) {
                throw e
            } catch (e: Exception) {
                // Offline, or that person has left: what we saved still verifies old grants.
            }
            return fromB64u(known.ed25519)
        }
        val live = api.userKeys(grantedBy)
        trust[grantedBy] = TrustEntry(live.x25519Pub, live.ed25519Pub, isoNow(), false, live.username)
        saveTrust(trust)
        return fromB64u(live.ed25519Pub)
    }

    private fun vaultKey(v: CachedVault): ByteArray {
        val s = need()
        s.vaultKeys[v.id]?.let { return it }
        val raw = openVaultKey(s.userId, s.keyset, v.id, v.memberGeneration, fromB64u(v.wrappedKey), fromB64u(v.signature), grantorKey(v.grantedBy))
        s.vaultKeys[v.id] = raw
        return raw
    }

    fun myIdentityWords(): List<String> {
        val s = need()
        return identityWords(s.userId, s.keyset.x25519Pub, s.keyset.ed25519Pub)
    }

    fun fingerprint(): String = hex(need().keyset.ed25519Pub).substring(0, 16)

    // ---- Local data ----

    private fun decode(c: CachedItem, v: CachedVault): Item? {
        val blob = c.blob
        if (blob == null || c.purged) return null
        val body = decryptItem(vaultKey(v), v.id, c.id, fromB64u(blob))
        return Item(c.id, c.vaultId, c.revision, c.deleted, c.updatedAt, body)
    }

    private fun loadLocal() {
        val s = need()
        s.items.clear()
        s.search.clear()
        for (v in store.getVaults()) {
            try {
                vaultKey(v)
            } catch (e: KeyChangedError) {
                throw e
            } catch (e: Exception) {
                continue
            }
            for (c in store.getItems(v.id)) {
                try {
                    decode(c, v)?.let { index(it) }
                } catch (e: Exception) {
                    // A blob that fails to open is reported, not a crash.
                    undecryptable += c.id
                }
            }
        }
        onChange?.invoke()
    }

    private fun index(item: Item) {
        val s = need()
        s.items[item.id] = item
        s.search[item.id] = searchText(item.body)
    }

    private fun unindex(id: String) {
        val s = need()
        s.items.remove(id)
        s.search.remove(id)
    }

    // ---- Sync ----

    private fun cacheVault(v: VaultOut, prev: CachedVault?) = CachedVault(
        v.id, v.kind, prev?.revision ?: 0, prev?.highWater ?: 0, v.generation, v.name, v.role, v.wrappedKey, v.signature, v.grantedBy, v.memberGeneration, v.accepted, v.memberCount,
    )

    /** Delta sync: push local edits first (a conflict is merged, nothing is lost), then
     *  pull what changed. Safe to call any time; offline it just says so. */
    @Synchronized
    fun sync(): SyncResult {
        val s = need()
        val out = SyncResult()
        try {
            val remote = api.vaults()
            val known = store.getVaults().associateBy { it.id }
            val seen = HashSet<String>()
            for (rv in remote) {
                seen += rv.id
                val prev = known[rv.id]
                var next = cacheVault(rv, prev)
                if (prev != null && rv.revision < prev.highWater) {
                    // A hostile or restored server is showing an older state.
                    out.rollback += rv.id
                    rollbackWarnings += rv.id
                    store.putVault(next.copy(revision = prev.revision, highWater = prev.highWater))
                    continue
                }
                if (prev != null && prev.memberGeneration != rv.memberGeneration) {
                    s.vaultKeys.remove(rv.id)?.fill(0)
                    // Everything was re-encrypted: start this vault over.
                    next = next.copy(revision = 0)
                }
                store.putVault(next)
                if (next.accepted || rv.kind == "personal") {
                    pushVault(next, out)
                    pullVault(next, out)
                }
            }
            for (v in known.values) {
                if (v.id !in seen) {
                    // Removed from this vault: drop the local copy and keys.
                    for (c in store.getItems(v.id)) unindex(c.id)
                    store.deleteVault(v.id)
                    s.vaultKeys.remove(v.id)?.fill(0)
                }
            }
            lastSyncAt = System.currentTimeMillis()
        } catch (e: OfflineError) {
            out.offline = true
        } catch (e: ApiError) {
            if (e.status >= 500) out.offline = true else throw e
        }
        onChange?.invoke()
        return out
    }

    private fun pullVault(v: CachedVault, out: SyncResult) {
        var since = v.revision
        var top = v.revision
        while (true) {
            val page = api.changes(v.id, since)
            top = maxOf(top, page.revision)
            val writes = ArrayList<CachedItem>()
            for (r in page.items) {
                since = maxOf(since, r.revision)
                // A local edit still waiting wins for now: the next push merges them.
                if (store.getItem(r.id)?.dirty == true) continue
                val c = CachedItem(r.id, v.id, r.revision, r.blob, r.deleted, r.purged, r.updatedAt)
                writes += c
                if (r.purged) {
                    unindex(r.id)
                } else {
                    try {
                        decode(c, v)?.let { index(it) }
                        undecryptable -= r.id
                    } catch (e: Exception) {
                        undecryptable += r.id
                    }
                }
                out.pulled++
            }
            store.putItems(writes)
            if (!page.more) break
        }
        store.putVault(v.copy(revision = top, highWater = maxOf(v.highWater, top)))
    }

    private fun pushVault(v: CachedVault, out: SyncResult) {
        val dirty = store.getItems(v.id).filter { it.dirty }
        if (dirty.isEmpty() || v.role !in setOf("manage", "edit")) return
        val key = vaultKey(v)
        for (chunk in dirty.chunked(200)) {
            val res = api.writeItems(v.id, chunk.map { ItemWrite(it.id, it.revision, if (it.purgeRequested) null else it.blob, it.deleted, it.purgeRequested) })
            val byId = chunk.associateBy { it.id }
            val writes = ArrayList<CachedItem>()
            for (id in res.applied) {
                val c = byId[id] ?: continue
                writes += c.copy(revision = res.revision, dirty = false, baseBlob = null, purged = c.purgeRequested, blob = if (c.purgeRequested) null else c.blob, purgeRequested = false)
                need().items[id]?.revision = res.revision
                out.pushed++
            }
            store.putItems(writes)
            val merged = ArrayList<String>()
            for (conflict in res.conflicts) {
                val c = byId[conflict.id]
                if (c == null || conflict.reason != "changed") continue
                out.conflicts++
                resolveConflict(v, key, c, conflict.blob, conflict.revision ?: 0, conflict.deleted)
                merged += conflict.id
            }
            // The merges left items dirty on top of the server's revision; send them too.
            if (merged.isNotEmpty()) {
                val again = merged.mapNotNull { store.getItem(it) }.filter { it.dirty }
                if (again.isNotEmpty()) {
                    val second = api.writeItems(v.id, again.map { ItemWrite(it.id, it.revision, it.blob, it.deleted) })
                    val writes2 = ArrayList<CachedItem>()
                    for (id in second.applied) {
                        val c = again.first { it.id == id }
                        writes2 += c.copy(revision = second.revision, dirty = false, baseBlob = null)
                        out.pushed++
                    }
                    store.putItems(writes2)
                }
            }
        }
    }

    private fun resolveConflict(v: CachedVault, key: ByteArray, local: CachedItem, serverBlob: String?, serverRevision: Int, serverDeleted: Boolean) {
        if (serverBlob == null) {
            // Purged elsewhere, edited here: the edit comes back as a new item rather
            // than vanish without a trace.
            val body = local.blob?.let { decryptItem(key, v.id, local.id, fromB64u(it)) }
            store.deleteItem(local.id)
            unindex(local.id)
            if (body != null && !local.purgeRequested) saveNew(v.id, body)
            return
        }
        val server = decryptItem(key, v.id, local.id, fromB64u(serverBlob))
        if (local.purgeRequested) {
            // Deleted here, changed there: keep the change. A purge can be repeated.
            store.putItems(listOf(local.copy(blob = serverBlob, revision = serverRevision, deleted = serverDeleted, dirty = false, purgeRequested = false, baseBlob = null)))
            index(Item(local.id, v.id, serverRevision, serverDeleted, server.updatedAt, server))
            return
        }
        val localBody = local.blob?.let { decryptItem(key, v.id, local.id, fromB64u(it)) } ?: server
        val base = local.baseBlob?.let { decryptItem(key, v.id, local.id, fromB64u(it)) }
        val merged = mergeBodies(base, localBody, server).body
        val blob = b64u(encryptItem(key, v.id, local.id, merged))
        val deleted = local.deleted && serverDeleted
        store.putItems(listOf(local.copy(blob = blob, baseBlob = serverBlob, revision = serverRevision, deleted = deleted, dirty = true)))
        index(Item(local.id, v.id, serverRevision, deleted, merged.updatedAt, merged))
    }

    // ---- Reading ----

    data class VaultInfo(val vault: CachedVault, val displayName: String)

    fun vaults(): List<VaultInfo> = store.getVaults().map { v ->
        val name = runCatching { (openField(vaultKey(v), v.id, "name", v.name) as JsonPrimitive).content }.getOrDefault("(can't open)")
        VaultInfo(v, name)
    }

    fun allItems(includeSystem: Boolean = false, includeDeleted: Boolean = false): List<Item> =
        need().items.values
            .filter { (includeSystem || !it.body.isSystem) && (includeDeleted || !it.deleted) }
            .sortedBy { it.body.title.lowercase() }

    fun trash(): List<Item> = allItems(includeDeleted = true).filter { it.deleted }

    fun get(id: String): Item? = state?.items?.get(id)

    /** Search over decrypted text in memory. Every word must match. */
    fun search(query: String): List<Item> {
        val s = need()
        val words = query.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return allItems()
        val out = ArrayList<Item>()
        for ((id, text) in s.search) {
            val item = s.items[id] ?: continue
            if (item.deleted || item.body.isSystem) continue
            if (words.all { text.contains(it) }) out += item
        }
        return out.sortedBy { it.body.title.lowercase() }
    }

    // ---- Writing ----

    private fun cachedVault(id: String) = store.getVaults().firstOrNull { it.id == id } ?: throw IllegalStateException("Unknown vault")

    fun personalVaultId(): String = store.getVaults().firstOrNull { it.kind == "personal" }?.id ?: throw IllegalStateException("No personal vault")

    /** Save locally first, so it works offline, then sync. */
    @Synchronized
    fun saveNew(vaultId: String, body: ItemBody, id: String = randomUuid()): Item {
        val v = cachedVault(vaultId)
        val clean = touch(null, body)
        val blob = b64u(encryptItem(vaultKey(v), vaultId, id, clean))
        val at = isoNow()
        store.putItems(listOf(CachedItem(id, vaultId, 0, blob, deleted = false, purged = false, updatedAt = at, dirty = true, baseBlob = null)))
        val item = Item(id, vaultId, 0, false, at, clean)
        index(item)
        onChange?.invoke()
        return item
    }

    @Synchronized
    fun update(id: String, body: ItemBody): Item {
        val prev = get(id) ?: throw IllegalStateException("Unknown item")
        val v = cachedVault(prev.vaultId)
        val clean = touch(prev.body, body)
        val blob = b64u(encryptItem(vaultKey(v), v.id, id, clean))
        val cached = store.getItem(id)
        val at = isoNow()
        store.putItems(listOf(CachedItem(
            id, v.id, cached?.revision ?: prev.revision, blob, cached?.deleted ?: false, false, at, dirty = true,
            // The first edit since the last sync is what a merge compares against.
            baseBlob = if (cached?.dirty == true) cached.baseBlob else cached?.blob,
        )))
        val item = Item(id, prev.vaultId, prev.revision, cached?.deleted ?: false, at, clean)
        index(item)
        onChange?.invoke()
        return item
    }

    @Synchronized
    private fun setDeleted(id: String, deleted: Boolean) {
        val cached = store.getItem(id) ?: throw IllegalStateException("Unknown item")
        store.putItems(listOf(cached.copy(deleted = deleted, dirty = true, baseBlob = if (cached.dirty) cached.baseBlob else cached.blob)))
        get(id)?.deleted = deleted
        onChange?.invoke()
    }

    fun trashItem(id: String) = setDeleted(id, true)
    fun restoreItem(id: String) = setDeleted(id, false)

    @Synchronized
    fun purgeItem(id: String) {
        val cached = store.getItem(id) ?: throw IllegalStateException("Unknown item")
        if (cached.revision == 0) store.deleteItem(id) else store.putItems(listOf(cached.copy(dirty = true, purgeRequested = true)))
        unindex(id)
        onChange?.invoke()
    }

    data class Version(val revision: Int, val createdAt: String, val body: ItemBody)

    fun versions(id: String): List<Version> {
        val item = get(id) ?: return emptyList()
        val v = cachedVault(item.vaultId)
        val key = vaultKey(v)
        return api.versions(v.id, id).mapNotNull { row ->
            runCatching { Version(row.revision, row.createdAt, decryptItem(key, v.id, id, fromB64u(row.blob))) }.getOrNull()
        }
    }

    fun acceptVault(id: String) {
        api.acceptVault(id)
        sync()
    }

    // ---- New devices (CRYPTO_SPEC.md section 8) ----

    class Approval(val words: List<String>, val approverPub: String)

    /** On the unlocked device: answer a request. Returns the words to compare. */
    fun beginApproval(requestId: String, devicePub: String): Approval {
        val approverSk = randomBytes(32)
        val approverPub = Primitives.x25519Public(approverSk)
        approverSk.fill(0)
        api.deviceRequestApprover(requestId, b64u(approverPub))
        return Approval(deviceSafetyWords(fromB64u(devicePub), approverPub), b64u(approverPub))
    }

    fun finishApproval(requestId: String, devicePub: String) {
        val s = need()
        val secretKey = keeper.load() ?: throw IllegalStateException("This device doesn't hold the Secret Key")
        val payload = buildJsonObject {
            put("secret_key", b64u(secretKey))
            put("account_id", s.accountId)
        }.toString()
        secretKey.fill(0)
        api.deviceRequestApprove(requestId, b64u(sealTo(fromB64u(devicePub), utf8(payload), aad(requestId, "", "device_payload"))))
    }

    /** On the new device. Poll with `poll`, compare the words, then the key arrives. */
    fun requestDevice(name: String): DeviceJoin {
        val sk = randomBytes(32)
        val pub = Primitives.x25519Public(sk)
        val created = api.deviceRequestCreate(name, platform, b64u(pub))
        return DeviceJoin(this, created.id, created.code, created.pollSecret, sk, pub)
    }

    /** Forget this device's copy entirely: the Secret Key and every cached blob. */
    @Synchronized
    fun forgetDevice() {
        lock()
        keeper.clear()
        store.clear()
    }
}

class DeviceJoin(
    private val client: VaultClient,
    val id: String,
    val code: String,
    private val pollSecret: String,
    private val sk: ByteArray,
    private val pub: ByteArray,
) {
    @Volatile
    var words: List<String>? = null

    class State(val status: String, val words: List<String>?, val secretKey: ByteArray?)

    /** "pending" until approved. Words appear as soon as the approver has posted its key,
     *  so the person can compare before approving. */
    fun poll(): State {
        val state = client.api.deviceRequestPoll(id, pollSecret)
        state.approverPub?.let { words = deviceSafetyWords(pub, fromB64u(it)) }
        val payload = state.payload
        if (state.status != "approved" || payload == null) return State(state.status, words, null)
        val plain = openSealed(sk, fromB64u(payload), aad(id, "", "device_payload"))
        val secretKey = fromB64u((Json.parseToJsonElement(fromUtf8(plain)) as JsonObject).str("secret_key")!!)
        client.keeper.save(secretKey)
        return State("approved", words, secretKey)
    }
}
