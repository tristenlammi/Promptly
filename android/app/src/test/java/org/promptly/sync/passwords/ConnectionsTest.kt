// Where the vault meets the rest of Promptly: the rules, on their own, with what a server or a
// stranger's email could hand them. Under Robolectric for Android's Public Suffix List.
package org.promptly.sync.passwords

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.passwords.autofill.FillTarget
import org.promptly.sync.passwords.autofill.MailOffer
import org.promptly.sync.passwords.core.ActivityLog
import org.promptly.sync.passwords.core.Attachments
import org.promptly.sync.passwords.core.DriveFiles
import org.promptly.sync.passwords.core.Generator
import org.promptly.sync.passwords.core.Health
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.ItemBody
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.MailCode
import org.promptly.sync.passwords.core.MailCodes
import org.promptly.sync.passwords.core.PasswordChange
import org.promptly.sync.passwords.core.SecurityEvent
import org.promptly.sync.passwords.core.SecurityEvents
import org.promptly.sync.passwords.core.UntrustedText
import org.promptly.sync.passwords.core.VaultApi
import org.promptly.sync.passwords.core.newBody
import org.promptly.sync.passwords.core.parseInstant
import org.promptly.sync.passwords.core.touch
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** An API whose every answer is this text, which records what it was asked. */
internal class Canned(val answer: String, val code: Int = 200) {
    val asked = ArrayList<String>()
    val bodies = ArrayList<String>()
    val api = VaultApi("https://server.test", { "pwd_x" }, OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
        val r = chain.request()
        asked += "${r.method} ${r.url.encodedPath}"
        bodies += Buffer().also { r.body?.writeTo(it) }.readUtf8()
        Response.Builder().request(r).protocol(Protocol.HTTP_1_1).code(code).message("x").body(answer.toResponseBody("application/json".toMediaType())).build()
    }).build())
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ConnectionsTest {
    init {
        Fixtures.setup()
        okhttp3.OkHttp.initialize(androidx.test.core.app.ApplicationProvider.getApplicationContext())
    }

    private var n = 0
    private fun item(body: ItemBody, id: String = "i${n++}") = Item(id, "v", 1, false, body.updatedAt, body)
    private fun login(title: String, pw: String, vararg urls: String, user: String = "ana") = newBody("login", title).withText("username", user).withText("password", pw).withUrls(urls.map { LoginUrl(it) })

    @Test fun untrustedTextIsOneLineWithNothingInvisible() {
        assertEquals("Hello World", UntrustedText.clean("Hello\n\u0007World​", 80))
        assertEquals("evilgnp.exe", UntrustedText.clean("evil‮gnp.exe", 80))
        assertEquals("abc", UntrustedText.clean("abcdefgh", 3))
        assertEquals("", UntrustedText.clean(null, 3))
        // A cut never leaves half a character behind.
        assertEquals("a", UntrustedText.clean("a😀", 2))
    }

    // ---- The vectors shared with connections.ts ----

    private val vectors: JsonObject by lazy { Json.parseToJsonElement(java.io.File(Fixtures.frontend.parentFile, "android/app/src/test/cross/connections-vectors.json").readText()).jsonObject }
    private fun JsonObject.text(k: String) = this[k].takeIf { it !is JsonNull && it != null }?.jsonPrimitive?.content

    @Test fun mailCodesRankAsOnTheWeb() {
        val now = parseInstant(vectors.getValue("now").jsonPrimitive.content)!!.toEpochMilli()
        val saved = vectors.getValue("saved").jsonArray.map { it.jsonPrimitive.content }
        for (e in vectors.getValue("rank").jsonArray) {
            val c = e.jsonObject
            val codes = c.getValue("codes").jsonArray.map { x -> val o = x.jsonObject; MailCode(o.text("id")!!, "", o.text("from_domain")!!, o.text("at")!!, o.text("code"), o.text("link")) }
            val got = MailCodes.rank(codes, c.text("page")!!, saved, now)
            val want = c.getValue("want").jsonArray.map { it.jsonObject }
            assertEquals(c.text("name"), want.map { it.text("id") }, got.map { it.mail.id })
            for ((w, r) in want.zip(got)) {
                assertEquals(c.text("name"), w.getValue("matches").jsonPrimitive.content.toBoolean(), r.matches)
                assertEquals(c.text("name") + " " + r.mail.id, w.text("lookalike"), r.lookalike)
                assertEquals(c.text("name"), w.text("ago")!!.toLong(), r.agoSeconds)
            }
        }
    }

    @Test fun linksFollowTheWebsRulesAndGoFurther() {
        for (e in vectors.getValue("linkIsSafe").jsonArray) {
            val c = e.jsonObject
            assertEquals(c.toString(), c.getValue("want").jsonPrimitive.content.toBoolean(), MailCodes.linkIsSafe(MailCode("i", "", c.text("from")!!, "2026-11-07T12:00:00Z", null, c.text("link"))))
        }
    }

    @Test fun securityAlertsMatchAsOnTheWeb() {
        for (e in vectors.getValue("securityAlerts").jsonArray) {
            val c = e.jsonObject
            val items = c.getValue("logins").jsonArray.map { l -> item(newBody("login", l.jsonObject.text("title")!!).withUrls(l.jsonObject.getValue("urls").jsonArray.map { LoginUrl(it.jsonPrimitive.content) })) }
            val events = SecurityEvents.parse(c.getValue("events").toString())
            val got = SecurityEvents.alerts(events, items)
            val want = c.getValue("want").jsonArray.map { it.jsonObject }
            // A name is whatever an email says. Android goes by the domain, as its mail rows do (A52).
            assertEquals(want.map { Triple(it.text("id"), it.text("title"), it.text("androidText") ?: it.text("text")) }, got.map { Triple(it.event.id, it.item.body.title, it.text) })
        }
    }

    @Test fun changePagesAndPlusAddressesMatchTheWeb() {
        for (e in vectors.getValue("changePageUrl").jsonArray) {
            val c = e.jsonObject
            assertEquals(c.toString(), c.text("want"), PasswordChange.changePageUrl(newBody("login", "x").withUrls(c.getValue("urls").jsonArray.map { LoginUrl(it.jsonPrimitive.content) })))
        }
        for (e in vectors.getValue("plusAddress").jsonArray) {
            val c = e.jsonObject
            assertEquals(c.text("want"), Generator.plusAddress(c.text("email")!!, c.text("tag")!!))
        }
    }

    // ---- Mail: what a server, or anyone who can send an email, could hand over ----

    private val AT = "2026-11-07T12:09:00Z"
    private val NOW = parseInstant("2026-11-07T12:10:00Z")!!.toEpochMilli()

    @Test fun aMailRowKeepsOnlyWhatItCanBeTrustedWith() {
        val rows = Canned("""[
            {"id":"ok","from_name":"Bank","from_domain":"promptlybank.com","at":"$AT","code":"482913","link":null},
            {"id":"spaced","from_domain":"promptlybank.com","at":"$AT","code":"482 913"},
            {"id":"mixed","from_domain":"promptlybank.com","at":"$AT","code":"AB12-CD3"},
            {"id":"script","from_domain":"promptlybank.com","at":"$AT","code":"<script>alert(1)</script>"},
            {"id":"sql","from_domain":"promptlybank.com","at":"$AT","code":"482913'; DROP"},
            {"id":"newline","from_domain":"promptlybank.com","at":"$AT","code":"482913
999"},
            {"id":"long","from_domain":"promptlybank.com","at":"$AT","code":"123456789012345678901234567890"},
            {"id":"number","from_domain":"promptlybank.com","at":"$AT","code":482913},
            {"id":"nowhen","from_domain":"promptlybank.com","code":"111111"},
            {"id":"badwhen","from_domain":"promptlybank.com","at":"yesterday","code":"111111"},
            {"id":123,"from_domain":"promptlybank.com","at":"$AT","code":"111111"},
            {"from_domain":"promptlybank.com","at":"$AT","code":"111111"},
            {"id":"nodomain","at":"$AT","code":"111111"},
            "rubbish", 7, null
        ]""".replace("\n            ", "")).api.mailCodes()
        assertEquals(listOf("ok", "spaced", "mixed"), rows.map { it.id })
        assertTrue(Canned("{\"detail\":\"x\"}").api.mailCodes().isEmpty())
        assertTrue(Canned("").api.mailCodes().isEmpty())
    }

    @Test fun aFromLineThatIsntADomainMatchesNothing() {
        for (from in listOf("promptlybank.com/x", "promptlybank.com evil.example", "promptlybank.com\nevil.example", "promptlybank.com@evil.example", "https://promptlybank.com", "", ".", "promptlybank.com#evil.example", "promptlybank.com?evil")) {
            assertNull(from, MailCodes.senderBase(from))
            val r = MailCodes.rank(listOf(MailCode("i", "", from, AT, "111111", null)), "https://promptlybank.com/", emptyList(), NOW)
            assertFalse(from, r.single().matches)
            assertTrue("Not even named in a warning: $from", MailCodes.otherSenders(r).isEmpty())
        }
    }

    /** The mail's own words don't come into it: only who it's from, and that's a stranger's mail here. */
    @Test fun aCodeThatClaimsToBeForThisSiteFromAnotherSenderGetsNoRow() {
        val claim = MailCode("i", "Promptly Bank security", "evil.example", AT, "482913", "https://promptlybank.com/magic/abc")
        val r = MailCodes.rank(listOf(claim), "https://promptlybank.com/verify", listOf("promptlybank.com"), NOW).single()
        assertFalse(r.matches)
        assertEquals("The warning names the sender and holds nothing of what it sent", listOf("evil.example"), MailCodes.otherSenders(listOf(r)))
        assertFalse("And its link goes elsewhere than its sender", MailCodes.linkIsSafe(claim))
    }

    @Test fun oldMailIsNoCodeWhateverTheServerSays() {
        fun ago(s: Long) = MailCodes.rank(listOf(MailCode("i", "", "promptlybank.com", java.time.Instant.ofEpochMilli(NOW - s * 1000).toString(), "111111", null)), "https://promptlybank.com/", emptyList(), NOW).single()
        assertTrue(MailCodes.fresh(ago(40)))
        assertTrue("Clocks disagree a little", MailCodes.fresh(ago(700)))
        assertFalse(MailCodes.fresh(ago(60 * 60)))
    }

    @Test fun aCodeFitsTheBoxesItsGiven() {
        assertEquals("482913", MailCodes.forOneBox("482 913"))
        assertEquals("482913", MailCodes.forOneBox("482-913"))
        assertEquals("Letters and all, as it was sent", "AB12-CD3", MailCodes.forOneBox("AB12-CD3"))
        assertEquals(listOf("4", "8", "2", "9", "1", "3"), MailCodes.forBoxes("482 913", 6))
        assertNull("One box isn't split", MailCodes.forBoxes("482913", 1))
        assertNull("Nor where there aren't enough", MailCodes.forBoxes("482913", 4))
    }

    @Test fun theMailRowOnlyShowsWhereItMakesSense() {
        val web = FillTarget.Web("promptlybank.com", "https", "b")
        val app = FillTarget.App("com.x", "c", null)
        assertEquals(MailOffer.Row.CODE, MailOffer.row(true, true, false, null, web, 0))
        assertEquals(MailOffer.Row.LINK, MailOffer.row(true, false, true, null, web, 0))
        assertEquals("A code box goes first", MailOffer.Row.CODE, MailOffer.row(true, true, true, null, web, 0))
        assertNull("Off by default means off", MailOffer.row(false, true, false, null, web, 3))
        assertNull("Nothing to put anything in", MailOffer.row(true, false, false, null, web, 3))
        assertNull("A frame from another site", MailOffer.row(true, true, false, "ads.example", web, 3))
        assertNull("An app with no linked login has no site", MailOffer.row(true, true, false, null, app, 0))
        assertEquals(MailOffer.Row.CODE, MailOffer.row(true, true, false, null, app, 1))
        assertNull("An app showing a page it says is someone's", MailOffer.row(true, true, false, null, FillTarget.App("com.x", "c", "promptlybank.com"), 1))
    }

    @Test fun onlyWhatsTheSiteComesThroughASharedGroupAndNotALookalikesOwnGroup() {
        assertTrue(MailCodes.related("envato.com", "themeforest.net"))
        assertFalse(MailCodes.related("envato.com", "themeforest.net.evil.example"))
        assertFalse(MailCodes.related(null, null))
    }

    // ---- Security emails ----

    @Test fun securityEventsAreFlatTextFromRealDomains() {
        val list = Canned("""[
            {"id":"a","kind":"password_changed","from_name":"Insta‮gram
Call 555","from_domain":"Mail.Instagram.com","subject":"${"x".repeat(500)}","at":"$AT"},
            {"id":"b","kind":"delete_everything","from_name":"","from_domain":"instagram.com","subject":"s","at":"$AT"},
            {"id":"c","kind":"new_signin","from_domain":"instagram.com/evil","subject":"s","at":"$AT"},
            {"id":"d","kind":"new_signin","from_domain":"instagram.com","subject":"s","at":"last week"},
            {"id":7,"kind":"new_signin","from_domain":"instagram.com","subject":"s","at":"$AT"},
            {"kind":"new_signin","from_domain":"instagram.com","subject":"s","at":"$AT"},
            "rubbish"
        ]""".replace("\n            ", "")).api.securityEvents()
        assertEquals(listOf("a"), list.map { it.id })
        assertEquals("Instagram Call 555", list[0].fromName)
        assertEquals("mail.instagram.com", list[0].fromDomain)
        assertEquals(200, list[0].subject.length)
        assertTrue(Canned("oops").api.securityEvents().isEmpty())
    }

    @Test fun aSecurityEmailNeedsToComeFromTheLoginsOwnSite() {
        val insta = item(login("Instagram", "pw", "https://www.instagram.com/"))
        fun event(from: String, name: String = "Instagram") = SecurityEvent("e", "password_changed", name, from, "s", AT)
        assertEquals(insta.id, SecurityEvents.alerts(listOf(event("mail.instagram.com")), listOf(insta)).single().item.id)
        for (from in listOf("instagram.com.evil.example", "instagrarn.com", "evil.example")) {
            assertTrue(from, SecurityEvents.alerts(listOf(event(from)), listOf(insta)).isEmpty())
        }
        assertTrue("Not an item with no login", SecurityEvents.alerts(listOf(event("instagram.com")), listOf(item(newBody("note", "Instagram").withUrls(listOf(LoginUrl("https://instagram.com")))))).isEmpty())
        assertEquals("instagram.com says your password changed. Was that you?", SecurityEvents.alerts(listOf(event("instagram.com", "")), listOf(insta)).single().text)
    }

    // ---- Changing a password ----

    @Test fun aChangedPasswordWaitsThenSwapsOrDrops() {
        val start = login("X", "old-One-1!", "https://example.com")
        val waiting = PasswordChange.withPending(start, "new-One-2!")
        assertEquals("old-One-1!", waiting.password)
        assertEquals("new-One-2!", waiting.str("pendingPassword"))
        val done = touch(waiting, PasswordChange.commit(waiting))
        assertEquals("new-One-2!", done.password)
        assertNull(done["pendingPassword"])
        assertEquals("old-One-1!", done.passwordHistory.first().first)
        val dropped = touch(waiting, PasswordChange.drop(waiting))
        assertEquals("old-One-1!", dropped.password)
        assertNull(dropped["pendingPassword"])
        assertEquals("A no can be a mistake", "new-One-2!", dropped.passwordHistory.single().first)
        assertEquals("Nothing waiting, nothing to do", start.password, PasswordChange.commit(start).password)
    }

    /** What `connections-vectors.json` says, which the real TypeScript also has to give. */
    @Test fun waitingPasswordsAndMergingMatchTheWeb() {
        fun hist(e: kotlinx.serialization.json.JsonElement?) = (e as kotlinx.serialization.json.JsonArray).map { JsonObject(mapOf("password" to it, "at" to JsonPrimitive("2026-01-01T00:00:00.000Z"))) }
        for (e in vectors.getValue("pending").jsonArray) {
            val c = e.jsonObject
            val body = login("x", c.text("password")!!, "https://e.example").with("passwordHistory" to kotlinx.serialization.json.JsonArray(hist(c["history"])), "pendingPassword" to c.text("pending")?.let { JsonPrimitive(it) })
            val out = when (c.text("op")) {
                "touch" -> touch(body, body.with("password" to c["next"]))
                "commit" -> touch(body, PasswordChange.commit(body))
                "drop" -> touch(body, PasswordChange.drop(body))
                else -> {
                    val gone = login("x", c.text("dropPassword")!!, "https://e.example").with("passwordHistory" to kotlinx.serialization.json.JsonArray(hist(c["dropHistory"])), "pendingPassword" to c.text("dropPending")?.let { JsonPrimitive(it) }, "updatedAt" to JsonPrimitive("2026-01-01T00:00:00.000Z"))
                    org.promptly.sync.passwords.core.Duplicates.merge(listOf(item(body.with("updatedAt" to JsonPrimitive("2026-02-01T00:00:00.000Z"))), item(gone))).body
                }
            }
            val name = c.text("name")!!
            assertEquals(name, c.text("wantPassword"), out.password)
            assertEquals(name, c.text("wantPending"), out.str("pendingPassword"))
            assertEquals(name, c.getValue("wantHistory").jsonArray.map { it.jsonPrimitive.content }, out.passwordHistory.map { it.first })
        }
    }

    /** The bug itself: a password updated from Android's own save sheet, then a yes to an old question. */
    @Test fun aStaleWaitingPasswordCantOverwriteOneSetSinceThen() {
        val waiting = PasswordChange.withPending(login("X", "old-One-1!", "https://example.com"), "stale-One-2!")
        val updated = touch(waiting, waiting.with("password" to JsonPrimitive("typed-One-3!")))
        assertNull(updated["pendingPassword"])
        assertEquals("Nothing waiting, so nothing to do", "typed-One-3!", touch(updated, PasswordChange.commit(updated)).password)
        assertEquals(listOf("stale-One-2!", "old-One-1!"), updated.passwordHistory.map { it.first })
    }

    @Test fun onlyTheVaultsOwnAccountCanReplaceItsDevice() {
        assertTrue(org.promptly.sync.passwords.core.sameAccount("A-b", "a-B"))
        assertFalse(org.promptly.sync.passwords.core.sameAccount("a", "b"))
        assertFalse("Not knowing isn't yes", org.promptly.sync.passwords.core.sameAccount("a", null))
        assertFalse(org.promptly.sync.passwords.core.sameAccount(null, "a"))
        assertFalse(org.promptly.sync.passwords.core.sameAccount("", ""))
    }

    @Test fun aCodeOnAnInsecurePageAsksAsALoginDoes() {
        assertEquals(MailOffer.Insecure.HTTP, MailOffer.insecure(FillTarget.Web("x.example", "http", "b")))
        assertEquals(MailOffer.Insecure.HTTP, MailOffer.insecure(FillTarget.Web("x.example", "HTTP", "b")))
        assertEquals(MailOffer.Insecure.UNKNOWN, MailOffer.insecure(FillTarget.Web("x.example", "https", "b", schemeKnown = false)))
        assertNull(MailOffer.insecure(FillTarget.Web("x.example", "https", "b")))
        assertNull(MailOffer.insecure(FillTarget.App("com.x", "c", null)))
    }

    @Test fun theQueueGoesWorstFirstAndEachOnce() {
        val breached = item(login("Breached", "bbbbbb", "https://b.example"))
        val a = item(login("Reused A", "CorrectHorseBatteryStaple99!", "https://a.example"))
        val b = item(login("Reused B", "CorrectHorseBatteryStaple99!", "https://c.example"))
        val fine = item(login("Fine", "Another-Long-Passphrase-77", "https://d.example"))
        val r = Health.run(listOf(fine, a, b, breached), { p -> if (p == Health.sha1Hex("bbbbbb").take(5)) Health.sha1Hex("bbbbbb").substring(5) + ":9" else "" })
        assertEquals(listOf("Breached", "Reused A", "Reused B"), PasswordChange.toChange(r).map { it.body.title })
    }

    @Test fun aKnownChangePageMustBeHttps() {
        val saved = PasswordChange.urlsLoader
        // The list ships with the app, and it still isn't handed to a browser as anything else.
        assertTrue(java.io.File(Fixtures.core, "data/change-password-URLs.json").readText().contains("https://"))
        assertEquals("https://nothing.example/.well-known/change-password", PasswordChange.changePageUrl(newBody("login", "x").withUrls(listOf(LoginUrl("https://nothing.example/")))))
        assertTrue(saved != null)
    }

    // ---- Plus addresses ----

    @Test fun aPlusAddressNeedsAnEmailAddress() {
        for (bad in listOf("", "@x.com", "no-at-sign")) assertThrows(bad, IllegalArgumentException::class.java) { Generator.plusAddress(bad, "shop") }
        assertTrue("An empty tag gets a random one", Regex("^me\\+[a-z0-9]{1,6}@x\\.com$").matches(Generator.plusAddress("me@x.com", "!!!")))
    }

    // ---- Documents from Files ----

    @Test fun whatFilesSaysIsCheckedBeforeItsUsed() {
        val id = "12345678-1234-1234-1234-123456789012"
        val list = Canned("""[
            {"id":"$id","name":"Passport scan.pdf","size_bytes":1000,"mime_type":"application/pdf"},
            {"id":"$id","name":"../../etc/pa\\sswd\n‮.pdf","size_bytes":10,"mime_type":"text/html; charset=x\nInjected: yes"},
            {"id":"$id","name":"","size_bytes":10,"mime_type":null},
            {"id":"../../other/user","name":"a","size_bytes":10,"mime_type":"text/plain"},
            {"id":"$id/../x","name":"a","size_bytes":10,"mime_type":"text/plain"},
            {"id":"$id","name":"negative","size_bytes":-5,"mime_type":"text/plain"},
            {"id":"$id","name":"empty","size_bytes":0,"mime_type":"text/plain"},
            {"id":"$id","name":"huge","size_bytes":104857601,"mime_type":"text/plain"},
            {"id":"$id","name":"string","size_bytes":"10","mime_type":"text/plain"},
            "rubbish"
        ]""".replace("\n            ", "")).api.driveFiles("q & x")
        assertEquals(3, list.size)
        assertEquals("application/pdf", list[0].mime)
        assertEquals(".._.._etc_pa_sswd .pdf", list[1].name)
        assertNull("A type that isn't one", list[1].mime)
        assertEquals("Document", list[2].name)
        assertTrue(Canned("nope").api.driveFiles("").isEmpty())
    }

    @Test fun onlyARealDayGoesToCalendar() {
        assertEquals("2027-02-28", DriveFiles.validDay(" 2027-02-28 "))
        for (bad in listOf("", "2027-02-30", "28/02/2027", "2027-2-8", "tomorrow", "2027-02-28T00:00:00Z", "1000-01-01", "<b>")) assertNull(bad, DriveFiles.validDay(bad))
    }

    @Test fun aStreamReadsForwardsAndMustBeTheSizeItSaid() {
        val data = ByteArray(10) { it.toByte() }
        val read = Attachments.streamReader(data.inputStream(), 10)
        assertEquals(listOf<Byte>(2, 3), read(2, 2).toList())
        assertEquals(listOf<Byte>(4, 5, 6, 7, 8, 9), read(4, 6).toList())
        val short = Attachments.streamReader(ByteArray(3).inputStream(), 10)
        assertThrows(java.io.IOException::class.java) { short(0, 10) }
        val long = Attachments.streamReader(ByteArray(11).inputStream(), 10)
        assertThrows("A file that runs on past what it said isn't that file", java.io.IOException::class.java) { long(0, 10) }
    }

    // ---- Activity ----

    @Test fun activityOnlyShowsRowsThatMakeSense() {
        val rows = Canned("""[
            {"event":"unlocked","at":"2026-11-07T01:02:03Z","device_id":null},
            {"event":"device_added","at":"not a time"},
            {"event":123,"at":"2026-11-07T01:02:03Z"},
            {"at":"2026-11-07T01:02:03Z"},
            "rubbish",
            {"event":"new_thing\n‮gnp","at":"2026-11-07T01:02:03+00:00"}
        ]""".replace("\n            ", "")).api.activity()
        assertEquals(2, rows.size)
        assertEquals("unlocked", rows[0].event)
        assertEquals("Unlocked", ActivityLog.text("unlocked"))
        assertEquals("A name the client doesn't know shows as flat text", "new_thing gnp", ActivityLog.text(rows[1].event))
        assertTrue(Canned("{\"detail\":\"nope\"}").api.activity().isEmpty())
        assertTrue(Canned("not json at all").api.activity().isEmpty())
    }

    @Test fun everyEventTheServerWritesHasWords() {
        val written = Regex("service\\.activity\\([^,]+,[^,]+, *\"([a-z_]+)\"").findAll(java.io.File(Fixtures.frontend.parentFile, "backend/app/passwords/router.py").readText()).map { it.groupValues[1] }.toSet()
        assertTrue("Found ${written.size}", written.size >= 15)
        for (e in written) assertFalse("No words for $e", ActivityLog.text(e) == e)
    }

    // ---- Today ----

    @Test fun todayGetsFourCountsAndNothingElse() {
        val a = item(login("Secret bank", "aaaaaa", "https://bank.example"))
        val b = item(login("Secret shop", "aaaaaa", "https://shop.example"))
        val c = item(login("Secret mail", "CorrectHorseBatteryStaple99!", "https://mail.example"))
        val r = Health.run(listOf(a, b, c), { "" })
        val api = Canned("")
        api.api.putHealth(Health.coarseCounts(r))
        assertEquals("PUT /api/passwords/health", api.asked.single())
        val sent = Json.parseToJsonElement(api.bodies.single()).jsonObject
        assertEquals(setOf("weak", "reused", "breached", "old"), sent.keys)
        assertEquals("2", sent.getValue("weak").jsonPrimitive.content)
        assertEquals("Both logins of the reused pair count, as on the web", "2", sent.getValue("reused").jsonPrimitive.content)
        for (word in listOf("Secret", "bank", "shop", "example", "aaaaaa", "ana")) assertFalse(api.bodies.single().contains(word))
        for (v in sent.values) assertTrue(v.jsonPrimitive.content.toIntOrNull() != null)
    }
}
