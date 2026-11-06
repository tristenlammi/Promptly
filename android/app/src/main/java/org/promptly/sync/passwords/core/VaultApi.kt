// The vault's HTTP API. Mirrors api.ts: a device token as the Promptly identity, and a
// vault session from proving auth_key. Nothing is cached and no cookies are kept.
package org.promptly.sync.passwords.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.CacheControl
import okhttp3.Credentials
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiError(val status: Int, val detail: String?, val retryAfter: Int? = null) : Exception(detail ?: "Request failed ($status)")

/** The server couldn't be reached at all, which clients treat as "work offline". The
 *  cause says why, for the log: a refused connection isn't a timeout. */
class OfflineError(cause: Throwable? = null) : Exception("The server can't be reached", cause)

data class Prelogin(val userId: String, val exists: Boolean, val accountId: String?, val kdf: KdfParams?, val salt: String?, val preview: Boolean, val enabled: Boolean, val serverTime: String, val minKdf: KdfParams? = null, val wrappedKeyset: String? = null)

data class MemberOut(val userId: String, val username: String, val role: String, val grantedBy: String?, val generation: Int, val accepted: Boolean, val x25519Pub: String?, val ed25519Pub: String?)

data class Person(val id: String, val username: String, val hasVault: Boolean)

data class AttachmentOut(val id: String, val itemId: String, val chunkCount: Int, val sizeBytes: Long, val complete: Boolean, val received: List<Int>)

data class SendOut(val id: String, val expiresAt: String, val viewsLeft: Int?, val hasPassword: Boolean, val disabled: Boolean, val createdAt: String)

data class EmergencyOut(
    val id: String,
    val grantorId: String,
    val grantor: String,
    val granteeId: String,
    val grantee: String,
    val waitDays: Int,
    val state: String,
    val requestedAt: String?,
    val opensAt: String?,
    val wrapped: Map<String, Int>,
    val openedVaults: List<String>,
)

/** Bare counts of what's waiting. They take only a device token, for a locked phone. */
data class Alerts(val deviceRequests: Int, val invitations: Int, val emergency: Int)

data class SessionOut(val token: String, val accountId: String, val wrappedKeyset: String, val kdf: KdfParams, val salt: String, val x25519Pub: String, val ed25519Pub: String, val kitConfirmed: Boolean, val kitCheckedAt: String?, val userId: String)

data class VaultOut(val id: String, val kind: String, val revision: Int, val generation: Int, val name: String, val role: String, val wrappedKey: String, val signature: String, val grantedBy: String?, val memberGeneration: Int, val accepted: Boolean, val memberCount: Int, val rotateNeeded: Boolean = false)

data class ItemOut(val id: String, val revision: Int, val blob: String?, val deleted: Boolean, val purged: Boolean, val updatedAt: String)

data class ChangesOut(val revision: Int, val generation: Int, val items: List<ItemOut>, val more: Boolean)

data class ItemWrite(val id: String, val baseRevision: Int, val blob: String?, val deleted: Boolean, val purge: Boolean = false)

data class Conflict(val id: String, val reason: String, val revision: Int?, val blob: String?, val deleted: Boolean)

data class BatchOut(val revision: Int, val applied: List<String>, val conflicts: List<Conflict>)

data class DeviceOut(val id: String, val name: String, val platform: String, val lastSeenAt: String?, val createdAt: String, val current: Boolean)

data class DeviceRequestOut(val id: String, val name: String, val platform: String, val code: String, val devicePub: String, val approverPub: String?, val status: String, val createdAt: String, val expiresAt: String)

data class Created(val id: String, val code: String, val pollSecret: String)

data class DeviceToken(val token: String, val deviceId: String, val userId: String)

data class PublicKeys(val userId: String, val username: String, val x25519Pub: String, val ed25519Pub: String)

class VaultApi(baseUrl: String, val auth: () -> String?, client: OkHttpClient? = null) {
    val baseUrl = baseUrl.trimEnd('/')
    @Volatile
    var session: String? = null

    private val http: OkHttpClient = client ?: OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(45, TimeUnit.SECONDS)
        // A redirect would carry the device token and the auth key somewhere else.
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    private val noStore = CacheControl.Builder().noStore().noCache().build()

    /** What the last network failure was: a method, a path with no query, and a status or an
     *  exception's name. Never a body. So "the server can't be reached" can be explained. */
    @Volatile
    var lastProblem: String? = null

    private fun call(method: String, path: String, body: JsonElement? = null, public: Boolean = false, authHeader: String? = null, sessionOverride: String? = null, raw: ByteArray? = null, noSession: Boolean = false): String? {
        val b = Request.Builder().url("$baseUrl/api/passwords$path").cacheControl(noStore)
        val reqBody = raw?.toRequestBody(OCTET) ?: body?.toString()?.toRequestBody(JSON)
        b.method(method, reqBody ?: if (method == "POST" || method == "PUT" || method == "PATCH") ByteArray(0).toRequestBody(null) else null)
        if (!public) {
            val header = authHeader ?: auth()?.let { "Bearer $it" }
            if (header != null) b.header("Authorization", header)
            if (!noSession) (sessionOverride ?: session)?.let { b.header("X-Vault-Session", it) }
        }
        val res = try {
            http.newCall(b.build()).execute()
        } catch (e: IOException) {
            lastProblem = "${method} ${path.substringBefore('?')}: ${e.javaClass.simpleName}"
            throw OfflineError(e)
        }
        res.use { r ->
            if (r.code == 204) return null
            val text = r.body.string()
            if (!r.isSuccessful) {
                val detail = runCatching { ((Json.parseToJsonElement(text) as JsonObject)["detail"] as? JsonPrimitive)?.content }.getOrNull() ?: r.message
                if (r.code >= 500 || r.code == 429) lastProblem = "${method} ${path.substringBefore('?')}: HTTP ${r.code}"
                throw ApiError(r.code, detail, r.header("Retry-After")?.toIntOrNull()?.takeIf { it > 0 })
            }
            return text
        }
    }

    private fun callBytes(method: String, path: String): ByteArray {
        val b = Request.Builder().url("$baseUrl/api/passwords$path").cacheControl(noStore).method(method, null)
        auth()?.let { b.header("Authorization", "Bearer $it") }
        session?.let { b.header("X-Vault-Session", it) }
        val res = try {
            http.newCall(b.build()).execute()
        } catch (e: IOException) {
            lastProblem = "$method $path: ${e.javaClass.simpleName}"
            throw OfflineError(e)
        }
        res.use { r ->
            if (!r.isSuccessful) throw ApiError(r.code, r.message)
            return r.body.bytes()
        }
    }

    private fun obj(text: String?) = Json.parseToJsonElement(text ?: "{}") as JsonObject
    private fun arr(text: String?) = Json.parseToJsonElement(text ?: "[]") as JsonArray

    fun prelogin(): Prelogin {
        val o = obj(call("GET", "/account"))
        return Prelogin(o.str("user_id")!!, o.bool("exists") ?: false, o.str("account_id"), parseKdf(o["kdf"]), o.str("salt"), o.bool("preview") ?: true, o.bool("enabled") ?: true, o.str("server_time") ?: "", parseKdf(o["min_kdf"]), o.str("wrapped_keyset"))
    }

    private fun session(o: JsonObject) = SessionOut(
        o.str("token")!!, o.str("account_id")!!, o.str("wrapped_keyset")!!, parseKdf(o["kdf"])!!, o.str("salt")!!,
        o.str("x25519_pub")!!, o.str("ed25519_pub")!!, o.bool("kit_confirmed") ?: false, o.str("kit_checked_at"), o.str("user_id")!!,
    )

    fun createAccount(body: JsonObject) = session(obj(call("POST", "/account", body)))
    fun createSession(authKey: String) = session(obj(call("POST", "/session", buildJsonObject { put("auth_key", authKey) })))
    fun endSession(token: String) { call("DELETE", "/session", sessionOverride = token) }
    fun rekey(body: JsonObject) { call("POST", "/account/rekey", body) }
    fun confirmKit() { call("POST", "/account/kit") }

    fun vaults(): List<VaultOut> = arr(call("GET", "/vaults")).map {
        val o = it as JsonObject
        VaultOut(
            o.str("id")!!, o.str("kind")!!, o.int("revision") ?: 0, o.int("generation") ?: 1, o.str("name") ?: "", o.str("role") ?: "view",
            o.str("wrapped_key") ?: "", o.str("signature") ?: "", o.str("granted_by"), o.int("member_generation") ?: 1, o.bool("accepted") ?: false, o.int("member_count") ?: 1, o.bool("rotate_needed") ?: false,
        )
    }

    fun acceptVault(id: String) { call("POST", "/vaults/$id/accept") }
    fun leaveVault(id: String) { call("POST", "/vaults/$id/leave") }
    fun deleteVault(id: String) { call("DELETE", "/vaults/$id") }
    fun createVault(id: String, name: String, grant: JsonObject) { call("POST", "/vaults", buildJsonObject { put("id", id); put("name", name); put("grant", grant) }) }

    fun members(id: String): List<MemberOut> = arr(call("GET", "/vaults/$id/members")).map {
        val o = it as JsonObject
        MemberOut(o.str("user_id")!!, o.str("username") ?: "", o.str("role") ?: "view", o.str("granted_by"), o.int("generation") ?: 1, o.bool("accepted") ?: false, o.str("x25519_pub"), o.str("ed25519_pub"))
    }

    fun addMember(id: String, userId: String, role: String, grant: JsonObject) {
        call("POST", "/vaults/$id/members", buildJsonObject { put("user_id", userId); put("role", role); put("grant", grant) })
    }

    /** Cuts them off at once. The key change that should follow is a separate step. */
    fun removeMember(id: String, userId: String) { call("DELETE", "/vaults/$id/members/$userId") }

    fun setRole(id: String, userId: String, role: String) { call("PATCH", "/vaults/$id/members/$userId", buildJsonObject { put("role", role) }) }
    fun rotate(id: String, body: JsonObject) { call("POST", "/vaults/$id/rotate", body) }

    fun people(): List<Person> = arr(call("GET", "/people")).map {
        val o = it as JsonObject
        Person(o.str("id")!!, o.str("username") ?: "", o.bool("has_vault") ?: false)
    }

    private fun attachment(o: JsonObject) = AttachmentOut(
        o.str("id")!!, o.str("item_id") ?: "", o.int("chunk_count") ?: 0, (o["size_bytes"] as? JsonPrimitive)?.content?.toLongOrNull() ?: 0L, o.bool("complete") ?: false,
        (o["received"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content?.toIntOrNull() } ?: emptyList(),
    )

    fun attachmentStart(vaultId: String, id: String, itemId: String, chunks: Int): AttachmentOut =
        attachment(obj(call("POST", "/vaults/$vaultId/attachments", buildJsonObject { put("id", id); put("item_id", itemId); put("chunk_count", chunks) })))

    fun attachmentPut(vaultId: String, id: String, index: Int, blob: ByteArray) {
        call("PUT", "/vaults/$vaultId/attachments/$id/chunks/$index", raw = blob)
    }

    fun attachmentFinish(vaultId: String, id: String) { call("POST", "/vaults/$vaultId/attachments/$id/finish") }
    fun attachmentGet(vaultId: String, id: String, index: Int): ByteArray = callBytes("GET", "/vaults/$vaultId/attachments/$id/chunks/$index")
    fun attachmentDelete(vaultId: String, id: String) { call("DELETE", "/vaults/$vaultId/attachments/$id") }

    /** Five hash characters out, padded replies back: k-anonymity through the server. */
    fun breachRange(prefix: String): String = call("POST", "/breach/range", buildJsonObject { put("prefix", prefix) }) ?: ""

    /** Which sites support 2FA and passkeys: for the Security check's advice. */
    fun directory(): SiteDirectory = SiteDirectory.parse(call("GET", "/directory"))

    /** Null if the server's answer doesn't make sense. */
    fun survival(): SurvivalOut? = Survival.parse(call("GET", "/survival"))

    /** A site's icon, through the server, which sees the name at that moment and keeps nothing.
     *  In the body, so it stays out of access logs. Too much back is the same as nothing. */
    fun icon(domain: String): ByteArray? {
        val b = Request.Builder().url("$baseUrl/api/passwords/icon").cacheControl(noStore)
            .post(buildJsonObject { put("domain", domain) }.toString().toRequestBody(JSON))
        auth()?.let { b.header("Authorization", "Bearer $it") }
        session?.let { b.header("X-Vault-Session", it) }
        val res = try {
            http.newCall(b.build()).execute()
        } catch (e: IOException) {
            throw OfflineError(e)
        }
        res.use { r ->
            if (r.code == 404) return null
            if (!r.isSuccessful) throw ApiError(r.code, r.message, r.header("Retry-After")?.toIntOrNull()?.takeIf { it > 0 })
            val source = r.body.source()
            source.request(SiteIcons.MAX_BYTES + 1L)
            if (source.buffer.size > SiteIcons.MAX_BYTES) return null
            return source.buffer.readByteArray()
        }
    }

    fun putHealth(weak: Int, reused: Int, breached: Int, old: Int) {
        call("PUT", "/health", buildJsonObject { put("weak", weak); put("reused", reused); put("breached", breached); put("old", old) })
    }

    fun noteExport() { call("POST", "/activity/export") }

    fun createSend(body: JsonObject) { call("POST", "/sends", body) }

    fun sends(): List<SendOut> = arr(call("GET", "/sends")).map {
        val o = it as JsonObject
        SendOut(o.str("id")!!, o.str("expires_at") ?: "", o.int("views_left"), o.bool("has_password") ?: false, o.bool("disabled") ?: false, o.str("created_at") ?: "")
    }

    fun deleteSend(id: String) { call("DELETE", "/sends/$id") }

    /** Posts a link and nothing else: these two have nowhere to put a secret, and the server
     *  writes the message itself. */
    fun sendViaRooms(id: String, link: String, userId: String) {
        call("POST", "/sends/$id/via-rooms", buildJsonObject { put("link", link); put("user_id", userId) })
    }

    fun sendViaMail(id: String, link: String, to: String) {
        call("POST", "/sends/$id/via-mail", buildJsonObject { put("link", link); put("to", to) })
    }

    private fun emergency(o: JsonObject) = EmergencyOut(
        o.str("id")!!, o.str("grantor_id")!!, o.str("grantor") ?: "", o.str("grantee_id")!!, o.str("grantee") ?: "", o.int("wait_days") ?: 0, o.str("state") ?: "",
        o.str("requested_at"), o.str("opens_at"),
        (o["wrapped"] as? JsonObject)?.mapValues { (it.value as? JsonPrimitive)?.content?.toIntOrNull() ?: 0 } ?: emptyMap(),
        (o["opened_vaults"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList(),
    )

    fun emergencyList(): List<EmergencyOut> = arr(call("GET", "/emergency")).map { emergency(it as JsonObject) }
    fun emergencyInvite(granteeId: String, waitDays: Int) { call("POST", "/emergency", buildJsonObject { put("grantee_id", granteeId); put("wait_days", waitDays) }) }
    fun emergencyAct(id: String, action: String): EmergencyOut = emergency(obj(call("POST", "/emergency/$id/$action")))
    fun emergencyWrap(id: String, grants: JsonArray) { call("PUT", "/emergency/$id/wrap", buildJsonObject { put("grants", grants) }) }
    fun emergencyDelete(id: String) { call("DELETE", "/emergency/$id") }

    /** A device token is enough, with no vault session: bare counts for a locked phone. */
    fun alerts(): Alerts {
        val o = obj(call("GET", "/alerts", noSession = true))
        return Alerts(o.int("device_requests") ?: 0, o.int("invitations") ?: 0, o.int("emergency") ?: 0)
    }

    fun changes(id: String, since: Int, limit: Int = 500): ChangesOut {
        val o = obj(call("GET", "/vaults/$id/changes?since=$since&limit=$limit"))
        return ChangesOut(
            o.int("revision") ?: 0, o.int("generation") ?: 1,
            (o["items"] as JsonArray).map { e ->
                val i = e as JsonObject
                ItemOut(i.str("id")!!, i.int("revision") ?: 0, i.str("blob"), i.bool("deleted") ?: false, i.bool("purged") ?: false, i.str("updated_at") ?: "")
            },
            o.bool("more") ?: false,
        )
    }

    /** `generation`: the vault key these were encrypted under. 409 means a newer one exists. */
    fun writeItems(id: String, items: List<ItemWrite>, generation: Int? = null): BatchOut {
        val body = buildJsonObject {
            put("items", buildJsonArray {
                for (w in items) add(buildJsonObject {
                    put("id", w.id)
                    put("base_revision", w.baseRevision)
                    if (w.blob != null) put("blob", w.blob)
                    put("deleted", w.deleted)
                    put("purge", w.purge)
                })
            })
            if (generation != null) put("generation", generation)
        }
        val o = obj(call("POST", "/vaults/$id/items", body))
        return BatchOut(
            o.int("revision") ?: 0,
            (o["applied"] as JsonArray).map { (it as JsonPrimitive).content },
            (o["conflicts"] as JsonArray).map { e ->
                val c = e as JsonObject
                Conflict(c.str("id")!!, c.str("reason") ?: "", c.int("revision"), c.str("blob"), c.bool("deleted") ?: false)
            },
        )
    }

    data class Version(val revision: Int, val blob: String, val createdAt: String)

    fun versions(vaultId: String, itemId: String): List<Version> = arr(call("GET", "/vaults/$vaultId/items/$itemId/versions")).map {
        val o = it as JsonObject
        Version(o.int("revision") ?: 0, o.str("blob")!!, o.str("created_at") ?: "")
    }

    fun userKeys(userId: String): PublicKeys {
        val o = obj(call("GET", "/users/$userId/keys"))
        return PublicKeys(o.str("user_id") ?: userId, o.str("username") ?: "", o.str("x25519_pub")!!, o.str("ed25519_pub")!!)
    }

    fun devices(): List<DeviceOut> = arr(call("GET", "/devices")).map {
        val o = it as JsonObject
        DeviceOut(o.str("id")!!, o.str("name") ?: "", o.str("platform") ?: "", o.str("last_seen_at"), o.str("created_at") ?: "", o.bool("current") ?: false)
    }

    fun revokeDevice(id: String) { call("DELETE", "/devices/$id") }

    /** With an app password (Basic), or a bearer JWT. */
    fun registerDevice(authHeader: String, name: String, platform: String = "android"): DeviceToken {
        val body = buildJsonObject {
            put("name", name)
            put("platform", platform)
            put("scopes", buildJsonArray { add(JsonPrimitive("vault")) })
        }
        val o = obj(call("POST", "/devices/register", body, authHeader = authHeader))
        return DeviceToken(o.str("token")!!, o.str("device_id")!!, o.str("user_id")!!)
    }

    fun connectStart(name: String, platform: String = "android"): Created {
        val body = buildJsonObject {
            put("name", name)
            put("platform", platform)
            put("scopes", buildJsonArray { add(JsonPrimitive("vault")) })
        }
        val o = obj(call("POST", "/connect/start", body, public = true))
        return Created(o.str("id")!!, o.str("code")!!, o.str("poll_secret")!!)
    }

    data class ConnectResult(val status: String, val token: String?, val deviceId: String?, val userId: String?)

    fun connectPoll(id: String, pollSecret: String): ConnectResult {
        val o = obj(call("POST", "/connect/poll", buildJsonObject { put("id", id); put("poll_secret", pollSecret) }, public = true))
        return ConnectResult(o.str("status") ?: "", o.str("token"), o.str("device_id"), o.str("user_id"))
    }

    fun deviceRequestCreate(name: String, platform: String, devicePub: String): Created {
        val o = obj(call("POST", "/device-requests", buildJsonObject { put("name", name); put("platform", platform); put("device_pub", devicePub) }))
        return Created(o.str("id")!!, o.str("code")!!, o.str("poll_secret")!!)
    }

    fun deviceRequests(): List<DeviceRequestOut> = arr(call("GET", "/device-requests")).map {
        val o = it as JsonObject
        DeviceRequestOut(o.str("id")!!, o.str("name") ?: "", o.str("platform") ?: "", o.str("code") ?: "", o.str("device_pub")!!, o.str("approver_pub"), o.str("status") ?: "", o.str("created_at") ?: "", o.str("expires_at") ?: "")
    }

    fun deviceRequestApprover(id: String, approverPub: String) { call("POST", "/device-requests/$id/approver", buildJsonObject { put("approver_pub", approverPub) }) }
    fun deviceRequestApprove(id: String, payload: String) { call("POST", "/device-requests/$id/approve", buildJsonObject { put("payload", payload) }) }
    fun deviceRequestDeny(id: String) { call("POST", "/device-requests/$id/deny") }

    data class RequestState(val status: String, val approverPub: String?, val payload: String?)

    fun deviceRequestPoll(id: String, pollSecret: String): RequestState {
        val o = obj(call("POST", "/device-requests/$id/poll", buildJsonObject { put("poll_secret", pollSecret) }))
        return RequestState(o.str("status") ?: "", o.str("approver_pub"), o.str("payload"))
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        private val OCTET = "application/octet-stream".toMediaType()
        fun basic(username: String, password: String) = Credentials.basic(username, password)
    }
}
