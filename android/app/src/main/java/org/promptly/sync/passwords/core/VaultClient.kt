// The vault client: the Kotlin twin of vault.ts. No Android imports. Keys live in this
// object's memory only; lock() drops them. See CRYPTO_SPEC.md. Writes hold the object's
// lock, and reads are lock-free so a sync can't stall a screen or an autofill answer.
package org.promptly.sync.passwords.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

data class SyncResult(var pulled: Int = 0, var pushed: Int = 0, var conflicts: Int = 0, var offline: Boolean = false, val rollback: MutableList<String> = ArrayList())

data class TrustEntry(val x25519: String, val ed25519: String, val firstSeen: String, val verified: Boolean = false, val username: String? = null) {
    fun toJson(): JsonObject = buildJsonObject {
        put("x25519", x25519)
        put("ed25519", ed25519)
        put("firstSeen", firstSeen)
        if (verified) put("verified", true)
        if (username != null) put("username", username)
    }

    companion object {
        fun from(e: JsonElement?): TrustEntry? {
            val o = e as? JsonObject ?: return null
            return TrustEntry(o.str("x25519") ?: return null, o.str("ed25519") ?: return null, o.str("firstSeen") ?: "", o.bool("verified") ?: false, o.str("username"))
        }
    }
}

/** What this person decided, kept where a server can't touch it: a system item in their own
 *  vault, so it syncs between their devices. The same JSON as `TrustBook` in model.ts. */
class TrustBook(
    val people: MutableMap<String, TrustEntry> = ConcurrentHashMap(),
    val accepted: MutableList<String> = CopyOnWriteArrayList(),
    val contacts: MutableList<String> = CopyOnWriteArrayList(),
    val generations: MutableMap<String, Int> = ConcurrentHashMap(),
    @Volatile var personalVaultId: String? = null,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("people", JsonObject(people.mapValues { it.value.toJson() }))
        put("accepted", stringArray(accepted))
        put("contacts", stringArray(contacts))
        put("generations", JsonObject(generations.mapValues { JsonPrimitive(it.value) }))
        personalVaultId?.let { put("personalVaultId", it) }
    }

    companion object {
        fun stringArray(list: Collection<String>) = JsonArray(list.map { JsonPrimitive(it) })
        fun strings(e: JsonElement?): List<String> = (e as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } ?: emptyList()
        fun numbers(e: JsonElement?): Map<String, Int> = (e as? JsonObject)?.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.content?.toDoubleOrNull()?.toInt()?.let { k to it } }?.toMap() ?: emptyMap()
        fun peopleOf(e: JsonElement?): Map<String, TrustEntry> = (e as? JsonObject)?.mapNotNull { (k, v) -> TrustEntry.from(v)?.let { k to it } }?.toMap() ?: emptyMap()
    }
}

/** `changedElsewhere`: the server's salt isn't the one this device last saw, so the master
 *  password or the Secret Key was changed on another device since. */
class WrongPasswordError(val changedElsewhere: Boolean = false) : Exception("That master password or Secret Key isn't right")

class KeyChangedError(val userId: String, val username: String) : Exception("$username's keys have changed since you last shared with them")

/** A new device token for someone other than this vault's owner. Nothing's been changed. */
class WrongAccountError : Exception("That sign-in is a different Promptly account from this vault's, so this phone keeps the connection it has. Sign in as the vault's owner and try again.")

/** Whether a token someone's just handed over is for this vault's account. Not knowing isn't yes. */
fun sameAccount(mine: String?, theirs: String?): Boolean = !mine.isNullOrEmpty() && !theirs.isNullOrEmpty() && mine.equals(theirs, ignoreCase = true)

private const val PERSONAL_META = "personal_vault"
/** The vaults this device knows are this person's own. See `refreshOwnPins`. */
private const val OWN_META = "own_vaults"
private const val STATE_META = "trust_state"
private const val LAST_SYNC_META = "last_sync"
private const val RECOVERY_META = "recovery_checked"

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

    /** What the server asks for at least. Never lower than the floor: `deriveRoot` checks. */
    @Volatile
    var minKdf: KdfParams? = null

    /** Vaults that can't open because whoever gave us the key now has a different one. */
    val keyChanges: MutableMap<String, KeyChangedError> = ConcurrentHashMap()

    private val roles = ConcurrentHashMap<String, String>()

    val rollbackWarnings: MutableList<String> = java.util.Collections.synchronizedList(ArrayList())
    val undecryptable: MutableSet<String> = ConcurrentHashMap.newKeySet()

    /** Vaults whose grant didn't verify on the last sync. */
    val cantOpen: MutableSet<String> = ConcurrentHashMap.newKeySet()

    val unlocked: Boolean get() = state != null
    val userId: String? get() = state?.userId

    private fun need(): Unlocked = state ?: throw IllegalStateException("The vault is locked")

    // ---- Setup and unlock ----

    /** Create the account. Returns the Secret Key's raw bytes for the recovery kit. */
    @Synchronized
    fun setup(password: String, wanted: KdfParams = KdfParams.FLOOR): ByteArray {
        val pre = api.prelogin()
        minKdf = pre.minKdf
        val kdf = strongerKdf(wanted, null)
        val secretKey = randomBytes(16)
        val salt = randomBytes(16)
        val accountId = randomUuid()
        val vaultId = randomUuid()
        val root = deriveRoot(password, secretKey, salt, kdf)
        val keyset = Keyset.random()
        val vaultKey = randomBytes(32)
        // The grant is bound to the user id, which prelogin tells us.
        val userId = pre.userId
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
        cacheAccount(session, setup = true)
        state = Unlocked(keyset, root.auth, root.unlock, userId, accountId)
        store.setMeta(PERSONAL_META, JsonPrimitive(vaultId))
        // Made here, so known for certain. The first sync signs it as theirs for their other devices.
        store.setMeta(OWN_META, TrustBook.stringArray(listOf(vaultId)))
        sync()
        return secretKey
    }

    /** A different account here means someone else signed in, or a server trying to wipe this
     *  device's trust and unsynced edits. It only counts if the new keyset really opens. What a
     *  session says is checked before it's stored: settings only go up, and with the key to hand
     *  the keyset has to open. `provenKdf` and `provenSalt` are what really made that key. */
    private fun cacheAccount(session: SessionOut, unlockKey: ByteArray? = null, setup: Boolean = false, provenKdf: KdfParams? = null, provenSalt: String? = null) {
        var s = session
        val prev = store.getAccount()
        if (!setup) {
            if (prev != null && prev.accountId != s.accountId && unlockKey == null) {
                throw IllegalStateException("The server says this is a different account. Lock and unlock again to check.")
            }
            if (prev != null && (s.kdf.m < prev.kdf.m || s.kdf.t < prev.kdf.t)) {
                throw IllegalStateException("The server sent weaker key settings than this device has seen, so they weren't accepted.")
            }
            if (unlockKey != null) {
                try {
                    unwrapKeyset(unlockKey, s.accountId, fromB64u(s.wrappedKeyset)).wipe()
                } catch (e: Exception) {
                    throw WrongPasswordError()
                }
            } else if (prev != null && s.wrappedKeyset != prev.wrappedKeyset) {
                // Re-proving a session has no password to check a new keyset with. Keep what's here.
                s = s.copy(wrappedKeyset = prev.wrappedKeyset, salt = prev.salt, kdf = prev.kdf)
            }
            if (provenKdf != null && provenSalt != null) s = s.copy(kdf = provenKdf, salt = provenSalt)
        }
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
        val knownSalt = cached?.salt
        var preWrapped: String? = null
        var preAccount: String? = null
        try {
            val pre = api.prelogin()
            serverTimeOffsetMs = runCatching { Instant.parse(pre.serverTime).toEpochMilli() - System.currentTimeMillis() }.getOrDefault(0L)
            preview = pre.preview
            minKdf = pre.minKdf
            if (!pre.exists) throw IllegalStateException("There's no vault on this account yet")
            if (pre.kdf != null && pre.salt != null) {
                // Settings can only ever go up. A server asking for weaker ones wants easier guessing.
                val seen = cached?.kdf
                if (seen != null && (pre.kdf.m < seen.m || pre.kdf.t < seen.t)) {
                    throw IllegalStateException("The server is asking for weaker key settings than this device has seen, so this device won't unlock with them.")
                }
                kdf = pre.kdf
                salt = pre.salt
                preWrapped = pre.wrappedKeyset
                preAccount = pre.accountId
            }
            // Leaving these out would switch off the check below.
            if (preWrapped == null || preAccount == null) throw IllegalStateException("The server didn't send what's needed to check your keys, so nothing was sent to it.")
        } catch (e: OfflineError) {
            offline = true
        } catch (e: ApiError) {
            if (e.status < 500) throw e
            offline = true
        }
        if (kdf == null || salt == null) throw IllegalStateException("This device has no offline copy, and the server can't be reached" + (api.lastProblem?.let { " ($it)" } ?: ""))
        val changedElsewhere = !offline && knownSalt != null && knownSalt != salt
        val raw = deriveRoot(password, secretKey, fromB64u(salt), kdf)
        // Open the keyset here before anything derived from the password goes anywhere. If a
        // server handed this device a Secret Key of its own choosing, what it would get back is
        // something it could guess the master password from, so nothing goes unless this works.
        if (!offline) {
            try {
                unwrapKeyset(raw.unlock, preAccount!!, fromB64u(preWrapped!!)).wipe()
            } catch (e: Exception) {
                throw WrongPasswordError(changedElsewhere)
            }
        }
        if (!offline) {
            try {
                val session = api.createSession(b64u(raw.auth))
                api.session = session.token
                cacheAccount(session, raw.unlock, provenKdf = kdf, provenSalt = salt)
                cached = store.getAccount()
            } catch (e: ApiError) {
                if (e.status == 401) throw WrongPasswordError(changedElsewhere)
                throw e
            } catch (e: OfflineError) {
                offline = true
            }
        }
        val account = cached ?: throw IllegalStateException("This device has no offline copy, and the server can't be reached" + (api.lastProblem?.let { " ($it)" } ?: ""))
        val keyset = try {
            unwrapKeyset(raw.unlock, account.accountId, fromB64u(account.wrappedKeyset))
        } catch (e: java.security.GeneralSecurityException) {
            throw WrongPasswordError()
        }
        if (secretKeyOverride != null) keeper.save(secretKey) else secretKey.fill(0)
        state = Unlocked(keyset, raw.auth, raw.unlock, account.userId, account.accountId)
        loadLocal()
        // The master password is what five wrong passkey PINs ask for. It starts the count again.
        PasskeyPin.clearTries(store)
        if (!offline) sync()
        return UnlockResult(offline, if (keepSecret) concat(raw.unlock, raw.auth) else null)
    }

    /** For reprompt items, and the biometric enrolment: is this the master password? Local. */
    fun checkPassword(password: String): Boolean {
        val s = need()
        val secretKey = keeper.load() ?: return false
        try {
            val account = store.getAccount() ?: return false
            return runCatching {
                val r = deriveRoot(password, secretKey, fromB64u(account.salt), account.kdf)
                unwrapKeyset(r.unlock, s.accountId, fromB64u(account.wrappedKeyset)).wipe()
                r.unlock.fill(0)
                r.auth.fill(0)
                true
            }.getOrDefault(false)
        } finally {
            secretKey.fill(0)
        }
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
        // A biometric: not after five wrong passkey PINs on this phone.
        if (PasskeyPin.lockedOut(store)) throw IllegalStateException(PasskeyPin.LOCKED_TEXT)
        var cached = store.getAccount()
        val unlockKey = secret.copyOfRange(0, 32)
        val authKey = secret.copyOfRange(32, 64)
        var offline = false
        try {
            val session = api.createSession(b64u(authKey))
            api.session = session.token
            cacheAccount(session, unlockKey)
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
            book = TrustBook()
            ownership = TrustState()
            ownVaultIds = emptySet()
            homeMissing = false
            api.session.also { api.session = null }
        }
        onChange?.invoke()
        if (session != null) runCatching { api.endSession(session) }
    }

    // ---- Change the master password ----

    /** Stretching settings at least as strong as they are now and as the server asks for. */
    private fun strongerKdf(current: KdfParams, wanted: KdfParams?): KdfParams {
        val a = wanted ?: current
        val min = minKdf
        return KdfParams("argon2id", maxOf(a.m, current.m, min?.m ?: 0), maxOf(a.t, current.t, min?.t ?: 0), a.p)
    }

    /** True if this device's copy is below what the server now asks for. */
    fun kdfBelowMinimum(): Boolean {
        val min = minKdf ?: return false
        val k = store.getAccount()?.kdf ?: return false
        return k.m < min.m || k.t < min.t
    }

    fun currentKdf(): KdfParams? = store.getAccount()?.kdf

    fun changePassword(current: String, next: String, kdf: KdfParams? = null) = rekeyWith(current, next, kdf, null)

    /** A new Secret Key, same master password. Other devices have to join again, and the
     *  old kit stops working. Returns the new key for a new kit. */
    fun rotateSecretKey(password: String): ByteArray {
        val fresh = randomBytes(16)
        rekeyWith(password, password, null, fresh)
        return fresh
    }

    /** Raise the stretching settings without changing anything else. */
    fun upgradeKdf(password: String, kdf: KdfParams? = null) = rekeyWith(password, password, kdf, null)

    @Synchronized
    private fun rekeyWith(current: String, next: String, kdf: KdfParams?, newKey: ByteArray?) {
        val s = need()
        val secretKey = keeper.load() ?: throw IllegalStateException("This device isn't set up")
        val account = store.getAccount() ?: throw IllegalStateException("This device isn't set up")
        val currentAuth = deriveRoot(current, secretKey, fromB64u(account.salt), account.kdf).auth
        val salt = randomBytes(16)
        val params = strongerKdf(account.kdf, kdf)
        val root = deriveRoot(next, newKey ?: secretKey, salt, params)
        val wrapped = wrapKeyset(root.unlock, s.accountId, s.keyset)
        api.rekey(buildJsonObject {
            put("auth_key", b64u(currentAuth))
            put("new_kdf", kdfJson(params))
            put("new_salt", b64u(salt))
            put("new_auth_key", b64u(root.auth))
            put("new_wrapped_keyset", b64u(wrapped))
        })
        store.putAccount(account.copy(kdf = params, salt = b64u(salt), wrappedKeyset = b64u(wrapped)))
        if (newKey != null) keeper.save(newKey)
        secretKey.fill(0)
        s.authKey = root.auth
    }

    // ---- Keys ----

    fun trustEntries(): Map<String, TrustEntry> = trustMap()

    private fun trustMap(): MutableMap<String, TrustEntry> = LinkedHashMap(TrustBook.peopleOf(store.getMeta("trust")))

    /** The key a grant must be signed with: ours, or one this person chose to remember. The
     *  server names who signed a grant, so it could name anyone, with keys of its own. A vault
     *  from a stranger stays shut until the person looks, and a changed key is refused. */
    private fun grantorKey(grantedBy: String?): ByteArray {
        val s = need()
        if (grantedBy == null || grantedBy == s.userId) return s.keyset.ed25519Pub
        val known = trustMap()[grantedBy]
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
        val live = runCatching { api.userKeys(grantedBy) }.getOrNull()
        throw KeyChangedError(grantedBy, live?.username ?: "")
    }

    private fun openGrant(v: CachedVault): ByteArray {
        val s = need()
        return openVaultKey(s.userId, s.keyset, v.id, v.memberGeneration, fromB64u(v.wrappedKey), fromB64u(v.signature), grantorKey(v.grantedBy))
    }

    private fun vaultKey(v: CachedVault): ByteArray {
        val s = need()
        s.vaultKeys[v.id]?.let { return it }
        val raw = openGrant(v)
        s.vaultKeys[v.id] = raw
        return raw
    }

    // ---- What this person decided ----

    @Volatile
    private var book = TrustBook()

    /** Pinned on this device; never from what the server calls a vault. */
    @Volatile
    private var ownVaultIds: Set<String> = emptySet()

    /** One of them has no signed statement in it yet, so other devices can't tell it's theirs. */
    @Volatile
    private var homeMissing = false

    /** Who's an emergency contact, and which vaults were made alone: synced beside the trust book. */
    @Volatile
    private var ownership = TrustState()

    /** Their own vault: one this device pinned as theirs, still signed by them. What the server
     *  calls a vault ("personal" or not) doesn't come into it: a shared vault they made has a grant
     *  signed by them too, and every member of it holds its key. */
    private fun isOwnVault(v: CachedVault): Boolean = v.id in ownVaultIds && selfGranted(v.grantedBy)

    private fun selfGranted(grantedBy: String?): Boolean = grantedBy == null || grantedBy == need().userId

    /** For other parts of the app that should only take things from this person's own vault. */
    fun isOwn(vaultId: String): Boolean = vaultId in ownVaultIds

    /** A vault opens if it's your own, or you made it, or you chose to accept it. What the
     *  server says about who accepted what doesn't come into it. */
    private fun mayOpen(v: CachedVault): Boolean {
        return isOwnVault(v) || selfGranted(v.grantedBy) || v.id in book.accepted
    }

    /** For the screens: has this person said yes to this vault? */
    fun chosen(v: CachedVault): Boolean = mayOpen(v)

    /** Only the book in your own vault counts. Anyone who can write to a shared vault could
     *  put an item of this kind there. */
    private fun trustItems(): List<Item> {
        val s = need()
        val own = ownVaultIds
        return s.items.values.filter { it.vaultId in own && it.body.kind == "trust" && !it.deleted && it.body["trustBook"] is JsonObject }.sortedBy { it.id }
    }

    /** Which vaults are theirs. Pinned at setup; carried over once from what this device already
     *  trusted before this check existed; or proven by a statement signed with their identity key
     *  inside the vault itself, which their other devices write. A server can relabel a shared
     *  vault they made as "personal", and any member can write a trust book into it, but neither
     *  can sign that statement. The same rules as vault.ts. */
    private fun refreshOwnPins() {
        val s = need()
        val vaults = store.getVaults()
        var pins = store.getMeta(OWN_META)?.let { TrustBook.strings(it) }
        if (pins == null) {
            val first = ArrayList<String>()
            val synced = store.getMeta(LAST_SYNC_META) != null
            val before = (store.getMeta(PERSONAL_META) as? JsonPrimitive)?.content
            if (before != null) first += before
            else if (synced) {
                // A device from before: what it already took to be theirs. A new device has no history.
                val was = vaults.filter { it.kind == "personal" && selfGranted(it.grantedBy) }
                if (was.size == 1) first += was[0].id
            }
            if (synced) {
                // The vaults it already treated as made alone, for emergency access, once.
                val local = TrustState().also { it.absorb(store.getMeta(STATE_META)) }
                local.made += vaults.filter { it.id !in first && it.kind != "personal" && selfGranted(it.grantedBy) && it.memberCount <= 1 }.map { it.id }
                store.setMeta(STATE_META, local.toJson())
            }
            store.setMeta(OWN_META, TrustBook.stringArray(first))
            pins = first
        }
        val me = s.keyset.ed25519Pub
        val byId = vaults.associateBy { it.id }
        val signed = HashSet<String>()
        for (item in s.items.values) {
            if (item.body.kind != "trust" || item.vaultId in signed) continue
            val v = byId[item.vaultId] ?: continue
            if (selfGranted(v.grantedBy) && Ownership.verifyHome(item.body.str("homeSig"), s.userId, v.id, me)) signed += v.id
        }
        val found = signed.filter { it !in pins }
        if (found.isNotEmpty()) {
            pins = pins + found
            store.setMeta(OWN_META, TrustBook.stringArray(pins))
        }
        ownVaultIds = pins.toSet()
        homeMissing = pins.any { id -> byId[id]?.let { !it.hidden && selfGranted(it.grantedBy) && id !in signed } ?: false }
    }

    /** Bring in what other devices decided. Union, and never a key change without a prompt. */
    private fun mergeTrustBook() {
        refreshOwnPins()
        val local = TrustBook.peopleOf(store.getMeta("trust"))
        val merged = TrustBook()
        val generations = HashMap<String, Int>()
        fun raise(from: Map<String, Int>) = from.forEach { (k, n) -> generations[k] = maxOf(generations[k] ?: 0, n) }
        val accepted = LinkedHashSet<String>()
        val contacts = LinkedHashSet<String>()
        val remotePeople = HashMap<String, TrustEntry>()
        for (item in trustItems()) {
            val o = item.body["trustBook"] as JsonObject
            for ((id, e) in TrustBook.peopleOf(o["people"])) {
                val had = remotePeople[id]
                remotePeople[id] = if (had == null) e else had.copy(verified = had.verified || (e.verified && sameKeys(e, had)))
            }
            accepted += TrustBook.strings(o["accepted"])
            contacts += TrustBook.strings(o["contacts"])
            raise(TrustBook.numbers(o["generations"]))
        }
        for ((id, e) in remotePeople) {
            val mine = local[id]
            // Words compared on another device vouch for the keys it saw, both of them. A server can show
            // this device the right signing key and an encryption key of its own.
            merged.people[id] = if (mine == null) e else if (e.verified && sameKeys(e, mine)) mine.copy(verified = true) else mine
        }
        for ((id, e) in local) merged.people.putIfAbsent(id, e)
        accepted += TrustBook.strings(store.getMeta("trust_accepted"))
        contacts += TrustBook.strings(store.getMeta("trust_contacts"))
        raise(TrustBook.numbers(store.getMeta("trust_generations")))
        // Anything decided in this session and not written yet.
        accepted += book.accepted
        contacts += book.contacts
        raise(book.generations)
        // Contacts go by counter, so a removal on any device sticks. A plain list could only add.
        val state = TrustState()
        for (item in trustItems()) state.absorb(item.body["trustState"])
        state.absorb(store.getMeta(STATE_META))
        state.absorb(ownership.toJson())
        Ownership.withListed(state.contacts, contacts)
        ownership = state
        merged.accepted += accepted
        merged.contacts += Ownership.named(state.contacts)
        merged.generations += generations
        book = merged
        store.setMeta("trust", JsonObject(merged.people.mapValues { it.value.toJson() }))
    }

    private fun sameKeys(a: TrustEntry, b: TrustEntry) = a.ed25519 == b.ed25519 && a.x25519 == b.x25519

    /** Saved locally now, and to your own vault so other devices know too. With no vault known
     *  for certain to be theirs yet, it stays on this device until there is one. */
    private fun saveTrustBook() {
        book.contacts.clear()
        book.contacts += Ownership.named(ownership.contacts)
        store.setMeta("trust", JsonObject(book.people.mapValues { it.value.toJson() }))
        store.setMeta("trust_accepted", TrustBook.stringArray(book.accepted))
        store.setMeta("trust_contacts", TrustBook.stringArray(book.contacts))
        store.setMeta("trust_generations", JsonObject(book.generations.mapValues { JsonPrimitive(it.value) }))
        store.setMeta(STATE_META, ownership.toJson())
        val s = state ?: return
        val item = trustItems().firstOrNull()
        // In travel mode the items aren't here, and a fresh one would look like the only one.
        val home = item?.vaultId ?: store.getVaults().firstOrNull { isOwnVault(it) && !it.hidden }?.id ?: return
        book.personalVaultId = null
        val body = (item?.body ?: newBody("trust", "trust-book")).with(
            "trustBook" to book.toJson(),
            "trustState" to ownership.toJson(),
            "homeSig" to JsonPrimitive(Ownership.signHome(s.keyset.ed25519, s.userId, home)),
        )
        if (item != null) update(item.id, body) else saveNew(home, body)
    }

    /** Remember this person's keys, because the person just chose to deal with them. A name
     *  already known under other keys is refused until they've looked, since a server picks
     *  the ids as well as the names. */
    private fun pin(userId: String, live: PublicKeys = api.userKeys(userId)): TrustEntry {
        val trust = trustMap()
        val known = trust[userId]
        if (known != null) {
            if (known.ed25519 != live.ed25519Pub || known.x25519 != live.x25519Pub) throw KeyChangedError(userId, live.username)
            book.people[userId] = known
            return known
        }
        if (trust.any { (id, e) -> id != userId && e.username != null && e.username == live.username }) throw KeyChangedError(userId, live.username)
        val entry = TrustEntry(live.x25519Pub, live.ed25519Pub, isoNow(), false, live.username)
        book.people[userId] = entry
        saveTrustBook()
        return entry
    }

    /** Looking isn't trusting: nothing's remembered until the person acts on it. */
    fun identityWordsFor(userId: String): List<String> {
        trustMap()[userId]?.let { return identityWords(userId, fromB64u(it.x25519), fromB64u(it.ed25519)) }
        val live = api.userKeys(userId)
        return identityWords(userId, fromB64u(live.x25519Pub), fromB64u(live.ed25519Pub))
    }

    class InviterInfo(val username: String, val words: List<String>, val twin: Boolean, val changed: Boolean)

    /** Who an invitation is from, without trusting them yet. */
    fun inviterInfo(userId: String): InviterInfo {
        val live = api.userKeys(userId)
        val trust = trustMap()
        val known = trust[userId]
        val changed = known != null && (known.ed25519 != live.ed25519Pub || known.x25519 != live.x25519Pub)
        val twin = known == null && trust.any { (id, e) -> id != userId && e.username == live.username }
        return InviterInfo(live.username, identityWords(userId, fromB64u(live.x25519Pub), fromB64u(live.ed25519Pub)), twin, changed)
    }

    @Synchronized
    fun markVerified(userId: String) {
        if (trustMap()[userId] == null) pin(userId)
        val entry = trustMap()[userId] ?: return
        book.people[userId] = entry.copy(verified = true)
        saveTrustBook()
    }

    /** "They match", about the words that were on screen. The keys get read again to be pinned, so a
     *  server could show one person's words and answer with another's keys: those words have to be
     *  what these keys make, or nothing's remembered. */
    @Synchronized
    fun markVerified(userId: String, shown: List<String>) {
        val known = trustMap()[userId]
        val live = if (known == null) api.userKeys(userId) else null
        val x = known?.x25519 ?: live!!.x25519Pub
        val e = known?.ed25519 ?: live!!.ed25519Pub
        if (identityWords(userId, fromB64u(x), fromB64u(e)) != shown) throw KeyChangedError(userId, known?.username ?: live?.username ?: "")
        if (live != null) pin(userId, live)
        val entry = trustMap()[userId] ?: return
        book.people[userId] = entry.copy(verified = true)
        saveTrustBook()
    }

    /** The person looked at it, and says the new key is right. Old grants signed with the
     *  old key still won't verify: they need to be granted again. */
    @Synchronized
    fun acceptChangedKey(userId: String) {
        val live = api.userKeys(userId)
        book.people[userId] = TrustEntry(live.x25519Pub, live.ed25519Pub, isoNow(), false, live.username)
        saveTrustBook()
        val s = need()
        s.vaultKeys.values.forEach { it.fill(0) }
        s.vaultKeys.clear()
        loadLocal()
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
        keyChanges.clear()
        roles.clear()
        val all = store.getVaults()
        // Their own vault has their decisions in it, so it opens before anything else is judged.
        // Then the others they made, which open on their own signature and may prove one theirs.
        mergeTrustBook()
        fun rank(v: CachedVault) = if (isOwnVault(v)) 0 else if (selfGranted(v.grantedBy)) 1 else 2
        val ownFirst = all.sortedBy { rank(it) }
        var merged = false
        for (v in ownFirst) {
            if (!merged && rank(v) == 2) {
                merged = true
                mergeTrustBook()
            }
            roles[v.id] = v.role
            if (!mayOpen(v)) continue
            try {
                vaultKey(v)
            } catch (e: KeyChangedError) {
                // One person's changed key can't stop everything else opening. That vault
                // stays shut, and the Shared vaults screen asks what to do about it.
                keyChanges[v.id] = e
                continue
            } catch (e: Exception) {
                continue
            }
            if (v.hidden) continue
            for (c in store.getItems(v.id)) {
                try {
                    decode(c, v)?.let { index(it) }
                } catch (e: Exception) {
                    // A blob that fails to open is reported, not a crash.
                    undecryptable += c.id
                }
            }
        }
        if (!merged) mergeTrustBook()
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
        v.id, v.kind, prev?.revision ?: 0, prev?.highWater ?: 0, v.generation, v.name, v.role, v.wrappedKey, v.signature, v.grantedBy, v.memberGeneration, v.accepted, v.memberCount, prev?.hidden ?: false, v.rotateNeeded,
    )

    private fun warnRollback(out: SyncResult, vaultId: String) {
        out.rollback += vaultId
        rollbackWarnings += vaultId
    }

    /** Delta sync: push local edits first (a conflict is merged, nothing is lost), then
     *  pull what changed. Safe to call any time; offline it just says so. */
    @Synchronized
    fun sync(): SyncResult {
        val s = need()
        val out = SyncResult()
        var generationsMoved = false
        try {
            val remote = api.vaults()
            val known = store.getVaults().associateBy { it.id }
            val seen = HashSet<String>()
            // Their own vault first: it holds what they've decided about the others. Then the rest
            // they made, which may prove one theirs on a new device. What the server calls a vault
            // doesn't decide any of this: a "personal" vault not signed by them is somebody else's,
            // and one signed by them is only their own if this device knows it is (refreshOwnPins).
            fun rank(rv: VaultOut) = if (rv.id in ownVaultIds) 0 else if (selfGranted(rv.grantedBy)) 1 else 2
            val ordered = remote
                .map { if (it.kind == "personal" && !selfGranted(it.grantedBy)) it.copy(kind = "shared") else it }
                .sortedBy { rank(it) }
            var trustFresh = false
            for (rv0 in ordered) {
                if (!trustFresh && rank(rv0) == 2) {
                    trustFresh = true
                    mergeTrustBook()
                }
                var rv = rv0
                seen += rv.id
                val prev = known[rv.id]
                // Your own vault's key is signed by you. Being told otherwise isn't a reason to believe it.
                if (prev != null && isOwnVault(prev) && !selfGranted(rv.grantedBy)) {
                    warnRollback(out, rv.id)
                    continue
                }
                // And it stays your own vault, whatever it's called.
                if (rv.id in ownVaultIds && rv.kind != "personal") {
                    warnRollback(out, rv.id)
                    rv = rv.copy(kind = "personal")
                }
                // Another vault of theirs turning "personal" is a server trying to pass a shared vault,
                // whose key its members hold, off as their own. Kept as what it is, and warned about.
                if (rv.kind == "personal" && ownVaultIds.isNotEmpty() && rv.id !in ownVaultIds) {
                    warnRollback(out, rv.id)
                    rv = rv.copy(kind = "shared")
                }
                var next = cacheVault(rv, prev)
                val highest = maxOf(prev?.memberGeneration ?: 0, book.generations[rv.id] ?: 0)
                // An older key brought back, or an older state: an old grant still has a good
                // signature, so this is the only thing that can catch it. Stay on what we have.
                if ((prev != null && rv.revision < prev.highWater) || rv.memberGeneration < highest) {
                    warnRollback(out, rv.id)
                    if (prev != null && rv.memberGeneration >= highest) store.putVault(next.copy(revision = prev.revision, highWater = prev.highWater))
                    continue
                }
                val newGeneration = prev != null && prev.memberGeneration != rv.memberGeneration
                if (prev != null && mayOpen(next) && !next.hidden && (newGeneration || prev.wrappedKey != next.wrappedKey)) {
                    // A new grant is checked before it replaces the one that works.
                    val fresh = try {
                        openGrant(next)
                    } catch (e: KeyChangedError) {
                        keyChanges[next.id] = e
                        continue
                    } catch (e: OfflineError) {
                        throw e
                    } catch (e: ApiError) {
                        throw e
                    } catch (e: Exception) {
                        cantOpen += next.id
                        warnRollback(out, rv.id)
                        continue
                    }
                    if (newGeneration) rekeyDirty(prev, fresh)
                    s.vaultKeys.remove(rv.id)?.fill(0)
                    s.vaultKeys[rv.id] = fresh
                } else if (newGeneration) {
                    s.vaultKeys.remove(rv.id)?.fill(0)
                }
                // Everything was re-encrypted: start this vault over.
                if (newGeneration) next = next.copy(revision = 0)
                store.putVault(next)
                roles[next.id] = next.role
                if (next.hidden) continue
                // Only what they've chosen to open. An invitation just sits here until then.
                if (mayOpen(next)) {
                    try {
                        vaultKey(next)
                        keyChanges.remove(next.id)
                        cantOpen -= next.id
                        if (rv.memberGeneration > (book.generations[rv.id] ?: 0)) {
                            book.generations[rv.id] = rv.memberGeneration
                            generationsMoved = true
                        }
                        pushVault(next, out)
                        pullVault(next, out)
                    } catch (e: KeyChangedError) {
                        // Only this vault stays shut. The rest of the sync carries on.
                        keyChanges[next.id] = e
                    } catch (e: OfflineError) {
                        throw e
                    } catch (e: ApiError) {
                        throw e
                    } catch (e: Exception) {
                        // A grant that doesn't verify: this vault can't be read, others can.
                        cantOpen += next.id
                    }
                }
            }
            if (!trustFresh) mergeTrustBook() else refreshOwnPins()
            // Sign their own vault as theirs, once, so their other devices can tell it from the rest.
            val unsigned = homeMissing
            if (generationsMoved || unsigned) {
                saveTrustBook()
                // Up straight away, rather than waiting for the next sync.
                store.getVaults().firstOrNull { isOwnVault(it) && !it.hidden }?.let { pushVault(it, out) }
            }
            for (v in known.values) {
                if (v.id !in seen) {
                    // Your own vault can't be taken away by leaving it off a list.
                    if (isOwnVault(v)) {
                        warnRollback(out, v.id)
                        continue
                    }
                    // Removed from this vault: drop the local copy and keys.
                    for (c in store.getItems(v.id)) unindex(c.id)
                    store.deleteVault(v.id)
                    s.vaultKeys.remove(v.id)?.fill(0)
                    roles.remove(v.id)
                    keyChanges.remove(v.id)
                }
            }
            // Keep what an emergency contact holds up to date, and finish setting one up.
            runCatching { refreshEmergency() }
            lastSyncAt = System.currentTimeMillis()
            store.setMeta(LAST_SYNC_META, JsonPrimitive(lastSyncAt))
        } catch (e: OfflineError) {
            out.offline = true
        } catch (e: ApiError) {
            if (e.status >= 500) out.offline = true else throw e
        }
        onChange?.invoke()
        return out
    }

    /** A new vault key arrived while this device had unsynced edits: move them under it, so
     *  they don't go up under the key of someone who's been removed. */
    private fun rekeyDirty(prev: CachedVault, newKey: ByteArray) {
        val dirty = store.getItems(prev.id).filter { it.dirty && it.blob != null }
        if (dirty.isEmpty()) return
        val oldKey = try {
            vaultKey(prev)
        } catch (e: Exception) {
            return
        }
        val writes = ArrayList<CachedItem>()
        for (c in dirty) {
            try {
                val body = decryptItem(oldKey, prev.id, c.id, fromB64u(c.blob!!))
                writes += c.copy(blob = b64u(encryptItem(newKey, prev.id, c.id, body)), baseBlob = null)
            } catch (e: Exception) {
                undecryptable += c.id
            }
        }
        store.putItems(writes)
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
                if (r.purged) {
                    unindex(r.id)
                } else {
                    try {
                        val item = decode(c, v)
                        val known = need().items[r.id]
                        // The revision's the server's word. The number inside the encryption isn't.
                        if (item != null && known != null && item.body.seq < known.body.seq) {
                            warnRollback(out, v.id)
                            continue
                        }
                        item?.let { index(it) }
                        undecryptable -= r.id
                    } catch (e: Exception) {
                        undecryptable += r.id
                    }
                }
                writes += c
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
            val res = try {
                api.writeItems(v.id, chunk.map { ItemWrite(it.id, it.revision, if (it.purgeRequested) null else it.blob, it.deleted, it.purgeRequested) }, v.generation)
            } catch (e: ApiError) {
                // A new key we haven't seen yet. The next sync re-encrypts these and tries again.
                if (e.status == 409) return
                throw e
            }
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
                try {
                    resolveConflict(v, key, c, conflict.blob, conflict.revision ?: 0, conflict.deleted)
                    merged += conflict.id
                } catch (e: Exception) {
                    // Junk from someone else in the vault can't stop everyone's sync. It's listed.
                    undecryptable += c.id
                }
            }
            // The merges left items dirty on top of the server's revision; send them too.
            if (merged.isNotEmpty()) {
                val again = merged.mapNotNull { store.getItem(it) }.filter { it.dirty }
                if (again.isNotEmpty()) {
                    val second = try {
                        api.writeItems(v.id, again.map { ItemWrite(it.id, it.revision, it.blob, it.deleted) }, v.generation)
                    } catch (e: ApiError) {
                        if (e.status == 409) return
                        throw e
                    }
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
        val merged = mergeBodies(base, localBody, server).body.with("seq" to JsonPrimitive(maxOf(localBody.seq, server.seq) + 1))
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

    /** Where new things are saved. Their own vault, as this device knows it (refreshOwnPins). A new
     *  device whose other devices haven't signed theirs yet goes on the one vault the server calls
     *  personal, as before, but reads no trust book from it and seals nothing from it. */
    fun personalVaultId(): String {
        val vaults = store.getVaults()
        val preferred = (store.getMeta(PERSONAL_META) as? JsonPrimitive)?.content
        val own = vaults.filter { isOwnVault(it) }
        val v = own.firstOrNull { it.id == preferred } ?: own.firstOrNull()
            ?: vaults.filter { it.kind == "personal" && selfGranted(it.grantedBy) }.takeIf { ownVaultIds.isEmpty() && it.size == 1 }?.first()
            ?: throw IllegalStateException("No personal vault")
        return v.id
    }

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

    /** Accept a vault someone shared. Only this opens it, whatever the server says. */
    @Synchronized
    fun acceptVault(id: String) {
        val s = need()
        // An invitation this device hasn't heard about yet.
        if (store.getVaults().none { it.id == id }) sync()
        val v = cachedVault(id)
        if (v.grantedBy != null && v.grantedBy != s.userId) pin(v.grantedBy)
        if (id !in book.accepted) book.accepted += id
        saveTrustBook()
        api.acceptVault(id)
        sync()
    }

    /** Fill-only members can't see secrets on screen. It's a convenience: their device still
     *  gets the password in order to fill it, and the Shared vaults screen says so. */
    fun canReveal(vaultId: String): Boolean = roles[vaultId] != "fill"

    fun canEdit(vaultId: String): Boolean = roles[vaultId].let { it == "manage" || it == "edit" }

    fun roleOf(vaultId: String): String? = roles[vaultId]

    /** Everything a person's own export covers. A fill-only member isn't meant to see those
     *  secrets, so they don't go in a file. */
    fun exportable(): List<Item> = allItems().filter { canReveal(it.vaultId) }

    /** A vault's key in the clear, for granting it again. Caller wipes it. */
    private fun rawVaultKey(v: CachedVault): ByteArray = openGrant(v)

    private fun grantJson(g: MemberGrant): JsonObject = buildJsonObject {
        put("wrapped_key", b64u(g.wrapped))
        put("signature", b64u(g.signature))
    }

    fun createSharedVault(name: String): String {
        val s = need()
        val id = randomUuid()
        val raw = randomBytes(32)
        val grant = grantVaultKey(s.userId, s.keyset, id, s.userId, s.keyset.x25519Pub, 1, raw)
        api.createVault(id, sealField(raw, id, "name", JsonPrimitive(name)), grantJson(grant))
        raw.fill(0)
        // Made alone, so it counts as theirs for emergency access until anyone else is added.
        ownership.made += id
        saveTrustBook()
        sync()
        return id
    }

    @Synchronized
    fun addMember(vaultId: String, userId: String, role: String) {
        val s = need()
        val v = cachedVault(vaultId)
        // Picking someone is the person's own act, and this is when their keys get remembered.
        val keys = pin(userId)
        // Someone else's logins can be in it from now on, so it's no longer only theirs to hand on.
        if (ownership.shared.add(vaultId)) saveTrustBook()
        val raw = rawVaultKey(v)
        val grant = grantVaultKey(s.userId, s.keyset, vaultId, userId, fromB64u(keys.x25519), v.generation, raw)
        raw.fill(0)
        api.addMember(vaultId, userId, role, grantJson(grant))
    }

    data class PlanEntry(val userId: String, val username: String, val known: Boolean, val changed: Boolean)

    /** Who'd get the new key if these people were removed. A server can add names to a list, so
     *  anyone not already trusted needs the person to look before a key is sealed to them. */
    fun rotationPlan(vaultId: String, removing: List<String>): List<PlanEntry> {
        val s = need()
        val trust = trustMap()
        return api.members(vaultId).filter { it.userId !in removing && it.userId != s.userId }.map { m ->
            val k = trust[m.userId]
            PlanEntry(m.userId, m.username, k != null, k != null && (k.ed25519 != m.ed25519Pub || k.x25519 != m.x25519Pub))
        }
    }

    /** Remove people: cut off now, then a new vault key, new item keys, every item and retained
     *  version re-encrypted here and swapped in one batch on the server. Returns the logins they
     *  could read, whose passwords should now change. If the re-encrypting fails they're still
     *  out, and the vault says it needs a new key. With nobody to remove, it just changes the key. */
    @Synchronized
    fun removeMembers(vaultId: String, userIds: List<String>, confirmed: List<String> = emptyList()): List<Item> {
        val plan = rotationPlan(vaultId, userIds)
        plan.firstOrNull { it.changed }?.let { throw KeyChangedError(it.userId, it.username) }
        val unknown = plan.filter { !it.known && it.userId !in confirmed }
        if (unknown.isNotEmpty()) throw IllegalStateException("Check who gets the new key first: ${unknown.joinToString(", ") { it.username }}")
        for (id in userIds) {
            try {
                api.removeMember(vaultId, id)
            } catch (e: ApiError) {
                if (e.status != 404) throw e
            }
        }
        var attempt = 0
        while (true) {
            try {
                return rotateOnce(vaultId, confirmed)
            } catch (e: ApiError) {
                // Someone wrote something meanwhile. Pick it up and go again.
                if ((e.status == 409 || e.status == 400) && attempt < 3) {
                    attempt++
                    continue
                }
                throw e
            }
        }
    }

    private fun rotateOnce(vaultId: String, confirmed: List<String>): List<Item> {
        val s = need()
        sync()
        val v = cachedVault(vaultId)
        val oldKey = vaultKey(v)
        val raw = randomBytes(32)
        val members = api.members(vaultId)
        val generation = v.generation + 1
        val trust = trustMap()
        val grants = buildJsonArray {
            for (m in members) {
                val pub: ByteArray
                if (m.userId == s.userId) {
                    // Our own key's the one we hold, not whatever a list says it is.
                    pub = s.keyset.x25519Pub
                } else {
                    val known = trust[m.userId]
                    if (known != null && (known.x25519 != m.x25519Pub || known.ed25519 != m.ed25519Pub)) throw KeyChangedError(m.userId, m.username)
                    if (known == null && m.userId !in confirmed) throw IllegalStateException("Check who gets the new key first: ${m.username}")
                    val x = m.x25519Pub
                    val e = m.ed25519Pub
                    if (x == null || e == null) throw IllegalStateException("${m.username} has no keys on this server")
                    if (known == null) book.people[m.userId] = TrustEntry(x, e, isoNow(), false, m.username)
                    pub = fromB64u(x)
                }
                val g = grantVaultKey(s.userId, s.keyset, vaultId, m.userId, pub, generation, raw)
                add(buildJsonObject {
                    put("user_id", m.userId)
                    put("grant", grantJson(g))
                })
            }
        }
        val toChange = ArrayList<Item>()
        val junk = ArrayList<ItemWrite>()
        val junkIds = ArrayList<String>()
        val items = buildJsonArray {
            for (c in store.getItems(vaultId)) {
                val blob = c.blob
                if (blob == null || c.purged) continue
                val body = try {
                    decryptItem(oldKey, vaultId, c.id, fromB64u(blob))
                } catch (e: Exception) {
                    // Nobody can read it, so it can't be moved to the new key. It goes, or a member
                    // could stop themselves being rotated out by writing rubbish.
                    junk += ItemWrite(c.id, c.revision, null, deleted = true, purge = true)
                    junkIds += c.id
                    continue
                }
                if (!body.password.isNullOrEmpty() && !c.deleted) toChange += Item(c.id, vaultId, c.revision, c.deleted, c.updatedAt, body)
                val versions = buildJsonArray {
                    for (row in api.versions(vaultId, c.id)) {
                        val old = runCatching { decryptItem(oldKey, vaultId, c.id, fromB64u(row.blob)) }.getOrNull() ?: continue
                        add(buildJsonObject {
                            put("revision", row.revision)
                            put("blob", b64u(encryptItem(raw, vaultId, c.id, old)))
                        })
                    }
                }
                add(buildJsonObject {
                    put("id", c.id)
                    put("blob", b64u(encryptItem(raw, vaultId, c.id, body)))
                    put("versions", versions)
                })
            }
        }
        if (junk.isNotEmpty()) {
            api.writeItems(vaultId, junk, v.generation)
            junkIds.forEach { store.deleteItem(it) }
            sync()
        }
        val fresh = cachedVault(vaultId)
        val name = openField(oldKey, vaultId, "name", v.name)
        api.rotate(vaultId, buildJsonObject {
            put("from_generation", v.generation)
            put("from_revision", fresh.revision)
            put("name", sealField(raw, vaultId, "name", name))
            put("remove_user_ids", JsonArray(emptyList()))
            put("members", grants)
            put("items", items)
        })
        raw.fill(0)
        s.vaultKeys.remove(vaultId)?.fill(0)
        book.generations[vaultId] = generation
        saveTrustBook()
        sync()
        return toChange
    }

    fun leaveVault(id: String) {
        api.leaveVault(id)
        sync()
    }

    fun deleteVault(id: String) {
        api.deleteVault(id)
        sync()
    }

    // ---- Travel mode ----

    /** Take these vaults off this device: their items go from the local copy and memory, and
     *  they aren't synced here until travel mode's turned off. They stay on your server. */
    @Synchronized
    fun setTravelHidden(vaultIds: Collection<String>) {
        sync()
        for (v in store.getVaults()) {
            val hide = v.id in vaultIds
            if (hide && store.getItems(v.id).any { it.dirty }) throw IllegalStateException("Something in that vault hasn't synced yet. Get back online first.")
            if (hide) {
                for (c in store.getItems(v.id)) {
                    unindex(c.id)
                    store.deleteItem(c.id)
                }
                store.putVault(v.copy(hidden = true, revision = 0, highWater = 0))
            } else {
                store.putVault(v.copy(hidden = false))
            }
        }
        loadLocal()
    }

    /** Back from the trip. Needs the master password, as a second look before it all returns. */
    @Synchronized
    fun endTravel(password: String) {
        if (!checkPassword(password)) throw WrongPasswordError()
        for (v in store.getVaults()) store.putVault(v.copy(hidden = false))
        sync()
        loadLocal()
    }

    // ---- Emergency access ----

    /** The only way someone becomes a contact: this person, on one of their own devices. */
    @Synchronized
    fun emergencyInvite(granteeId: String, waitDays: Int) {
        pin(granteeId)
        Ownership.name(ownership.contacts, granteeId)
        saveTrustBook()
        api.emergencyInvite(granteeId, waitDays)
    }

    @Synchronized
    fun emergencyOpen(id: String) {
        val row = api.emergencyAct(id, "open")
        // Asking for this and waiting was the person's choice, so these are theirs to open.
        pin(row.grantorId)
        for (vaultId in row.openedVaults) if (vaultId !in book.accepted) book.accepted += vaultId
        saveTrustBook()
        sync()
    }

    /** End it. If it was opened, what they could read gets a new key first. */
    @Synchronized
    fun emergencyEnd(row: EmergencyOut) {
        val s = need()
        if (row.grantorId == s.userId && (row.state == "opened" || row.state == "ended")) {
            for (vaultId in row.openedVaults) removeMembers(vaultId, listOf(row.granteeId))
        }
        api.emergencyDelete(row.id)
        // Removed for good: the counter beats any device's older list of contacts.
        if (row.grantorId == s.userId) Ownership.remove(ownership.contacts, row.granteeId)
        saveTrustBook()
        sync()
    }

    /** Seal our vault keys to each accepted contact, signed, and again whenever a vault has
     *  been added or re-keyed since. A row in that list is only the server's word: keys go to
     *  someone this person named, whose safety words they've compared, on the keys they compared
     *  them for, and to nobody else, ever. */
    fun refreshEmergency() {
        val s = need()
        val rows = api.emergencyList()
        // Your own vaults only. Other people's logins in a shared vault aren't yours to hand on. Which
        // vaults those are is decided on your devices: the vault you own, and ones you made that you've
        // never added anyone to. A member count, or a label, from the server doesn't come into it.
        val own = ownership
        val mine = store.getVaults().filter { isOwnVault(it) || (selfGranted(it.grantedBy) && it.id in own.made && it.id !in own.shared) }
        for (row in rows) {
            if (row.grantorId != s.userId || row.state == "invited" || row.state == "opened" || row.state == "ended") continue
            if (row.granteeId !in book.contacts) continue
            val stale = mine.size != row.wrapped.size || mine.any { row.wrapped[it.id] != it.generation }
            if (!stale) continue
            val keys = api.userKeys(row.granteeId)
            val known = trustMap()[row.granteeId] ?: continue
            if (known.ed25519 != keys.ed25519Pub || known.x25519 != keys.x25519Pub) continue
            // Every key this person has, on keys only the server has vouched for so far, would be
            // the whole game for a hostile server. The same rule as vault.ts.
            if (!known.verified) continue
            val grants = buildJsonArray {
                for (v in mine) {
                    val raw = rawVaultKey(v)
                    val g = grantVaultKey(s.userId, s.keyset, v.id, row.granteeId, fromB64u(keys.x25519Pub), v.generation, raw)
                    raw.fill(0)
                    add(buildJsonObject {
                        put("vault_id", v.id)
                        put("generation", v.generation)
                        put("wrapped_key", b64u(g.wrapped))
                        put("signature", b64u(g.signature))
                    })
                }
            }
            api.emergencyWrap(row.id, grants)
        }
    }

    // ---- Attachments: the item's body records them ----

    /** A file's name is what A38 keeps out of the local copy, so the key holds a hash of it, under
     *  the vault's key, so a guess at a name can't be checked against it either. */
    private fun resumeMeta(item: Item, name: String, size: Long): String {
        val tag = Primitives.hkdf(vaultKey(cachedVault(item.vaultId)), ByteArray(0), "promptly-pw/android/upload-resume:$name:$size", 16)
        return "upload_resume:${item.id}:${b64u(tag)}"
    }

    /** The id and key an interrupted upload of this file was using, kept under the vault's key so
     *  the local copy holds no attachment key in the clear. `first` is a hash of the file's first
     *  chunk: a different file of the same name and size is a new upload, not a mix of the two. */
    private fun resumeFor(item: Item, meta: String, first: String): Pair<String, String> {
        val v = cachedVault(item.vaultId)
        val key = vaultKey(v)
        val bound = aad(v.id, item.id, "upload_resume")
        (store.getMeta(meta) as? JsonPrimitive)?.content?.let { sealed ->
            // Sealed under a vault key that's since changed: start again.
            val kept = runCatching { Json.parseToJsonElement(fromUtf8(open(key, fromB64u(sealed), bound))) as JsonObject }.getOrNull()
            val id = kept?.str("id")
            val raw = kept?.str("key")
            if (id != null && raw != null) {
                if (kept.str("first") == first) return id to raw
                // Another file's chunks, which nothing's going to finish. If this fails they go with the item.
                runCatching { api.attachmentDelete(v.id, id) }
            }
        }
        val fresh = randomUuid() to b64u(randomBytes(32))
        val plain = buildJsonObject {
            put("id", fresh.first)
            put("key", fresh.second)
            put("first", first)
        }.toString()
        store.setMeta(meta, JsonPrimitive(b64u(seal(key, utf8(plain), bound))))
        return fresh
    }

    /** Upload and record on the item. An item not on the server yet is synced first. An
     *  interrupted upload picks up where it stopped if the same file's chosen again: by name and
     *  size as on the web vault, and by its first chunk as well. */
    fun addAttachment(itemId: String, name: String, mime: String?, size: Long, read: (Long, Int) -> ByteArray, onProgress: (Int, Int) -> Unit = { _, _ -> }): Item {
        var item = get(itemId) ?: throw IllegalStateException("Unknown item")
        if (store.getItem(itemId)?.revision == 0 || store.getItem(itemId)?.dirty == true) sync()
        val meta = resumeMeta(item, name, size)
        // What an older version wrote for this file, with its name in the clear.
        store.deleteMeta("upload_resume:$itemId:$name:$size")
        // Read once: a file from Files is a stream that only goes forwards.
        val firstLength = minOf(size, Attachments.CHUNK.toLong()).toInt()
        val firstChunk = read(0, firstLength)
        val once: (Long, Int) -> ByteArray = { offset, length -> if (offset == 0L && length == firstLength) firstChunk else read(offset, length) }
        val ref = Attachments.upload(api, item.vaultId, itemId, name, mime, size, once, onProgress, resumeFor(item, meta, b64u(Primitives.sha256(firstChunk))))
        store.deleteMeta(meta)
        item = get(itemId) ?: item
        val updated = update(itemId, item.body.withAttachments(item.body.attachments + ref))
        sync()
        return updated
    }

    /** From Files into the vault, sealed here as it's read: `FromFiles`. The original stays. */
    fun addFromFiles(itemId: String, file: DriveFile, onProgress: (Int, Int) -> Unit = { _, _ -> }): Item {
        if (store.getItem(itemId)?.revision == 0 || store.getItem(itemId)?.dirty == true) sync()
        return api.driveContent(file.id) { input, length ->
            if (length >= 0 && length != file.sizeBytes) throw IllegalStateException("That file changed in Files. Try again.")
            addAttachment(itemId, file.name, file.mime, file.sizeBytes, Attachments.streamReader(input, file.sizeBytes), onProgress)
        }
    }

    /** Read back from the vault and compared with Files, before the original's offered for the Trash.
     *  A first chunk can match and the rest not. If they differ, what reached the vault is no use and
     *  comes out again. False if it can't be checked right now. */
    fun fromFilesMatches(itemId: String, file: DriveFile): Boolean {
        val item = get(itemId) ?: throw IllegalStateException("Unknown item")
        val ref = item.body.attachments.lastOrNull { it.name == file.name && it.size == file.sizeBytes } ?: throw IllegalStateException("That file didn't reach the vault. Try again.")
        val same = try {
            api.driveContent(file.id) { input, _ ->
                var matches = true
                Attachments.download(api, item.vaultId, itemId, ref, { part ->
                    var got = 0
                    val back = ByteArray(part.size)
                    while (got < back.size) {
                        val n = input.read(back, got, back.size - got)
                        if (n < 0) break
                        got += n
                    }
                    if (got != part.size || !back.contentEquals(part)) matches = false
                })
                matches && input.read() == -1
            }
        } catch (e: IllegalArgumentException) {
            false // The chunks themselves don't open, under the key that was recorded.
        } catch (e: Exception) {
            return false
        }
        if (same) return true
        removeAttachment(itemId, ref)
        throw IllegalStateException("What reached the vault didn't match the file in Files, so it's been taken out again. Try once more.")
    }

    fun removeAttachment(itemId: String, ref: AttachmentRef): Item {
        val item = get(itemId) ?: throw IllegalStateException("Unknown item")
        // Gone from the server first; if that fails the record stays, and it can be retried.
        try {
            api.attachmentDelete(item.vaultId, ref.id)
        } catch (e: ApiError) {
            if (e.status != 404) throw e
        }
        val updated = update(itemId, item.body.withAttachments(item.body.attachments.filter { it.id != ref.id }))
        sync()
        return updated
    }

    // ---- Folders, duplicates, Send records and site icons ----

    fun renameFolder(id: String, name: String): Item {
        val folder = get(id)?.takeIf { it.body.kind == "folder" } ?: throw IllegalStateException("Unknown folder")
        val clean = name.trim().take(80)
        require(clean.isNotEmpty()) { "A folder needs a name." }
        return update(id, folder.body.with("title" to JsonPrimitive(clean)))
    }

    /** The items in it stay, just out of the folder. */
    fun deleteFolder(id: String) {
        val folder = get(id)?.takeIf { it.body.kind == "folder" } ?: throw IllegalStateException("Unknown folder")
        for (i in allItems()) {
            if (i.body.str("folderId") == id && canEdit(i.vaultId)) update(i.id, i.body.with("folderId" to JsonNull))
        }
        trashItem(folder.id)
    }

    /** What can be merged here: a fill-only or view-only vault can't take the write. */
    fun duplicates(): List<List<Item>> = Duplicates.find(allItems().filter { canEdit(it.vaultId) })

    /** The newest stays and the others go to Trash, with nothing thrown away. An attachment on a
     *  copy has to be sealed again under the one that stays: its chunks are bound to their item, and
     *  they go with that item when it's purged. If that fails nothing has changed but some unused
     *  uploads, so it can be tried again. */
    fun mergeDuplicates(group: List<Item>, onProgress: (Int, Int) -> Unit = { _, _ -> }) {
        val m = Duplicates.merge(group)
        val own = m.keep.body.attachments.mapTo(HashSet()) { it.id }
        val moved = LinkedHashMap<String, AttachmentRef>()
        for (d in m.drop) {
            for (a in d.body.attachments) {
                if (a.id in own || a.id in moved) continue
                moved[a.id] = Attachments.rehome(api, m.keep.vaultId, d.id, m.keep.id, a, onProgress)
            }
        }
        val all = m.body.attachments.map { moved[it.id] ?: it }
        update(m.keep.id, m.body.with("attachments" to JsonArray(all.map { it.toJson() })))
        for (d in m.drop) trashItem(d.id)
        runCatching { sync() }
    }

    fun sendRecords(): Map<String, SendRecords.Record> = SendRecords.of(allItems(includeSystem = true), personalVaultId())

    /** Remembered in your own vault, so the server never knows what any of them are called. */
    fun recordSend(title: String, link: String, sendId: String): Item {
        val saved = saveNew(personalVaultId(), SendRecords.body(title, link, sendId))
        runCatching { sync() }
        return saved
    }

    fun deleteSend(sendId: String) {
        api.deleteSend(sendId)
        sendRecords()[sendId]?.let {
            trashItem(it.itemId)
            purgeItem(it.itemId)
        }
        runCatching { sync() }
    }

    fun iconVaults(): Set<String> = SiteIcons.iconVaults(allItems(includeSystem = true))

    /** Who gets a say over which vaults show site icons. Off unless turned on, per vault. */
    fun setVaultIcons(vaultId: String, on: Boolean) {
        val row = SiteIcons.prefsRow(allItems(includeSystem = true), vaultId)
        if (row != null) update(row.id, row.body.with("icon" to JsonPrimitive(on)))
        else saveNew(vaultId, newBody("prefs", SiteIcons.PREFS_TITLE, "icon" to JsonPrimitive(on)))
        runCatching { sync() }
    }

    /** When this phone last reached the server, across restarts. Null if it never has. */
    fun lastSync(): Long? = (store.getMeta(LAST_SYNC_META) as? JsonPrimitive)?.content?.toLongOrNull()

    /** The twice-yearly "do you still have your kit?". Kept on this device, as on the web. */
    fun recoveryChecked(): String? = (store.getMeta(RECOVERY_META) as? JsonPrimitive)?.content

    fun noteRecoveryChecked() = store.setMeta(RECOVERY_META, JsonPrimitive(isoNow()))

    /** Your recovery kit's Secret Key, to show again until it's confirmed. */
    fun encodedSecretKey(): String? = keeper.load()?.let { raw ->
        try {
            SecretKeys.encode(raw)
        } finally {
            raw.fill(0)
        }
    }

    // ---- New devices (CRYPTO_SPEC.md section 8) ----

    /** One answer to one request. The key to seal to travels with it, fixed when the words were
     *  worked out, so what's approved is what was compared and not whatever a later refresh of
     *  the list says. */
    class Approval(val requestId: String, val devicePub: String, val words: List<String>, val approverPub: String) {
        /** False if the request's gone or now names a different key: throw this answer away. */
        fun stillMatches(list: List<DeviceRequestOut>): Boolean = list.any { it.id == requestId && it.devicePub == devicePub }
    }

    /** On the unlocked device: answer a request. Returns the words to compare. */
    fun beginApproval(requestId: String, devicePub: String): Approval {
        val approverSk = randomBytes(32)
        val approverPub = Primitives.x25519Public(approverSk)
        approverSk.fill(0)
        api.deviceRequestApprover(requestId, b64u(approverPub))
        return Approval(requestId, devicePub, deviceSafetyWords(fromB64u(devicePub), approverPub), b64u(approverPub))
    }

    fun finishApproval(approval: Approval) {
        val s = need()
        val secretKey = keeper.load() ?: throw IllegalStateException("This device doesn't hold the Secret Key")
        val payload = buildJsonObject {
            put("secret_key", b64u(secretKey))
            put("account_id", s.accountId)
        }.toString()
        secretKey.fill(0)
        api.deviceRequestApprove(approval.requestId, b64u(sealTo(fromB64u(approval.devicePub), utf8(payload), aad(approval.requestId, "", "device_payload"))))
    }

    /** On the new device. Poll with `poll`, compare the words, then the key arrives. */
    fun requestDevice(name: String): DeviceJoin {
        val sk = randomBytes(32)
        val pub = Primitives.x25519Public(sk)
        val created = api.deviceRequestCreate(name, platform, b64u(pub))
        return DeviceJoin(this, created.id, created.code, created.pollSecret, sk, pub)
    }

    /** The scanner's check. The QR carries the request and the new device's key, so what's
     *  approved is what's on that screen. Anything else is refused, not guessed at. */
    fun requestForQr(text: String): DeviceRequestOut {
        val (id, pub) = DeviceQr.parse(text) ?: throw DeviceQr.Refused("That isn't a Promptly Passwords device code.")
        val found = api.deviceRequests().firstOrNull { it.id == id } ?: throw DeviceQr.Refused("That request has gone, or it's for another account.")
        if (found.devicePub != pub) throw DeviceQr.Refused("The server's copy of that request doesn't match the screen you scanned. Don't approve it.")
        return found
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

    /** For the QR on the new device's screen: the same exchange, with the key to expect. */
    val qrText: String get() = DeviceQr.text(id, pub)

    class State(val status: String, val words: List<String>?, val secretKey: ByteArray?)

    companion object {
        const val REFUSED = "refused"
    }

    /** "pending" until approved. Words appear as soon as the approver has posted its key,
     *  so the person can compare before approving. */
    fun poll(): State {
        val state = client.api.deviceRequestPoll(id, pollSecret)
        state.approverPub?.let { words = deviceSafetyWords(pub, fromB64u(it)) }
        val payload = state.payload
        if (state.status != "approved" || payload == null) return State(state.status, words, null)
        val plain = openSealed(sk, fromB64u(payload), aad(id, "", "device_payload"))
        val o = Json.parseToJsonElement(fromUtf8(plain)) as JsonObject
        val secretKey = fromB64u(o.str("secret_key") ?: return State(REFUSED, words, null))
        // It has to be this account's. A key from anywhere else is never saved, or used.
        val account = client.api.prelogin().accountId
        if (secretKey.size != 16 || account == null || o.str("account_id") != account) return State(REFUSED, words, null)
        client.keeper.save(secretKey)
        return State("approved", words, secretKey)
    }
}
