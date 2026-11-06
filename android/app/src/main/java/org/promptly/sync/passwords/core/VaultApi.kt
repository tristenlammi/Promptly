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

/** The server couldn't be reached at all, which clients treat as "work offline". */
class OfflineError : Exception("The server can't be reached")

data class Prelogin(val userId: String, val exists: Boolean, val accountId: String?, val kdf: KdfParams?, val salt: String?, val preview: Boolean, val enabled: Boolean, val serverTime: String)

data class SessionOut(val token: String, val accountId: String, val wrappedKeyset: String, val kdf: KdfParams, val salt: String, val x25519Pub: String, val ed25519Pub: String, val kitConfirmed: Boolean, val kitCheckedAt: String?, val userId: String)

data class VaultOut(val id: String, val kind: String, val revision: Int, val generation: Int, val name: String, val role: String, val wrappedKey: String, val signature: String, val grantedBy: String?, val memberGeneration: Int, val accepted: Boolean, val memberCount: Int)

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
        .build()

    private val noStore = CacheControl.Builder().noStore().noCache().build()

    private fun call(method: String, path: String, body: JsonElement? = null, public: Boolean = false, authHeader: String? = null, sessionOverride: String? = null): String? {
        val b = Request.Builder().url("$baseUrl/api/passwords$path").cacheControl(noStore)
        val reqBody = body?.toString()?.toRequestBody(JSON)
        b.method(method, reqBody ?: if (method == "POST" || method == "PUT" || method == "PATCH") ByteArray(0).toRequestBody(null) else null)
        if (!public) {
            val header = authHeader ?: auth()?.let { "Bearer $it" }
            if (header != null) b.header("Authorization", header)
            (sessionOverride ?: session)?.let { b.header("X-Vault-Session", it) }
        }
        val res = try {
            http.newCall(b.build()).execute()
        } catch (e: IOException) {
            throw OfflineError()
        }
        res.use { r ->
            if (r.code == 204) return null
            val text = r.body.string()
            if (!r.isSuccessful) {
                val detail = runCatching { ((Json.parseToJsonElement(text) as JsonObject)["detail"] as? JsonPrimitive)?.content }.getOrNull() ?: r.message
                throw ApiError(r.code, detail, r.header("Retry-After")?.toIntOrNull()?.takeIf { it > 0 })
            }
            return text
        }
    }

    private fun obj(text: String?) = Json.parseToJsonElement(text ?: "{}") as JsonObject
    private fun arr(text: String?) = Json.parseToJsonElement(text ?: "[]") as JsonArray

    fun prelogin(): Prelogin {
        val o = obj(call("GET", "/account"))
        return Prelogin(o.str("user_id")!!, o.bool("exists") ?: false, o.str("account_id"), parseKdf(o["kdf"]), o.str("salt"), o.bool("preview") ?: true, o.bool("enabled") ?: true, o.str("server_time") ?: "")
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
            o.str("wrapped_key") ?: "", o.str("signature") ?: "", o.str("granted_by"), o.int("member_generation") ?: 1, o.bool("accepted") ?: false, o.int("member_count") ?: 1,
        )
    }

    fun acceptVault(id: String) { call("POST", "/vaults/$id/accept") }

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

    fun writeItems(id: String, items: List<ItemWrite>): BatchOut {
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
        fun basic(username: String, password: String) = Credentials.basic(username, password)
    }
}
