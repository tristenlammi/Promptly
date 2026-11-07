// The other managers' files, read on this phone. Mirrors importers.ts one format at a time, down
// to what JavaScript does with a value of the wrong type, because the point is that a file comes
// in as the same items on every client. android/app/src/test/cross checks that against the
// TypeScript. No code from those projects: their public documentation and observed files. Pure JVM.
package org.promptly.sync.passwords.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigDecimal
import java.time.Instant

private val NOTHING = JsonObject(emptyMap())

private fun JsonElement?.obj(): JsonObject = this as? JsonObject ?: NOTHING

/** `arr()`: an array, each element read as an object. A property of a string or a number is
 *  undefined, which an empty object gives too. A property of null throws. */
private fun JsonElement?.objects(): List<JsonObject> = (this as? JsonArray)?.map {
    if (it is JsonNull) throw IllegalArgumentException("That file has an empty entry where an item should be.")
    it as? JsonObject ?: NOTHING
} ?: emptyList()

private fun JsonElement?.isText() = this is JsonPrimitive && isString

/** `str()`: a string with something in it. */
private fun JsonElement?.text(): String? = if (this is JsonPrimitive && isString) content.ifEmpty { null } else null

private fun JsonElement?.isTheText(v: String) = this is JsonPrimitive && isString && content == v

private fun JsonElement?.isNumber() = this is JsonPrimitive && this !is JsonNull && !isString && content != "true" && content != "false"

private fun JsonElement?.isTrue() = this is JsonPrimitive && !isString && content == "true"

private fun textOf(d: Double): String {
    if (d.isNaN()) return "NaN"
    if (d.isInfinite()) return if (d > 0) "Infinity" else "-Infinity"
    val abs = Math.abs(d)
    if (abs == 0.0) return "0"
    if (abs < 1e21 && abs >= 1e-6) return BigDecimal(d.toString()).stripTrailingZeros().toPlainString()
    return d.toString().replace(".0E", "E").replace("E-", "e-").replace("E", "e+")
}

/** `String(x)`. */
private fun jsString(e: JsonElement?): String = when (e) {
    null -> "undefined"
    is JsonNull -> "null"
    is JsonPrimitive -> if (e.isString || !e.isNumber()) e.content else textOf(jsNumber(e))
    is JsonArray -> e.joinToString(",") { if (it is JsonNull) "" else jsString(it) }
    is JsonObject -> "[object Object]"
}

/** Longer than any number means anything here, and both ways of reading one below go quadratic on a
 *  long enough run of digits: BigInteger, and this regex backtracking on a bad last character. */
private const val MAX_NUMBER_TEXT = 1100

private val DECIMAL = Regex("^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?\\z")

private fun numberIn(text: String): Double {
    val t = text.trim()
    if (t.isEmpty()) return 0.0
    // JavaScript makes this Infinity or NaN. Nothing that reads a number here can hold either.
    if (t.length > MAX_NUMBER_TEXT) return Double.NaN
    if (t == "Infinity" || t == "+Infinity") return Double.POSITIVE_INFINITY
    if (t == "-Infinity") return Double.NEGATIVE_INFINITY
    if (t.length > 2 && t[0] == '0') {
        val radix = when (t[1]) {
            'x', 'X' -> 16
            'o', 'O' -> 8
            'b', 'B' -> 2
            else -> 0
        }
        if (radix != 0) return t.substring(2).toBigIntegerOrNull(radix)?.takeIf { it.signum() >= 0 }?.toDouble() ?: Double.NaN
    }
    return if (DECIMAL.matches(t)) t.toDouble() else Double.NaN
}

/** `Number(x)`. An array of one number isn't worth carrying over: NaN. */
private fun jsNumber(e: JsonElement): Double = when (e) {
    is JsonNull -> 0.0
    is JsonPrimitive -> if (e.isString) numberIn(e.content) else when (e.content) {
        "true" -> 1.0
        "false" -> 0.0
        else -> e.content.toDoubleOrNull() ?: Double.NaN
    }
    else -> Double.NaN
}

/** `Number(x ?? fallback)`, as far as a TotpConfig can hold it. */
private fun numberOr(e: JsonElement?, fallback: Int): Int? {
    val d = if (e == null || e is JsonNull) fallback.toDouble() else jsNumber(e)
    if (d.isNaN() || d != Math.floor(d) || Math.abs(d) > Int.MAX_VALUE) return null
    return d.toInt()
}

private fun truthy(e: JsonElement?): Boolean = when (e) {
    null, is JsonNull -> false
    is JsonPrimitive -> if (e.isString) e.content.isNotEmpty() else if (e.isNumber()) jsNumber(e).let { it != 0.0 && !it.isNaN() } else e.content == "true"
    else -> true
}

/** `new Date(seconds * 1000).toISOString()`, which throws on anything out of its range. */
private fun isoFromSeconds(e: JsonElement?): String {
    val ms = (if (e == null || e is JsonNull) 0.0 else jsNumber(e)) * 1000
    if (ms.isNaN() || Math.abs(ms) > 8.64e15) throw IllegalArgumentException("That file has a date we can't read")
    return isoNow(Instant.ofEpochMilli(ms.toLong()))
}

private fun jsonOf(bytes: ByteArray): JsonElement? = runCatching { StrictJson.parse(decode(bytes)) }.getOrNull()

/** fflate's strFromU8: bad UTF-8 becomes U+FFFD, and a leading BOM goes. */
private fun decode(b: ByteArray) = String(b, Charsets.UTF_8).removePrefix("﻿")

private fun algorithm(name: JsonElement?, sha1: String, sha256: String, sha512: String): String = when (jsString(name)) {
    sha256 -> "SHA256"
    sha512 -> "SHA512"
    sha1 -> "SHA1"
    else -> "SHA1"
}

/** An array's strings. The web would throw on any other kind of URL, later on. */
private fun JsonElement?.strings(): List<String> = (this as? JsonArray)?.mapNotNull { e -> (e as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } ?: emptyList()

private fun ItemBody.withTags(tags: JsonArray?) = with("tags" to tags?.takeIf { it.isNotEmpty() })

object ImportFormats {
    // ---- 1Password .1pux ------------------------------------------------------------

    /** Whether a zip is a .1pux, whatever it's called. A file that won't open as a zip isn't. */
    fun isOnePux(zip: ByteArray): Boolean = runCatching { "export.attributes" in SafeZip.names(zip) }.getOrDefault(false)

    fun from1pux(zip: ByteArray): ImportResult {
        val files = SafeZip.read(zip)
        val raw = files["export.data"] ?: throw IllegalArgumentException("That .1pux has no export.data")
        val data = jsonOf(raw) ?: throw IllegalArgumentException("That .1pux is damaged")
        val items = ArrayList<Imported>()
        val warnings = ArrayList<String>()
        for (account in data.obj()["accounts"].objects()) {
            for (vault in account["vaults"].objects()) {
                val folder = vault["attrs"].obj()["name"].text()
                for (it in vault["items"].objects()) {
                    if (it["state"].isTheText("trashed")) continue
                    val ov = it["overview"].obj()
                    val d = it["details"].obj()
                    val title = ov["title"].text() ?: "Imported item"
                    val fields = ArrayList<CustomField>()
                    var totp: TotpConfig? = null
                    val loginFields = d["loginFields"].objects()
                    val username = loginFields.firstOrNull { f -> f["designation"].isTheText("username") }?.get("value").text()
                    val password = loginFields.firstOrNull { f -> f["designation"].isTheText("password") }?.get("value").text()
                    for (section in d["sections"].objects()) {
                        for (f in section["fields"].objects()) {
                            val v = f["value"].obj()
                            val name = f["title"].text() ?: f["id"].text() ?: "Field"
                            if (v["totp"].isText()) {
                                totp = totp ?: Importers.otpFrom((v["totp"] as JsonPrimitive).content, warnings, title)
                                continue
                            }
                            val email = (v["email"] as? JsonObject)?.get("email_address")
                            when {
                                v["concealed"].isText() -> fields += CustomField(name, (v["concealed"] as JsonPrimitive).content, "hidden")
                                v["string"].isText() -> fields += CustomField(name, (v["string"] as JsonPrimitive).content, "text")
                                v["url"].isText() -> fields += CustomField(name, (v["url"] as JsonPrimitive).content, "text")
                                email.isText() -> fields += CustomField(name, (email as JsonPrimitive).content, "text")
                                v["phone"].isText() -> fields += CustomField(name, (v["phone"] as JsonPrimitive).content, "text")
                                v["creditCardNumber"].isText() -> fields += CustomField("cardNumber", (v["creditCardNumber"] as JsonPrimitive).content, "hidden")
                                v["creditCardType"].isText() -> fields += CustomField("cardBrand", (v["creditCardType"] as JsonPrimitive).content, "text")
                                v["monthYear"].isNumber() -> fields += CustomField("expiry", jsString(v["monthYear"]), "text")
                            }
                        }
                    }
                    val urls = ArrayList(ov["urls"].objects().map { u -> LoginUrl(jsStringOrEmpty(u["url"])) }.filter { u -> u.url.isNotEmpty() })
                    if (urls.isEmpty()) ov["url"].text()?.let { u -> urls += LoginUrl(u) }
                    val tags = ov["tags"] as? JsonArray
                    fun common(b: ItemBody, withFields: List<CustomField>) = b.withText("notes", d["notesPlain"].text()).withTags(tags).withFlag("archived", it["state"].isTheText("archived")).withCustomFields(withFields)
                    // Only category 001 is documented. The rest go by what's in them.
                    val card = fields.firstOrNull { f -> f.name == "cardNumber" }
                    if (it["categoryUuid"].isTheText("001") || username != null || password != null) {
                        val history = d["passwordHistory"].objects().map { h -> jsStringOrEmpty(h["value"]) to isoFromSeconds(h["time"]) }.filter { h -> h.first.isNotEmpty() }
                            .map { (pw, at) -> JsonObject(mapOf("password" to JsonPrimitive(pw), "at" to JsonPrimitive(at))) }
                        val body = common(newBody("login", title), fields).withText("username", username).withText("password", password).withUrls(urls).withTotp(totp)
                            .with("passwordHistory" to history.takeIf { h -> h.isNotEmpty() }?.let { h -> JsonArray(h) })
                        items += Imported(body, folder)
                    } else if (card != null) {
                        items += Imported(common(newBody("card", title), fields.filter { f -> f !== card }).withText("cardNumber", card.value), folder)
                    } else {
                        items += Imported(common(newBody("note", title), fields), folder)
                    }
                }
            }
        }
        return ImportResult("1Password", items, warnings)
    }

    /** `String(x ?? "")`. */
    private fun jsStringOrEmpty(e: JsonElement?) = if (e == null || e is JsonNull) "" else jsString(e)

    // ---- Proton Pass ------------------------------------------------------------------

    fun fromProtonJson(data: JsonObject): ImportResult {
        val items = ArrayList<Imported>()
        val warnings = ArrayList<String>()
        val vaults = when (val v = data["vaults"]) {
            is JsonObject -> v.values.toList()
            is JsonArray -> v.toList()
            else -> emptyList()
        }
        for (vaultValue in vaults) {
            if (vaultValue is JsonNull) throw IllegalArgumentException("That file has an empty entry where a vault should be.")
            val vault = vaultValue.obj()
            val folder = vault["name"].text()
            for (it in vault["items"].objects()) {
                val state = it["state"]
                if (state.isNumber() && jsNumber(state!!) == 2.0) continue // trashed
                val d = it["data"].obj()
                val meta = d["metadata"].obj()
                val c = d["content"].obj()
                val title = meta["name"].text() ?: "Imported item"
                val notes = meta["note"].text()
                val fields = d["extraFields"].objects().map { f ->
                    CustomField(f["fieldName"].text() ?: "Field", jsStringOrEmpty(f["data"].obj()["content"]), if (f["type"].isTheText("hidden")) "hidden" else "text")
                }
                fun base(kind: String) = newBody(kind, title).withText("notes", notes).withCustomFields(fields)
                when (d["type"].text()) {
                    "login" -> {
                        val urls = c["urls"].strings().map { u -> LoginUrl(u) }
                        items += Imported(
                            base("login").withText("username", c["itemUsername"].text() ?: c["username"].text() ?: c["itemEmail"].text()).withText("password", c["password"].text())
                                .withUrls(urls).withTotp(Importers.otpFrom(c["totpUri"].text(), warnings, title)),
                            folder,
                        )
                    }
                    "creditCard" -> {
                        val expiry = c["expirationDate"].text()
                        items += Imported(
                            base("card").withText("cardholder", c["cardholderName"].text()).withText("cardNumber", c["number"].text()).withText("cardCvv", c["verificationNumber"].text())
                                .withText("cardExpMonth", expiry?.let { e -> e.substring(minOf(5, e.length), minOf(7, e.length)) }).withText("cardExpYear", expiry?.let { e -> e.substring(0, minOf(4, e.length)) }),
                            folder,
                        )
                    }
                    "identity" -> {
                        var b = base("identity")
                        for ((from, to) in listOf("firstName" to "firstName", "lastName" to "lastName", "email" to "email", "phoneNumber" to "phone", "streetAddress" to "address1", "city" to "city", "zipOrPostalCode" to "postcode", "countryOrRegion" to "country")) {
                            b = b.withText(to, c[from].text())
                        }
                        items += Imported(b, folder)
                    }
                    else -> items += Imported(base("note"), folder)
                }
            }
        }
        return ImportResult("Proton Pass", items, warnings)
    }

    // ---- Dashlane -----------------------------------------------------------------------

    private fun normHeader(h: String) = h.trim().lowercase().replace(Regex("[^a-z0-9]"), "")

    /** Dashlane's zip of CSVs. */
    fun fromDashlaneZip(zip: ByteArray): ImportResult {
        val files = SafeZip.read(zip)
        val items = ArrayList<Imported>()
        val warnings = ArrayList<String>()
        for ((name, raw) in files) {
            if (!name.endsWith(".csv")) continue
            val text = decode(raw)
            val rows = Importers.parseCsv(text)
            if (rows.size < 2) continue
            val base = name.lowercase()
            val h = rows[0].map { normHeader(it) }
            fun List<String>.cell(k: String) = h.indexOf(k).let { at -> if (at >= 0) getOrNull(at) ?: "" else "" }
            when {
                "credential" in base -> {
                    val r = Importers.fromGenericCsv(text, "Dashlane")
                    items += r.items
                    warnings += r.warnings
                }
                "securenote" in base -> for (row in rows.drop(1)) {
                    items += Imported(newBody("note", row.cell("title").ifEmpty { "Imported note" }).withText("notes", row.cell("note")))
                }
                "payment" in base -> for (row in rows.drop(1)) {
                    items += Imported(
                        newBody("card", row.cell("name").ifEmpty { "Imported card" }).withText("cardholder", row.cell("accountname")).withText("cardNumber", row.cell("accountnumber")).withText("cardCvv", row.cell("cvv"))
                            .withText("cardExpMonth", row.cell("expirationmonth")).withText("cardExpYear", row.cell("expirationyear")).withText("notes", row.cell("note")),
                    )
                }
                "id" in base -> for (row in rows.drop(1)) {
                    val title = listOf(row.cell("firstname"), row.cell("lastname")).filter { it.isNotEmpty() }.joinToString(" ").ifEmpty { "Imported identity" }
                    var b = newBody("identity", title)
                    for ((column, to) in listOf("firstname" to "firstName", "lastname" to "lastName", "email" to "email", "phonenumber" to "phone", "address" to "address1", "city" to "city", "zip" to "postcode", "country" to "country")) {
                        b = b.withText(to, row.cell(column))
                    }
                    items += Imported(b)
                }
                else -> warnings += "$name: not something we can read yet."
            }
        }
        return ImportResult("Dashlane", items, warnings)
    }

    // ---- KeePass ------------------------------------------------------------------------

    fun fromKeepassXml(text: String): ImportResult {
        if (text.contains("<!ENTITY", ignoreCase = true)) throw IllegalArgumentException("That XML defines its own entities, which we don't accept.")
        val doc = try {
            SafeXml.parse(text)
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException("That XML couldn't be read: ${e.message}")
        }
        val root = SafeXml.keepassRoot(doc) ?: throw IllegalArgumentException("That isn't a KeePass XML export")
        val items = ArrayList<Imported>()
        fun walk(group: XmlElement, path: List<String>, depth: Int) {
            if (depth > 64) throw IllegalArgumentException("Those groups nest too deeply")
            val name = group.child("Name")?.textContent() ?: ""
            val here = if (depth == 0) emptyList() else path + name
            for (entry in group.childrenOf("Entry")) {
                val strings = LinkedHashMap<String, String>()
                for (s in entry.childrenOf("String")) strings[s.child("Key")?.textContent() ?: ""] = s.child("Value")?.textContent() ?: ""
                items += keepassItem(strings, here.joinToString("/").ifEmpty { null })
            }
            for (g in group.childrenOf("Group")) walk(g, here, depth + 1)
        }
        for (g in root.childrenOf("Group")) walk(g, emptyList(), 0)
        return ImportResult("KeePass", items, emptyList())
    }

    /** One entry's strings. What's left after the known ones becomes custom fields. */
    fun keepassItem(strings: MutableMap<String, String>, folder: String?): Imported {
        fun take(k: String) = strings.remove(k)?.ifEmpty { null }
        val title = take("Title") ?: "Imported login"
        val username = take("UserName")
        val password = take("Password")
        val url = take("URL")
        val notes = take("Notes")
        var totp: TotpConfig? = take("otp")?.let { Importers.otpFrom(it, ArrayList(), title) }
        val seed = take("TOTP Seed") ?: take("TimeOtp-Secret-Base32")
        if (totp == null && seed != null) totp = TotpConfig(seed.uppercase().replace(Regex("\\s"), ""))
        val fields = strings.filterValues { it.isNotEmpty() }.map { (name, value) -> CustomField(name, value, "text") }
        val body = newBody("login", title).withText("username", username).withText("password", password).withUrls(url?.let { listOf(LoginUrl(it)) } ?: emptyList()).withText("notes", notes).withTotp(totp).withCustomFields(fields)
        return Imported(body, folder)
    }

    // ---- FIDO CXF -----------------------------------------------------------------------

    /** A field that's a bare string, or `{ value }`. */
    private fun ef(v: JsonElement?): String? = when {
        v is JsonPrimitive && v.isString -> v.content.ifEmpty { null }
        v is JsonObject && "value" in v -> v["value"].let { x -> if (x is JsonNull || (x.isText() && (x as JsonPrimitive).content.isEmpty())) null else jsString(x) }
        else -> null
    }

    fun fromCxf(data: JsonObject): ImportResult {
        val items = ArrayList<Imported>()
        val warnings = ArrayList<String>()
        for (account in data["accounts"].objects()) {
            val folders = HashMap<String, String>()
            for (c in account["collections"].objects()) {
                for (ref in c["items"].objects()) folders[jsString(ref["item"])] = jsStringOrEmpty(c["title"])
            }
            for (it in account["items"].objects()) {
                val title = it["title"].text() ?: "Imported item"
                var b = ItemBody(emptyMap()).withUrls(it["scope"].obj()["urls"].strings().map { u -> LoginUrl(u) })
                    .withFlag("favorite", it["favorite"].isTrue()).withTags(it["tags"] as? JsonArray)
                val notes = ArrayList<String>()
                var kind = "login"
                val passkeys = ArrayList<Passkey>()
                val fields = ArrayList<CustomField>()
                for (cr in it["credentials"].objects()) {
                    val type = cr["type"].let { t -> if (t is JsonPrimitive && t.isString) t.content else null }
                    when (type) {
                        "basic-auth" -> b = b.withText("username", ef(cr["username"])).withText("password", ef(cr["password"]))
                        "totp" -> cr["secret"].text()?.let { secret ->
                            b = b.withTotp(TotpConfig(secret, algorithm(cr["algorithm"], "sha1", "sha256", "sha512"), numberOr(cr["digits"], 6), numberOr(cr["period"], 30), false, cr["issuer"].text(), cr["username"].text()))
                        }
                        "passkey" -> {
                            val key = cr["key"].text()
                            val rp = cr["rpId"].text()
                            if (key != null && rp != null) {
                                passkeys += Passkey(jsString(cr["credentialId"]), rp, null, jsStringOrEmpty(cr["userHandle"]), jsStringOrEmpty(cr["username"]), cr["userDisplayName"].text(), key, 0, isoNow(), null, true)
                            }
                        }
                        "note" -> {
                            ef(cr["content"])?.let { n -> notes += n }
                            if (b.username == null && b.password == null) kind = "note"
                        }
                        "credit-card" -> {
                            kind = "card"
                            b = b.withText("cardNumber", ef(cr["number"])).withText("cardholder", ef(cr["fullName"])).withText("cardBrand", ef(cr["cardType"])).withText("cardCvv", ef(cr["verificationNumber"]))
                            ef(cr["expiryDate"])?.let { e ->
                                val parts = e.split("-")
                                b = b.withText("cardExpYear", parts[0]).withText("cardExpMonth", parts.getOrNull(1))
                            }
                        }
                        "api-key" -> {
                            kind = "apikey"
                            b = b.withText("apiKey", ef(cr["key"]))
                        }
                        "wifi" -> {
                            kind = "wifi"
                            b = b.withText("ssid", ef(cr["ssid"])).withText("wifiPassword", ef(cr["passphrase"]))
                        }
                        "ssh-key" -> {
                            kind = "ssh"
                            b = b.withText("sshPrivate", ef(cr["privateKey"]))
                        }
                        "custom-fields" -> for (f in (cr["fields"] as? JsonArray) ?: emptyList<JsonElement>()) {
                            ef(f)?.let { value ->
                                val o = f.obj()
                                fields += CustomField(o["label"].text() ?: "Field", value, if (o["fieldType"].isTheText("concealed-string")) "hidden" else "text")
                            }
                        }
                        else -> warnings += "$title: \"${jsString(cr["type"])}\" isn't something we can import yet."
                    }
                }
                if (passkeys.isNotEmpty()) b = b.withPasskeys(passkeys)
                if (notes.isNotEmpty()) b = b.withText("notes", notes.joinToString("\n\n"))
                if (fields.isNotEmpty()) b = b.withCustomFields(fields)
                items += Imported(ItemBody(newBody(kind, title).fields + b.fields), folders[jsString(it["id"])]?.ifEmpty { null })
            }
        }
        return ImportResult("Credential Exchange", items, warnings)
    }

    // ---- Authenticator apps -----------------------------------------------------------------

    fun fromAegisJson(data: JsonObject): ImportResult {
        if (data["db"].isText() || truthy(data["header"].obj()["slots"])) throw IllegalArgumentException("That Aegis export is encrypted. Export it without a password, import, then delete the file.")
        val items = ArrayList<Imported>()
        var skipped = 0
        for (e in data["db"].obj()["entries"].objects()) {
            val info = e["info"].obj()
            val type = e["type"].text()
            if (type != "totp" && type != "steam") {
                skipped++
                continue
            }
            val issuer = e["issuer"].text()
            val label = e["name"].text()
            val name = listOfNotNull(issuer, label).joinToString(": ").ifEmpty { "Imported code" }
            val totp = TotpConfig(jsStringOrEmpty(info["secret"]), algorithm(info["algo"], "SHA1", "SHA256", "SHA512"), numberOr(info["digits"], 6), numberOr(info["period"], 30), type == "steam", issuer, label)
            items += Imported(newBody("totp", name).withText("notes", e["note"].text()).withFlag("favorite", e["favorite"].isTrue()).withTotp(totp))
        }
        return ImportResult("Aegis", items, if (skipped > 0) listOf("$skipped counter-based or other codes weren't imported.") else emptyList())
    }

    fun from2fasJson(data: JsonObject): ImportResult {
        if (truthy(data["servicesEncrypted"]) || truthy(data["reference"])) throw IllegalArgumentException("That 2FAS backup is encrypted. Export it without a password, import, then delete the file.")
        val items = ArrayList<Imported>()
        var skipped = 0
        for (s in data["services"].objects()) {
            val otp = s["otp"].obj()
            val token = (otp["tokenType"].let { t -> if (t == null || t is JsonNull) "TOTP" else jsString(t) }).uppercase()
            if (token != "TOTP" && token != "STEAM") {
                skipped++
                continue
            }
            val title = s["name"].text() ?: otp["issuer"].text() ?: "Imported code"
            val totp = TotpConfig(jsStringOrEmpty(s["secret"]), algorithm(otp["algorithm"], "SHA1", "SHA256", "SHA512"), numberOr(otp["digits"], 6), numberOr(otp["period"], 30), token == "STEAM", otp["issuer"].text(), otp["account"].text())
            items += Imported(newBody("totp", title).withTotp(totp))
        }
        return ImportResult("2FAS", items, if (skipped > 0) listOf("$skipped counter-based codes weren't imported.") else emptyList())
    }

    fun fromMigrationLinks(text: String): ImportResult {
        val items = ArrayList<Imported>()
        var skipped = 0
        for (line in text.split(Regex("\\s+")).filter { it.isNotEmpty() }) {
            val m = Totp.parseMigration(line)
            skipped += m.skipped
            for (c in m.codes) items += Imported(newBody("totp", listOfNotNull(c.issuer, c.label).filter { it.isNotEmpty() }.joinToString(": ").ifEmpty { "Imported code" }).withTotp(c))
        }
        return ImportResult("Google Authenticator", items, if (skipped > 0) listOf("$skipped counter-based codes weren't imported.") else emptyList())
    }
}
