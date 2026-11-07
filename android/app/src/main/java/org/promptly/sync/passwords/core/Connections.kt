// Where the vault meets the rest of Promptly, on the client's side. Mirrors connections.ts for
// duplicates, and the small rules in the web vault's screens: survival warnings, Send records,
// site icons, and what an emergency row's state means. Everything the server says here is read
// with suspicion: a malformed answer is no answer.
package org.promptly.sync.passwords.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.time.Instant
import java.time.OffsetDateTime

/** ISO 8601 with Z or an offset. Null for anything else. */
fun parseInstant(s: String?): Instant? {
    if (s.isNullOrEmpty()) return null
    return runCatching { Instant.parse(s) }.getOrNull() ?: runCatching { OffsetDateTime.parse(s).toInstant() }.getOrNull()
}

// ---- Duplicates ----------------------------------------------------------------------

object Duplicates {
    private fun sites(b: ItemBody): Set<String> = Match.savedDomainsOf(b.urls)

    /** Same site, same username: almost always the same login saved twice. */
    fun find(items: Collection<Item>): List<List<Item>> {
        val groups = LinkedHashMap<String, MutableList<Item>>()
        for (i in items) {
            val user = i.body.username
            if (i.body.kind != "login" || user.isNullOrEmpty()) continue
            for (site in sites(i.body)) groups.getOrPut("${i.vaultId}|$site|${user.lowercase()}") { ArrayList() } += i
        }
        val seen = HashSet<String>()
        return groups.values.filter { it.size >= 2 && seen.add(it.map { i -> i.id }.sorted().joinToString(",")) }
    }

    class Merged(val keep: Item, val drop: List<Item>, val body: ItemBody)

    /** Keeps the newest as the main one, and nothing else is thrown away: other passwords go to
     *  history, and other URLs, notes, 2FA, passkeys and fields come across. One thing the web's
     *  merge doesn't do: if any copy asks again before showing, the merged one does too, or its
     *  password would turn up unguarded in the kept one's history. */
    fun merge(group: List<Item>): Merged {
        val order = group.sortedByDescending { it.body.updatedAt }
        val keep = order[0]
        val drop = order.drop(1)
        val body = keep.body
        val history = ArrayList<JsonObject>()
        fun inHistory(pw: String?) = history.any { it.str("password") == pw }
        fun historyOf(b: ItemBody) = (b["passwordHistory"] as? JsonArray)?.filterIsInstance<JsonObject>() ?: emptyList()
        // As they're written, so a field this client doesn't know about comes across too.
        fun urlOf(e: JsonElement) = (e as? JsonObject)?.str("url") ?: (e as? JsonPrimitive)?.takeIf { it.isString }?.content
        val urls = ArrayList((body["urls"] as? JsonArray)?.filter { urlOf(it) != null } ?: emptyList())
        val seenUrls = urls.mapTo(HashSet()) { urlOf(it) }
        val notes = ArrayList<String>()
        body.notes?.takeIf { it.isNotEmpty() }?.let { notes += it }
        val fields = ArrayList((body["fields"] as? JsonArray)?.filterIsInstance<JsonObject>() ?: emptyList())
        val passkeys = ArrayList((body["passkeys"] as? JsonArray)?.filterIsInstance<JsonObject>() ?: emptyList())
        val attachments = ArrayList((body["attachments"] as? JsonArray)?.filterIsInstance<JsonObject>() ?: emptyList())
        var totp = body["totp"]
        var reprompt = body.reprompt
        for (d in drop) {
            val b = d.body
            val pw = b.password
            if (!pw.isNullOrEmpty() && pw != body.password && !inHistory(pw)) {
                history += JsonObject(mapOf("password" to JsonPrimitive(pw), "at" to JsonPrimitive(b.updatedAt)))
            }
            val pending = b.str("pendingPassword")
            if (!pending.isNullOrEmpty() && pending != body.password && !inHistory(pending)) {
                history += JsonObject(mapOf("password" to JsonPrimitive(pending), "at" to JsonPrimitive(isoNow())))
            }
            for (u in (b["urls"] as? JsonArray) ?: emptyList()) if (urlOf(u) != null && seenUrls.add(urlOf(u))) urls += u
            b.notes?.takeIf { it.isNotEmpty() && it !in notes }?.let { notes += it }
            for (f in (b["fields"] as? JsonArray)?.filterIsInstance<JsonObject>() ?: emptyList()) {
                if (fields.none { it.str("name") == f.str("name") && it.str("value") == f.str("value") }) fields += f
            }
            for (p in (b["passkeys"] as? JsonArray)?.filterIsInstance<JsonObject>() ?: emptyList()) {
                if (passkeys.none { it.str("credentialId") == p.str("credentialId") }) passkeys += p
            }
            for (a in (b["attachments"] as? JsonArray)?.filterIsInstance<JsonObject>() ?: emptyList()) {
                if (attachments.none { it.str("id") == a.str("id") }) attachments += a
            }
            if (totp == null && b["totp"] is JsonObject) totp = b["totp"]
            if (b.reprompt) reprompt = true
        }
        // What's being merged in comes first, as the copies are about to go. Older history fills the rest.
        for (h in historyOf(body) + drop.flatMap { historyOf(it.body) }) if (!inHistory(h.str("password"))) history += h
        val merged = body.with(
            "urls" to JsonArray(urls),
            "notes" to notes.joinToString("\n\n").takeIf { it.isNotEmpty() }?.let { JsonPrimitive(it) },
            "fields" to JsonArray(fields),
            "passkeys" to JsonArray(passkeys),
            "attachments" to JsonArray(attachments),
            "passwordHistory" to JsonArray(history.take(20)),
            "totp" to totp,
        ).withFlag("reprompt", reprompt)
        return Merged(keep, drop, touch(keep.body, merged))
    }
}

// ---- What could lose you this vault (plan 5.6) ----------------------------------------

data class SurvivalOut(val isAdmin: Boolean, val kitConfirmed: Boolean, val kitConfirmedAt: String?, val offsiteConfigured: Boolean, val lastBackupAt: String?, val backupAgeDays: Int?)

object Survival {
    const val RECOVERY_CHECK_DAYS = 182L
    const val UNREACHABLE_WARN_DAYS = 3L
    const val BACKUP_WARN_DAYS = 8
    private const val DAY_MS = 86_400_000L

    /** Null unless the answer has the two facts that drive a warning, as real booleans: a server
     *  that returns rubbish doesn't get to pop up the recovery kit. */
    fun parse(text: String?): SurvivalOut? {
        val o = runCatching { Json.parseToJsonElement(text ?: return null) as? JsonObject }.getOrNull() ?: return null
        val kit = (o["kit_confirmed"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: return null
        val offsite = (o["offsite_configured"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: return null
        val age = (o["backup_age_days"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull?.takeIf { it >= 0 }
        return SurvivalOut((o["is_admin"] as? JsonPrimitive)?.booleanOrNull ?: false, kit, o.str("kit_confirmed_at"), offsite, o.str("last_backup_at"), age)
    }

    data class Warning(val key: String, val danger: Boolean, val text: String, val export: Boolean = false)

    /** The same warnings as SurvivalPanel, worst first. */
    fun warnings(data: SurvivalOut?, lastSync: Long?, now: Long = System.currentTimeMillis()): List<Warning> {
        val out = ArrayList<Warning>()
        if (data != null && !data.kitConfirmed) out += Warning("kit", true, "You haven't confirmed saving your recovery kit. Without it, a forgotten master password means this vault is gone for good.")
        if (data != null && !data.offsiteConfigured) {
            out += Warning(
                "offsite", false,
                if (data.isAdmin) "No off-site backup is set up. If this server's disk fails, your vault goes with it, unless a device still has its copy." else "Whoever runs this server hasn't set up off-site backups. Keep an encrypted export of your own.",
                export = true,
            )
        }
        if (data != null) {
            val age = data.backupAgeDays
            if (age == null) out += Warning("backup", false, "This server hasn't made a backup yet.")
            else if (age > BACKUP_WARN_DAYS) out += Warning("backup", false, "The last backup on this server was $age days ago.")
        }
        val unreachable = unreachableDays(lastSync, now)
        if (unreachable >= UNREACHABLE_WARN_DAYS) out += Warning("unreachable", false, "This device hasn't reached your server for $unreachable days. It keeps working from its own copy, but what you change here isn't backed up anywhere else yet.")
        return out
    }

    fun unreachableDays(lastSync: Long?, now: Long = System.currentTimeMillis()): Long = if (lastSync == null || lastSync <= 0) 0 else maxOf(0, (now - lastSync) / DAY_MS)

    /** Twice a year: do you still have the kit, and do you still know the password? */
    fun recoveryDue(kitAt: String?, checked: String?, now: Long = System.currentTimeMillis()): Boolean {
        val last = listOfNotNull(parseInstant(kitAt), parseInstant(checked)).maxOfOrNull { it.toEpochMilli() } ?: return false
        return now - last > RECOVERY_CHECK_DAYS * DAY_MS
    }
}

/** Android's half of "an encrypted export reminder" (plan 5.6). Windows backs up by itself; a phone
 *  can't, so it asks: three months from the last one, and a fortnight's peace if you say later. */
object ExportReminder {
    const val INTERVAL_DAYS = 90L
    const val SNOOZE_DAYS = 14L
    private const val DAY_MS = 86_400_000L

    /** `since` is when this phone first opened the vault: it's not due on day one. */
    fun due(lastExport: Long, since: Long, snoozedUntil: Long, now: Long = System.currentTimeMillis()): Boolean {
        val from = maxOf(lastExport, since)
        return from > 0 && now >= snoozedUntil && now - from >= INTERVAL_DAYS * DAY_MS
    }

    fun snoozeUntil(now: Long = System.currentTimeMillis()) = now + SNOOZE_DAYS * DAY_MS

    /** Once for each stretch of being due: a later "later" earns a new one. */
    fun shouldNotify(lastExport: Long, since: Long, snoozedUntil: Long, notifiedAt: Long, now: Long = System.currentTimeMillis()): Boolean =
        due(lastExport, since, snoozedUntil, now) && now - notifiedAt >= SNOOZE_DAYS * DAY_MS

    fun text(lastExport: Long, now: Long = System.currentTimeMillis()): String =
        if (lastExport > 0) "It's been ${(now - lastExport) / DAY_MS} days since this phone made an encrypted export of your vault. A fresh copy, kept off this phone and away from your server, gets you back in if the server's ever lost."
        else "This phone hasn't made an encrypted export of your vault. A copy kept off this phone and away from your server gets you back in if the server's ever lost."
}

// ---- Secure Send records --------------------------------------------------------------

object SendRecords {
    class Record(val itemId: String, val title: String, val link: String)

    fun body(title: String, link: String, sendId: String): ItemBody = newBody("send", title, "notes" to JsonPrimitive(link), "sendId" to JsonPrimitive(sendId))

    /** By Send id, from your own vault: the server never knows what any of them are called. Only that
     *  vault, as anyone who can write to a shared one could plant a record for one of your Sends. */
    fun of(items: Collection<Item>, ownVaultId: String): Map<String, Record> {
        val out = HashMap<String, Record>()
        for (i in items) {
            val link = i.body.notes
            if (i.vaultId == ownVaultId && i.body.kind == "send" && !link.isNullOrEmpty() && !i.deleted) out[i.body.str("sendId") ?: ""] = Record(i.id, i.body.title, link)
        }
        return out
    }

    /** Past its date, or out of views. */
    fun finished(s: SendOut, now: Long = System.currentTimeMillis()): Boolean =
        s.viewsLeft == 0 || (parseInstant(s.expiresAt)?.toEpochMilli()?.let { it < now } ?: false)

    private val LINK = Regex("^https?://[^\\s#]+/passwords/send/([0-9a-f-]{36})#[A-Za-z0-9_-]{43}$")

    /** Only a link to this Send goes to Rooms or Mail, on top of the server's own check. What's in
     *  the record could've been written by anything that can write to your vault, and if it isn't
     *  a link it might be the secret itself. */
    fun isLinkTo(sendId: String, link: String, baseUrl: String): Boolean {
        val m = LINK.matchEntire(link) ?: return false
        return m.groupValues[1] == sendId && link.startsWith("${baseUrl.trimEnd('/')}/passwords/send/")
    }
}

// ---- Site icons -----------------------------------------------------------------------

object SiteIcons {
    const val PREFS_TITLE = "vault-prefs"
    const val MAX_BYTES = 256 * 1024

    private val DOMAIN = Regex("^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$")

    /** What may be asked about. The same shape the server wants, so a saved address that's an IP,
     *  a local name or an app never goes out at all. */
    fun domainOf(url: String?): String? = url?.let { Match.hostOf(it) }?.takeIf { DOMAIN.matches(it) }

    fun prefsRow(items: Collection<Item>, vaultId: String): Item? =
        items.firstOrNull { it.vaultId == vaultId && it.body.kind == "prefs" && it.body.title == PREFS_TITLE && !it.deleted }

    /** Vaults that have said yes. Off unless turned on, per vault. */
    fun iconVaults(items: Collection<Item>): Set<String> =
        items.filter { it.body.kind == "prefs" && it.body.title == PREFS_TITLE && it.body.bool("icon") && !it.deleted }.mapTo(HashSet()) { it.vaultId }

    fun show(item: Item, vaults: Set<String>): Boolean = item.body.bool("icon") || item.vaultId in vaults
}

// ---- The directories for the Security check ---------------------------------------------

data class SiteDirectory(val twofa: Map<String, String?>, val passkeys: Set<String>) {
    companion object {
        val EMPTY = SiteDirectory(emptyMap(), emptySet())

        /** Odd entries are dropped rather than trusted: it's advice, and the worst it can do is
         *  suggest setting up something a site doesn't have. */
        fun parse(text: String?): SiteDirectory {
            val o = runCatching { Json.parseToJsonElement(text ?: return EMPTY) as? JsonObject }.getOrNull() ?: return EMPTY
            val twofa = (o["twofa"] as? JsonObject)?.mapValues { (_, v) -> (v as? JsonObject)?.str("documentation") } ?: emptyMap()
            val passkeys = (o["passkeys"] as? JsonObject)?.filterValues { truthy(it) }?.keys ?: emptySet()
            return SiteDirectory(twofa, passkeys)
        }

        private fun truthy(e: JsonElement) = e !is JsonNull && (e as? JsonPrimitive)?.booleanOrNull != false
    }
}

// ---- Emergency access --------------------------------------------------------------------

object EmergencyText {
    const val WARNING = "If you don't refuse before the wait runs out, it opens. They can then read everything in your vaults. Pick someone you'd trust with all of it, and a wait long enough that you'd notice. The wait is kept by this server, so whoever runs the server, working with your contact, could skip it."

    /** Nothing's sealed to them until the words have been compared, whatever the row's state says. */
    const val COMPARE = "Compare safety words to finish setting this up."

    fun needsWords(r: EmergencyOut, verified: Boolean) = !verified && r.state != "ended"

    fun state(r: EmergencyOut, mine: Boolean): String = when (r.state) {
        "invited" -> if (mine) "Waiting for them to accept." else "They've asked you."
        "accepted" -> if (mine) "Finishing on this device." else "Waiting for them to finish setting it up."
        "ready" -> "Set up."
        "requested" -> r.opensAt?.let { "Asked. Opens ${it.take(16).replace('T', ' ')} unless refused." } ?: "Asked."
        "refused" -> "Refused."
        "opened" -> if (mine) "They can read your vault." else "Open."
        "ended" -> if (mine) "They've stopped, but they saw your vault. Change the keys." else "Ended."
        else -> r.state
    }

    /** They can ask for your vault once it's set up, or again after a refusal. */
    fun canAsk(r: EmergencyOut) = r.state == "ready" || r.state == "refused"

    fun due(r: EmergencyOut, now: Long = System.currentTimeMillis()) = r.state == "requested" && (parseInstant(r.opensAt)?.toEpochMilli()?.let { it <= now } ?: false)

    const val MIN_WAIT = 1
    const val MAX_WAIT = 90

    fun validWait(text: String): Int? = text.trim().toIntOrNull()?.takeIf { it in MIN_WAIT..MAX_WAIT }
}

// ---- Text someone else wrote ------------------------------------------------------------

object UntrustedText {
    /** One line of plain text, for a sender's name or a subject: no line breaks, control characters,
     *  or the invisible ones that turn text around. Nothing here ever reads it as anything but text. */
    fun clean(s: String?, max: Int): String {
        if (s == null) return ""
        val b = StringBuilder()
        var i = 0
        while (i < s.length && b.length < max) {
            val cp = s.codePointAt(i)
            i += Character.charCount(cp)
            when (Character.getType(cp).toByte()) {
                Character.CONTROL, Character.LINE_SEPARATOR, Character.PARAGRAPH_SEPARATOR -> b.append(' ')
                Character.FORMAT, Character.PRIVATE_USE, Character.SURROGATE, Character.UNASSIGNED -> Unit
                else -> if (b.length + Character.charCount(cp) <= max) b.appendCodePoint(cp) else i = s.length
            }
        }
        return b.toString().replace(WHITESPACE, " ").trim()
    }

    private val WHITESPACE = Regex("\\s+")
}

// ---- Activity log ------------------------------------------------------------------------

data class ActivityOut(val event: String, val at: String)

object ActivityLog {
    /** The web vault's words, and one it leaves as a bare event name. */
    private val TEXT = mapOf(
        "vault_created" to "Vault created",
        "unlocked" to "Unlocked",
        "unlock_locked_out" to "Too many wrong tries: unlock paused",
        "master_password_changed" to "Master password changed",
        "vault_reset" to "Vault reset",
        "device_added" to "Device added",
        "device_removed" to "Device removed",
        "device_approved" to "New device approved",
        "device_denied" to "New device refused",
        "vault_shared_created" to "Shared vault created",
        "vault_deleted" to "Shared vault deleted",
        "vault_left" to "Left a shared vault",
        "vault_member_added" to "Someone added to a shared vault",
        "vault_member_removed" to "Someone removed from a shared vault",
        "vault_invited" to "You were invited to a shared vault",
        "vault_role_changed" to "A member's role changed",
        "vault_key_rotated" to "Shared vault's key changed",
        "vault_removed" to "Removed from a shared vault",
        "exported" to "Vault exported",
    )

    fun text(event: String): String = TEXT[event] ?: UntrustedText.clean(event, 80)

    /** A row with no event or no real time isn't shown. Rubbish in place of a list is an empty list. */
    fun parse(text: String?): List<ActivityOut> {
        val rows = runCatching { Json.parseToJsonElement(text ?: return emptyList()) as? JsonArray }.getOrNull() ?: return emptyList()
        return rows.take(500).mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val event = o.str("event")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val at = o.str("at")?.takeIf { parseInstant(it) != null } ?: return@mapNotNull null
            ActivityOut(event, at)
        }
    }
}

// ---- Mail codes (plan 5.1) ---------------------------------------------------------------

data class MailCode(val id: String, val fromName: String, val fromDomain: String, val at: String, val code: String?, val link: String?)

data class RankedCode(
    val mail: MailCode,
    /** The sender belongs to this site. Nothing else is ever offered as something to fill. */
    val matches: Boolean,
    /** The sender's domain looks like a site you have a login for, without being it. */
    val lookalike: String?,
    val agoSeconds: Long,
)

object MailCodes {
    const val WINDOW_SECONDS = 600L

    /** The shapes the server's extraction can make. Anything else came from somewhere else, and it's
     *  about to go into a box on someone's page. */
    private val CODE = Regex("^[A-Z0-9]{3,8}(?:[- ][A-Z0-9]{3,6})?$")

    /** A sender's domain is the text after an @ in a From line, so it can hold anything at all. */
    private val DOMAIN = Regex("^[\\p{L}\\p{N}](?:[\\p{L}\\p{N}.-]{0,251}[\\p{L}\\p{N}])?$")

    /** Null for what doesn't look like a domain. OkHttp would read `netflix.com/x` as netflix.com. */
    fun senderBase(domain: String): String? = domain.takeIf { DOMAIN.matches(it) }?.let { Match.baseDomain(it.lowercase()) }

    fun related(a: String?, b: String?): Boolean {
        if (a == null || b == null) return false
        return a == b || b in Match.sharedWith(a)
    }

    /** Rubbish is dropped row by row. A row keeps only what it can be trusted with, and a row with
     *  nothing to offer isn't a row. */
    fun parse(text: String?): List<MailCode> {
        val rows = runCatching { Json.parseToJsonElement(text ?: return emptyList()) as? JsonArray }.getOrNull() ?: return emptyList()
        return rows.take(25).mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val id = o.str("id")?.takeIf { it.isNotEmpty() && it.length <= 64 } ?: return@mapNotNull null
            val domain = o.str("from_domain")?.takeIf { it.length <= 253 } ?: return@mapNotNull null
            val at = o.str("at")?.takeIf { parseInstant(it) != null } ?: return@mapNotNull null
            val code = o.str("code")?.takeIf { CODE.matches(it) }
            val link = o.str("link")?.takeIf { it.length <= 2048 }
            if (code == null && link == null) return@mapNotNull null
            MailCode(id, UntrustedText.clean(o.str("from_name"), 80), domain, at, code, link)
        }
    }

    private fun ranked(codes: List<MailCode>, sites: Set<String>, saved: Iterable<String>, now: Long): List<RankedCode> {
        val list = saved.toList()
        return codes.map { c ->
            val sender = senderBase(c.fromDomain)
            val matches = sites.any { related(sender, it) }
            RankedCode(c, matches, if (matches || sender == null) null else Match.lookalikeOf(c.fromDomain.lowercase(), list), maxOf(0L, (now - parseInstant(c.at)!!.toEpochMilli()) / 1000))
        }.sortedWith(compareBy<RankedCode> { !it.matches }.thenBy { it.agoSeconds })
    }

    /** `rankMailCodes`: the sender against the page, on this phone. */
    fun rank(codes: List<MailCode>, pageUrl: String, saved: Iterable<String>, now: Long = System.currentTimeMillis()): List<RankedCode> =
        ranked(codes, setOfNotNull(Match.hostOf(pageUrl)?.let { Match.baseDomain(it) }), saved, now)

    /** An app has no page. Its sites are the ones saved on the logins linked to it. */
    fun rankForSites(codes: List<MailCode>, sites: Set<String>, saved: Iterable<String>, now: Long = System.currentTimeMillis()): List<RankedCode> =
        ranked(codes, sites, saved, now)

    /** The server's window is ten minutes. A row that's older, whatever it says, isn't a code now. */
    fun fresh(r: RankedCode): Boolean = r.agoSeconds <= WINDOW_SECONDS + 120

    /** Other senders with a code: only their names, for a warning, and never what they sent. */
    fun otherSenders(list: List<RankedCode>): List<String> =
        list.filter { !it.matches && it.mail.code != null && senderBase(it.mail.fromDomain) != null }.map { it.mail.fromDomain.lowercase() }.distinct()

    /** `linkIsSafe`, and more: a browser and this parser can't be allowed to disagree about where a
     *  link goes, so anything they might read differently is refused before they get to try. */
    fun linkIsSafe(c: MailCode): Boolean = linkHost(c) != null

    fun linkHost(c: MailCode): String? {
        val link = c.link ?: return null
        if (!link.startsWith("https://", true) || link.any { it == '\\' || it.code <= 0x20 || it.code == 0x7f }) return null
        val u = link.toHttpUrlOrNull() ?: return null
        if (u.scheme != "https" || u.username.isNotEmpty() || u.password.isNotEmpty()) return null
        return u.host.takeIf { related(Match.baseDomain(it), senderBase(c.fromDomain)) }
    }

    fun agoText(seconds: Long): String = if (seconds < 60) "$seconds s ago" else "${Math.round(seconds / 60.0)} min ago"

    /** What goes in a single box: digits with their spacing taken out, or a mixed code as sent. */
    fun forOneBox(code: String): String = if (code.all { it.isDigit() || it == ' ' || it == '-' }) code.filter { it.isDigit() } else code

    /** One character each, if there's a box for each. Null if not. */
    fun forBoxes(code: String, boxes: Int): List<String>? {
        val bare = code.filter { it != ' ' && it != '-' }
        return if (boxes > 1 && boxes == bare.length) bare.map { it.toString() } else null
    }
}

// ---- Security emails (plan 5.8) -----------------------------------------------------------

data class SecurityEvent(val id: String, val kind: String, val fromName: String, val fromDomain: String, val subject: String, val at: String)

class SecurityAlert(val event: SecurityEvent, val item: Item, val text: String)

object SecurityEvents {
    const val DISMISSED_META = "alerts_dismissed"

    /** Only the two kinds this was built for. Names and subjects are a stranger's words. */
    fun parse(text: String?): List<SecurityEvent> {
        val rows = runCatching { Json.parseToJsonElement(text ?: return emptyList()) as? JsonArray }.getOrNull() ?: return emptyList()
        return rows.take(50).mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val id = o.str("id")?.takeIf { it.isNotEmpty() && it.length <= 64 } ?: return@mapNotNull null
            val kind = o.str("kind")?.takeIf { it == "password_changed" || it == "new_signin" } ?: return@mapNotNull null
            val domain = o.str("from_domain")?.takeIf { MailCodes.senderBase(it) != null } ?: return@mapNotNull null
            val at = o.str("at")?.takeIf { parseInstant(it) != null } ?: return@mapNotNull null
            SecurityEvent(id, kind, UntrustedText.clean(o.str("from_name"), 60), domain.lowercase(), UntrustedText.clean(o.str("subject"), 200), at)
        }
    }

    /** `securityAlerts`: the first login whose site the sender belongs to, matched here. */
    fun alerts(events: List<SecurityEvent>, items: Collection<Item>): List<SecurityAlert> = events.mapNotNull { event ->
        val sender = MailCodes.senderBase(event.fromDomain)
        val item = items.firstOrNull { i -> i.body.kind == "login" && i.body.urls.any { u -> MailCodes.related(Match.hostOf(u.url)?.let { Match.baseDomain(it) }, sender) } } ?: return@mapNotNull null
        // The domain and never the name: a name is whatever the email says, as on the mail rows (A52).
        val who = event.fromDomain
        val what = if (event.kind == "password_changed") "your password changed" else "there was a new sign-in"
        SecurityAlert(event, item, "$who says $what. Was that you?")
    }
}

// ---- Change password (plan 5.10) ----------------------------------------------------------

object PasswordChange {
    @Volatile
    var urlsLoader: (() -> String)? = null

    private val urls: Map<String, String> by lazy {
        val o = urlsLoader?.invoke()?.let { runCatching { Json.parseToJsonElement(it) as? JsonObject }.getOrNull() } ?: JsonObject(emptyMap())
        o.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.startsWith("https://") }?.let { k to it } }.toMap()
    }

    private val WEB = Regex("^https?:", RegexOption.IGNORE_CASE)

    /** `changePageUrl`: the site's own page as far as anyone's written it down, or the standard place. */
    fun changePageUrl(body: ItemBody): String? {
        for (u in body.urls) {
            val host = Match.hostOf(u.url) ?: continue
            if (!WEB.containsMatchIn(u.url)) continue
            val known = urls[host] ?: Match.baseDomain(host)?.let { urls[it] }
            return known ?: "https://$host/.well-known/change-password"
        }
        return null
    }

    /** Saved before the site's told, so a failed change can't lose the new one. */
    fun withPending(body: ItemBody, password: String): ItemBody = body.with("pendingPassword" to JsonPrimitive(password))

    /** It worked: the new one's the password, and `VaultClient.update` moves the old one to history. */
    fun commit(body: ItemBody): ItemBody {
        val pending = body.str("pendingPassword") ?: return body
        return body.with("pendingPassword" to null, "password" to JsonPrimitive(pending))
    }

    /** Into the history, not away: "no" can be a mistake, and the site may have taken it. */
    fun drop(body: ItemBody): ItemBody {
        val pending = body.str("pendingPassword")
        if (pending.isNullOrEmpty() || pending == body.password) return body.with("pendingPassword" to null)
        val entry = JsonObject(mapOf("password" to JsonPrimitive(pending), "at" to JsonPrimitive(isoNow())))
        val old = (body["passwordHistory"] as? JsonArray) ?: JsonArray(emptyList())
        return body.with("pendingPassword" to null, "passwordHistory" to JsonArray((listOf<JsonElement>(entry) + old).take(20)))
    }

    /** Worst first, each once. */
    fun toChange(r: HealthReport): List<Item> = (r.breached.map { it.first } + r.reused.flatten() + r.weak).distinctBy { it.id }
}

// ---- Documents from Files (plan 5.12) ------------------------------------------------------

data class DriveFile(val id: String, val name: String, val sizeBytes: Long, val mime: String?)

object DriveFiles {
    const val MAX_BYTES = 100L * 1024 * 1024
    private val ID = Regex("^[0-9a-fA-F-]{36}$")
    private val MIME = Regex("^[A-Za-z0-9!#$&^_.+-]{1,64}/[A-Za-z0-9!#$&^_.+-]{1,64}(; ?[a-zA-Z0-9-]{1,32}=[A-Za-z0-9._-]{1,32})?$")
    private val DAY = Regex("^\\d{4}-\\d{2}-\\d{2}$")

    /** An id goes into a path, a name goes on an attachment, and neither is taken on trust. */
    fun parse(text: String?): List<DriveFile> {
        val rows = runCatching { Json.parseToJsonElement(text ?: return emptyList()) as? JsonArray }.getOrNull() ?: return emptyList()
        return rows.take(50).mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val id = o.str("id")?.takeIf { ID.matches(it) } ?: return@mapNotNull null
            val size = (o["size_bytes"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toLongOrNull()?.takeIf { it in 1..MAX_BYTES } ?: return@mapNotNull null
            val name = UntrustedText.clean(o.str("name"), 255).replace('/', '_').replace('\\', '_').ifEmpty { "Document" }
            DriveFile(id, name, size, o.str("mime_type")?.takeIf { MIME.matches(it) })
        }
    }

    /** What a reminder takes: a real date, written the one way the server reads. */
    fun validDay(text: String): String? {
        val t = text.trim()
        if (!DAY.matches(t)) return null
        return runCatching { java.time.LocalDate.parse(t) }.getOrNull()?.takeIf { it.year in 2000..2199 }?.toString()
    }
}
