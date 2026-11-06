// What a hostile server can try, against the real client: hostile.test.ts, in Kotlin, plus the
// things only this client has. The server here is an OkHttp interceptor speaking the real API,
// so what goes over the wire is what's checked, and it reads and changes whatever it likes.
package org.promptly.sync.passwords

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.promptly.sync.passwords.core.KdfParams
import org.promptly.sync.passwords.core.KeyChangedError
import org.promptly.sync.passwords.core.MemoryKeeper
import org.promptly.sync.passwords.core.MemoryStore
import org.promptly.sync.passwords.core.Primitives
import org.promptly.sync.passwords.core.TrustBook
import org.promptly.sync.passwords.core.VaultApi
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.WrongPasswordError
import org.promptly.sync.passwords.core.aad
import org.promptly.sync.passwords.core.b64u
import org.promptly.sync.passwords.core.decryptItem
import org.promptly.sync.passwords.core.encryptItem
import org.promptly.sync.passwords.core.fromB64u
import org.promptly.sync.passwords.core.grantInput
import org.promptly.sync.passwords.core.newBody
import org.promptly.sync.passwords.core.openSealed
import org.promptly.sync.passwords.core.randomBytes
import org.promptly.sync.passwords.core.sealField
import org.promptly.sync.passwords.core.sealTo

private const val ALICE = "11111111-1111-4111-8111-111111111111"
private const val MASTER = "correct horse battery staple 7!"
private val JSON_TYPE = "application/json".toMediaType()

private class FV(
    val id: String, var kind: String, var revision: Int, var generation: Int, var name: String, var role: String,
    var wrapped: String, var signature: String, var grantedBy: String?, var memberGeneration: Int, var accepted: Boolean, var memberCount: Int, var rotateNeeded: Boolean = false,
)

private class FI(val id: String, val vaultId: String, var revision: Int, var blob: String?, var deleted: Boolean, var purged: Boolean)

private class FM(val userId: String, val username: String, var x: String?, var e: String?, var grant: JsonObject? = null, var role: String = "edit")

private class Persona(val username: String, val x: ByteArray = randomBytes(32), val e: ByteArray = randomBytes(32)) {
    val xPub = b64u(Primitives.x25519Public(x))
    val ePub = b64u(Primitives.ed25519Public(e))
}

private class HostileServer(val userId: String = ALICE) {
    var account: JsonObject? = null
    var sessionAccountId: String? = null
    val vaults = LinkedHashMap<String, FV>()
    val items = LinkedHashMap<String, FI>()
    val members = HashMap<String, MutableList<FM>>()
    val userKeys = HashMap<String, Persona>()
    var emergency: MutableList<JsonObject> = ArrayList()
    val wrapped = ArrayList<JsonObject>()
    val rotations = ArrayList<JsonObject>()
    val authKeys = ArrayList<String>()
    val writeGenerations = ArrayList<Int?>()
    val calls = ArrayList<String>()
    val requests = ArrayList<JsonObject>()
    var approvedPayload: String? = null
    var hideVault: String? = null
    var refuseNextWrite = false
    var omitWrapped = false
    var sessionKdf: JsonObject? = null
    var sessionWrapped: String? = null
    var preKdf: JsonObject? = null
    var pollPayload: ((String) -> String)? = null

    private fun str(o: JsonObject, k: String) = (o[k] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

    private fun session() = buildJsonObject {
        val a = account!!
        put("token", "t")
        put("account_id", sessionAccountId ?: str(a, "account_id"))
        put("wrapped_keyset", sessionWrapped ?: str(a, "wrapped_keyset"))
        put("kdf", sessionKdf ?: a["kdf"]!!)
        put("salt", str(a, "salt"))
        put("x25519_pub", str(a, "x25519_pub"))
        put("ed25519_pub", str(a, "ed25519_pub"))
        put("kit_confirmed", false)
        put("user_id", userId)
    }

    private fun vaultJson(v: FV) = buildJsonObject {
        put("id", v.id)
        put("kind", v.kind)
        put("revision", v.revision)
        put("generation", v.generation)
        put("name", v.name)
        put("role", v.role)
        put("wrapped_key", v.wrapped)
        put("signature", v.signature)
        put("granted_by", v.grantedBy)
        put("member_generation", v.memberGeneration)
        put("accepted", v.accepted)
        put("member_count", v.memberCount)
        put("rotate_needed", v.rotateNeeded)
    }

    private fun itemJson(i: FI) = buildJsonObject {
        put("id", i.id)
        put("revision", i.revision)
        put("blob", i.blob)
        put("deleted", i.deleted)
        put("purged", i.purged)
        put("updated_at", "2026-11-06T00:00:00Z")
    }

    private fun memberJson(m: FM) = buildJsonObject {
        put("user_id", m.userId)
        put("username", m.username)
        put("role", m.role)
        put("accepted", true)
        put("generation", 1)
        put("x25519_pub", m.x)
        put("ed25519_pub", m.e)
    }

    val interceptor = Interceptor { chain ->
        val req = chain.request()
        val path = req.url.encodedPath.removePrefix("/api/passwords")
        val body = req.body?.let { b ->
            val buf = Buffer()
            b.writeTo(buf)
            buf.readUtf8().takeIf { it.isNotEmpty() }?.let { Json.parseToJsonElement(it) as JsonObject }
        }
        calls += "${req.method} $path"
        val (status, out) = handle(req.method, path, req.url.queryParameter("since")?.toInt() ?: 0, body)
        Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(status).message("x")
            .body((out?.toString() ?: "").toResponseBody(JSON_TYPE)).build()
    }

    val http: OkHttpClient = OkHttpClient.Builder().addInterceptor(interceptor).build()
    val api get() = VaultApi("http://evil.invalid", { "t" }, http)

    private fun detail(s: String) = buildJsonObject { put("detail", s) }

    private fun handle(method: String, path: String, since: Int, b: JsonObject?): Pair<Int, JsonElement?> {
        val parts = path.trim('/').split('/')
        return when {
            method == "GET" && path == "/account" -> 200 to buildJsonObject {
                val a = account
                put("user_id", userId)
                put("exists", a != null)
                put("account_id", a?.let { str(it, "account_id") })
                put("wrapped_keyset", if (omitWrapped) null else a?.let { str(it, "wrapped_keyset") })
                put("kdf", preKdf ?: a?.get("kdf") ?: JsonNull)
                put("salt", a?.let { str(it, "salt") })
                put("min_kdf", buildJsonObject { put("alg", "argon2id"); put("m", 65536); put("t", 3); put("p", 1) })
                put("preview", false)
                put("enabled", true)
                put("server_time", "2026-11-06T00:00:00Z")
            }
            method == "POST" && path == "/account" -> {
                account = b
                val id = str(b!!, "personal_vault_id")!!
                val g = b["personal_vault_grant"]!!.jsonObject
                vaults[id] = FV(id, "personal", 0, 1, str(b, "personal_vault_name")!!, "manage", str(g, "wrapped_key")!!, str(g, "signature")!!, userId, 1, true, 1)
                200 to session()
            }
            method == "POST" && path == "/session" -> {
                authKeys += str(b!!, "auth_key")!!
                200 to session()
            }
            method == "DELETE" && path == "/session" -> 204 to null
            method == "POST" && path == "/account/rekey" -> {
                account = JsonObject(account!! + mapOf("kdf" to b!!["new_kdf"]!!, "salt" to b["new_salt"]!!, "wrapped_keyset" to b["new_wrapped_keyset"]!!))
                204 to null
            }
            method == "GET" && path == "/vaults" -> 200 to JsonArray(vaults.values.filter { it.id != hideVault }.map { vaultJson(it) })
            method == "POST" && path == "/vaults" -> {
                val id = str(b!!, "id")!!
                val g = b["grant"]!!.jsonObject
                vaults[id] = FV(id, "shared", 0, 1, str(b, "name")!!, "manage", str(g, "wrapped_key")!!, str(g, "signature")!!, userId, 1, true, 1)
                val a = account!!
                members[id] = mutableListOf(FM(userId, "alice", str(a, "x25519_pub"), str(a, "ed25519_pub"), role = "manage"))
                204 to null
            }
            parts[0] == "vaults" && parts.getOrNull(2) == "changes" -> {
                val v = vaults.getValue(parts[1])
                200 to buildJsonObject {
                    put("revision", v.revision)
                    put("generation", v.generation)
                    put("items", JsonArray(items.values.filter { it.vaultId == v.id && it.revision > since }.map { itemJson(it) }))
                    put("more", false)
                }
            }
            method == "POST" && parts[0] == "vaults" && parts.getOrNull(2) == "items" -> {
                val v = vaults.getValue(parts[1])
                val gen = (b!!["generation"] as? JsonPrimitive)?.content?.toInt()
                writeGenerations += gen
                if (refuseNextWrite || (gen != null && gen != v.generation)) {
                    refuseNextWrite = false
                    return 409 to detail("new key")
                }
                v.revision += 1
                val applied = buildJsonArray { }.toMutableList()
                val conflicts = ArrayList<JsonElement>()
                for (e in b["items"]!!.jsonArray) {
                    val w = e.jsonObject
                    val id = str(w, "id")!!
                    val base = str(w, "base_revision")?.toInt() ?: 0
                    val row = items[id]
                    if (row != null && row.revision > base) {
                        conflicts += buildJsonObject {
                            put("id", id)
                            put("reason", "changed")
                            put("revision", row.revision)
                            put("blob", row.blob)
                            put("deleted", row.deleted)
                        }
                        continue
                    }
                    val blob = str(w, "blob")
                    items[id] = FI(id, v.id, v.revision, blob, str(w, "deleted") == "true", blob == null)
                    applied += JsonPrimitive(id)
                }
                200 to buildJsonObject {
                    put("revision", v.revision)
                    put("applied", JsonArray(applied))
                    put("conflicts", JsonArray(conflicts))
                }
            }
            parts[0] == "vaults" && parts.size == 5 && parts[4] == "versions" -> 200 to JsonArray(emptyList())
            method == "GET" && parts[0] == "vaults" && parts.getOrNull(2) == "members" -> 200 to JsonArray((members[parts[1]] ?: emptyList<FM>()).map { memberJson(it) })
            method == "POST" && parts[0] == "vaults" && parts.getOrNull(2) == "members" -> {
                val uid = str(b!!, "user_id")!!
                val p = userKeys.getValue(uid)
                members.getOrPut(parts[1]) { ArrayList() } += FM(uid, p.username, p.xPub, p.ePub, b["grant"]!!.jsonObject, str(b, "role") ?: "view")
                vaults[parts[1]]?.let { it.memberCount += 1 }
                204 to null
            }
            method == "DELETE" && parts[0] == "vaults" && parts.getOrNull(2) == "members" -> {
                calls += "cut ${parts[3]}"
                members[parts[1]]?.removeAll { it.userId == parts[3] }
                vaults[parts[1]]?.let { it.memberCount -= 1 }
                204 to null
            }
            method == "POST" && parts[0] == "vaults" && parts.getOrNull(2) == "accept" -> 204 to null
            method == "POST" && parts[0] == "vaults" && parts.getOrNull(2) == "rotate" -> {
                rotations += b!!
                val v = vaults.getValue(parts[1])
                v.generation += 1
                v.revision += 1
                v.name = str(b, "name")!!
                v.rotateNeeded = false
                val list = b["members"]!!.jsonArray.map { it.jsonObject }
                val mine = list.first { str(it, "user_id") == userId }["grant"]!!.jsonObject
                v.wrapped = str(mine, "wrapped_key")!!
                v.signature = str(mine, "signature")!!
                v.memberGeneration = v.generation
                for (m in list) members[v.id]?.firstOrNull { it.userId == str(m, "user_id") }?.grant = m["grant"]!!.jsonObject
                for (e in b["items"]!!.jsonArray) {
                    val i = items.getValue(str(e.jsonObject, "id")!!)
                    i.blob = str(e.jsonObject, "blob")
                    i.revision = v.revision
                }
                204 to null
            }
            method == "GET" && parts[0] == "users" -> {
                val p = userKeys[parts[1]] ?: return 404 to detail("no such user")
                200 to buildJsonObject {
                    put("user_id", parts[1])
                    put("username", p.username)
                    put("x25519_pub", p.xPub)
                    put("ed25519_pub", p.ePub)
                }
            }
            method == "GET" && path == "/emergency" -> 200 to JsonArray(emergency)
            method == "POST" && path == "/emergency" -> {
                emergency.add(emergencyRow("real", str(b!!, "grantee_id")!!, "accepted"))
                200 to emergency.last()
            }
            method == "PUT" && parts[0] == "emergency" && parts.getOrNull(2) == "wrap" -> {
                wrapped += b!!
                204 to null
            }
            method == "POST" && parts[0] == "emergency" && parts.getOrNull(2) == "open" -> 200 to emergency.first { str(it, "id") == parts[1] }
            method == "DELETE" && parts[0] == "emergency" -> {
                calls += "emergency-deleted"
                emergency.removeAll { str(it, "id") == parts[1] }
                204 to null
            }
            method == "POST" && path == "/device-requests" -> {
                requests += buildJsonObject {
                    put("id", "req-1")
                    put("name", "phone")
                    put("platform", "android")
                    put("code", "ABC")
                    put("device_pub", str(b!!, "device_pub"))
                    put("status", "pending")
                }
                200 to buildJsonObject { put("id", "req-1"); put("code", "ABC"); put("poll_secret", "p") }
            }
            method == "GET" && path == "/device-requests" -> 200 to JsonArray(requests)
            parts[0] == "device-requests" && parts.getOrNull(2) == "poll" -> 200 to buildJsonObject {
                put("status", "approved")
                put("approver_pub", b64u(randomBytes(32)))
                put("payload", pollPayload!!(str(requests.last(), "device_pub")!!))
            }
            parts[0] == "device-requests" && parts.getOrNull(2) == "approver" -> 204 to null
            parts[0] == "device-requests" && parts.getOrNull(2) == "approve" -> {
                approvedPayload = str(b!!, "payload")
                204 to null
            }
            else -> error("unhandled $method $path")
        }
    }

    fun emergencyRow(id: String, grantee: String, state: String, openedVaults: List<String> = emptyList(), grantor: String = userId) = buildJsonObject {
        put("id", id)
        put("grantor_id", grantor)
        put("grantor", "alice")
        put("grantee_id", grantee)
        put("grantee", "contact")
        put("wait_days", 3)
        put("state", state)
        put("wrapped", JsonObject(emptyMap()))
        put("opened_vaults", JsonArray(openedVaults.map { JsonPrimitive(it) }))
    }
}

class HostileTest {
    init {
        Fixtures.setup()
    }

    private class World(val s: HostileServer, val c: VaultClient, val secretKey: ByteArray, val store: MemoryStore)

    private fun fresh(store: MemoryStore = MemoryStore()): World {
        val s = HostileServer()
        val c = VaultClient(s.api, store, MemoryKeeper())
        val key = c.setup(MASTER)
        return World(s, c, key, store)
    }

    private val bobId = "22222222-2222-4222-8222-222222222222"
    private val carolId = "33333333-3333-4333-8333-333333333333"
    private val malloryId = "44444444-4444-4444-8444-444444444444"
    private val danaId = "77777777-7777-4777-8777-777777777777"

    /** A vault someone else shared with Alice, signed by them, with the server calling it what it likes. */
    private fun invite(w: World, from: Persona, fromId: String, vaultId: String, name: String, kind: String = "shared", accepted: Boolean = true, role: String = "view"): ByteArray {
        val me = w.store.getAccount()!!
        val k = randomBytes(32)
        val wrapped = sealTo(fromB64u(me.x25519Pub), k, aad(vaultId, "", "vault_key:$ALICE"))
        val sig = Primitives.ed25519Sign(from.e, grantInput(vaultId, ALICE, 1, wrapped))
        w.s.vaults[vaultId] = FV(vaultId, kind, 0, 1, sealField(k, vaultId, "name", JsonPrimitive(name)), role, b64u(wrapped), b64u(sig), fromId, 1, accepted, 2)
        return k
    }

    private fun opened(p: Persona, vaultId: String, memberId: String, grant: JsonObject) =
        openSealed(p.x, fromB64u(grant["wrapped_key"]!!.jsonPrimitive.content), aad(vaultId, "", "vault_key:$memberId"))

    // ---- From the independent review: each of these worked before ----

    private fun kdfJson(m: Int) = buildJsonObject { put("alg", "argon2id"); put("m", m); put("t", 3); put("p", 1) }

    private fun payloadFor(secret: ByteArray, account: String?): (String) -> String = { pub ->
        val plain = buildJsonObject {
            put("secret_key", b64u(secret))
            if (account != null) put("account_id", account)
        }.toString()
        b64u(sealTo(fromB64u(pub), plain.toByteArray(), aad("req-1", "", "device_payload")))
    }

    @Test fun leavingOutTheKeysetGetsNoAuthKey() {
        val w = fresh()
        val attackerKey = randomBytes(16)
        val before = w.s.authKeys.size
        w.s.omitWrapped = true
        val phone = VaultClient(w.s.api, MemoryStore(), MemoryKeeper())
        val e = assertThrows(IllegalStateException::class.java) { phone.unlock(MASTER, attackerKey) }
        assertTrue(e.message, e.message!!.contains("nothing was sent"))
        assertEquals(before, w.s.authKeys.size)
        // The same for a device that already has its copy.
        w.c.lock()
        assertThrows(IllegalStateException::class.java) { w.c.unlock(MASTER) }
        assertEquals(before, w.s.authKeys.size)
    }

    @Test fun aSecretKeyChosenByTheServerIsNotSavedOrUsed() {
        val w = fresh()
        val attackerKey = randomBytes(16)
        val before = w.s.authKeys.size
        for (account in listOf("whatever", null)) {
            w.s.pollPayload = payloadFor(attackerKey, account)
            val phone = VaultClient(w.s.api, MemoryStore(), MemoryKeeper())
            val st = phone.requestDevice("new phone").poll()
            assertEquals(org.promptly.sync.passwords.core.DeviceJoin.REFUSED, st.status)
            assertFalse(phone.keeper.has())
        }
        // With the right account named it's kept, and the keyset check is what stops it.
        w.s.pollPayload = payloadFor(attackerKey, w.store.getAccount()!!.accountId)
        val phone = VaultClient(w.s.api, MemoryStore(), MemoryKeeper())
        assertEquals("approved", phone.requestDevice("new phone").poll().status)
        assertThrows(WrongPasswordError::class.java) { phone.unlock(MASTER) }
        assertEquals(before, w.s.authKeys.size)
    }

    @Test fun aSessionCantLowerTheKeySettings() {
        val s = HostileServer()
        val store = MemoryStore()
        val c = VaultClient(s.api, store, MemoryKeeper())
        c.setup(MASTER, KdfParams("argon2id", 131072, 3, 1))
        c.lock()
        s.sessionKdf = kdfJson(65536)
        val e = assertThrows(IllegalStateException::class.java) { c.unlock(MASTER) }
        assertTrue(e.message, e.message!!.contains("weaker"))
        assertEquals(131072, store.getAccount()!!.kdf.m)
        // So prelogin can't follow it down either, keyset or no keyset.
        s.sessionKdf = null
        s.preKdf = kdfJson(65536)
        s.omitWrapped = true
        val before = s.authKeys.size
        assertThrows(IllegalStateException::class.java) { c.unlock(MASTER) }
        assertEquals(before, s.authKeys.size)
    }

    @Test fun whatAKeySessionStoresIsWhatRealOpened() {
        val s = HostileServer()
        val store = MemoryStore()
        val c = VaultClient(s.api, store, MemoryKeeper())
        c.setup(MASTER)
        val good = store.getAccount()!!
        c.lock()
        // A keyset that doesn't open isn't stored.
        s.sessionWrapped = b64u(randomBytes(200))
        assertThrows(WrongPasswordError::class.java) { c.unlock(MASTER) }
        assertEquals(good.wrappedKeyset, store.getAccount()!!.wrappedKeyset)
        s.sessionWrapped = null
        // Settings stronger than what the key was really made with aren't believed.
        s.sessionKdf = kdfJson(1048576)
        c.unlock(MASTER)
        assertEquals(good.kdf.m, store.getAccount()!!.kdf.m)
        s.sessionKdf = null
        // Re-proving has no password to check a new keyset with, so what's here stays.
        s.sessionWrapped = b64u(randomBytes(200))
        c.reprove()
        assertEquals(good.wrappedKeyset, store.getAccount()!!.wrappedKeyset)
        c.lock()
        assertThrows(WrongPasswordError::class.java) { c.unlock(MASTER) }
        assertEquals(good.wrappedKeyset, store.getAccount()!!.wrappedKeyset)
    }

    @Test fun anImportedTrustBookMakesNobodyAContact() {
        val w = fresh()
        val evil = Persona("mallory")
        w.s.userKeys[malloryId] = evil
        w.s.emergency = mutableListOf(w.s.emergencyRow("e1", malloryId, "accepted"))
        val file = """{"format":"promptly-pw-plain","version":1,"items":[
          {"v":1,"kind":"login","title":"Team wifi portal","username":"guest","password":"guest"},
          {"v":1,"kind":"trust","title":"trust-book","trustBook":{"people":{"$malloryId":{"x25519":"${evil.xPub}","ed25519":"${evil.ePub}","firstSeen":"2026-01-01T00:00:00.000Z"}},"accepted":[],"contacts":["$malloryId"],"generations":{}}}
        ]}"""
        val res = org.promptly.sync.passwords.core.Importers.importFile("team.json", file.toByteArray())
        val vault = w.c.personalVaultId()
        for (it in res.items) w.c.saveNew(vault, it.body)
        w.c.sync()
        w.c.sync()
        assertEquals(emptyList<JsonObject>(), w.s.wrapped)
        assertNull(w.c.trustEntries()[malloryId])
        assertEquals(1, w.c.allItems(includeSystem = true).count { it.body.kind == "trust" })
    }

    // ---- The attacks in hostile.test.ts ----

    @Test fun cantMakeUpAnEmergencyContactAndBeHandedTheVaultKeys() {
        val w = fresh()
        w.c.saveNew(w.c.personalVaultId(), newBody("login", "Bank").withText("password", "hunter2-secret"))
        w.c.sync()
        val fake = "99999999-9999-4999-8999-999999999999"
        w.s.userKeys[fake] = Persona("nobody")
        w.s.emergency = mutableListOf(w.s.emergencyRow("e1", fake, "accepted"))
        w.c.sync()
        assertEquals(emptyList<JsonObject>(), w.s.wrapped)
    }

    @Test fun someoneYouShareWithIsntAContactBecauseTheServerSaysSo() {
        val w = fresh()
        val vid = w.c.createSharedVault("Team")
        w.s.userKeys[bobId] = Persona("bob")
        w.c.addMember(vid, bobId, "edit")
        // Bob's keys are pinned, and they're right. He still never got named as a contact.
        assertNotNull(w.c.trustEntries()[bobId])
        w.s.emergency = mutableListOf(w.s.emergencyRow("e1", bobId, "accepted"))
        w.c.sync()
        assertEquals(emptyList<JsonObject>(), w.s.wrapped)
    }

    @Test fun sealsToAChosenContactAndStopsIfTheirKeysChange() {
        val w = fresh()
        w.s.userKeys[carolId] = Persona("carol")
        w.c.markVerified(carolId)
        w.c.emergencyInvite(carolId, 3)
        w.c.sync()
        assertEquals(1, w.s.wrapped.size)
        assertEquals(1, w.s.wrapped[0]["grants"]!!.jsonArray.size)

        // Same person, new keys: the server's swapped them in. Nothing more goes out.
        w.s.wrapped.clear()
        w.s.userKeys[carolId] = Persona("carol")
        val v = w.s.vaults.getValue(w.c.personalVaultId())
        v.generation += 1
        v.memberGeneration = 1
        w.c.sync()
        assertEquals(emptyList<JsonObject>(), w.s.wrapped)
    }

    /** A contact not pinned yet: the server answers with a key of its own, marks the row accepted,
     *  and every look at the screen tries to seal. Naming someone isn't enough. */
    @Test fun nothingIsSealedToAContactUntilTheirWordsAreCompared() {
        val w = fresh()
        w.c.saveNew(w.c.personalVaultId(), newBody("login", "Bank").withText("password", "hunter2-secret"))
        w.c.sync()
        val servers = Persona("carol")
        w.s.userKeys[carolId] = servers
        w.c.emergencyInvite(carolId, 3)
        assertEquals("Named, and pinned on what the server said", false, w.c.trustEntries()[carolId]?.verified)
        repeat(3) { w.c.refreshEmergency() }
        w.c.sync()
        assertEquals("Sealed on the server's word", emptyList<JsonObject>(), w.s.wrapped)

        // The person compares the words with the real Carol's: the server's are what's on screen, and
        // she'd read out others. Here they did match, and only now does anything go.
        w.c.markVerified(carolId, w.c.identityWordsFor(carolId))
        assertEquals(true, w.c.trustEntries()[carolId]?.verified)
        w.c.refreshEmergency()
        assertEquals(1, w.s.wrapped.size)
    }

    @Test fun aKeySwappedAfterComparingSealsNothingAndHasToBeComparedAgain() {
        val w = fresh()
        w.s.userKeys[carolId] = Persona("carol")
        w.c.markVerified(carolId, w.c.identityWordsFor(carolId))
        w.c.emergencyInvite(carolId, 3)
        w.c.refreshEmergency()
        assertEquals(1, w.s.wrapped.size)
        w.s.wrapped.clear()

        val swapped = Persona("carol")
        w.s.userKeys[carolId] = swapped
        val v = w.s.vaults.getValue(w.c.personalVaultId())
        v.generation += 1
        v.memberGeneration = 1
        w.c.sync()
        w.c.refreshEmergency()
        assertEquals(emptyList<JsonObject>(), w.s.wrapped)

        // Accepting the new key isn't comparing its words.
        w.c.acceptChangedKey(carolId)
        assertEquals(swapped.ePub, w.c.trustEntries()[carolId]?.ed25519)
        assertEquals(false, w.c.trustEntries()[carolId]?.verified)
        w.c.sync()
        w.c.refreshEmergency()
        assertEquals(emptyList<JsonObject>(), w.s.wrapped)
        w.c.markVerified(carolId, w.c.identityWordsFor(carolId))
        w.c.refreshEmergency()
        assertEquals(1, w.s.wrapped.size)
    }

    /** One person's words on screen, and another's keys when "They match" reads them again. */
    @Test fun wordsShownForOneKeyDontVouchForAnother() {
        val w = fresh()
        w.s.userKeys[carolId] = Persona("carol")
        val shown = w.c.identityWordsFor(carolId)
        w.s.userKeys[carolId] = Persona("carol")
        assertThrows(KeyChangedError::class.java) { w.c.markVerified(carolId, shown) }
        assertNull("Nothing remembered", w.c.trustEntries()[carolId])
    }

    /** The server tells this phone the right signing key and its own encryption key. Words compared
     *  on another device, on the real keys, reach this phone through the trust book. They don't
     *  vouch for what's pinned here. */
    @Test fun wordsComparedOnAnotherDeviceOnlyVouchForTheKeysItSaw() {
        val w = fresh()
        val carol = Persona("carol")
        val half = Persona("carol", randomBytes(32), carol.e)
        val other = VaultClient(w.s.api, MemoryStore(), MemoryKeeper())
        other.unlock(MASTER, w.secretKey)

        // Each device on its own, before either has the other's book.
        w.s.userKeys[carolId] = carol
        w.c.markVerified(carolId, w.c.identityWordsFor(carolId))
        w.s.userKeys[carolId] = half
        other.emergencyInvite(carolId, 3)
        w.c.sync()
        assertEquals(true, w.c.trustEntries()[carolId]?.verified)
        assertEquals(carol.xPub, w.c.trustEntries()[carolId]?.x25519)

        other.sync()
        other.sync()
        assertEquals(half.xPub, other.trustEntries()[carolId]?.x25519)
        assertEquals(false, other.trustEntries()[carolId]?.verified)
        other.refreshEmergency()
        assertEquals(emptyList<JsonObject>(), w.s.wrapped)
    }

    @Test fun cantGetANewVaultKeySealedToSomeoneElseWhenAMemberIsRemoved() {
        val w = fresh()
        val vid = w.c.createSharedVault("Team")
        val bob = Persona("bob")
        w.s.userKeys[bobId] = bob
        w.s.userKeys[carolId] = Persona("carol")
        w.c.addMember(vid, bobId, "edit")
        w.c.addMember(vid, carolId, "edit")

        // A pinned member's key swapped in the list.
        val row = w.s.members.getValue(vid).first { it.userId == bobId }
        val honest = row.x
        row.x = Persona("evil").xPub
        assertThrows(KeyChangedError::class.java) { w.c.removeMembers(vid, listOf(carolId)) }
        assertEquals(emptyList<JsonObject>(), w.s.rotations)
        row.x = honest

        // Somebody slipped into the list, with no say from anyone.
        val evil = Persona("newcomer")
        val evilId = "66666666-6666-4666-8666-666666666666"
        w.s.members.getValue(vid) += FM(evilId, "newcomer", evil.xPub, evil.ePub)
        val e = assertThrows(IllegalStateException::class.java) { w.c.removeMembers(vid, listOf(carolId)) }
        assertTrue(e.message, e.message!!.contains("Check who gets the new key"))
        assertEquals(emptyList<JsonObject>(), w.s.rotations)
        // Nobody's cut off before the check passes either.
        assertFalse(w.s.calls.any { it.startsWith("cut ") })
        // It's named, for the person to decide.
        assertEquals(false, w.c.rotationPlan(vid, listOf(carolId)).first { it.userId == evilId }.known)
    }

    @Test fun cantPlantAVaultAsYourPersonalOneOrSwapTheRealOnesKey() {
        // A store that lists vaults by id, so the planted one comes first, as IndexedDB would.
        val w = fresh(SortedStore())
        val realId = w.c.personalVaultId()
        val evil = Persona("alice")
        val fake = "00000000-0000-4000-8000-00000000abcd"
        w.s.userKeys[fake] = evil
        val phantom = "00000000-0000-4000-8000-000000000001"
        invite(w, evil, fake, phantom, "Personal", kind = "personal", role = "manage")
        w.c.sync()
        assertEquals(realId, w.c.personalVaultId())
        // It's filed as what it is: somebody else's vault, waiting to be accepted.
        assertEquals("shared", w.store.getVaults().first { it.id == phantom }.kind)
        // Nothing from it opens, and new saves go to the real one.
        w.s.items["planted"] = FI("planted", phantom, 1, "x", deleted = false, purged = false)
        w.s.vaults.getValue(phantom).revision = 1
        w.c.sync()
        assertFalse(w.c.allItems(includeSystem = true).any { it.vaultId == phantom })

        // And the real one's grant replaced outright with one the server signed.
        val me = w.store.getAccount()!!
        val k2 = randomBytes(32)
        val w2 = sealTo(fromB64u(me.x25519Pub), k2, aad(realId, "", "vault_key:$ALICE"))
        val v = w.s.vaults.getValue(realId)
        v.wrapped = b64u(w2)
        v.signature = b64u(Primitives.ed25519Sign(evil.e, grantInput(realId, ALICE, 2, w2)))
        v.grantedBy = fake
        v.memberGeneration = 2
        v.generation = 2
        val r = w.c.sync()
        assertTrue(realId in r.rollback)
        assertEquals(realId, w.c.personalVaultId())
        assertEquals(ALICE, w.store.getVaults().first { it.id == realId }.grantedBy)
        val saved = w.c.saveNew(realId, newBody("login", "After").withText("password", "secret-3"))
        w.c.sync()
        w.s.items[saved.id]?.blob?.let { blob -> assertThrows(Exception::class.java) { decryptItem(k2, realId, saved.id, fromB64u(blob)) } }
    }

    @Test fun cantOpenASharedVaultJustBySayingYouAcceptedIt() {
        val w = fresh()
        val dana = Persona("dana")
        w.s.userKeys[danaId] = dana
        val vid = "88888888-8888-4888-8888-888888888888"
        val k = invite(w, dana, danaId, vid, "Shared")
        val itemBlob = b64u(encryptItem(k, vid, "i-1", newBody("login", "Dana's").withText("password", "dana-1")))
        w.s.items["i-1"] = FI("i-1", vid, 1, itemBlob, deleted = false, purged = false)
        w.s.vaults.getValue(vid).revision = 1
        w.c.sync()
        assertNull("background sync pinned someone", w.c.trustEntries()[danaId])
        assertEquals("(can't open)", w.c.vaults().first { it.vault.id == vid }.displayName)
        assertNull(w.c.get("i-1"))
        assertFalse(w.c.chosen(w.store.getVaults().first { it.id == vid }))
        // Looking at their words isn't trusting them.
        assertTrue(w.c.identityWordsFor(danaId).isNotEmpty())
        assertNull("viewing words pinned someone", w.c.trustEntries()[danaId])
        // Nor is locking and unlocking.
        w.c.lock()
        w.c.unlock(MASTER)
        assertNull(w.c.trustEntries()[danaId])
        assertNull(w.c.get("i-1"))

        // The person accepts: now it opens, on the keys they were shown.
        w.c.acceptVault(vid)
        assertEquals("Shared", w.c.vaults().first { it.vault.id == vid }.displayName)
        assertEquals(dana.ePub, w.c.trustEntries()[danaId]?.ed25519)
        assertEquals("dana-1", w.c.get("i-1")!!.body.password)
    }

    @Test fun cantBringBackAnOldVaultKeyAfterSomeoneIsRemoved() {
        val w = fresh()
        val vid = w.c.createSharedVault("Team")
        val mallory = Persona("mallory")
        w.s.userKeys[malloryId] = mallory
        w.c.addMember(vid, malloryId, "edit")
        val m = w.s.members.getValue(vid).first { it.userId == malloryId }
        val k1 = opened(mallory, vid, malloryId, m.grant!!)
        val v = w.s.vaults.getValue(vid)
        val oldWrapped = v.wrapped
        val oldSig = v.signature
        val oldName = v.name
        w.c.removeMembers(vid, listOf(malloryId))
        v.wrapped = oldWrapped
        v.signature = oldSig
        v.name = oldName
        v.memberGeneration = 1
        v.generation = 1
        v.revision += 5
        val r = w.c.sync()
        assertTrue(vid in r.rollback)
        val after = w.c.saveNew(vid, newBody("login", "After removal").withText("password", "for-remaining-members"))
        w.c.sync()
        w.s.items[after.id]?.blob?.let { blob -> assertThrows(Exception::class.java) { decryptItem(k1, vid, after.id, fromB64u(blob)) } }
    }

    @Test fun cantServeAnOlderCopyOfAnItemWhateverRevisionItClaims() {
        val w = fresh()
        val vid = w.c.personalVaultId()
        val it1 = w.c.saveNew(vid, newBody("login", "Mail").withText("password", "old-compromised"))
        w.c.sync()
        val oldBlob = w.s.items.getValue(it1.id).blob
        w.c.update(it1.id, w.c.get(it1.id)!!.body.withText("password", "new-strong"))
        w.c.sync()
        val v = w.s.vaults.getValue(vid)
        v.revision += 100
        w.s.items.getValue(it1.id).blob = oldBlob
        w.s.items.getValue(it1.id).revision = v.revision
        val r = w.c.sync()
        assertTrue(vid in r.rollback)
        assertEquals("new-strong", w.c.get(it1.id)!!.body.password)
        // And it's not the copy kept on the device either.
        w.c.lock()
        w.c.unlock(MASTER)
        assertEquals("new-strong", w.c.get(it1.id)!!.body.password)
    }

    @Test fun cantWipeADeviceByClaimingADifferentAccount() {
        val w = fresh()
        val vid = w.c.createSharedVault("Team")
        w.s.userKeys[bobId] = Persona("bob")
        w.c.addMember(vid, bobId, "edit")
        w.c.lock()
        w.s.sessionAccountId = "deadbeef-dead-4ead-8ead-deadbeefdead"
        assertThrows(WrongPasswordError::class.java) { w.c.unlock(MASTER) }
        assertNotNull((w.store.getMeta("trust") as JsonObject)[bobId])
        assertTrue(w.store.getVaults().isNotEmpty())
        w.s.sessionAccountId = null
        w.c.unlock(MASTER)
        assertTrue(w.c.unlocked)
        assertNotNull(w.c.trustEntries()[bobId])
    }

    @Test fun cantGetAPasswordGuessOutOfASecretKeyItMadeUp() {
        val w = fresh()
        val d = VaultClient(w.s.api, MemoryStore(), MemoryKeeper())
        val forged = randomBytes(16)
        val before = w.s.authKeys.size
        assertThrows(WrongPasswordError::class.java) { d.unlock(MASTER, forged) }
        // Nothing derived from the password left the device.
        assertEquals(before, w.s.authKeys.size)
    }

    @Test fun cantGetWeakerKeySettingsAccepted() {
        val w = fresh()
        w.c.upgradeKdf(MASTER, KdfParams("argon2id", 131072, 3, 1))
        w.c.lock()
        val weaker = buildJsonObject { put("alg", "argon2id"); put("m", 65536); put("t", 3); put("p", 1) }
        val before = w.s.authKeys.size
        w.s.account = JsonObject(w.s.account!! + mapOf("kdf" to weaker))
        val e = assertThrows(IllegalStateException::class.java) { w.c.unlock(MASTER) }
        assertTrue(e.message, e.message!!.contains("weaker"))
        assertEquals(before, w.s.authKeys.size)
    }

    @Test fun kdfOnlyEverGoesUp() {
        val w = fresh()
        w.c.upgradeKdf(MASTER, KdfParams("argon2id", 131072, 4, 1))
        w.c.upgradeKdf(MASTER, KdfParams("argon2id", 65536, 3, 1))
        val k = w.c.currentKdf()!!
        assertEquals(131072, k.m)
        assertEquals(4, k.t)
    }

    @Test fun aDeviceThatMissedAKeyChangeMovesItsEditsToTheNewKey() {
        val w = fresh()
        val vid = w.c.createSharedVault("Team")
        val mallory = Persona("mallory")
        w.s.userKeys[malloryId] = mallory
        w.c.addMember(vid, malloryId, "edit")
        val k1 = opened(mallory, vid, malloryId, w.s.members.getValue(vid).first { it.userId == malloryId }.grant!!)
        w.c.sync()
        val c2 = VaultClient(w.s.api, MemoryStore(), MemoryKeeper())
        c2.unlock(MASTER, w.secretKey)
        val offline = c2.saveNew(vid, newBody("login", "Added offline").withText("password", "written-before-seeing-rotation"))
        w.c.removeMembers(vid, listOf(malloryId))
        c2.sync()
        val row = w.s.items[offline.id]
        assertNotNull(row)
        assertThrows(Exception::class.java) { decryptItem(k1, vid, offline.id, fromB64u(row!!.blob!!)) }
        w.c.sync()
        assertEquals("written-before-seeing-rotation", w.c.get(offline.id)?.body?.password)
    }

    @Test fun aMembersJunkBlobDoesntStopThemBeingRotatedOut() {
        val w = fresh()
        val vid = w.c.createSharedVault("Team")
        w.s.userKeys[malloryId] = Persona("mallory")
        w.c.addMember(vid, malloryId, "edit")
        w.c.saveNew(vid, newBody("login", "Real").withText("password", "real"))
        w.c.sync()
        val v = w.s.vaults.getValue(vid)
        v.revision += 1
        val poison = "11111111-aaaa-4aaa-8aaa-111111111111"
        w.s.items[poison] = FI(poison, vid, v.revision, b64u(randomBytes(200)), deleted = false, purged = false)
        w.c.sync()
        val list = w.c.removeMembers(vid, listOf(malloryId))
        assertEquals(listOf("Real"), list.map { it.body.title })
        assertEquals(1, w.s.rotations.size)
        assertFalse(w.s.rotations[0]["items"]!!.jsonArray.any { it.jsonObject["id"]!!.jsonPrimitive.content == poison })
    }

    // ---- The rest of the review's list, and what's only on this client ----

    @Test fun rotationCutsAccessFirstAndUsesTheCurrentRevision() {
        val w = fresh()
        val vid = w.c.createSharedVault("Team")
        w.s.userKeys[malloryId] = Persona("mallory")
        w.c.addMember(vid, malloryId, "edit")
        w.c.removeMembers(vid, listOf(malloryId))
        val cut = w.s.calls.indexOf("cut $malloryId")
        val rotate = w.s.calls.indexOf("POST /vaults/$vid/rotate")
        assertTrue("cut at $cut, rotate at $rotate", cut in 0 until rotate)
        val body = w.s.rotations.single()
        assertEquals(JsonArray(emptyList()), body["remove_user_ids"])
        assertNotNull(body["from_revision"])
        // Nothing sealed to the one who left, and our own key isn't taken from the list.
        assertFalse(body["members"]!!.jsonArray.any { it.jsonObject["user_id"]!!.jsonPrimitive.content == malloryId })
    }

    @Test fun ownKeyIsNeverTakenFromTheMemberList() {
        val w = fresh()
        val vid = w.c.createSharedVault("Team")
        val row = w.s.members.getValue(vid).first { it.userId == ALICE }
        row.x = Persona("evil").xPub
        w.c.removeMembers(vid, emptyList())
        assertEquals(1, w.s.rotations.size)
        // Sealed to the key we hold: the new grant opens with it, and that's the one in use.
        val mine = w.s.rotations[0]["members"]!!.jsonArray.map { it.jsonObject }.first { it["user_id"]!!.jsonPrimitive.content == ALICE }["grant"]!!.jsonObject
        val account = w.store.getAccount()!!
        val keyset = org.promptly.sync.passwords.core.unwrapKeyset(
            org.promptly.sync.passwords.core.deriveRoot(MASTER, w.secretKey, fromB64u(account.salt), account.kdf).unlock, account.accountId, fromB64u(account.wrappedKeyset),
        )
        assertEquals(32, openSealed(keyset.x25519, fromB64u(mine["wrapped_key"]!!.jsonPrimitive.content), aad(vid, "", "vault_key:$ALICE")).size)
        assertEquals(2, w.store.getVaults().first { it.id == vid }.memberGeneration)
        w.c.lock()
        w.c.unlock(MASTER)
        assertEquals("Team", w.c.vaults().first { it.vault.id == vid }.displayName)
    }

    @Test fun aFailedRotationLeavesAChangeTheKeyPrompt() {
        val w = fresh()
        val vid = w.c.createSharedVault("Team")
        w.s.vaults.getValue(vid).rotateNeeded = true
        w.c.sync()
        assertTrue(w.store.getVaults().first { it.id == vid }.rotateNeeded)
        w.c.removeMembers(vid, emptyList())
        assertFalse(w.store.getVaults().first { it.id == vid }.rotateNeeded)
    }

    @Test fun generationGoesWithEveryWriteAnd409MeansSyncAgain() {
        val w = fresh()
        val vid = w.c.personalVaultId()
        w.c.saveNew(vid, newBody("login", "L").withText("password", "p"))
        w.c.sync()
        assertTrue(w.s.writeGenerations.isNotEmpty())
        assertTrue(w.s.writeGenerations.all { it == 1 })
        // A new key appeared between the list and the write. It's refused, and nothing's lost.
        val edited = w.c.saveNew(vid, newBody("login", "M").withText("password", "q"))
        w.s.refuseNextWrite = true
        val r = w.c.sync()
        assertFalse(r.offline)
        assertTrue(w.store.getItem(edited.id)!!.dirty)
        w.c.sync()
        assertFalse(w.store.getItem(edited.id)!!.dirty)
    }

    @Test fun aConflictThatCantDecryptDoesntAbortSync() {
        val w = fresh()
        val vid = w.c.personalVaultId()
        val a = w.c.saveNew(vid, newBody("login", "A").withText("password", "a"))
        val b = w.c.saveNew(vid, newBody("login", "B").withText("password", "b"))
        w.c.sync()
        w.c.update(a.id, w.c.get(a.id)!!.body.withText("password", "a2"))
        w.c.update(b.id, w.c.get(b.id)!!.body.withText("password", "b2"))
        val v = w.s.vaults.getValue(vid)
        v.revision += 1
        w.s.items.getValue(a.id).blob = b64u(randomBytes(200))
        w.s.items.getValue(a.id).revision = v.revision
        val r = w.c.sync()
        assertEquals(1, r.conflicts)
        assertTrue(a.id in w.c.undecryptable)
        assertEquals("b2", decryptItem(keyOf(w, vid), vid, b.id, fromB64u(w.s.items.getValue(b.id).blob!!)).password)
    }

    private fun keyOf(w: World, vid: String): ByteArray {
        val v = w.s.vaults.getValue(vid)
        val raw = w.store.getAccount()!!
        val keyset = org.promptly.sync.passwords.core.unwrapKeyset(
            org.promptly.sync.passwords.core.deriveRoot(MASTER, w.secretKey, fromB64u(raw.salt), raw.kdf).unlock, raw.accountId, fromB64u(raw.wrappedKeyset),
        )
        return org.promptly.sync.passwords.core.openVaultKey(ALICE, keyset, vid, v.memberGeneration, fromB64u(v.wrapped), fromB64u(v.signature), keyset.ed25519Pub)
    }

    @Test fun seqGoesUpOnEveryEditSurvivesAndMergesToMaxPlusOne() {
        val w = fresh()
        val vid = w.c.personalVaultId()
        val item = w.c.saveNew(vid, newBody("login", "Seq").withText("password", "1"))
        assertEquals(1L, item.body.seq)
        val two = w.c.update(item.id, item.body.withText("password", "2"))
        assertEquals(2L, two.body.seq)
        // A stale copy being saved over a newer one still goes past it.
        val three = w.c.update(item.id, item.body.withText("password", "3"))
        assertEquals(3L, three.body.seq)
        w.c.sync()
        // Through encryption and JSON, on a second device.
        val c2 = VaultClient(w.s.api, MemoryStore(), MemoryKeeper())
        c2.unlock(MASTER, w.secretKey)
        assertEquals(3L, c2.get(item.id)!!.body.seq)
        // Both edit: the merge is ahead of both, and two edits against one isn't a false conflict.
        val b1 = c2.update(item.id, c2.get(item.id)!!.body.withText("notes", "from two"))
        c2.update(item.id, b1.body.withText("notes", "from two, again"))
        c2.sync()
        w.c.update(item.id, w.c.get(item.id)!!.body.withText("username", "from-one"))
        val r = w.c.sync()
        assertEquals(1, r.conflicts)
        val merged = w.c.get(item.id)!!.body
        assertEquals(6L, merged.seq)
        assertEquals("from two, again", merged.notes)
        assertEquals("from-one", merged.username)
        assertTrue("false conflict: ${merged.conflicts}", merged.conflicts.isEmpty())
    }

    @Test fun aTrustBookPlantedInASharedVaultIsIgnored() {
        val w = fresh()
        val dana = Persona("dana")
        w.s.userKeys[danaId] = dana
        val vid = "88888888-8888-4888-8888-888888888888"
        val k = invite(w, dana, danaId, vid, "Shared")
        w.c.acceptVault(vid)
        // A member writes a book naming a contact, and a vault as accepted.
        val evilId = "66666666-6666-4666-8666-666666666666"
        val evil = Persona("friend")
        w.s.userKeys[evilId] = evil
        val forged = TrustBook()
        forged.contacts += evilId
        forged.accepted += "99999999-9999-4999-8999-999999999999"
        forged.people[evilId] = org.promptly.sync.passwords.core.TrustEntry(evil.xPub, evil.ePub, "2020-01-01T00:00:00Z")
        val body = newBody("trust", "trust-book").with("trustBook" to forged.toJson())
        val v = w.s.vaults.getValue(vid)
        v.revision += 1
        w.s.items["planted-book"] = FI("planted-book", vid, v.revision, b64u(encryptItem(k, vid, "planted-book", body)), deleted = false, purged = false)
        w.c.sync()
        w.c.lock()
        w.c.unlock(MASTER)
        assertNull(w.c.trustEntries()[evilId])
        w.s.emergency = mutableListOf(w.s.emergencyRow("e1", evilId, "accepted"))
        w.c.sync()
        assertEquals(emptyList<JsonObject>(), w.s.wrapped)
    }

    @Test fun theTrustBookReachesAnotherDeviceInTheSameShapeAsTheWebClients() {
        val w = fresh()
        val vid = w.c.createSharedVault("Team")
        val bob = Persona("bob")
        w.s.userKeys[bobId] = bob
        w.c.addMember(vid, bobId, "edit")
        w.c.markVerified(bobId)
        val dana = Persona("dana")
        w.s.userKeys[danaId] = dana
        val invited = "88888888-8888-4888-8888-888888888888"
        invite(w, dana, danaId, invited, "Shared")
        w.c.acceptVault(invited)
        w.s.userKeys[carolId] = Persona("carol")
        w.c.emergencyInvite(carolId, 3)
        w.c.sync()

        val c2 = VaultClient(w.s.api, MemoryStore(), MemoryKeeper())
        c2.unlock(MASTER, w.secretKey)
        // No prompts on the second device: the decision came with it.
        assertEquals(bob.ePub, c2.trustEntries()[bobId]?.ed25519)
        assertEquals(true, c2.trustEntries()[bobId]?.verified)
        assertEquals("Shared", c2.vaults().first { it.vault.id == invited }.displayName)
        assertTrue(c2.chosen(c2.store.getVaults().first { it.id == invited }))

        val own = w.c.allItems(includeSystem = true).first { it.body.kind == "trust" }
        assertEquals("trust-book", own.body.title)
        assertEquals(w.c.personalVaultId(), own.vaultId)
        assertTrue("A system item shows in lists", w.c.allItems().none { it.body.kind == "trust" })
        val book = own.body["trustBook"] as JsonObject
        assertEquals(setOf("people", "accepted", "contacts", "generations", "personalVaultId"), book.keys)
        assertEquals(setOf("x25519", "ed25519", "firstSeen", "verified", "username"), (book["people"] as JsonObject).getValue(bobId).jsonObject.keys)
        assertEquals(listOf(invited), TrustBook.strings(book["accepted"]))
        assertEquals(listOf(carolId), TrustBook.strings(book["contacts"]))
        assertEquals(1, TrustBook.numbers(book["generations"])[vid])
    }

    @Test fun oneChangedKeyShutsOnlyThatVaultAndAsks() {
        val w = fresh()
        val dana = Persona("dana")
        w.s.userKeys[danaId] = dana
        val vid = "88888888-8888-4888-8888-888888888888"
        val k = invite(w, dana, danaId, vid, "Shared")
        w.s.items["i-1"] = FI("i-1", vid, 1, b64u(encryptItem(k, vid, "i-1", newBody("login", "Dana's").withText("password", "dana-1"))), deleted = false, purged = false)
        w.s.vaults.getValue(vid).revision = 1
        w.c.acceptVault(vid)
        val mine = w.c.saveNew(w.c.personalVaultId(), newBody("login", "Mine").withText("password", "mine-1"))
        w.c.sync()
        assertEquals("dana-1", w.c.get("i-1")!!.body.password)

        w.s.userKeys[danaId] = Persona("dana")
        w.c.lock()
        w.c.unlock(MASTER)
        assertEquals("mine-1", w.c.get(mine.id)!!.body.password)
        assertNull(w.c.get("i-1"))
        assertEquals(danaId, w.c.keyChanges[vid]?.userId)
        // It isn't swallowed quietly by the next sync either.
        w.c.sync()
        assertNull(w.c.get("i-1"))
        assertEquals(dana.ePub, w.c.trustEntries()[danaId]?.ed25519)
    }

    @Test fun aSecondPersonWithTheSameNameIsNotPinnedQuietly() {
        val w = fresh()
        val vid = w.c.createSharedVault("Team")
        w.s.userKeys[bobId] = Persona("bob")
        w.c.addMember(vid, bobId, "edit")
        val otherBob = "55555555-5555-4555-8555-555555555555"
        w.s.userKeys[otherBob] = Persona("bob")
        assertThrows(KeyChangedError::class.java) { w.c.addMember(vid, otherBob, "edit") }
        assertNull(w.c.trustEntries()[otherBob])
        assertTrue(w.c.inviterInfo(otherBob).twin)
    }

    @Test fun onlyYourOwnVaultsAreSealedToAnEmergencyContact() {
        val w = fresh()
        val own = w.c.personalVaultId()
        val solo = w.c.createSharedVault("Just me")
        val team = w.c.createSharedVault("Team")
        w.s.userKeys[bobId] = Persona("bob")
        w.c.addMember(team, bobId, "edit")
        val dana = Persona("dana")
        w.s.userKeys[danaId] = dana
        val theirs = "88888888-8888-4888-8888-888888888888"
        invite(w, dana, danaId, theirs, "Theirs")
        w.c.acceptVault(theirs)
        w.s.userKeys[carolId] = Persona("carol")
        w.c.markVerified(carolId)
        w.c.emergencyInvite(carolId, 3)
        w.c.sync()
        val sealed = w.s.wrapped.last()["grants"]!!.jsonArray.map { it.jsonObject["vault_id"]!!.jsonPrimitive.content }.toSet()
        assertEquals(setOf(own, solo), sealed)
    }

    @Test fun emergencyOpenAddsTheOpenedVaultsAndEndedRotatesThenDeletes() {
        val w = fresh()
        val grantor = "99999999-9999-4999-8999-999999999999"
        val them = Persona("them")
        w.s.userKeys[grantor] = them
        val vid = "88888888-8888-4888-8888-888888888888"
        invite(w, them, grantor, vid, "Theirs")
        w.s.emergency = mutableListOf(w.s.emergencyRow("in", ALICE, "opened", listOf(vid), grantor = grantor))
        w.c.sync()
        assertEquals("(can't open)", w.c.vaults().first { it.vault.id == vid }.displayName)
        w.c.emergencyOpen("in")
        assertEquals("Theirs", w.c.vaults().first { it.vault.id == vid }.displayName)

        // The other side of it: they've stopped, and saw my vault. Rotate, then delete.
        val team = w.c.createSharedVault("Mine")
        w.s.userKeys[carolId] = Persona("carol")
        w.c.addMember(team, carolId, "view")
        val row = w.s.emergencyRow("out", carolId, "ended", listOf(team))
        w.s.emergency = mutableListOf(row)
        val parsed = w.c.api.emergencyList().single()
        assertEquals("ended", parsed.state)
        w.c.emergencyEnd(parsed)
        val rotated = w.s.calls.indexOf("POST /vaults/$team/rotate")
        val deleted = w.s.calls.indexOf("emergency-deleted")
        assertTrue("rotate at $rotated, delete at $deleted", rotated in 0 until deleted)
    }

    @Test fun anApprovalSealsOnlyToTheKeyItsWordsCameFrom() {
        val w = fresh()
        val deviceSk = randomBytes(32)
        val devicePub = b64u(Primitives.x25519Public(deviceSk))
        val realRow = org.promptly.sync.passwords.core.DeviceRequestOut("req-1", "phone", "android", "ABC", devicePub, null, "pending", "", "")
        val approval = w.c.beginApproval("req-1", devicePub)

        // The list refreshes while the person's reading the words, with the server's key in it.
        val attackerSk = randomBytes(32)
        val swapped = realRow.copy(devicePub = b64u(Primitives.x25519Public(attackerSk)))
        assertTrue(approval.stillMatches(listOf(realRow)))
        assertFalse("A swapped key must discard the approval", approval.stillMatches(listOf(swapped)))
        assertFalse("A request that's gone must discard it", approval.stillMatches(emptyList()))

        // Whatever the list says, only the key that was compared can open what's sent.
        w.c.finishApproval(approval)
        val sealed = fromB64u(w.s.approvedPayload!!)
        val plain = openSealed(deviceSk, sealed, aad("req-1", "", "device_payload"))
        assertTrue(String(plain, Charsets.UTF_8).contains(b64u(w.secretKey)))
        assertThrows(Exception::class.java) { openSealed(attackerSk, sealed, aad("req-1", "", "device_payload")) }
    }

    @Test fun yourOwnVaultCantBeTakenAwayByLeavingItOffTheList() {
        val w = fresh()
        val vid = w.c.personalVaultId()
        val item = w.c.saveNew(vid, newBody("login", "Stays").withText("password", "stays-1"))
        w.c.sync()
        w.s.hideVault = vid
        val r = w.c.sync()
        assertTrue(vid in r.rollback)
        assertEquals("stays-1", w.c.get(item.id)!!.body.password)
        assertNotEquals(0, w.store.getItems(vid).size)
    }

    @Test fun aGrantThatDoesntVerifyDoesntReplaceTheOneThatWorks() {
        val w = fresh()
        val vid = w.c.createSharedVault("Team")
        val item = w.c.saveNew(vid, newBody("login", "L").withText("password", "still-here"))
        w.c.sync()
        val v = w.s.vaults.getValue(vid)
        // Signed by nobody, claiming a new generation far ahead.
        v.memberGeneration = 999
        v.generation = 999
        v.wrapped = b64u(randomBytes(120))
        v.signature = b64u(randomBytes(64))
        val r = w.c.sync()
        assertTrue(vid in r.rollback)
        assertEquals(1, w.store.getVaults().first { it.id == vid }.memberGeneration)
        w.c.lock()
        w.c.unlock(MASTER)
        assertEquals("still-here", w.c.get(item.id)!!.body.password)
    }

}

/** Lists vaults by id, the way IndexedDB's getAll() does, so order can't save the client. */
private class SortedStore : MemoryStore() {
    override fun getVaults() = super.getVaults().sortedBy { it.id }
}
