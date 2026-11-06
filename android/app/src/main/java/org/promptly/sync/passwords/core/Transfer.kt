// Bringing passwords in and out, parsed and made on this device. Mirrors importers.ts for
// browser CSVs, Bitwarden JSON (plain and password-protected) and Promptly's own files,
// exporter.ts for export, and send.ts for Secure Send. Input is treated as hostile: size
// limits, and anything that doesn't parse fails with an error rather than a crash.
package org.promptly.sync.passwords.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

class NeedsPasswordError(val format: String) : Exception("This file is protected by a password")

data class Imported(val body: ItemBody, val folder: String? = null)

class ImportResult(val format: String, val items: List<Imported>, val warnings: List<String>)

object Importers {
    const val MAX_BYTES = 64 * 1024 * 1024
    private const val MAX_ITEMS = 200_000

    /** RFC 4180 with the usual messes: BOM, CRLF or LF, quotes in the middle of cells. */
    fun parseCsv(text: String): List<List<String>> {
        val rows = ArrayList<List<String>>()
        var row = ArrayList<String>()
        val cell = StringBuilder()
        var quoted = false
        val s = text.removePrefix("\uFEFF")
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (quoted) {
                if (c == '"') {
                    if (i + 1 < s.length && s[i + 1] == '"') {
                        cell.append('"')
                        i++
                    } else {
                        quoted = false
                    }
                } else {
                    cell.append(c)
                }
            } else if (c == '"' && cell.isEmpty()) {
                quoted = true
            } else if (c == ',') {
                row.add(cell.toString())
                cell.clear()
            } else if (c == '\n' || c == '\r') {
                if (c == '\r' && i + 1 < s.length && s[i + 1] == '\n') i++
                row.add(cell.toString())
                cell.clear()
                if (row.size > 1 || row[0] != "") rows.add(row)
                row = ArrayList()
                if (rows.size > MAX_ITEMS) throw IllegalArgumentException("That file has too many rows")
            } else {
                cell.append(c)
            }
            i++
        }
        if (cell.isNotEmpty() || row.isNotEmpty()) {
            row.add(cell.toString())
            rows.add(row)
        }
        return rows
    }

    private fun norm(h: String) = h.trim().lowercase().replace(Regex("[^a-z0-9]"), "")

    // Synonyms for fuzzy columns, most specific first. The same list as importers.ts.
    private val COLUMNS = linkedMapOf(
        "title" to listOf("name", "title", "item", "itemname", "account", "accountname", "site", "sitename", "service", "entry", "label", "group/title"),
        "url" to listOf("url", "website", "uri", "loginuri", "web", "address", "origin", "hostname", "host", "loginurl", "domain", "siteurl", "formactionorigin"),
        "username" to listOf("username", "user", "login", "loginname", "loginusername", "email", "emailaddress", "userid", "usernameemail"),
        "password" to listOf("password", "pass", "pwd", "passwd", "loginpassword", "secret"),
        "otp" to listOf("otpauth", "otp", "totp", "otpurl", "logintotp", "authenticator", "2fa", "twofactor", "onetimepassword", "verificationcode", "totpuri"),
        "notes" to listOf("notes", "note", "extra", "comments", "comment", "description"),
        "folder" to listOf("folder", "group", "grouping", "category", "vault"),
        "tags" to listOf("tags", "tag", "labels"),
        "fav" to listOf("favorite", "favourite", "fav", "starred"),
    )

    private fun columnsOf(header: List<String>): Map<String, Int> {
        val idx = HashMap<String, Int>()
        val n = header.map { norm(it) }
        for ((key, names) in COLUMNS) {
            for (name in names) {
                val at = n.indexOf(name.replace(Regex("[^a-z0-9]"), ""))
                if (at >= 0) {
                    idx[key] = at
                    break
                }
            }
        }
        return idx
    }

    private val ANDROID_URL = Regex("^android(?:app)?://(?:[^@/?#]*@)?([A-Za-z0-9_.]+)/?(?:[?#].*)?$", RegexOption.IGNORE_CASE)

    /** Chrome's `android://HASH@com.acme.app/` and Bitwarden's `androidapp://com.acme.app` name
     *  an app. Kept as one, with match "never", so a package that reads like a hostname never
     *  matches a website. With no certificate to go on, it fills only after a person picks it. */
    private fun appUrlFrom(u: LoginUrl): LoginUrl {
        if (!u.url.startsWith("android", true)) return u
        val pkg = ANDROID_URL.find(u.url)?.groupValues?.get(1) ?: return u
        if (u.url.contains("?cert=") && u.url.startsWith(Match.APP_SCHEME)) return u.copy(match = "never")
        return LoginUrl("${Match.APP_SCHEME}$pkg", "never")
    }

    /** What a file can make: every item kind a person sees, and nothing the app keeps for itself. */
    private val IMPORTABLE_KINDS = setOf("login", "note", "card", "identity", "totp", "passkey", "apikey", "wifi", "ssh", "bank", "document")

    /** Fields only this app writes. A file naming them could plant a trust book, or make an
     *  item's version look newer than it is. */
    private val INTERNAL_FIELDS = setOf("trustBook", "conflicts", "seq", "pendingPassword", "sendId")

    /** A file can say anything, so only what a person could have made comes in. */
    fun sanitize(r: ImportResult): ImportResult {
        val items = ArrayList<Imported>()
        var dropped = 0
        for (it in r.items) {
            if (it.body.kind !in IMPORTABLE_KINDS) {
                dropped++
                continue
            }
            val kept = LinkedHashMap(it.body.fields)
            INTERNAL_FIELDS.forEach { f -> kept.remove(f) }
            val clean = ItemBody(kept)
            items += Imported(if (clean["urls"] != null) clean.withUrls(clean.urls.map { u -> appUrlFrom(u) }) else clean, it.folder)
        }
        val warnings = if (dropped > 0) r.warnings + "$dropped entries in that file weren't items you can see, and were left out." else r.warnings
        return ImportResult(r.format, items, warnings)
    }

    /** Reads no more than the limit, wherever the bytes come from. */
    fun readLimited(input: java.io.InputStream): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            if (out.size() + n > MAX_BYTES) throw IllegalArgumentException("That file is too large")
            out.write(buffer, 0, n)
        }
        return out.toByteArray()
    }

    private fun cleanUrl(u: String): List<LoginUrl> {
        val t = u.trim()
        return if (t.isEmpty() || t == "http://sn" || t == "http://" || t == "https://") emptyList() else listOf(appUrlFrom(LoginUrl(t)))
    }

    private fun titleFrom(title: String?, url: String?, user: String?): String {
        if (!title.isNullOrBlank()) return title.trim()
        if (!url.isNullOrEmpty()) Match.hostOf(url)?.let { return it.removePrefix("www.") }
        return user?.trim()?.ifEmpty { null } ?: "Imported login"
    }

    private val B32 = Regex("^[A-Z2-7]+=*$")

    private fun otpFrom(text: String?, warnings: MutableList<String>, name: String): TotpConfig? {
        val t = text?.trim()
        if (t.isNullOrEmpty()) return null
        try {
            if (t.startsWith("otpauth://") || t.startsWith("steam://")) return Totp.parseOtpauth(t)
            val secret = t.uppercase().replace(Regex("\\s"), "")
            if (B32.matches(secret)) return TotpConfig(secret)
            warnings += "$name: its 2FA secret wasn't in a form we can read."
        } catch (e: IllegalArgumentException) {
            warnings += "$name: ${e.message}"
        }
        return null
    }

    fun fromGenericCsv(text: String, format: String = "CSV"): ImportResult {
        val rows = parseCsv(text)
        if (rows.isEmpty()) return ImportResult(format, emptyList(), listOf("That file is empty."))
        val idx = columnsOf(rows[0])
        val warnings = ArrayList<String>()
        if ("password" !in idx && "username" !in idx && "url" !in idx) throw IllegalArgumentException("We couldn't find a password, username or website column in that file.")
        val known = idx.values.toSet()
        val items = ArrayList<Imported>()
        for ((line, r) in rows.drop(1).withIndex()) {
            if (r.all { it.isBlank() }) continue
            fun get(k: String) = idx[k]?.let { r.getOrNull(it) } ?: ""
            val url = get("url")
            val username = get("username")
            val password = get("password")
            val title = titleFrom(get("title"), url, username)
            if (password.isEmpty() && username.isEmpty() && url.isEmpty() && get("notes").isEmpty()) {
                warnings += "Line ${line + 2}: nothing usable, skipped."
                continue
            }
            val totp = otpFrom(get("otp"), warnings, title)
            // Everything else in the row is kept as a field rather than dropped.
            val fields = ArrayList<CustomField>()
            for ((i, h) in rows[0].withIndex()) {
                val v = r.getOrNull(i)
                if (i !in known && !v.isNullOrBlank()) fields += CustomField(h.trim().ifEmpty { "Column ${i + 1}" }, v, "text")
            }
            var body = newBody("login", title).withText("username", username).withText("password", password).withText("notes", get("notes")).withUrls(cleanUrl(url)).withCustomFields(fields)
            if (totp != null) body = body.withTotp(totp)
            val tags = get("tags").split(Regex("[;,]")).map { it.trim() }.filter { it.isNotEmpty() }
            if (tags.isNotEmpty()) body = body.with("tags" to JsonArray(tags.map { JsonPrimitive(it) }))
            if (Regex("^(1|true|yes)$", RegexOption.IGNORE_CASE).matches(get("fav"))) body = body.withFlag("favorite", true)
            items += Imported(body, get("folder").ifEmpty { null })
        }
        return ImportResult(format, items, warnings)
    }

    private fun JsonElement?.obj() = this as? JsonObject
    private fun JsonElement?.list(): List<JsonObject> = (this as? JsonArray)?.filterIsInstance<JsonObject>() ?: emptyList()
    private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content?.ifEmpty { null }
    private fun JsonElement?.any(): String = when (this) {
        null, is JsonNull -> ""
        is JsonPrimitive -> content
        else -> toString()
    }

    private fun bwMatch(m: JsonElement?): String? = when ((m as? JsonPrimitive)?.contentOrNull) {
        "0" -> "base"
        "1" -> "host"
        "2" -> "prefix"
        "3" -> "exact"
        "4" -> "regex"
        "5" -> "never"
        else -> null
    }

    private fun base(body: ItemBody, it: JsonObject): ItemBody {
        var b = body.withText("notes", it["notes"].text())
        if ((it["favorite"] as? JsonPrimitive)?.booleanOrNull == true) b = b.withFlag("favorite", true)
        if ((it["reprompt"] as? JsonPrimitive)?.contentOrNull == "1") b = b.withFlag("reprompt", true)
        val fields = it["fields"].list().map { f ->
            val type = when ((f["type"] as? JsonPrimitive)?.contentOrNull) {
                "1" -> "hidden"
                "2" -> "boolean"
                else -> "text"
            }
            CustomField(f["name"].text() ?: "Field", f["value"].any(), type)
        }.filter { it.value.isNotEmpty() }
        return b.withCustomFields(fields)
    }

    fun fromBitwardenJson(data: JsonObject): ImportResult {
        if ((data["encrypted"] as? JsonPrimitive)?.booleanOrNull == true) throw NeedsPasswordError("Bitwarden")
        val warnings = ArrayList<String>()
        val folders = data["folders"].list().associate { it["id"].text() to it["name"].text() }
        val items = ArrayList<Imported>()
        for (it in data["items"].list()) {
            val title = it["name"].text() ?: "Imported item"
            val folder = folders[it["folderId"].text()]
            when ((it["type"] as? JsonPrimitive)?.contentOrNull) {
                "1" -> {
                    val l = it["login"].obj() ?: JsonObject(emptyMap())
                    val passkeys = l["fido2Credentials"].list().mapNotNull { pk ->
                        val key = pk["keyValue"].text()
                        val rp = pk["rpId"].text()
                        val cred = pk["credentialId"].text()
                        if (key == null || rp == null || cred == null) {
                            null
                        } else {
                            // Bitwarden's key is a PKCS#8 ES256 private key, base64url.
                            Passkey(cred, rp, pk["rpName"].text(), pk["userHandle"].text() ?: "", pk["userName"].text() ?: "", pk["userDisplayName"].text(), key, pk["counter"].any().toIntOrNull() ?: 0, pk["creationDate"].text() ?: isoNow(), null, pk["discoverable"].any() != "false")
                        }
                    }
                    val urls = l["uris"].list().map { u -> appUrlFrom(LoginUrl(u["uri"].any(), bwMatch(u["match"]))) }.filter { u -> u.url.isNotEmpty() }
                    val history = it["passwordHistory"].list().mapNotNull { h ->
                        val pw = h["password"].any()
                        if (pw.isEmpty()) null else JsonObject(mapOf("password" to JsonPrimitive(pw), "at" to JsonPrimitive(h["lastUsedDate"].text() ?: "1970-01-01T00:00:00.000Z")))
                    }
                    var b = base(newBody("login", title), it).withText("username", l["username"].text()).withText("password", l["password"].text()).withUrls(urls)
                    otpFrom(l["totp"].text(), warnings, title)?.let { t -> b = b.withTotp(t) }
                    if (passkeys.isNotEmpty()) b = b.withPasskeys(passkeys)
                    if (history.isNotEmpty()) b = b.with("passwordHistory" to JsonArray(history))
                    items += Imported(b, folder)
                }
                "2" -> items += Imported(base(newBody("note", title), it), folder)
                "3" -> {
                    val c = it["card"].obj() ?: JsonObject(emptyMap())
                    items += Imported(
                        base(newBody("card", title), it).withText("cardholder", c["cardholderName"].text()).withText("cardNumber", c["number"].text()).withText("cardBrand", c["brand"].text())
                            .withText("cardExpMonth", c["expMonth"].text()).withText("cardExpYear", c["expYear"].text()).withText("cardCvv", c["code"].text()),
                        folder,
                    )
                }
                "4" -> {
                    val d = it["identity"].obj() ?: JsonObject(emptyMap())
                    var b = base(newBody("identity", title), it)
                    for ((from, to) in listOf("firstName" to "firstName", "middleName" to "middleName", "lastName" to "lastName", "email" to "email", "phone" to "phone", "company" to "company", "address1" to "address1", "address2" to "address2", "city" to "city", "state" to "state", "postalCode" to "postcode", "country" to "country")) {
                        b = b.withText(to, d[from].text())
                    }
                    items += Imported(b, folder)
                }
                "5" -> {
                    val k = it["sshKey"].obj() ?: JsonObject(emptyMap())
                    items += Imported(base(newBody("ssh", title), it).withText("sshPublic", k["publicKey"].text()).withText("sshPrivate", k["privateKey"].text()).withText("sshFingerprint", k["keyFingerprint"].text()), folder)
                }
                else -> {
                    warnings += "$title: a kind of item we don't know, kept as a note."
                    var b = base(newBody("note", title), it)
                    if (b.notes == null) b = b.withText("notes", it.toString())
                    items += Imported(b, folder)
                }
            }
        }
        return ImportResult("Bitwarden", items, warnings)
    }

    // ---- Bitwarden's password-protected export: the same reading as bitwarden.ts ----

    private fun b64(s: String): ByteArray = Base64.getDecoder().decode(s)

    private fun hkdfExpand(prk: ByteArray, info: String): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        return mac.doFinal(concat(utf8(info), byteArrayOf(1)))
    }

    private fun masterKey(password: String, salt: ByteArray, data: JsonObject): ByteArray {
        val kdfType = data["kdfType"].any().toIntOrNull() ?: 0
        val iterations = data["kdfIterations"].any().toIntOrNull() ?: 0
        require(iterations in 1..100_000_000) { "Unusual KDF settings in that file" }
        if (kdfType == 0) {
            val f = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
            // PBEKeySpec takes chars and encodes them as UTF-8 for this algorithm.
            return f.generateSecret(PBEKeySpec(password.toCharArray(), salt, iterations, 256)).encoded
        }
        if (kdfType == 1) {
            val memory = data["kdfMemory"].any().toIntOrNull() ?: 64
            val parallelism = data["kdfParallelism"].any().toIntOrNull() ?: 4
            require(memory in 1..4096 && parallelism in 1..16) { "Unusual KDF settings in that file" }
            return Primitives.argon2Engine.hash(utf8(password), Primitives.sha256(salt), memory * 1024, iterations, parallelism, 32)
        }
        throw IllegalArgumentException("That file uses a key setting we don't know")
    }

    private fun decryptCipherString(s: String, enc: ByteArray, macKey: ByteArray): ByteArray {
        val dot = s.indexOf('.')
        require(dot > 0 && s.substring(0, dot) == "2") { "Unknown Bitwarden cipher type" }
        val parts = s.substring(dot + 1).split('|').map { b64(it) }
        require(parts.size == 3 && parts[0].size == 16 && parts[2].size == 32) { "Damaged Bitwarden data" }
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(macKey, "HmacSHA256"))
        if (!equalBytes(mac.doFinal(concat(parts[0], parts[1])), parts[2])) throw IllegalArgumentException("wrong password")
        val c = Cipher.getInstance("AES/CBC/PKCS5Padding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(enc, "AES"), IvParameterSpec(parts[0]))
        return c.doFinal(parts[1])
    }

    fun decryptBitwarden(data: JsonObject, password: String): JsonObject {
        val saltText = data["salt"].any()
        val validation = data["encKeyValidation_DO_NOT_EDIT"].any()
        val payload = data["data"].any()
        require(saltText.isNotEmpty() && validation.isNotEmpty() && payload.isNotEmpty()) { "That Bitwarden file is missing parts" }
        // Notes disagree on whether the salt is its base64 text or the bytes: the MAC decides.
        val salts = listOfNotNull(utf8(saltText), runCatching { b64(saltText) }.getOrNull())
        for (salt in salts) {
            val master = masterKey(password, salt, data)
            val enc = hkdfExpand(master, "enc")
            val mac = hkdfExpand(master, "mac")
            if (runCatching { decryptCipherString(validation, enc, mac) }.isFailure) continue
            return Json.parseToJsonElement(fromUtf8(decryptCipherString(payload, enc, mac))) as JsonObject
        }
        throw IllegalArgumentException("That password didn't open the file")
    }

    /** The formats this client reads. The others (1Password, KeePass and so on) are the web
     *  vault's, and say so rather than failing strangely. */
    fun importFile(name: String, bytes: ByteArray, password: String? = null): ImportResult = sanitize(readFile(name, bytes, password))

    private fun readFile(name: String, bytes: ByteArray, password: String?): ImportResult {
        require(bytes.size <= MAX_BYTES) { "That file is too large" }
        if (bytes.size >= 2 && bytes[0] == 0x50.toByte() && bytes[1] == 0x4b.toByte()) throw IllegalArgumentException("That's a zip file. Import 1Password and Dashlane files from the web vault.")
        if (bytes.size >= 4 && bytes[0] == 0x03.toByte() && bytes[1] == 0xd9.toByte()) throw IllegalArgumentException("That's a KeePass file. Import it from the web vault.")
        val text = runCatching { fromUtf8(bytes) }.getOrElse { throw IllegalArgumentException("We can't read that file. Is it a password export?") }
        val trimmed = text.trimStart().removePrefix("\uFEFF")
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            val data = runCatching { Json.parseToJsonElement(trimmed) }.getOrElse { throw IllegalArgumentException("That JSON file is damaged") } as? JsonObject
                ?: throw IllegalArgumentException("We don't recognise that JSON file.")
            val format = data["format"].any()
            if (format == "promptly-pw-export") return Exporter.readEncrypted(data, password ?: throw NeedsPasswordError("Promptly"))
            if (format == "promptly-pw-plain") return ImportResult("Promptly", data["items"].list().map { Imported(ItemBody(LinkedHashMap(it))) }, emptyList())
            val encrypted = (data["encrypted"] as? JsonPrimitive)?.booleanOrNull == true
            if (encrypted && "encKeyValidation_DO_NOT_EDIT" in data) return fromBitwardenJson(decryptBitwarden(data, password ?: throw NeedsPasswordError("Bitwarden")))
            if (encrypted) throw IllegalArgumentException("That Bitwarden file is locked to its account. Export it as 'Password protected' or plain JSON instead.")
            if (data["items"] is JsonArray && ((data["encrypted"] as? JsonPrimitive)?.booleanOrNull == false || data["folders"] is JsonArray)) return fromBitwardenJson(data)
            throw IllegalArgumentException("We don't recognise that JSON file. Other formats can be imported from the web vault.")
        }
        val header = text.lineSequence().firstOrNull()?.lowercase() ?: ""
        return when {
            "httprealm" in header || "formactionorigin" in header -> fromGenericCsv(text, "Firefox")
            "otpauth" in header && "title" in header -> fromGenericCsv(text, "Apple Passwords")
            "name" in header && "url" in header && "username" in header && "password" in header -> fromGenericCsv(text, "Browser")
            else -> fromGenericCsv(text)
        }
    }

    private fun fingerprint(b: ItemBody): String {
        val host = b.urls.firstOrNull()?.url?.let { Match.hostOf(it)?.removePrefix("www.") ?: it } ?: ""
        return listOf(b.kind, host, b.username ?: "", b.password ?: "", b.str("cardNumber") ?: "", if (b.kind == "note") "${b.title}|${b.notes ?: ""}" else "", b.totp?.secret ?: "").joinToString("\u0000")
    }

    /** Removes exact duplicates, inside the file and against what's already here. */
    fun dedupe(items: List<Imported>, existing: List<ItemBody>): Pair<List<Imported>, Int> {
        val seen = existing.map { fingerprint(it) }.toHashSet()
        val fresh = ArrayList<Imported>()
        var duplicates = 0
        for (it in items) if (seen.add(fingerprint(it.body))) fresh += it else duplicates++
        return fresh to duplicates
    }

    /** "Delete the old copy" instructions shown after an import from a browser. */
    val AFTER_IMPORT = mapOf(
        "Browser" to "Your browser still has its copy. Once this looks right, remove it: Chrome or Edge, Settings, Passwords, and delete them there. Turn off offering to save passwords too.",
        "Firefox" to "Firefox still has its copy. Once this looks right: Settings, Privacy & Security, Saved Passwords, Remove All.",
    )
}

object Exporter {
    private val EMPTY = ByteArray(0)

    private fun exportKey(password: String, salt: ByteArray, kdf: KdfParams): ByteArray {
        checkKdf(kdf)
        return Primitives.hkdf(Primitives.argon2(normalizePassword(password), salt, kdf), EMPTY, "promptly-pw/v1/export")
    }

    private fun bodies(items: List<Item>) = JsonArray(items.map { JsonObject(it.body.fields) })

    fun encrypted(items: List<Item>, password: String, kdf: KdfParams = KdfParams.FLOOR): String {
        val salt = randomBytes(16)
        val key = exportKey(password, salt, kdf)
        val payload = JsonObject(mapOf("items" to bodies(items))).toString()
        val blob = seal(key, utf8(payload), aad("export", "", "payload"))
        return buildJsonObject {
            put("format", "promptly-pw-export")
            put("version", 1)
            put("kdf", kdfJson(kdf))
            put("salt", b64u(salt))
            put("data", b64u(blob))
        }.toString()
    }

    fun readEncrypted(data: JsonObject, password: String): ImportResult {
        require(data.int("version") == 1) { "That export is from a newer version" }
        val kdf = parseKdf(data["kdf"]) ?: throw IllegalArgumentException("That export is damaged")
        val key = exportKey(password, fromB64u(data.str("salt") ?: ""), kdf)
        val plain = runCatching { open(key, fromB64u(data.str("data") ?: ""), aad("export", "", "payload")) }.getOrElse { throw IllegalArgumentException("That password didn't open the file") }
        val payload = Json.parseToJsonElement(fromUtf8(plain)) as JsonObject
        return ImportResult("Promptly", (payload["items"] as JsonArray).filterIsInstance<JsonObject>().map { Imported(ItemBody(LinkedHashMap(it))) }, emptyList())
    }

    fun plainJson(items: List<Item>): String = buildJsonObject {
        put("format", "promptly-pw-plain")
        put("version", 1)
        put("items", bodies(items))
    }.toString()

    private fun csvCell(v: String): String {
        // A leading =, +, - or @ would run as a formula if someone opens this in a spreadsheet.
        val safe = if (v.isNotEmpty() && v[0] in "=+-@\t\r") "'$v" else v
        return if (safe.any { it in "\",\r\n" }) "\"" + safe.replace("\"", "\"\"") + "\"" else safe
    }

    /** Logins as CSV, in the column names other managers read. */
    fun plainCsv(items: List<Item>): String {
        val rows = ArrayList<List<String>>()
        rows += listOf("name", "url", "username", "password", "otpauth", "notes")
        for (i in items) {
            val b = i.body
            if (b.kind != "login") continue
            rows += listOf(b.title, b.urls.firstOrNull()?.url ?: "", b.username ?: "", b.password ?: "", b.totp?.secret ?: "", b.notes ?: "")
        }
        return rows.joinToString("\r\n") { r -> r.joinToString(",") { csvCell(it) } } + "\r\n"
    }
}

object SecureSend {
    private val EMPTY = ByteArray(0)

    /** A file becomes base64 inside the blob, and the blob's limit is 10 MB. */
    const val MAX_FILE = 7 * 1024 * 1024

    private class FromPassword(val proof: ByteArray, val mix: ByteArray)

    private fun fromPassword(password: String, salt: ByteArray): FromPassword {
        val stretched = Primitives.argon2(normalizePassword(password), salt, KdfParams.FLOOR)
        // Two separate outputs: what the server checks can't open anything.
        val proof = Primitives.hkdf(stretched, salt, "promptly-pw/v1/send-auth")
        val mix = Primitives.hkdf(stretched, salt, "promptly-pw/v1/send-mix")
        stretched.fill(0)
        return FromPassword(proof, mix)
    }

    private fun contentKey(sendKey: ByteArray, mix: ByteArray) = Primitives.hkdf(sendKey, mix, "promptly-pw/v1/send")

    fun textPayload(title: String, text: String): JsonObject = buildJsonObject {
        put("kind", "text")
        put("title", title)
        put("text", text)
    }

    fun filePayload(title: String, name: String, mime: String?, data: ByteArray): JsonObject = buildJsonObject {
        require(data.size <= MAX_FILE) { "A Send's file can be up to 7 MB." }
        put("kind", "file")
        put("title", title)
        put("name", name)
        if (mime != null) put("mime", mime)
        put("data", Base64.getEncoder().encodeToString(data))
    }

    class Created(val id: String, val link: String)

    /** The key goes in the link's fragment, which browsers don't send to servers. */
    fun create(api: VaultApi, payload: JsonObject, days: Int, views: Int?, password: String?): Created {
        val id = randomUuid()
        val sendKey = randomBytes(32)
        val salt = if (password.isNullOrEmpty()) null else randomBytes(16)
        val derived = salt?.let { fromPassword(password!!, it) }
        val blob = seal(contentKey(sendKey, derived?.mix ?: EMPTY), pad(utf8(payload.toString())), aad(id, "", "send"))
        api.createSend(buildJsonObject {
            put("id", id)
            put("blob", b64u(blob))
            put("days", days)
            put("views", views)
            put("password_salt", salt?.let { b64u(it) })
            put("password_proof", derived?.let { b64u(it.proof) })
        })
        return Created(id, "${api.baseUrl}/passwords/send/$id#${b64u(sendKey)}")
    }
}

/** The device-join QR: `pwdev:<request id>:<device pub b64url>`, the web client's text. */
object DeviceQr {
    class Refused(message: String) : Exception(message)

    private val SHAPE = Regex("^pwdev:([0-9a-f-]{36}):([A-Za-z0-9_-]+)$")

    fun text(id: String, pub: ByteArray) = "pwdev:$id:${b64u(pub)}"

    fun parse(text: String): Pair<String, String>? = SHAPE.find(text.trim())?.let { it.groupValues[1] to it.groupValues[2] }
}

/** How a Wi-Fi network is written in a QR that phones join from. The web client's text. */
fun wifiQrText(body: ItemBody): String {
    fun esc(s: String) = s.replace(Regex("([\\\\;,\":])"), "\\\\$1")
    return "WIFI:T:${body.str("wifiSecurity") ?: "WPA"};S:${esc(body.text("ssid"))};P:${esc(body.text("wifiPassword"))};;"
}

/** What setup should use: the floor, raised a step if this device is quick. Same steps as
 *  the web client's Onboarding. The time is one run at the floor. */
fun calibrateKdf(millisAtFloor: Long): KdfParams = when {
    millisAtFloor < 180 -> KdfParams.FLOOR.copy(m = 262144)
    millisAtFloor < 400 -> KdfParams.FLOOR.copy(m = 131072)
    else -> KdfParams.FLOOR
}

fun calibrateKdf(engine: Argon2Engine = Primitives.argon2Engine): KdfParams {
    // BouncyCastle runs on the Java heap: don't size a vault for what only native code can do.
    if (engine === BouncyCastleArgon2) return KdfParams.FLOOR
    val f = KdfParams.FLOOR
    val start = System.nanoTime()
    engine.hash(ByteArray(16), ByteArray(16), f.m, f.t, f.p, 32)
    return calibrateKdf((System.nanoTime() - start) / 1_000_000)
}
