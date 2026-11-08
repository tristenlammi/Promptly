// What's inside an item's encrypted body. Mirrors model.ts. The body is kept as a JSON
// object, in order, so fields this client doesn't know survive a save: an older client
// can't destroy a newer client's data (CRYPTO_SPEC.md section 4).
package org.promptly.sync.passwords.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/** `new Date().toISOString()`: always three decimals. */
fun isoNow(now: Instant = Instant.now()): String {
    val s = DateTimeFormatter.ISO_INSTANT.format(now.truncatedTo(ChronoUnit.MILLIS))
    return if (s.contains('.')) s else s.removeSuffix("Z") + ".000Z"
}

val SYSTEM_KINDS = setOf("folder", "site_rule", "trust", "prefs", "send", "bookmark")

data class LoginUrl(val url: String, val match: String? = null) {
    fun toJson(): JsonObject = JsonObject(buildMap {
        put("url", JsonPrimitive(url))
        if (match != null) put("match", JsonPrimitive(match))
    })
}

data class CustomField(val name: String, val value: String, val type: String)

fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
fun JsonObject.int(k: String): Int? = (this[k] as? JsonPrimitive)?.intOrNull
fun JsonObject.bool(k: String): Boolean? = (this[k] as? JsonPrimitive)?.booleanOrNull

data class TotpConfig(
    val secret: String,
    val algorithm: String? = null,
    val digits: Int? = null,
    val period: Int? = null,
    val steam: Boolean = false,
    val issuer: String? = null,
    val label: String? = null,
) {
    fun toJson(): JsonObject = JsonObject(buildMap {
        put("secret", JsonPrimitive(secret))
        if (algorithm != null) put("algorithm", JsonPrimitive(algorithm))
        if (digits != null) put("digits", JsonPrimitive(digits))
        if (period != null) put("period", JsonPrimitive(period))
        if (steam) put("steam", JsonPrimitive(true))
        if (issuer != null) put("issuer", JsonPrimitive(issuer))
        if (label != null) put("label", JsonPrimitive(label))
    })

    companion object {
        fun from(e: JsonElement?): TotpConfig? {
            val o = e as? JsonObject ?: return null
            val secret = o.str("secret") ?: return null
            return TotpConfig(secret, o.str("algorithm"), o.int("digits"), o.int("period"), o.bool("steam") ?: false, o.str("issuer"), o.str("label"))
        }
    }
}

/** A passkey's private key is portable, so any client can use it. */
data class Passkey(
    val credentialId: String,
    val rpId: String,
    val rpName: String?,
    val userHandle: String,
    val userName: String,
    val userDisplayName: String?,
    val key: String,
    val signCount: Int,
    val createdAt: String,
    val lastUsedAt: String?,
    val discoverable: Boolean,
) {
    fun toJson(): JsonObject = JsonObject(buildMap {
        put("credentialId", JsonPrimitive(credentialId))
        put("rpId", JsonPrimitive(rpId))
        if (rpName != null) put("rpName", JsonPrimitive(rpName))
        put("userHandle", JsonPrimitive(userHandle))
        put("userName", JsonPrimitive(userName))
        if (userDisplayName != null) put("userDisplayName", JsonPrimitive(userDisplayName))
        put("key", JsonPrimitive(key))
        put("alg", JsonPrimitive(-7))
        put("signCount", JsonPrimitive(signCount))
        put("createdAt", JsonPrimitive(createdAt))
        if (lastUsedAt != null) put("lastUsedAt", JsonPrimitive(lastUsedAt))
        put("discoverable", JsonPrimitive(discoverable))
    })

    companion object {
        fun from(e: JsonElement): Passkey? {
            val o = e as? JsonObject ?: return null
            return Passkey(
                o.str("credentialId") ?: return null, o.str("rpId") ?: return null, o.str("rpName"),
                o.str("userHandle") ?: return null, o.str("userName") ?: "", o.str("userDisplayName"),
                o.str("key") ?: return null, o.int("signCount") ?: 0, o.str("createdAt") ?: "", o.str("lastUsedAt"),
                o.bool("discoverable") ?: false,
            )
        }
    }
}

/** A file recorded on an item. Its key lives only in the body, so the server can't place it. */
data class AttachmentRef(val id: String, val name: String, val size: Long, val key: String, val chunks: Int, val mime: String? = null) {
    fun toJson(): JsonObject = JsonObject(buildMap {
        put("id", JsonPrimitive(id))
        put("name", JsonPrimitive(name))
        // Not plain `size`: inside buildMap that would be the map's own entry count.
        put("size", JsonPrimitive(this@AttachmentRef.size))
        put("key", JsonPrimitive(key))
        put("chunks", JsonPrimitive(chunks))
        if (mime != null) put("mime", JsonPrimitive(mime))
    })

    companion object {
        fun from(e: JsonElement): AttachmentRef? {
            val o = e as? JsonObject ?: return null
            return AttachmentRef(
                o.str("id") ?: return null, o.str("name") ?: "file", (o["size"] as? JsonPrimitive)?.content?.toDoubleOrNull()?.toLong() ?: 0L,
                o.str("key") ?: return null, o.int("chunks") ?: 0, o.str("mime"),
            )
        }
    }
}

/** An immutable item body: a JSON object with typed reads. Edits make a copy. */
class ItemBody(val fields: Map<String, JsonElement>) {
    operator fun get(k: String): JsonElement? = fields[k]
    fun str(k: String): String? = (fields[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
    fun text(k: String): String = str(k) ?: ""
    fun bool(k: String): Boolean = (fields[k] as? JsonPrimitive)?.booleanOrNull ?: false

    val kind: String get() = text("kind")
    val title: String get() = text("title")
    val username: String? get() = str("username")
    val password: String? get() = str("password")
    val notes: String? get() = str("notes")
    val archived: Boolean get() = bool("archived")
    val favorite: Boolean get() = bool("favorite")
    val reprompt: Boolean get() = bool("reprompt")
    val updatedAt: String get() = text("updatedAt")
    val isSystem: Boolean get() = kind in SYSTEM_KINDS

    /** Goes up with every edit, and it's inside the encryption. The revision is only the
     *  server's word, so this is what shows an older copy being passed off as new. */
    val seq: Long get() = (fields["seq"] as? JsonPrimitive)?.content?.toDoubleOrNull()?.toLong() ?: 0L

    val urls: List<LoginUrl>
        get() = (fields["urls"] as? JsonArray)?.mapNotNull { e ->
            when (e) {
                is JsonObject -> e.str("url")?.let { LoginUrl(it, e.str("match")) }
                // The vectors, and very old items, hold a plain string.
                is JsonPrimitive -> e.contentOrNull?.let { LoginUrl(it) }
                else -> null
            }
        } ?: emptyList()

    /** How this login's websites match a page, unless an address says otherwise (Match.kt). None: "auto". */
    val match: String? get() = str("match")

    val tags: List<String> get() = (fields["tags"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()

    val customFields: List<CustomField>
        get() = (fields["fields"] as? JsonArray)?.mapNotNull { e ->
            (e as? JsonObject)?.let { CustomField(it.str("name") ?: "", it.str("value") ?: "", it.str("type") ?: "text") }
        } ?: emptyList()

    val totp: TotpConfig? get() = TotpConfig.from(fields["totp"])
    val attachments: List<AttachmentRef> get() = (fields["attachments"] as? JsonArray)?.mapNotNull { AttachmentRef.from(it) } ?: emptyList()
    fun withAttachments(list: List<AttachmentRef>) = with("attachments" to if (list.isEmpty()) null else JsonArray(list.map { it.toJson() }))
    val passkeys: List<Passkey> get() = (fields["passkeys"] as? JsonArray)?.mapNotNull { Passkey.from(it) } ?: emptyList()
    val conflicts: List<JsonObject> get() = (fields["conflicts"] as? JsonArray)?.filterIsInstance<JsonObject>() ?: emptyList()
    val passwordHistory: List<Pair<String, String>>
        get() = (fields["passwordHistory"] as? JsonArray)?.mapNotNull { e ->
            (e as? JsonObject)?.let { o -> o.str("password")?.let { it to (o.str("at") ?: "") } }
        } ?: emptyList()

    /** A copy with these set. A null removes the key, as `undefined` does on the web. */
    fun with(vararg changes: Pair<String, JsonElement?>): ItemBody {
        val out = LinkedHashMap(fields)
        for ((k, v) in changes) if (v == null) out.remove(k) else out[k] = v
        return ItemBody(out)
    }

    fun withText(key: String, value: String?): ItemBody = with(key to value?.takeIf { it.isNotEmpty() }?.let { JsonPrimitive(it) })
    fun withFlag(key: String, on: Boolean): ItemBody = with(key to if (on) JsonPrimitive(true) else null)
    fun withPasskeys(list: List<Passkey>) = with("passkeys" to JsonArray(list.map { it.toJson() }))
    fun withUrls(list: List<LoginUrl>) = with("urls" to if (list.isEmpty()) null else JsonArray(list.map { it.toJson() }))
    fun withTotp(t: TotpConfig?) = with("totp" to t?.toJson())
    fun withCustomFields(list: List<CustomField>) = with(
        "fields" to if (list.isEmpty()) null else JsonArray(
            list.map { JsonObject(mapOf("name" to JsonPrimitive(it.name), "value" to JsonPrimitive(it.value), "type" to JsonPrimitive(it.type))) },
        ),
    )

    fun toJson(): String = JsonObject(fields).toString()

    companion object {
        fun parse(json: String): ItemBody = ItemBody(LinkedHashMap(Json.parseToJsonElement(json) as JsonObject))
    }
}

class Item(
    val id: String,
    val vaultId: String,
    @Volatile var revision: Int,
    @Volatile var deleted: Boolean,
    val updatedAt: String,
    val body: ItemBody,
)

fun newBody(kind: String, title: String, vararg extra: Pair<String, JsonElement?>): ItemBody {
    val at = isoNow()
    val base = LinkedHashMap<String, JsonElement>()
    base["v"] = JsonPrimitive(1)
    base["kind"] = JsonPrimitive(kind)
    base["title"] = JsonPrimitive(title)
    base["createdAt"] = JsonPrimitive(at)
    base["updatedAt"] = JsonPrimitive(at)
    return ItemBody(base).with(*extra)
}

/** On save: note an old password in the history, and when it changed. */
fun touch(prev: ItemBody?, next: ItemBody): ItemBody {
    val at = isoNow()
    var out = next.with("updatedAt" to JsonPrimitive(at), "seq" to JsonPrimitive(maxOf(prev?.seq ?: 0L, next.seq) + 1))
    val before = prev?.password
    if (prev != null && !before.isNullOrEmpty() && before != next.password) {
        val entry = JsonObject(mapOf("password" to JsonPrimitive(before), "at" to JsonPrimitive(at)))
        val old = (prev["passwordHistory"] as? JsonArray) ?: JsonArray(emptyList())
        out = out.with("passwordHistory" to JsonArray((listOf<JsonElement>(entry) + old).take(20)), "passwordChangedAt" to JsonPrimitive(at))
    } else if (prev == null && !next.password.isNullOrEmpty()) {
        out = out.with("passwordChangedAt" to JsonPrimitive(at))
    }
    // A password set some other way settles it: a new one still waiting would later overwrite this.
    // It might be what the site took, so it's kept where it can be got back. As `touch` in model.ts.
    val pending = out.str("pendingPassword")
    if (prev != null && before != next.password && !pending.isNullOrEmpty() && next.password != pending) {
        if (pending != before) {
            val entry = JsonObject(mapOf("password" to JsonPrimitive(pending), "at" to JsonPrimitive(at)))
            val old = (out["passwordHistory"] as? JsonArray) ?: JsonArray(emptyList())
            out = out.with("passwordHistory" to JsonArray((listOf<JsonElement>(entry) + old).take(20)))
        }
        out = out.with("pendingPassword" to null)
    }
    return out
}

private val SEARCHED = listOf("title", "username", "notes", "email", "cardholder", "ssid", "bankName", "documentType", "firstName", "lastName", "company")

/** What search looks through, lowercased. Never secrets, so a search can't test a guess. */
fun searchText(body: ItemBody): String {
    val parts = ArrayList<String>()
    for (k in SEARCHED) body.str(k)?.let { parts += it }
    body.urls.forEach { parts += it.url }
    parts += body.tags
    for (f in body.customFields) {
        parts += f.name
        if (f.type != "hidden") parts += f.value
    }
    return parts.joinToString("\n").lowercase()
}

/** Same comparison as `stable()` in model.ts: sorted keys; a missing value reads as null. */
fun stable(v: JsonElement?): String = when (v) {
    null, is JsonNull -> "null"
    is JsonPrimitive -> v.toString()
    is JsonArray -> v.joinToString(",", "[", "]") { stable(it) }
    is JsonObject -> v.keys.sorted().joinToString(",", "{", "}") { JsonPrimitive(it).toString() + ":" + stable(v[it]) }
}

private fun same(a: JsonElement?, b: JsonElement?) = stable(a) == stable(b)

private fun strip(b: ItemBody): JsonObject = JsonObject(b.fields.filterKeys { it != "updatedAt" && it != "conflicts" && it != "seq" })

class MergeResult(val body: ItemBody, val conflicted: Boolean)

/** Three-way merge, field by field: whatever only one side changed is kept. A field
 *  both changed differently can't be decided here, so the server's stands and the
 *  local one is kept whole as a conflict to pick from. Nothing is ever dropped. */
fun mergeBodies(base: ItemBody?, local: ItemBody, server: ItemBody): MergeResult {
    val out = LinkedHashMap(server.fields)
    var conflicted = base == null && !same(strip(local), strip(server))
    if (base != null) {
        for (key in base.fields.keys + local.fields.keys + server.fields.keys) {
            // `seq` is set by whoever calls this: two sides having edited isn't a conflict in itself.
            if (key == "updatedAt" || key == "conflicts" || key == "seq") continue
            val b = base[key]
            val l = local[key]
            val s = server[key]
            if (same(l, s) || same(l, b)) continue // server's stands
            if (same(s, b)) {
                if (l == null) out.remove(key) else out[key] = l
                continue
            }
            conflicted = true
        }
    }
    val conflicts = ArrayList<JsonObject>(server.conflicts + local.conflicts)
    val at = isoNow()
    if (conflicted) conflicts += JsonObject(mapOf("at" to JsonPrimitive(at), "body" to strip(local)))
    out["updatedAt"] = JsonPrimitive(at)
    if (conflicts.isNotEmpty()) {
        val seen = HashSet<String>()
        out["conflicts"] = JsonArray(conflicts.filter { seen.add(stable(it["body"])) })
    } else {
        out.remove("conflicts")
    }
    var body = ItemBody(out)
    val serverPw = server.password
    val mergedPw = body.password
    if (serverPw != null && mergedPw != null && serverPw != mergedPw) {
        val entry = JsonObject(mapOf("password" to JsonPrimitive(serverPw), "at" to JsonPrimitive(at)))
        val old = (body["passwordHistory"] as? JsonArray) ?: JsonArray(emptyList())
        body = body.with("passwordHistory" to JsonArray((listOf<JsonElement>(entry) + old).take(20)))
    }
    return MergeResult(body, conflicted)
}
