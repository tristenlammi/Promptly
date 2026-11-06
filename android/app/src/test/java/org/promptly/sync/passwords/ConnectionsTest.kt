// Where the vault meets the rest of Promptly: the rules, on their own, with what a server or a
// stranger's email could hand them. Under Robolectric for Android's Public Suffix List.
package org.promptly.sync.passwords

import kotlinx.serialization.json.Json
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
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.passwords.core.ActivityLog
import org.promptly.sync.passwords.core.Health
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.ItemBody
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.UntrustedText
import org.promptly.sync.passwords.core.VaultApi
import org.promptly.sync.passwords.core.newBody
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
