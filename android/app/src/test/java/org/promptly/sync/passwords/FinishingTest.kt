// The features that finished the Android client: the rules, on their own, with what a server or a
// shared vault's member could hand them. Under Robolectric for Android's Public Suffix List.
package org.promptly.sync.passwords

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.passwords.autofill.AutofillIndex
import org.promptly.sync.passwords.autofill.FillTarget
import org.promptly.sync.passwords.autofill.IndexEntry
import org.promptly.sync.passwords.autofill.IndexLookup
import org.promptly.sync.passwords.core.ApiError
import org.promptly.sync.passwords.core.Attachments
import org.promptly.sync.passwords.core.Duplicates
import org.promptly.sync.passwords.core.EmergencyOut
import org.promptly.sync.passwords.core.EmergencyText
import org.promptly.sync.passwords.core.ExportReminder
import org.promptly.sync.passwords.core.Health
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.ItemBody
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.SendOut
import org.promptly.sync.passwords.core.SendRecords
import org.promptly.sync.passwords.core.SiteDirectory
import org.promptly.sync.passwords.core.SiteIcons
import org.promptly.sync.passwords.core.Survival
import org.promptly.sync.passwords.core.SurvivalOut
import org.promptly.sync.passwords.core.VaultApi
import org.promptly.sync.passwords.core.newBody
import org.promptly.sync.passwords.core.parseInstant
import org.promptly.sync.passwords.core.randomBytes
import org.promptly.sync.passwords.credentials.Caller
import org.promptly.sync.passwords.credentials.credentialLookalike
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FinishingTest {
    init {
        Fixtures.setup()
        okhttp3.OkHttp.initialize(androidx.test.core.app.ApplicationProvider.getApplicationContext())
    }

    private val DAY = 86_400_000L
    private var n = 0
    private fun item(body: ItemBody, vault: String = "v", id: String = "i${n++}", deleted: Boolean = false) = Item(id, vault, 1, deleted, body.updatedAt, body)
    private fun login(title: String, user: String?, pw: String?, vararg urls: String) = newBody("login", title).withText("username", user).withText("password", pw).withUrls(urls.map { LoginUrl(it) })
    private fun at(b: ItemBody, time: String) = b.with("updatedAt" to JsonPrimitive(time))

    // ---- Lookalikes, from one list shared with match.ts ----

    @Test fun lookalikeVectorsSharedWithTheWebClient() {
        val v = Json.parseToJsonElement(File(Fixtures.frontend.parentFile, "android/app/src/test/cross/match-vectors.json").readText()).jsonObject
        val vault = v.getValue("lookalikeVault").jsonArray.map { it.jsonPrimitive.content }
        val list = v.getValue("lookalike").jsonArray
        assertTrue(list.size >= 30)
        for (e in list) {
            val c = e.jsonObject
            val want = c["want"].takeIf { it !is JsonNull }?.jsonPrimitive?.content
            val saved = c["saved"]?.jsonArray?.map { it.jsonPrimitive.content } ?: vault
            val page = c.getValue("page").jsonPrimitive.content
            assertEquals(page, want, Match.lookalikeOf(page, saved))
        }
        for (e in v.getValue("editDistance").jsonArray) {
            val c = e.jsonObject
            assertEquals(c.toString(), c.getValue("want").jsonPrimitive.content.toInt(), Match.editDistance(c.getValue("a").jsonPrimitive.content, c.getValue("b").jsonPrimitive.content))
        }
        for (e in v.getValue("skeleton").jsonArray) {
            val c = e.jsonObject
            assertEquals(c.toString(), Match.skeleton(c.getValue("b").jsonPrimitive.content), Match.skeleton(c.getValue("a").jsonPrimitive.content))
        }
    }

    /** Past match.ts: which site it names. Both warn on the same pages. */
    @Test fun aPunycodePageIsNamedAfterTheSiteItsDressedAs() {
        assertEquals("paypal.com", Match.lookalikeOf("xn--pypal-4ve.com", listOf("example.com", "paypal.com")))
        assertEquals("Close to nothing here, and still warned about", "example.com", Match.lookalikeOf("xn--80ak6aa92e.com", listOf("example.com")))
        assertNull("Too short a name to compare with", Match.lookalikeOf("xn--80ak6aa92e.com", listOf("abc.com")))
    }

    @Test fun anIndexKnowsTheSameSitesAsItsAddressesSay() {
        val lookup = IndexLookup(listOf(
            entry("a", LoginUrl("https://www.paypal.com/x"), LoginUrl("https://mybank.com.au/login", "exact"), LoginUrl("https://shop.example.org/app", "prefix"), LoginUrl("https://hidden.example.net", "never")),
            entry("b", LoginUrl("^https://pattern\\.example", "regex"), Match.appUrl("com.foo", "CERT"), LoginUrl("http://192.168.1.10"), LoginUrl("http://router/")),
        ))
        assertEquals(setOf("paypal.com", "mybank.com.au", "example.org", "example.net"), lookup.savedDomains)
    }

    @Test fun savedDomainsLeaveOutAppsAndAddressesThatAreNotSites() {
        val got = Match.savedDomainsOf(listOf(LoginUrl("https://www.paypal.com/x"), LoginUrl("androidapp://com.paypal?cert=abc", "never"), LoginUrl("android://H==@com.bank/"), LoginUrl("http://192.168.1.1"), LoginUrl(""), LoginUrl("mybank.com.au")))
        assertEquals(setOf("paypal.com", "mybank.com.au"), got)
    }

    private fun entry(id: String, vararg urls: LoginUrl) = IndexEntry(id, "login", "T", "u", urls.toList(), false, false)
    private fun web(domain: String) = FillTarget.Web(domain, "https", "com.android.chrome")

    @Test fun aPageThatOnlyLooksLikeASavedSiteHasNoOrdinarySuggestions() {
        val lookup = IndexLookup(listOf(entry("a", LoginUrl("https://paypal.com"))))
        val target = web("paypa1.com")
        val hits = AutofillIndex.matches(lookup, target, emptyMap()) { false }
        assertTrue("Nothing's saved for it, so nothing's offered as a suggestion", hits.isEmpty())
        assertEquals("paypal.com", AutofillIndex.lookalikeFor(lookup, target, hits))
    }

    @Test fun aRealMatchIsNotALookalike() {
        val lookup = IndexLookup(listOf(entry("a", LoginUrl("https://paypal.com")), entry("b", LoginUrl("https://paypal.co"))))
        val target = web("paypal.co")
        val hits = AutofillIndex.matches(lookup, target, emptyMap()) { false }
        assertEquals(1, hits.size)
        assertNull(AutofillIndex.lookalikeFor(lookup, target, hits))
        val other = web("example.org")
        assertNull(AutofillIndex.lookalikeFor(lookup, other, AutofillIndex.matches(lookup, other, emptyMap()) { false }))
    }

    @Test fun anAppsClaimedPageIsCheckedAndItsOwnLinkDoesNotClearIt() {
        val linked = entry("a", Match.appUrl("com.bank", "CERT"))
        val saved = entry("b", LoginUrl("https://paypal.com"))
        val lookup = IndexLookup(listOf(linked, saved))
        val app = FillTarget.App("com.bank", "CERT", "paypa1.com")
        val hits = AutofillIndex.matches(lookup, app, emptyMap()) { false }
        assertEquals("The app's own login", 1, hits.size)
        assertEquals("paypal.com", AutofillIndex.lookalikeFor(lookup, app, hits))
        assertNull("No claim, nothing to compare", AutofillIndex.lookalikeFor(lookup, FillTarget.App("com.bank", "CERT", null), hits))
        // A login saved for the page the app's showing is what clears it.
        val alsoSaved = IndexLookup(listOf(entry("c", Match.appUrl("com.bank", "CERT"), LoginUrl("https://paypal.co")), saved))
        val onCo = FillTarget.App("com.bank", "CERT", "paypal.co")
        assertNull(AutofillIndex.lookalikeFor(alsoSaved, onCo, AutofillIndex.matches(alsoSaved, onCo, emptyMap()) { false }))
    }

    @Test fun aSiteWithAPortIsComparedByItsHost() {
        val lookup = IndexLookup(listOf(entry("a", LoginUrl("https://paypal.com"))))
        assertEquals("paypal.com", AutofillIndex.lookalikeFor(lookup, web("paypa1.com:8443"), emptyList()))
    }

    @Test fun credentialManagerLooksAtTheOriginOnly() {
        val items = listOf(item(login("Real", "a", "p", "https://paypal.com")))
        assertEquals("paypal.com", credentialLookalike(items, Caller("com.browser", "https://paypa1.com", "CERT")))
        assertNull(credentialLookalike(items, Caller("com.browser", "https://paypal.com", "CERT")))
        assertNull("A native app has no page to look like anything", credentialLookalike(items, Caller("com.paypa1", null, "CERT")))
        assertNull(credentialLookalike(items, Caller("com.browser", "not a url", "CERT")))
    }

    // ---- Duplicates ----

    @Test fun duplicatesAreTheSameSiteAndUsernameInTheSameVault() {
        val a = item(login("A", "Ana", "p1", "https://www.example.com/login"))
        val b = item(login("B", "ana", "p2", "https://accounts.example.com"))
        val otherUser = item(login("C", "bob", "p3", "https://example.com"))
        val otherVault = item(login("D", "ana", "p4", "https://example.com"), vault = "w")
        val noUser = item(login("E", null, "p5", "https://example.com"))
        val aNote = item(newBody("note", "F").withText("username", "ana").withUrls(listOf(LoginUrl("https://example.com"))))
        val groups = Duplicates.find(listOf(a, b, otherUser, otherVault, noUser, aNote))
        assertEquals(1, groups.size)
        assertEquals(listOf(a.id, b.id), groups[0].map { it.id })
    }

    @Test fun twoSitesInCommonAreOneGroupAndOneSiteIsNotADuplicate() {
        val a = item(login("A", "ana", "p", "https://one.example", "https://two.example"))
        val b = item(login("B", "ana", "p", "https://one.example", "https://two.example"))
        val alone = item(login("C", "ana", "p", "https://three.example"))
        assertEquals(1, Duplicates.find(listOf(a, b, alone)).size)
        assertTrue(Duplicates.find(listOf(alone)).isEmpty())
    }

    @Test fun mergeKeepsTheNewestAndThrowsNothingAway() {
        val otherField = JsonArray(listOf(buildJsonObject { put("name", "pin"); put("value", "1234"); put("type", "hidden") }))
        val attachment = JsonArray(listOf(buildJsonObject { put("id", "att1"); put("name", "x.txt"); put("size", 4); put("key", "k"); put("chunks", 1) }))
        val passkey = JsonArray(listOf(buildJsonObject { put("credentialId", "cred1"); put("rpId", "example.com"); put("userHandle", "h"); put("userName", "ana"); put("key", "k"); put("signCount", 0); put("createdAt", "t"); put("discoverable", true) }))
        val newest = item(at(login("New", "ana", "pw-new", "https://example.com").withText("notes", "new note"), "2026-02-01T00:00:00.000Z"))
        val older = item(
            at(login("Old", "ana", "pw-old", "https://example.com", "https://other.example").withText("notes", "old note").withTotp(org.promptly.sync.passwords.core.TotpConfig("JBSWY3DPEHPK3PXP")), "2026-01-01T00:00:00.000Z")
                .with("fields" to otherField, "attachments" to attachment, "passkeys" to passkey, "passwordHistory" to JsonArray(listOf(buildJsonObject { put("password", "pw-older"); put("at", "2025") }))),
        )
        val m = Duplicates.merge(listOf(older, newest))
        assertEquals(newest.id, m.keep.id)
        assertEquals(listOf(older.id), m.drop.map { it.id })
        val b = m.body
        assertEquals("New", b.title)
        assertEquals("pw-new", b.password)
        assertEquals(listOf("pw-old", "pw-older"), b.passwordHistory.map { it.first })
        assertEquals(listOf("https://example.com", "https://other.example"), b.urls.map { it.url })
        assertEquals("new note\n\nold note", b.notes)
        assertEquals("pin", b.customFields.single().name)
        assertEquals("cred1", b.passkeys.single().credentialId)
        assertEquals("att1", b.attachments.single().id)
        assertNotNull(b.totp)
        assertEquals(1L, b.seq - newest.body.seq)
    }

    @Test fun mergeDoesNotRepeatAndKeepsTwentyInHistory() {
        val history = JsonArray((1..25).map { i -> buildJsonObject { put("password", "h$i"); put("at", "t") } })
        val a = item(at(login("A", "ana", "same", "https://e.example").with("passwordHistory" to history), "2026-02-01T00:00:00.000Z"))
        val b = item(at(login("B", "ana", "same", "https://e.example").with("passwordHistory" to history), "2026-01-01T00:00:00.000Z"))
        val m = Duplicates.merge(listOf(a, b)).body
        assertEquals(20, m.passwordHistory.size)
        assertEquals("h1", m.passwordHistory[0].first)
        assertEquals("One notes field's enough", null, m.notes)
    }

    /** Twenty of its own, and what's merged in still gets kept: those copies are about to go. */
    @Test fun mergeKeepsWhatItsMergingInWithinTheLimit() {
        val history = JsonArray((1..20).map { i -> buildJsonObject { put("password", "h$i"); put("at", "t") } })
        val kept = item(at(login("Kept", "ana", "kept-pw", "https://e.example").with("passwordHistory" to history), "2026-02-01T00:00:00.000Z"))
        val gone = item(at(org.promptly.sync.passwords.core.PasswordChange.withPending(login("Gone", "ana", "gone-pw", "https://e.example"), "gone-waiting"), "2026-01-01T00:00:00.000Z"))
        val m = Duplicates.merge(listOf(kept, gone)).body
        assertEquals(20, m.passwordHistory.size)
        assertEquals(listOf("gone-pw", "gone-waiting", "h1"), m.passwordHistory.take(3).map { it.first })
        assertEquals("kept-pw", m.password)
        assertEquals("Only the kept item's own waits", null, m.str("pendingPassword"))
    }

    @Test fun mergeCarriesAskAgainAndUnknownFieldsAcross() {
        val guarded = item(at(login("Guarded", "ana", "pw-a", "https://e.example").withFlag("reprompt", true), "2026-01-01T00:00:00.000Z"))
        val plain = item(at(login("Plain", "ana", "pw-b", "https://e.example").with("newerClientField" to JsonPrimitive("kept")), "2026-02-01T00:00:00.000Z"))
        val m = Duplicates.merge(listOf(guarded, plain)).body
        assertTrue("Its password is in this history now", m.reprompt)
        assertEquals("kept", m.str("newerClientField"))
    }

    @Test fun mergeCopesWithBodiesOfTheWrongShape() {
        val odd = item(at(newBody("login", "Odd").withText("username", "ana").with("urls" to JsonArray(listOf(JsonPrimitive(3), JsonPrimitive("https://e.example"), buildJsonObject { put("no", "url") })), "fields" to JsonPrimitive("nope"), "attachments" to buildJsonObject { }, "passkeys" to JsonArray(listOf(JsonPrimitive(1))), "passwordHistory" to JsonPrimitive(9), "totp" to JsonPrimitive("x")), "2026-01-01T00:00:00.000Z"))
        val fine = item(at(login("Fine", "ana", "pw", "https://e.example"), "2026-02-01T00:00:00.000Z"))
        val m = Duplicates.merge(listOf(odd, fine))
        assertEquals(fine.id, m.keep.id)
        assertEquals(listOf("https://e.example"), m.body.urls.map { it.url })
        assertNull(m.body.totp)
    }

    /** Why the client's merge seals an attachment again, instead of copying what the web's does. */
    @Test fun aChunkOnlyOpensUnderTheItemItWasUploadedOn() {
        val key = randomBytes(32)
        val blob = Attachments.sealChunk(key, "v", "item-a", "att", 0, 1, "hello".toByteArray())
        assertEquals("hello", String(Attachments.openChunk(key, "v", "item-a", "att", 0, 1, blob)))
        assertThrows(Exception::class.java) { Attachments.openChunk(key, "v", "item-b", "att", 0, 1, blob) }
    }

    // ---- What could lose you this vault ----

    @Test fun survivalReadsTheServersAnswerWithSuspicion() {
        val good = Survival.parse("""{"is_admin":true,"kit_confirmed":true,"kit_confirmed_at":"2026-01-01T00:00:00Z","offsite_configured":false,"last_backup_at":null,"backup_age_days":3}""")!!
        assertEquals(SurvivalOut(true, true, "2026-01-01T00:00:00Z", false, null, 3), good)
        for (bad in listOf(null, "", "not json", "[]", "3", "null", "{}", """{"kit_confirmed":"false","offsite_configured":false}""", """{"kit_confirmed":1,"offsite_configured":false}""", """{"kit_confirmed":true}""", """{"kit_confirmed":null,"offsite_configured":null}""")) {
            assertNull(bad, Survival.parse(bad))
        }
        // A number that can't be an age counts as not knowing.
        for (age in listOf("-5", "\"7\"", "1.5", "null", "99999999999")) {
            assertNull(age, Survival.parse("""{"kit_confirmed":true,"offsite_configured":true,"backup_age_days":$age}""")!!.backupAgeDays)
        }
    }

    @Test fun survivalWarnsAboutTheSameThingsAsTheWebVault() {
        val now = 1_800_000_000_000L
        fun keys(d: SurvivalOut?, last: Long? = now) = Survival.warnings(d, last, now).map { it.key }
        assertEquals(listOf("kit", "offsite", "backup"), keys(SurvivalOut(false, false, null, false, null, null)))
        assertEquals(emptyList<String>(), keys(SurvivalOut(false, true, "x", true, "y", 8)))
        assertEquals(listOf("backup"), keys(SurvivalOut(false, true, "x", true, "y", 9)))
        assertEquals(emptyList<String>(), keys(null))
        assertEquals("Unreachable counts even when the server can't say anything", listOf("unreachable"), keys(null, now - 3 * DAY))
        assertEquals(emptyList<String>(), keys(null, now - 3 * DAY + 1))
        assertEquals(emptyList<String>(), keys(null, null))
        val admin = Survival.warnings(SurvivalOut(true, true, "x", false, "y", 0), now, now).single { it.key == "offsite" }
        assertTrue(admin.text.startsWith("No off-site backup"))
        assertTrue(admin.export)
        val member = Survival.warnings(SurvivalOut(false, true, "x", false, "y", 0), now, now).single { it.key == "offsite" }
        assertTrue(member.text.startsWith("Whoever runs this server"))
        assertTrue(Survival.warnings(SurvivalOut(false, false, null, true, "y", 0), now, now).single().danger)
        assertTrue(Survival.warnings(SurvivalOut(false, true, "x", true, "y", 40), now, now).single().text.contains("40 days ago"))
    }

    @Test fun theRecoveryCheckComesRoundEverySixMonths() {
        val now = java.time.Instant.parse("2027-01-01T00:00:00Z").toEpochMilli()
        val old = java.time.Instant.ofEpochMilli(now - 183 * DAY).toString()
        val recent = java.time.Instant.ofEpochMilli(now - 100 * DAY).toString()
        assertTrue(Survival.recoveryDue(old, null, now))
        assertFalse(Survival.recoveryDue(recent, null, now))
        assertFalse(Survival.recoveryDue(old, recent, now))
        assertFalse(Survival.recoveryDue(null, null, now))
        assertFalse("A date that can't be read isn't a reason to ask", Survival.recoveryDue("yesterday", "", now))
        assertTrue(Survival.recoveryDue(old, "rubbish", now))
    }

    @Test fun datesWithAnOffsetRead() {
        assertNotNull(parseInstant("2026-11-07T01:02:03.123456+00:00"))
        assertNotNull(parseInstant("2026-11-07T01:02:03Z"))
        assertNull(parseInstant("2026-11-07"))
        assertNull(parseInstant(null))
    }

    @Test fun theExportReminder() {
        val now = 1_800_000_000_000L
        fun due(last: Long, since: Long, snooze: Long = 0) = ExportReminder.due(last, since, snooze, now)
        assertFalse("Never opened here: not counting yet", due(0, 0))
        assertFalse(due(0, now - 89 * DAY))
        assertTrue(due(0, now - 90 * DAY))
        assertFalse("Exported recently", due(now - DAY, now - 400 * DAY))
        assertTrue(due(now - 91 * DAY, now - 400 * DAY))
        assertFalse("Said later", due(0, now - 400 * DAY, now + 1))
        assertTrue("Later's over", due(0, now - 400 * DAY, now))
        assertEquals(now + 14 * DAY, ExportReminder.snoozeUntil(now))
        assertTrue(ExportReminder.shouldNotify(0, now - 90 * DAY, 0, 0, now))
        assertFalse("Once for a stretch of being due", ExportReminder.shouldNotify(0, now - 90 * DAY, 0, now - DAY, now))
        assertTrue(ExportReminder.shouldNotify(0, now - 90 * DAY, 0, now - 14 * DAY, now))
        assertFalse(ExportReminder.shouldNotify(now, now - 90 * DAY, 0, 0, now))
        assertTrue(ExportReminder.text(now - 100 * DAY, now).contains("100 days"))
        assertTrue(ExportReminder.text(0, now).contains("hasn't made"))
    }

    // ---- Secure Send ----

    @Test fun sendRecordsHaveTheWebVaultsShape() {
        val id = "11111111-2222-3333-4444-555555555555"
        val b = SendRecords.body("For a friend", "https://s.example/passwords/send/$id#k", id)
        assertEquals("send", b.kind)
        assertEquals("For a friend", b.title)
        assertEquals("https://s.example/passwords/send/$id#k", b.notes)
        assertEquals(id, b.str("sendId"))
        assertTrue("A system item, out of the list", b.isSystem)
        val rec = SendRecords.of(listOf(item(b, id = "the-record"), item(newBody("send", "No link"), id = "x"), item(SendRecords.body("Gone", "l", "gone"), deleted = true), item(login("Other", "a", "b"))), "v")
        assertEquals(setOf(id), rec.keys)
        assertEquals("the-record", rec.getValue(id).itemId)
    }

    /** Anyone who can write to a shared vault can write this, naming one of your Sends. */
    @Test fun aSendRecordPlantedInASharedVaultIsntYours() {
        val id = "11111111-2222-3333-4444-555555555555"
        val mine = item(SendRecords.body("Mine", "https://s.example/passwords/send/$id#k", id), vault = "own", id = "mine")
        val planted = item(SendRecords.body("Planted", "https://evil.example/passwords/send/$id#k", id), vault = "shared", id = "planted")
        for (order in listOf(listOf(mine, planted), listOf(planted, mine))) assertEquals("mine", SendRecords.of(order, "own").getValue(id).itemId)
        assertTrue(SendRecords.of(listOf(planted), "own").isEmpty())
    }

    @Test fun onlyALinkToThisSendCanBePosted() {
        val id = "11111111-2222-3333-4444-555555555555"
        val key = "A".repeat(43)
        val base = "https://promptly.example"
        val good = "$base/passwords/send/$id#$key"
        assertTrue(SendRecords.isLinkTo(id, good, base))
        assertTrue(SendRecords.isLinkTo(id, good, "$base/"))
        for (bad in listOf(
            "the wifi password is hunter2",
            "$base/passwords/send/$id",
            "$base/passwords/send/$id#short",
            "$base/passwords/send/$id#$key extra",
            "$base/passwords/send/$id#$key\nand a secret",
            "https://evil.example/passwords/send/$id#$key",
            "$base.evil.example/passwords/send/$id#$key",
            "$base/passwords/send/99999999-2222-3333-4444-555555555555#$key",
            "$base/other/$id#$key",
            "",
        )) {
            assertFalse(bad, SendRecords.isLinkTo(id, bad, base))
        }
    }

    @Test fun aSendIsFinishedWhenItsTimeOrViewsRunOut() {
        val now = java.time.Instant.parse("2027-01-01T00:00:00Z").toEpochMilli()
        fun send(expires: String, views: Int?) = SendOut("id", expires, views, false, false, "")
        assertFalse(SendRecords.finished(send("2027-01-02T00:00:00Z", null), now))
        assertTrue(SendRecords.finished(send("2026-12-31T00:00:00Z", null), now))
        assertTrue(SendRecords.finished(send("2027-01-02T00:00:00Z", 0), now))
        assertFalse(SendRecords.finished(send("2027-01-02T00:00:00+00:00", 1), now))
        assertFalse("A date that can't be read isn't a finished Send", SendRecords.finished(send("rubbish", 1), now))
    }

    @Test fun postingOnlyEverSendsTheLinkAndThePerson() {
        val seen = ArrayList<Pair<String, JsonObject>>()
        val http = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val buf = okio.Buffer()
            chain.request().body?.writeTo(buf)
            seen += chain.request().url.encodedPath to (Json.parseToJsonElement(buf.readUtf8()) as JsonObject)
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(204).message("").body("".toResponseBody(null)).build()
        }).build()
        val api = VaultApi("https://s.example", { "t" }, http)
        api.sendViaRooms("sid", "the-link", "user-1")
        api.sendViaMail("sid", "the-link", "a@b.example")
        assertEquals("/api/passwords/sends/sid/via-rooms", seen[0].first)
        assertEquals(setOf("link", "user_id"), seen[0].second.keys)
        assertEquals("/api/passwords/sends/sid/via-mail", seen[1].first)
        assertEquals(setOf("link", "to"), seen[1].second.keys)
    }

    // ---- Site icons ----

    @Test fun onlyAPlainDomainIsAskedAbout() {
        assertEquals("example.com", SiteIcons.domainOf("https://Example.com/login"))
        assertEquals("www.example.co.uk", SiteIcons.domainOf("www.example.co.uk"))
        for (bad in listOf(null, "", "http://192.168.1.1", "http://localhost:8080", "http://router/", "androidapp://com.foo?cert=x", "android://H==@com.foo/", "ftp://example.com", "https://[::1]/", "https://exa mple.com")) {
            assertNull(bad, SiteIcons.domainOf(bad))
        }
    }

    @Test fun iconsAreOffUntilAVaultSaysYes() {
        val row = item(newBody("prefs", SiteIcons.PREFS_TITLE, "icon" to JsonPrimitive(true)), vault = "on")
        val off = item(newBody("prefs", SiteIcons.PREFS_TITLE, "icon" to JsonPrimitive(false)), vault = "off")
        val notABool = item(newBody("prefs", SiteIcons.PREFS_TITLE, "icon" to JsonPrimitive("yes")), vault = "odd")
        val otherPrefs = item(newBody("prefs", "something-else", "icon" to JsonPrimitive(true)), vault = "other")
        val trashed = item(newBody("prefs", SiteIcons.PREFS_TITLE, "icon" to JsonPrimitive(true)), vault = "gone", deleted = true)
        val vaults = SiteIcons.iconVaults(listOf(row, off, notABool, otherPrefs, trashed))
        assertEquals(setOf("on"), vaults)
        assertTrue(SiteIcons.show(item(login("A", "u", "p"), vault = "on"), vaults))
        assertFalse(SiteIcons.show(item(login("B", "u", "p"), vault = "none"), vaults))
        assertTrue("One item can ask for itself, as on the web", SiteIcons.show(item(login("C", "u", "p").withFlag("icon", true), vault = "none"), vaults))
        assertEquals(row.id, SiteIcons.prefsRow(listOf(row, off), "on")!!.id)
        assertNull(SiteIcons.prefsRow(listOf(row), "off"))
    }

    private fun answering(code: Int, body: ByteArray) = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
        Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(code).message("").body(body.toResponseBody("image/png".toMediaType())).build()
    }).build()

    @Test fun anIconBiggerThanTheServersOwnLimitIsRefused() {
        assertEquals(3, VaultApi("https://s.example", { "t" }, answering(200, ByteArray(3))).icon("example.com")!!.size)
        assertEquals(SiteIcons.MAX_BYTES, VaultApi("https://s.example", { "t" }, answering(200, ByteArray(SiteIcons.MAX_BYTES))).icon("example.com")!!.size)
        assertNull(VaultApi("https://s.example", { "t" }, answering(200, ByteArray(SiteIcons.MAX_BYTES + 1))).icon("example.com"))
        assertNull("No icon isn't an error", VaultApi("https://s.example", { "t" }, answering(404, ByteArray(0))).icon("example.com"))
        assertThrows(ApiError::class.java) { VaultApi("https://s.example", { "t" }, answering(500, ByteArray(0))).icon("example.com") }
    }

    // ---- The directories ----

    @Test fun theDirectoryIsAdviceAndOddEntriesAreDropped() {
        val d = SiteDirectory.parse("""{"twofa":{"a.example":{"documentation":"https://a.example/2fa"},"b.example":{},"c.example":3},"passkeys":{"p.example":true,"q.example":false,"r.example":null}}""")
        assertEquals("https://a.example/2fa", d.twofa["a.example"])
        assertTrue("b.example" in d.twofa)
        assertEquals(setOf("p.example"), d.passkeys)
        for (bad in listOf(null, "", "[]", "not json", """{"twofa":[],"passkeys":[1,2]}""", """{"twofa":3}""")) {
            assertEquals(SiteDirectory.EMPTY, SiteDirectory.parse(bad))
        }
    }

    @Test fun theSecurityCheckSaysWhichSitesCouldUseAPasskey() {
        val passkeys = setOf("example.com")
        val could = item(login("Could", "u", "kX9!vQ2#mL7pR4zQ", "https://www.example.com"))
        val hasOne = item(login("Has one", "u", "kX9!vQ2#mL7pR4zQ", "https://example.com").with("passkeys" to JsonArray(listOf(buildJsonObject { put("credentialId", "c"); put("rpId", "example.com"); put("userHandle", "h"); put("key", "k") }))))
        val noDirectoryEntry = item(login("Elsewhere", "u", "kX9!vQ2#mL7pR4zQ", "https://other.example"))
        val noUrl = item(login("No address", "u", "kX9!vQ2#mL7pR4zQ"))
        val r = Health.run(listOf(could, hasOne, noDirectoryEntry, noUrl), null, emptyMap(), passkeys = passkeys)
        assertEquals(listOf("Could"), r.noPasskey.map { it.body.title })
        assertTrue(Health.run(listOf(could)).noPasskey.isEmpty())
    }

    // ---- Emergency access ----

    private fun row(state: String, opensAt: String? = null) = EmergencyOut("e", "g", "Grantor", "c", "Contact", 7, state, null, opensAt, emptyMap(), emptyList())

    @Test fun whatAnEmergencyStateMeansFromEachSide() {
        assertEquals("Waiting for them to accept.", EmergencyText.state(row("invited"), true))
        assertEquals("They've asked you.", EmergencyText.state(row("invited"), false))
        assertEquals("Finishing on this device.", EmergencyText.state(row("accepted"), true))
        assertEquals("Waiting for them to finish setting it up.", EmergencyText.state(row("accepted"), false))
        assertEquals("Set up.", EmergencyText.state(row("ready"), true))
        assertEquals("Asked. Opens 2027-01-01 10:00 unless refused.", EmergencyText.state(row("requested", "2027-01-01T10:00:00Z"), true))
        assertEquals("Asked.", EmergencyText.state(row("requested"), false))
        assertEquals("Refused.", EmergencyText.state(row("refused"), false))
        assertEquals("They can read your vault.", EmergencyText.state(row("opened"), true))
        assertEquals("Open.", EmergencyText.state(row("opened"), false))
        assertTrue(EmergencyText.state(row("ended"), true).contains("Change the keys"))
        assertEquals("A state from a newer server shows as it is", "paused", EmergencyText.state(row("paused"), true))
        assertTrue(EmergencyText.WARNING.startsWith("If you don't refuse before the wait runs out, it opens."))
        assertTrue(EmergencyText.WARNING.contains("could skip it"))
    }

    @Test fun whenAContactCanAskAndOpen() {
        for (s in listOf("ready", "refused")) assertTrue(s, EmergencyText.canAsk(row(s)))
        for (s in listOf("invited", "accepted", "requested", "opened", "ended")) assertFalse(s, EmergencyText.canAsk(row(s)))
        val now = java.time.Instant.parse("2027-01-01T00:00:00Z").toEpochMilli()
        assertTrue(EmergencyText.due(row("requested", "2026-12-31T00:00:00Z"), now))
        assertFalse(EmergencyText.due(row("requested", "2027-01-02T00:00:00Z"), now))
        assertFalse("No date, no opening", EmergencyText.due(row("requested", null), now))
        assertFalse(EmergencyText.due(row("requested", "rubbish"), now))
        assertFalse(EmergencyText.due(row("ready", "2026-12-31T00:00:00Z"), now))
    }

    @Test fun aWaitIsOneToNinetyDays() {
        assertEquals(1, EmergencyText.validWait("1"))
        assertEquals(90, EmergencyText.validWait(" 90 "))
        for (bad in listOf("0", "91", "", "-3", "seven", "99999999999")) assertNull(bad, EmergencyText.validWait(bad))
    }
}
