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
        val history = ArrayList((body["passwordHistory"] as? JsonArray)?.filterIsInstance<JsonObject>() ?: emptyList())
        fun inHistory(pw: String?) = history.any { it.str("password") == pw }
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
            for (h in (b["passwordHistory"] as? JsonArray)?.filterIsInstance<JsonObject>() ?: emptyList()) if (!inHistory(h.str("password"))) history += h
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

    /** By Send id, from your own vault: the server never knows what any of them are called. */
    fun of(items: Collection<Item>): Map<String, Record> {
        val out = HashMap<String, Record>()
        for (i in items) {
            val link = i.body.notes
            if (i.body.kind == "send" && !link.isNullOrEmpty() && !i.deleted) out[i.body.str("sendId") ?: ""] = Record(i.id, i.body.title, link)
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
