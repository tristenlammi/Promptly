// Against the isolated :8092 stack, with throwaway users made by a script piped into the
// backend container. Skipped unless -Dpw.stack=http://localhost:8092 is passed.
//   gradlew :app:testDebugUnitTest --tests "*StackTests*" -Dpw.stack=http://localhost:8092
package org.promptly.sync.passwords

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.promptly.sync.passwords.core.ApiError
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.MemoryKeeper
import org.promptly.sync.passwords.core.MemoryStore
import org.promptly.sync.passwords.core.Passkeys
import org.promptly.sync.passwords.core.Primitives
import org.promptly.sync.passwords.core.SecretKeys
import org.promptly.sync.passwords.core.Totp
import org.promptly.sync.passwords.core.TotpConfig
import org.promptly.sync.passwords.core.VaultApi
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.WrongPasswordError
import org.promptly.sync.passwords.core.b64u
import org.promptly.sync.passwords.core.fromB64u
import org.promptly.sync.passwords.core.newBody
import org.promptly.sync.passwords.core.randomBytes
import org.promptly.sync.passwords.core.utf8
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.TimeUnit

private val BASE: String get() = System.getProperty("pw.stack") ?: ""
private const val MASTER = "correct horse battery staple 7!"

private const val SEED = """
import asyncio, json, os, secrets, uuid
import app.db_models
from app.auth.models import User
from app.auth.utils import create_access_token, hash_password
from app.auth.app_passwords import AppPassword, new_token, token_hash, hint
from app.database import SessionLocal

async def main():
    out = []
    async with SessionLocal() as db:
        for tag in os.environ["PW_USERS"].split(","):
            s = uuid.uuid4().hex[:10]
            u = User(email=f"pw-kt-{tag}-{s}@example.com", username=f"pwkt{tag}{s}", password_hash=hash_password("Kt-" + secrets.token_urlsafe(16) + "!9"), role="user")
            db.add(u)
            await db.flush()
            full, partial = new_token(), new_token()
            db.add(AppPassword(user_id=u.id, name="phone", token_hash=token_hash(full), hint=hint(full), scopes=["upload", "dav:read", "maps", "assistant"]))
            db.add(AppPassword(user_id=u.id, name="old phone", token_hash=token_hash(partial), hint=hint(partial), scopes=["upload", "dav:read"]))
            out.append({"tag": tag, "id": str(u.id), "username": u.username, "token": create_access_token(u.id, token_version=u.token_version), "app_full": full, "app_old": partial})
        await db.commit()
    print("PW_RESULT " + json.dumps(out))

asyncio.run(main())
"""

data class StackUser(val id: String, val username: String, val token: String, val appFull: String, val appOld: String)

private fun makeUser(tag: String): StackUser {
    val p = ProcessBuilder("docker", "exec", "-i", "-e", "PW_USERS=$tag", "PromptlyPw-Backend", "python", "-").redirectErrorStream(false).start()
    p.outputStream.use { it.write(SEED.toByteArray()) }
    val out = p.inputStream.bufferedReader().readText()
    p.waitFor(120, TimeUnit.SECONDS)
    val line = out.lineSequence().firstOrNull { it.startsWith("PW_RESULT ") } ?: error("No user made: $out")
    val o = Json.parseToJsonElement(line.removePrefix("PW_RESULT ")).jsonArray[0].jsonObject
    fun s(k: String) = o.getValue(k).jsonPrimitive.content
    return StackUser(s("id"), s("username"), s("token"), s("app_full"), s("app_old"))
}

/** Other suites share this stack and its rate limits: wait those out, the way a person would. */
private val patient: OkHttpClient = OkHttpClient.Builder().readTimeout(120, TimeUnit.SECONDS).addInterceptor(Interceptor { chain ->
    var res = chain.proceed(chain.request())
    var tries = 0
    while (res.code == 429 && tries++ < 8) {
        val s = res.header("Retry-After")?.toLongOrNull() ?: 30
        res.close()
        Thread.sleep((s + 1) * 1000)
        res = chain.proceed(chain.request())
    }
    res
}).build()

private fun device(u: StackUser, http: OkHttpClient? = null) = VaultClient(VaultApi(BASE, { u.token }, http ?: patient), MemoryStore(), MemoryKeeper())

private fun rewriting(block: (String, String) -> String?): OkHttpClient = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
    val res = chain.proceed(chain.request())
    val body = res.body.string()
    val out = block(chain.request().url.encodedPath, body) ?: body
    res.newBuilder().body(out.toResponseBody("application/json".toMediaType())).build()
}).build()

private class Switch {
    @Volatile var offline = false
    val client: OkHttpClient = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
        if (offline) throw IOException("the network is off")
        chain.proceed(chain.request())
    }).build()
}

class StackTests {
    init {
        Fixtures.setup()
    }

    private fun need() = assumeTrue("Pass -Dpw.stack=http://localhost:8092", BASE.isNotEmpty())

    @Test fun setupSyncSecondDeviceAndSecretsNotSearched() {
        need()
        val u = makeUser("sync")
        val a = device(u)
        val sk = a.setup(MASTER)
        val vault = a.personalVaultId()
        val item = a.saveNew(vault, newBody("login", "Example").withText("username", "ana").withText("password", "s3cret").withUrls(listOf(LoginUrl("https://example.com"))))
        assertEquals(1, a.sync().pushed)

        val b = device(u)
        b.unlock(MASTER, sk)
        assertEquals("s3cret", b.get(item.id)!!.body.password)
        assertEquals(listOf(item.id), b.search("exam").map { it.id })
        assertTrue(b.search("s3cret").isEmpty())
        assertEquals("Personal", b.vaults()[0].displayName)

        b.update(item.id, b.get(item.id)!!.body.withText("password", "changed"))
        b.sync()
        a.sync()
        assertEquals("changed", a.get(item.id)!!.body.password)
        assertEquals("s3cret", a.get(item.id)!!.body.passwordHistory[0].first)
        assertEquals("s3cret", a.versions(item.id)[0].body.password)
    }

    @Test fun refusesWrongPasswordAndWrongSecretKey() {
        need()
        val u = makeUser("wrong")
        val a = device(u)
        val sk = a.setup(MASTER)
        val c = device(u)
        assertThrows(WrongPasswordError::class.java) { c.unlock("not it", sk) }
        assertThrows(WrongPasswordError::class.java) { c.unlock(MASTER, randomBytes(16)) }
        assertFalse(c.unlocked)
    }

    @Test fun hostileKdfFromTheServerIsRefused() {
        need()
        val u = makeUser("kdf")
        val sk = device(u).setup(MASTER)
        val weak = rewriting { path, body ->
            if (path.endsWith("/account")) body.replace("\"m\":65536", "\"m\":1024") else null
        }
        val c = device(u, weak)
        assertThrows(IllegalArgumentException::class.java) { c.unlock(MASTER, sk) }
    }

    @Test fun offlineUnlockEditsAndTheQueueFlushesLater() {
        need()
        val u = makeUser("offline")
        val a = device(u)
        val sk = a.setup(MASTER)
        val vid = a.personalVaultId()
        val before = a.saveNew(vid, newBody("login", "Before outage").withText("password", "one"))
        a.sync()

        val sw = Switch()
        val phone = device(u, sw.client)
        phone.unlock(MASTER, sk)
        assertEquals("one", phone.get(before.id)!!.body.password)
        phone.lock()

        sw.offline = true
        assertTrue(phone.unlock(MASTER).offline)
        assertEquals("one", phone.get(before.id)!!.body.password)
        val added = phone.saveNew(vid, newBody("note", "Written offline").withText("notes", "hello"))
        phone.update(before.id, phone.get(before.id)!!.body.withText("password", "two"))
        phone.trashItem(added.id)
        phone.restoreItem(added.id)
        assertTrue(phone.sync().offline)
        assertThrows(WrongPasswordError::class.java) { phone.lock(); phone.unlock("not it") }
        phone.unlock(MASTER)

        sw.offline = false
        phone.reprove()
        val r = phone.sync()
        assertEquals(2, r.pushed)
        a.sync()
        assertEquals("hello", a.get(added.id)!!.body.notes)
        assertEquals("two", a.get(before.id)!!.body.password)
    }

    @Test fun rollbackIsRefusedAndWarned() {
        need()
        val u = makeUser("rollback")
        val a = device(u)
        val sk = a.setup(MASTER)
        val vid = a.personalVaultId()
        val item = a.saveNew(vid, newBody("login", "T").withText("password", "x"))
        a.sync()

        // A device that's seen the current revision, then a server showing an older one.
        val lower = java.util.concurrent.atomic.AtomicBoolean(false)
        val http = rewriting { path, body ->
            if (lower.get() && path.endsWith("/vaults")) {
                val arr = Json.parseToJsonElement(body).jsonArray
                JsonArray(arr.map { v -> JsonObject(v.jsonObject + ("revision" to JsonPrimitive(0))) }).toString()
            } else {
                null
            }
        }
        val phone = device(u, http)
        phone.unlock(MASTER, sk)
        val highWater = phone.store.getVaults().first().highWater
        assertTrue(highWater > 0)
        lower.set(true)
        val r = phone.sync()
        assertEquals(listOf(vid), r.rollback)
        assertEquals(listOf(vid), phone.rollbackWarnings.toList())
        assertEquals(highWater, phone.store.getVaults().first().highWater)
        assertEquals("x", phone.get(item.id)!!.body.password)
    }

    @Test fun threeWayMergeOnConflict() {
        need()
        val u = makeUser("merge")
        val a = device(u)
        val sk = a.setup(MASTER)
        val vid = a.personalVaultId()
        val item = a.saveNew(vid, newBody("login", "T").withText("password", "base").withText("notes", "n").withText("username", "u"))
        a.sync()
        val b = device(u)
        b.unlock(MASTER, sk)

        a.update(item.id, a.get(item.id)!!.body.withText("username", "from-a"))
        a.sync()
        b.update(item.id, b.get(item.id)!!.body.withText("notes", "from-b"))
        val r = b.sync()
        assertEquals(1, r.conflicts)
        val m = b.get(item.id)!!.body
        assertEquals("from-a", m.username)
        assertEquals("from-b", m.notes)
        assertTrue(m.conflicts.isEmpty())
        a.sync()
        assertEquals("from-b", a.get(item.id)!!.body.notes)

        // Both change the same field: nothing is lost.
        a.update(item.id, a.get(item.id)!!.body.withText("password", "pa"))
        a.sync()
        b.update(item.id, b.get(item.id)!!.body.withText("password", "pb"))
        b.sync()
        a.sync()
        val both = a.get(item.id)!!.body
        assertEquals("pa", both.password)
        assertEquals("pb", (both.conflicts.single()["body"] as JsonObject).let { (it["password"] as JsonPrimitive).content })
    }

    @Test fun trashPurgeAndTombstones() {
        need()
        val u = makeUser("trash")
        val a = device(u)
        val sk = a.setup(MASTER)
        val vid = a.personalVaultId()
        val i1 = a.saveNew(vid, newBody("note", "Bin me"))
        val i2 = a.saveNew(vid, newBody("note", "Delete me"))
        a.sync()
        a.trashItem(i1.id)
        a.trashItem(i2.id)
        a.sync()
        assertEquals(setOf(i1.id, i2.id), a.trash().map { it.id }.toSet())
        a.purgeItem(i2.id)
        a.sync()
        val b = device(u)
        b.unlock(MASTER, sk)
        assertTrue(b.get(i1.id)!!.deleted)
        assertNull(b.get(i2.id))
        b.restoreItem(i1.id)
        b.sync()
        a.sync()
        assertFalse(a.get(i1.id)!!.deleted)
    }

    @Test fun changePasswordKeepsTheVault() {
        need()
        val u = makeUser("rekey")
        val a = device(u)
        val sk = a.setup(MASTER)
        val item = a.saveNew(a.personalVaultId(), newBody("login", "T").withText("password", "x"))
        a.sync()
        a.changePassword(MASTER, "a new master password 8!")
        val b = device(u)
        assertThrows(WrongPasswordError::class.java) { b.unlock(MASTER, sk) }
        b.unlock("a new master password 8!", sk)
        assertEquals("x", b.get(item.id)!!.body.password)
    }

    @Test fun deviceApprovalWithSafetyWords() {
        need()
        val u = makeUser("join")
        val old = device(u)
        val sk = old.setup(MASTER)
        val fresh = device(u)
        val join = fresh.requestDevice("New phone")
        assertNull(join.words)
        val req = old.api.deviceRequests().first { it.id == join.id }
        val approval = old.beginApproval(req.id, req.devicePub)
        // The new device shows the same words before anything's approved.
        val s1 = join.poll()
        assertEquals("pending", s1.status)
        assertEquals(approval.words, s1.words)
        assertEquals(5, approval.words.size)
        old.finishApproval(approval)
        val s2 = join.poll()
        assertEquals("approved", s2.status)
        assertEquals(SecretKeys.encode(sk), SecretKeys.encode(s2.secretKey!!))
        assertTrue(fresh.keeper.has())
        fresh.unlock(MASTER)
        assertTrue(fresh.unlocked)
    }

    @Test fun deviceTokensAndTheAppPasswordScope() {
        need()
        val u = makeUser("token")
        val anon = VaultApi(BASE, { null })
        // The app password every phone paired since the assistant holds: it works.
        val t = anon.registerDevice(VaultApi.basic(u.username, u.appFull), "Pixel Test")
        assertTrue(t.token.startsWith("pwd_"))
        val viaDevice = VaultClient(VaultApi(BASE, { t.token }), MemoryStore(), MemoryKeeper())
        viaDevice.setup(MASTER)
        assertTrue(viaDevice.api.devices().any { it.id == t.deviceId && it.current })
        // An older app password, without "assistant", is told no: the app uses the browser.
        val e = assertThrows(ApiError::class.java) { anon.registerDevice(VaultApi.basic(u.username, u.appOld), "Old phone") }
        assertEquals(403, e.status)
        // The connect flow itself.
        val started = anon.connectStart("Phone via browser")
        assertEquals("pending", anon.connectPoll(started.id, started.pollSecret).status)
    }

    @Test fun lockForgetsTheKeys() {
        need()
        val u = makeUser("lock")
        val a = device(u)
        a.setup(MASTER)
        val item = a.saveNew(a.personalVaultId(), newBody("note", "T"))
        a.lock()
        assertFalse(a.unlocked)
        assertNull(a.get(item.id))
        assertThrows(IllegalStateException::class.java) { a.allItems() }
        assertEquals(null, a.api.session)
    }

    // ---- Cross-device: the real TypeScript client on the same server ----

    private fun runTs(step: String, file: File) {
        val frontend = Fixtures.frontend
        val config = File(frontend.parentFile, "android/app/src/test/cross/vitest.config.mts").absolutePath
        val cmd = if (System.getProperty("os.name").lowercase().contains("win")) {
            listOf("cmd", "/c", "npx", "vitest", "run", "--config", config, "--reporter=dot")
        } else {
            listOf("npx", "vitest", "run", "--config", config, "--reporter=dot")
        }
        val pb = ProcessBuilder(cmd).directory(frontend).redirectErrorStream(true)
        pb.environment()["PW_STACK_URL"] = BASE
        pb.environment()["PW_CROSS_FILE"] = file.absolutePath
        pb.environment()["PW_CROSS_STEP"] = step
        val p = pb.start()
        val out = p.inputStream.bufferedReader().readText()
        assertTrue("TS step $step timed out", p.waitFor(240, TimeUnit.SECONDS))
        assertEquals("TS step $step failed:\n$out", 0, p.exitValue())
    }

    /** OkHttp's list needs Robolectric to load, as CoreTest does. These hosts don't need it. */
    private val realBaseDomains = org.promptly.sync.passwords.core.Match.baseDomainOf
    private fun useSimpleBaseDomains() {
        org.promptly.sync.passwords.core.Match.baseDomainOf = { host -> host.split('.').takeLast(2).joinToString(".") }
    }
    @org.junit.After fun restoreBaseDomains() {
        org.promptly.sync.passwords.core.Match.baseDomainOf = realBaseDomains
    }

    private fun readState(f: File) = Json.parseToJsonElement(f.readText()).jsonObject
    private fun writeState(f: File, o: JsonObject) = f.writeText(o.toString())

    @Test fun crossDeviceWithTheTypeScriptClient() {
        need()
        val u = makeUser("cross")
        val dir = Files.createTempDirectory("pwcross").toFile()
        val file = File(dir, "state.json")
        try {
            writeState(file, buildJsonObject { put("token", u.token) })
            runTs("A", file)
            var st = readState(file)
            val sk = fromB64u(st.getValue("secretKey").jsonPrimitive.content)
            val ids = st.getValue("ids").jsonObject.mapValues { it.value.jsonPrimitive.content }
            val saved = st.getValue("saved").jsonObject

            // Everything TS wrote reads here, field for field, every kind.
            val phone = device(u)
            phone.unlock(MASTER, sk)
            assertEquals(11, ids.size)
            for ((kind, id) in ids) {
                val got = phone.get(id) ?: throw AssertionError("No $kind item on Android")
                assertEquals(kind, got.body.kind)
                assertEquals(kind, saved.getValue(kind), JsonObject(got.body.fields))
            }
            val login = phone.get(ids.getValue("login"))!!
            assertEquals("ts-Pässword-🔑", login.body.password)
            assertEquals(2, login.body.urls.size)
            assertEquals("host", login.body.urls[1].match)
            assertEquals(listOf("work", "tag two"), login.body.tags)
            assertEquals("1234", login.body.customFields.single().value)
            val at = st.getValue("totpAt").jsonObject
            assertEquals(at.getValue("code").jsonPrimitive.content, Totp.code(TotpConfig("JBSWY3DPEHPK3PXP", "SHA1", 6, 30), at.getValue("time").jsonPrimitive.content.toLong()))
            assertEquals(listOf(ids.getValue("login")), phone.search("TS login").map { it.id })

            // A passkey made by the web client signs here, and verifies with its public key.
            val tsKey = phone.get(ids.getValue("passkey"))!!.body.passkeys.single()
            val tsAssertion = Passkeys.getAssertion(tsKey, b64u(utf8("kt")), "https://cross.example", true)
            val spki = fromB64u(st.getValue("tsPublicKey").jsonPrimitive.content)
            val verifier = java.security.Signature.getInstance("SHA256withECDSA")
            verifier.initVerify(java.security.KeyFactory.getInstance("EC").generatePublic(java.security.spec.X509EncodedKeySpec(spki)))
            verifier.update(fromB64u(tsAssertion.authenticatorData))
            verifier.update(Primitives.sha256(fromB64u(tsAssertion.clientDataJSON)))
            assertTrue(verifier.verify(fromB64u(tsAssertion.signature)))

            // Android's turn: an edit that must keep TS's unknown field, and one of each kind.
            phone.update(login.id, login.body.withText("password", "android-new-password"))
            val vault = phone.personalVaultId()
            val made = Passkeys.makeCredential("android.example", "Android", b64u(utf8("kt-user")), "kt@android.example", "KT", b64u(utf8("reg")), "https://android.example", true, true)
            val bodies = linkedMapOf(
                "login" to newBody("login", "Android login", "androidFuture" to Json.parseToJsonElement("""{"k":[true,null]}""")).withText("username", "kt").withText("password", "kt-Pässword-🔑").withUrls(listOf(LoginUrl("https://android.example"), org.promptly.sync.passwords.core.Match.appUrl("com.android.example", "CERT"))).withTotp(TotpConfig("JBSWY3DPEHPK3PXP", issuer = "KT")),
                "note" to newBody("note", "Android note").withText("notes", "text"),
                "card" to newBody("card", "Android card").withText("cardNumber", "4242").withText("cardCvv", "999").withText("cardExpMonth", "01").withText("cardExpYear", "2030"),
                "identity" to newBody("identity", "Android identity").withText("firstName", "Bo").withText("city", "Perth"),
                "totp" to newBody("totp", "Android 2FA").withTotp(TotpConfig("GEZDGNBVGY3TQOJQ")),
                "passkey" to newBody("passkey", "Android").withText("username", "kt@android.example").withUrls(listOf(LoginUrl("https://android.example"))).withPasskeys(listOf(made.passkey)),
                "apikey" to newBody("apikey", "Android key").withText("apiKey", "k"),
                "wifi" to newBody("wifi", "Android wifi").withText("ssid", "Net").withText("wifiPassword", "p"),
                "ssh" to newBody("ssh", "Android ssh").withText("sshPublic", "pub"),
                "bank" to newBody("bank", "Android bank").withText("iban", "AU"),
                "document" to newBody("document", "Android document").withText("documentNumber", "D1"),
            )
            val androidIds = LinkedHashMap<String, String>()
            val androidSaved = LinkedHashMap<String, JsonElement>()
            for ((k, b) in bodies) {
                val item = phone.saveNew(vault, b)
                androidIds[k] = item.id
                androidSaved[k] = JsonObject(item.body.fields)
            }
            val assertion = Passkeys.getAssertion(made.passkey, b64u(utf8("chal")), "https://android.example", true)
            val trashed = phone.saveNew(vault, newBody("note", "Android trashed"))
            val purged = phone.saveNew(vault, newBody("note", "Android purged"))
            phone.sync()
            phone.trashItem(trashed.id)
            phone.purgeItem(purged.id)
            // Two items for the merges. One edited here offline, changing a different field.
            val clean = phone.saveNew(vault, newBody("login", "Clean merge").withText("username", "ts-user-1").withText("notes", "start"))
            phone.sync()

            st = readState(file)
            writeState(file, JsonObject(st + mapOf(
                "androidIds" to JsonObject(androidIds.mapValues { JsonPrimitive(it.value) }),
                "androidSaved" to JsonObject(androidSaved),
                "androidPublicKey" to JsonPrimitive(made.publicKey),
                "androidAssertion" to buildJsonObject {
                    put("authenticatorData", assertion.authenticatorData)
                    put("clientDataJSON", assertion.clientDataJSON)
                    put("signature", assertion.signature)
                },
                "androidTrashed" to JsonPrimitive(trashed.id),
                "androidPurged" to JsonPrimitive(purged.id),
                "cleanMergeId" to JsonPrimitive(clean.id),
            )))

            // Android's change to the shared item, not sent yet: "offline" until TS has changed it.
            val conflictId = st.getValue("conflictId").jsonPrimitive.content
            phone.update(conflictId, phone.get(conflictId)!!.body.withText("password", "android-password").withText("notes", "android-note"))
            runTs("B", file)

            // TS changes the other merge item's username while Android holds a note edit.
            val ts2 = device(u)
            ts2.unlock(MASTER, sk)
            ts2.update(clean.id, ts2.get(clean.id)!!.body.withText("username", "ts-user-2"))
            ts2.sync()
            phone.update(clean.id, phone.get(clean.id)!!.body.withText("notes", "android-only"))
            val r = phone.sync()
            assertEquals(2, r.conflicts)
            runTs("C", file)
        } finally {
            dir.deleteRecursively()
        }
    }

    // ---- The features added after the first pass ----

    private fun setupRetrying(c: VaultClient): ByteArray {
        while (true) {
            try {
                return c.setup(MASTER)
            } catch (e: ApiError) {
                if (e.status != 429) throw e
                Thread.sleep(((e.retryAfter ?: 30) + 1) * 1000L)
            }
        }
    }

    private fun tmpState(): File = File(Files.createTempDirectory("pwcross").toFile(), "state.json")

    private fun withState(block: (File) -> Unit) {
        val f = tmpState()
        try {
            block(f)
        } finally {
            f.parentFile!!.deleteRecursively()
        }
    }

    private fun patternBytes(n: Int, seed: Int): ByteArray {
        var v = seed
        return ByteArray(n) {
            v = (v * 31 + 7) and 255
            v.toByte()
        }
    }

    private fun shaHex(b: ByteArray) = org.promptly.sync.passwords.core.hex(Primitives.sha256(b))

    private fun downloadAll(c: VaultClient, vault: String, item: String, ref: org.promptly.sync.passwords.core.AttachmentRef): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        org.promptly.sync.passwords.core.Attachments.download(c.api, vault, item, ref, { out.write(it) })
        return out.toByteArray()
    }

    @Test fun attachmentsCrossWithTheTypeScriptClient() {
        need()
        val u = makeUser("att")
        withState { file ->
            writeState(file, buildJsonObject { put("token", u.token) })
            runTs("att1", file)
            val st = readState(file)
            fun s(k: String) = st.getValue(k).jsonPrimitive.content
            val phone = device(u)
            phone.unlock(MASTER, fromB64u(s("secretKey")))
            val itemId = s("itemId")
            val vault = s("vault")
            val item = phone.get(itemId)!!
            val big = item.body.attachments.first { it.name == "big.bin" }
            val small = item.body.attachments.first { it.name == "small.txt" }
            assertEquals(3, big.chunks)
            assertEquals(2_500_000L, big.size)
            assertEquals(s("bigSha"), shaHex(downloadAll(phone, vault, itemId, big)))
            assertEquals(s("smallSha"), shaHex(downloadAll(phone, vault, itemId, small)))
            // What the list says about a file survives a trip through JSON.
            assertEquals(big, org.promptly.sync.passwords.core.AttachmentRef.from(big.toJson()))
            // A wrong place for a chunk doesn't open: its index is in the additional data.
            val wrong = big.copy(id = small.id)
            assertThrows(Exception::class.java) { downloadAll(phone, vault, itemId, wrong) }

            val mine = patternBytes(1_200_000, 33)
            phone.addAttachment(itemId, "from-android.bin", "application/x-test", mine.size.toLong(), { off, len -> mine.copyOfRange(off.toInt(), off.toInt() + len) })
            phone.removeAttachment(itemId, small)
            assertEquals(setOf("big.bin", "from-android.bin"), phone.get(itemId)!!.body.attachments.map { it.name }.toSet())
            writeState(file, JsonObject(st + mapOf(
                "androidSha" to JsonPrimitive(shaHex(mine)),
                "androidSize" to JsonPrimitive(mine.size),
                "deletedId" to JsonPrimitive(small.id),
            )))
            runTs("att2", file)
        }
    }

    @Test fun attachmentResumesAndEmptyFileWorks() {
        need()
        val u = makeUser("att2")
        val c = device(u)
        setupRetrying(c)
        val vault = c.personalVaultId()
        val item = c.saveNew(vault, newBody("note", "T"))
        c.sync()
        val data = patternBytes(2_200_000, 5)
        val id = org.promptly.sync.passwords.core.randomUuid()
        val key = b64u(randomBytes(32))
        // A first try that dies after one chunk...
        assertThrows(IOException::class.java) {
            org.promptly.sync.passwords.core.Attachments.upload(c.api, vault, item.id, "r.bin", null, data.size.toLong(), { off, len ->
                if (off > 0) throw IOException("the network went")
                data.copyOfRange(off.toInt(), off.toInt() + len)
            }, resume = id to key)
        }
        // ...and a second that only asks for what the server hasn't got.
        val asked = ArrayList<Long>()
        val ref = org.promptly.sync.passwords.core.Attachments.upload(c.api, vault, item.id, "r.bin", null, data.size.toLong(), { off, len ->
            asked += off
            data.copyOfRange(off.toInt(), off.toInt() + len)
        }, resume = id to key)
        assertEquals(listOf(1048576L, 2097152L), asked)
        assertEquals(shaHex(data), shaHex(downloadAll(c, vault, item.id, ref)))
        val empty = org.promptly.sync.passwords.core.Attachments.upload(c.api, vault, item.id, "empty", null, 0, { _, _ -> ByteArray(0) })
        assertEquals(1, empty.chunks)
        assertEquals(0, downloadAll(c, vault, item.id, empty).size)
    }

    /** The real client: an upload that dies partway picks up, by name and size, from what the server
     *  has, under the same id and key, and that key's not in the local copy in the clear. */
    @Test fun anInterruptedAttachmentPicksUpWhereItStopped() {
        need()
        val u = makeUser("res")
        val store = MemoryStore()
        val c = VaultClient(VaultApi(BASE, { u.token }, patient), store, MemoryKeeper())
        setupRetrying(c)
        val vault = c.personalVaultId()
        val item = c.saveNew(vault, newBody("note", "T"))
        c.sync()
        val data = patternBytes(2_200_000, 9)
        assertThrows(IOException::class.java) {
            c.addAttachment(item.id, "r.bin", null, data.size.toLong(), { off, len ->
                if (off > 0) throw IOException("the network went")
                data.copyOfRange(off.toInt(), off.toInt() + len)
            })
        }
        val meta = "upload_resume:${item.id}:r.bin:${data.size}"
        assertTrue("Nothing was recorded on the item", c.get(item.id)!!.body.attachments.isEmpty())
        val sealed = store.getMeta(meta)!!.jsonPrimitive.content
        assertFalse("A sealed blob, no id or key to read", sealed.contains("\"key\""))
        val asked = ArrayList<Long>()
        val done = c.addAttachment(item.id, "r.bin", null, data.size.toLong(), { off, len ->
            asked += off
            data.copyOfRange(off.toInt(), off.toInt() + len)
        })
        assertEquals("Only what the server hadn't got", listOf(1048576L, 2097152L), asked)
        assertEquals(shaHex(data), shaHex(downloadAll(c, vault, item.id, done.body.attachments.single())))
        assertNull("Nothing's left waiting", store.getMeta(meta))
        // The same file again isn't a resume of that one: it's a new upload, of every chunk.
        asked.clear()
        c.addAttachment(item.id, "r.bin", null, data.size.toLong(), { off, len ->
            asked += off
            data.copyOfRange(off.toInt(), off.toInt() + len)
        })
        assertEquals(listOf(0L, 1048576L, 2097152L), asked)
        assertEquals(2, c.get(item.id)!!.body.attachments.map { it.id }.toSet().size)
        // A different size is a different file.
        val other = patternBytes(1_500_000, 10)
        assertThrows(IOException::class.java) { c.addAttachment(item.id, "r.bin", null, other.size.toLong(), { _, _ -> throw IOException("no") }) }
        assertNotNull(store.getMeta("upload_resume:${item.id}:r.bin:${other.size}"))
    }

    /** Everything else the features write, read back by the real TypeScript client: it has to be
     *  the shapes the web vault uses. Merging, with an attachment that has to keep opening. */
    @Test fun whatTheFinishingFeaturesWriteCrossesWithTheTypeScriptClient() {
        need()
        useSimpleBaseDomains()
        val u = makeUser("fin")
        val c = device(u)
        val secret = setupRetrying(c)
        val vault = c.personalVaultId()
        // Folders: one renamed, one deleted with an item in it.
        val kept = c.saveNew(vault, newBody("folder", "Before"))
        val gone = c.saveNew(vault, newBody("folder", "To delete"))
        val inside = c.saveNew(vault, newBody("login", "In a folder").with("folderId" to JsonPrimitive(gone.id), "tags" to JsonArray(listOf(JsonPrimitive("work")))))
        val staying = c.saveNew(vault, newBody("login", "Stays in").with("folderId" to JsonPrimitive(kept.id)))
        c.renameFolder(kept.id, "  After  ")
        c.deleteFolder(gone.id)
        c.sync()
        assertEquals("After", c.get(kept.id)!!.body.title)
        assertEquals(JsonNull, c.get(inside.id)!!.body["folderId"])
        assertTrue(c.get(gone.id)!!.deleted)
        assertThrows(IllegalStateException::class.java) { c.renameFolder(inside.id, "not a folder") }
        assertThrows(IllegalArgumentException::class.java) { c.renameFolder(kept.id, "   ") }
        // Site icons for this vault.
        assertFalse(vault in c.iconVaults())
        c.setVaultIcons(vault, true)
        c.setVaultIcons(vault, false)
        c.setVaultIcons(vault, true)
        assertTrue(vault in c.iconVaults())
        assertEquals("One row, turned on and off", 1, c.allItems(includeSystem = true).count { it.body.kind == "prefs" && it.body.title == "vault-prefs" })
        // A Send, remembered in the vault.
        val send = org.promptly.sync.passwords.core.SecureSend.create(c.api, org.promptly.sync.passwords.core.SecureSend.textPayload("Named", "pw-Send-1!"), 1, null, null)
        c.recordSend("Named", send.link, send.id)
        assertEquals("Named", c.sendRecords().getValue(send.id).title)
        // Duplicates, the older with an attachment and another password.
        val older = c.saveNew(vault, newBody("login", "Dup").withText("username", "Ana").withText("password", "pw-older").withUrls(listOf(LoginUrl("https://dup.example"))))
        val data = patternBytes(1_300_000, 12)
        c.sync()
        c.addAttachment(older.id, "moved.bin", "application/x-test", data.size.toLong(), { off, len -> data.copyOfRange(off.toInt(), off.toInt() + len) })
        Thread.sleep(5)
        val newer = c.saveNew(vault, newBody("login", "Dup").withText("username", "ana").withText("password", "pw-newer").withUrls(listOf(LoginUrl("https://dup.example"))))
        c.sync()
        val groups = c.duplicates()
        assertEquals(1, groups.size)
        c.mergeDuplicates(groups.single())
        val merged = c.get(newer.id)!!
        assertEquals("pw-newer", merged.body.password)
        assertEquals("pw-older", merged.body.passwordHistory.single().first)
        assertTrue(c.get(older.id)!!.deleted)
        val moved = merged.body.attachments.single()
        assertEquals("moved.bin", moved.name)
        assertEquals(shaHex(data), shaHex(downloadAll(c, vault, newer.id, moved)))
        assertTrue(c.duplicates().isEmpty())
        c.sync()
        // And the other side reads it all.
        withState { file ->
            writeState(file, buildJsonObject {
                put("token", u.token)
                put("secretKey", b64u(secret))
                put("vault", vault)
                put("keptFolder", kept.id)
                put("goneFolder", gone.id)
                put("inside", inside.id)
                put("staying", staying.id)
                put("sendId", send.id)
                put("sendLink", send.link)
                put("older", older.id)
                put("newer", newer.id)
                put("movedSha", shaHex(data))
            })
            runTs("fin", file)
        }
    }

    @Test fun postingASendAskingTheDirectoriesAndSurvivalOnTheRealServer() {
        need()
        val a = makeUser("snA")
        val b = makeUser("snB")
        val c = device(a)
        setupRetrying(c)
        val send = org.promptly.sync.passwords.core.SecureSend.create(c.api, org.promptly.sync.passwords.core.SecureSend.textPayload("T", "pw-Send-2!"), 1, 2, null)
        assertTrue(send.link, org.promptly.sync.passwords.core.SendRecords.isLinkTo(send.id, send.link, c.api.baseUrl))
        c.api.sendViaRooms(send.id, send.link, b.id)
        // Nobody on the server can be handed plain text: what it's sent has to be this Send's link.
        for (bad in listOf("the wifi is pw-Send-2!", send.link.substringBefore('#'), send.link.replace(send.id, org.promptly.sync.passwords.core.randomUuid()))) {
            val e = assertThrows(ApiError::class.java) { c.api.sendViaRooms(send.id, bad, b.id) }
            assertEquals(bad, 400, e.status)
        }
        // No Mail account here: it says so, and the link can still be copied.
        val noMail = assertThrows(ApiError::class.java) { c.api.sendViaMail(send.id, send.link, "someone@example.com") }
        assertEquals(409, noMail.status)
        // The record goes with the Send.
        c.recordSend("T", send.link, send.id)
        c.deleteSend(send.id)
        assertTrue(c.api.sends().none { it.id == send.id })
        assertTrue(c.sendRecords().isEmpty())

        val survival = c.api.survival()!!
        assertFalse("Made by setup alone, no kit's been confirmed", survival.kitConfirmed)
        c.api.confirmKit()
        val after = c.api.survival()!!
        assertTrue(after.kitConfirmed)
        assertNotNull(org.promptly.sync.passwords.core.parseInstant(after.kitConfirmedAt))
        assertFalse(org.promptly.sync.passwords.core.Survival.recoveryDue(after.kitConfirmedAt, null))

        // What's in them comes from outside the stack, so only their shape's checked.
        val dir = c.api.directory()
        assertTrue(dir.twofa.keys.all { it.isNotEmpty() } && dir.passkeys.all { it.isNotEmpty() })
        // The icon proxy: the server refuses a name that isn't one, and this client doesn't ask.
        assertEquals(400, assertThrows(ApiError::class.java) { c.api.icon("not-a-domain") }.status)
        assertNull(c.api.icon("no-such-host.promptly.test"))
        assertEquals(null, org.promptly.sync.passwords.core.SiteIcons.domainOf("http://not-a-domain/"))
    }

    @Test fun sharingCrossWithTheTypeScriptClient() {
        need()
        val alice = makeUser("shalice")
        val bob = makeUser("shbob")
        val phone = device(bob)
        setupRetrying(phone)
        withState { file ->
            writeState(file, buildJsonObject {
                put("alice", alice.token)
                put("bobId", bob.id)
            })
            runTs("sh1", file)
            val st = readState(file)
            val tsVault = st.getValue("tsVault").jsonPrimitive.content
            phone.sync()
            // Invited: not trusted yet, so no name, and nothing's come down.
            val invited = phone.vaults().first { it.vault.id == tsVault }
            assertFalse(invited.vault.accepted)
            assertEquals("(can't open)", invited.displayName)
            assertEquals("edit", invited.vault.role)
            assertTrue(phone.allItems().none { it.vaultId == tsVault })
            assertTrue(phone.trustEntries().isEmpty())
            phone.acceptVault(tsVault)
            assertEquals("TS shared", phone.vaults().first { it.vault.id == tsVault }.displayName)
            val shared = phone.allItems().first { it.vaultId == tsVault }
            assertEquals("shared-Pass-1!", shared.body.password)
            assertTrue(phone.canReveal(tsVault))
            assertTrue(phone.canEdit(tsVault))
            // Pinned by accepting, and the safety words agree with what the web client shows.
            val aliceId = st.getValue("aliceId").jsonPrimitive.content
            assertEquals(st.getValue("aliceWords").jsonArray.map { it.jsonPrimitive.content }, phone.identityWordsFor(aliceId))
            assertTrue(aliceId in phone.trustEntries())

            phone.update(shared.id, shared.body.withText("password", "edited-by-android"))
            phone.saveNew(tsVault, newBody("login", "Added by Android").withText("username", "kt").withText("password", "kt-Added-1!"))
            phone.sync()

            val ktVault = phone.createSharedVault("KT shared")
            phone.saveNew(ktVault, newBody("login", "KT login").withText("password", "kt-Vault-1!"))
            phone.sync()
            phone.addMember(ktVault, aliceId, "fill")
            writeState(file, JsonObject(st + ("ktVault" to JsonPrimitive(ktVault))))
            runTs("sh2", file)

            // Removed, and the local copy and keys went with it.
            val after = readState(file)
            assertEquals(after.getValue("bobWordsSeenByAlice").jsonArray.map { it.jsonPrimitive.content }, phone.myIdentityWords())
            phone.sync()
            assertTrue(phone.vaults().none { it.vault.id == tsVault })
            assertTrue(phone.allItems().none { it.vaultId == tsVault })

            // Android removes Alice from its own vault: rotation, and its list.
            val toChange = phone.removeMembers(ktVault, listOf(aliceId))
            assertEquals(listOf("KT login"), toChange.map { it.body.title })
            assertEquals("kt-Vault-1!", phone.allItems().first { it.vaultId == ktVault }.body.password)
            assertEquals(2, phone.store.getVaults().first { it.id == ktVault }.generation)
            runTs("sh3", file)
        }
    }

    @Test fun matchVectorsPassInTheWebClientToo() {
        // The list itself is checked against Match.kt in ReviewFixesTest.
        withState { file ->
            writeState(file, buildJsonObject { })
            runTs("match", file)
        }
    }

    @Test fun theTrustBookAndSeqCrossWithTheTypeScriptClient() {
        need()
        val alice = makeUser("bka")
        val bob = makeUser("bkb")
        val carol = makeUser("bkc")
        val dan = makeUser("bkd")
        withState { file ->
            writeState(file, buildJsonObject {
                put("alice", alice.token)
                put("bob", bob.token)
                put("carol", carol.token)
                put("bobId", bob.id)
            })
            runTs("bk1", file)
            val st = readState(file)
            fun s(k: String) = st.getValue(k).jsonPrimitive.content
            // Android, as Alice's second device: what she decided on the web came with it.
            val phone = device(alice)
            phone.unlock(MASTER, fromB64u(s("aliceKey")))
            val trust = phone.trustEntries()
            assertEquals(true, trust[bob.id]?.verified)
            assertTrue(trust.containsKey(s("carolId")))
            assertEquals("From Carol", phone.vaults().first { it.vault.id == s("fromCarol") }.displayName)
            assertTrue(phone.chosen(phone.store.getVaults().first { it.id == s("fromCarol") }))
            assertTrue(phone.keyChanges.isEmpty())
            assertEquals(2L, phone.get(s("seqItem"))!!.body.seq)
            // And the other way: Android's choices, and an edit past the web's seq.
            val danDevice = device(dan)
            setupRetrying(danDevice)
            val ktVault = phone.createSharedVault("KT team")
            phone.addMember(ktVault, dan.id, "view")
            val edited = phone.update(s("seqItem"), phone.get(s("seqItem"))!!.body.withText("password", "seq-android"))
            assertEquals(3L, edited.body.seq)
            phone.sync()
            writeState(file, JsonObject(st + mapOf(
                "danId" to JsonPrimitive(dan.id),
                "danEd" to JsonPrimitive(phone.trustEntries().getValue(dan.id).ed25519),
                "ktVault" to JsonPrimitive(ktVault),
                "androidSeq" to JsonPrimitive(edited.body.seq),
            )))
            runTs("bk2", file)
            // The web's edit comes back past this one, without being taken for a rollback.
            val before = phone.rollbackWarnings.size
            phone.sync()
            assertEquals(before, phone.rollbackWarnings.size)
            assertEquals(4L, phone.get(s("seqItem"))!!.body.seq)
            assertEquals("from ts", phone.get(s("seqItem"))!!.body.notes)
        }
    }

    @Test fun threePeopleRotationKeepsTheOneWhoStays() {
        need()
        val aUser = makeUser("rotaa")
        val bUser = makeUser("rotab")
        val cUser = makeUser("rotac")
        val owner = device(aUser)
        val stays = device(bUser)
        val goes = device(cUser)
        setupRetrying(owner)
        val staysKey = setupRetrying(stays)
        setupRetrying(goes)
        val v = owner.createSharedVault("Three")
        val item = owner.saveNew(v, newBody("login", "L").withText("password", "one"))
        owner.sync()
        owner.update(item.id, owner.get(item.id)!!.body.withText("password", "two"))
        owner.sync()
        owner.addMember(v, bUser.id, "view")
        owner.addMember(v, cUser.id, "edit")
        stays.acceptVault(v)
        goes.acceptVault(v)
        assertEquals("two", stays.get(item.id)!!.body.password)
        assertFalse("view can't write", stays.canEdit(v))
        assertTrue(stays.canReveal(v))
        // Roles change on the server and reach the member.
        owner.api.setRole(v, bUser.id, "fill")
        stays.sync()
        assertFalse(stays.canReveal(v))
        assertTrue(stays.exportable().none { it.vaultId == v })
        owner.api.setRole(v, bUser.id, "view")
        stays.sync()

        val change = owner.removeMembers(v, listOf(cUser.id))
        assertEquals(listOf("L"), change.map { it.body.title })
        stays.sync()
        goes.sync()
        assertEquals("two", stays.get(item.id)!!.body.password)
        assertEquals("one", stays.versions(item.id).last().body.password)
        assertTrue(goes.vaults().none { it.vault.id == v })
        assertNull(goes.get(item.id))
        // A second device of the one who stays: the rotated vault opens from scratch.
        val again = device(bUser)
        again.unlock(MASTER, staysKey)
        assertEquals("two", again.get(item.id)!!.body.password)
        // Leaving and declining.
        val invited = owner.createSharedVault("Declined")
        owner.addMember(invited, bUser.id, "view")
        stays.sync()
        assertTrue(stays.vaults().any { it.vault.id == invited })
        stays.leaveVault(invited)
        assertTrue(stays.vaults().none { it.vault.id == invited })
        stays.leaveVault(v)
        assertTrue(stays.vaults().none { it.vault.id == v })
        // The list is capped at 500 and this stack holds more throwaway users than that, so
        // only say what's true of any list: you aren't offered yourself.
        assertTrue(owner.api.people().none { it.username == aUser.username })
    }

    @Test fun aChangedKeyShutsOnlyThatVault() {
        need()
        val aUser = makeUser("chg1")
        val bUser = makeUser("chg2")
        val owner = device(aUser)
        val member = device(bUser)
        setupRetrying(owner)
        val key = setupRetrying(member)
        val mine = member.saveNew(member.personalVaultId(), newBody("login", "Still mine").withText("password", "mine"))
        member.sync()
        val v = owner.createSharedVault("Theirs")
        val shared = owner.saveNew(v, newBody("login", "Theirs").withText("password", "theirs"))
        owner.sync()
        owner.addMember(v, bUser.id, "view")
        member.acceptVault(v)
        assertEquals("theirs", member.get(shared.id)!!.body.password)

        // The server starts saying the owner's keys are different.
        val swap = java.util.concurrent.atomic.AtomicBoolean(true)
        val hostile = rewriting { path, body ->
            if (swap.get() && path.contains("/users/") && path.endsWith("/keys")) {
                val o = Json.parseToJsonElement(body).jsonObject
                JsonObject(o + ("ed25519_pub" to JsonPrimitive(b64u(randomBytes(32))))).toString()
            } else {
                null
            }
        }
        val phone = VaultClient(VaultApi(BASE, { bUser.token }, hostile), member.store, member.keeper)
        phone.unlock(MASTER, key)
        // Not locked out. Their own vault opens; that one stays shut, and says who.
        assertTrue(phone.unlocked)
        assertEquals("mine", phone.get(mine.id)!!.body.password)
        assertNull(phone.get(shared.id))
        assertEquals(aUser.id, phone.keyChanges[v]!!.userId)
        // A sync doesn't throw, or lose the good vault.
        assertFalse(phone.sync().offline)
        assertEquals("mine", phone.get(mine.id)!!.body.password)
        assertNull(phone.get(shared.id))
        assertTrue(v in phone.keyChanges)
        // Inviting that person refuses too.
        assertThrows(org.promptly.sync.passwords.core.KeyChangedError::class.java) { phone.addMember(phone.createSharedVault("New"), aUser.id, "view") }
        // Once the server's honest again and the person's looked, it opens.
        swap.set(false)
        phone.acceptChangedKey(aUser.id)
        assertTrue(phone.keyChanges.isEmpty())
        assertEquals("theirs", phone.get(shared.id)!!.body.password)
    }

    @Test fun exportImportSendAndHealthCrossWithTheTypeScriptClient() {
        need()
        val u = makeUser("tx")
        val fixtures = mapOf(
            "Chrome Passwords.csv" to "name,url,username,password,note\nGitHub,https://github.com/login,ana,pw1,hello\n,https://www.x.org,bo,pw2,\n",
            "logins.csv" to "\"url\",\"username\",\"password\",\"httpRealm\",\"formActionOrigin\",\"guid\",\"timeCreated\",\"timeLastUsed\",\"timePasswordChanged\"\n\"https://f.example\",\"u\",\"p\",,\"https://f.example\",\"{abc}\",\"1\",\"2\",\"3\"\n",
            "Passwords.csv" to "Title,URL,Username,Password,Notes,OTPAuth\nExample,https://e.example,me,secret,,otpauth://totp/E:me?secret=JBSWY3DPEHPK3PXP&issuer=E\n",
            "quotes.csv" to "\uFEFFname,url,username,password,folder,tags,favorite\r\n\"A, comma\",https://a.example,\"he said \"\"hi\"\"\",\"multi\nline\",Work,\"x;y\",true\r\n",
        )
        val bitwarden = """{"encrypted":false,"folders":[{"id":"f1","name":"Work"}],"items":[
          {"id":"1","type":1,"name":"BW login","folderId":"f1","favorite":true,"reprompt":1,"notes":"n","fields":[{"name":"pin","value":"1","type":1},{"name":"empty","value":"","type":0}],"login":{"username":"u","password":"p","totp":"JBSWY3DPEHPK3PXP","uris":[{"uri":"https://bw.example","match":1},{"uri":"https://bw2.example","match":null}],"fido2Credentials":[{"keyValue":"a2V5","rpId":"bw.example","credentialId":"Y3JlZA","userHandle":"dQ","userName":"un","counter":"3","creationDate":"2024-01-01T00:00:00.000Z","discoverable":"true"}]},"passwordHistory":[{"password":"old","lastUsedDate":"2023-01-01T00:00:00.000Z"}]},
          {"id":"2","type":2,"name":"BW note","notes":"text"},
          {"id":"3","type":3,"name":"BW card","card":{"cardholderName":"A","number":"4111","brand":"Visa","expMonth":"1","expYear":"2030","code":"123"}},
          {"id":"4","type":4,"name":"BW identity","identity":{"firstName":"F","lastName":"L","postalCode":"6000","country":"AU"}},
          {"id":"5","type":5,"name":"BW ssh","sshKey":{"publicKey":"pub","privateKey":"priv","keyFingerprint":"fp"}},
          {"id":"6","type":9,"name":"BW unknown","notes":"keep"}
        ]}"""
        val strengthList = listOf(
            "password", "123456", "qwerty", "letmein", "Password1", "iloveyou", "abc123", "aaaaaa", "1234567890", "dragon", "Summer2024", "p@ssw0rd", "monkey123", "qazwsx", "trustno1", "correcthorse",
            "Tr0ub4dor&3", "correct horse battery staple", "kX9!vQ2#mL7\$pR4z", "ghJ8#kLm2\$xZ9qWv4!", "xkcd-pails-graft-mints", "7Hq2vN9pLw3ZbX6t", "q8Z!r2\$Lx0", "aB3dE6gH", "Zx9#", "hunter2", "mypassword2021", "ilovemydog", "London1999", "wibble-wobble-99",
        )
        // A password-protected Bitwarden file, built to the format notes bitwarden.ts reads.
        val bwProtected = run {
            val salt = "c2FsdHNhbHRzYWx0c2FsdA=="
            val master = javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(javax.crypto.spec.PBEKeySpec("bw-file-password".toCharArray(), salt.toByteArray(), 1000, 256)).encoded
            fun expand(info: String): ByteArray {
                val m = javax.crypto.Mac.getInstance("HmacSHA256")
                m.init(javax.crypto.spec.SecretKeySpec(master, "HmacSHA256"))
                return m.doFinal(info.toByteArray() + byteArrayOf(1))
            }
            val enc = expand("enc")
            val macKey = expand("mac")
            fun cipher(plain: String): String {
                val iv = randomBytes(16)
                val c = javax.crypto.Cipher.getInstance("AES/CBC/PKCS5Padding")
                c.init(javax.crypto.Cipher.ENCRYPT_MODE, javax.crypto.spec.SecretKeySpec(enc, "AES"), javax.crypto.spec.IvParameterSpec(iv))
                val ct = c.doFinal(plain.toByteArray())
                val m = javax.crypto.Mac.getInstance("HmacSHA256")
                m.init(javax.crypto.spec.SecretKeySpec(macKey, "HmacSHA256"))
                val tag = m.doFinal(iv + ct)
                val b = java.util.Base64.getEncoder()
                return "2.${b.encodeToString(iv)}|${b.encodeToString(ct)}|${b.encodeToString(tag)}"
            }
            buildJsonObject {
                put("encrypted", true)
                put("passwordProtected", true)
                put("salt", salt)
                put("kdfType", 0)
                put("kdfIterations", 1000)
                put("encKeyValidation_DO_NOT_EDIT", cipher("validation"))
                put("data", cipher("""{"encrypted":false,"folders":[],"items":[{"id":"1","type":2,"name":"Inside protected","notes":"x"}]}"""))
            }.toString()
        }
        val dedupeFixture = "name,url,username,password\nA,https://www.d.example,u,p\nB,https://d.example/other,u,p\nC,https://d.example,u,q\n"
        withState { file ->
            writeState(file, buildJsonObject {
                put("token", u.token)
                put("strengthList", JsonArray(strengthList.map { JsonPrimitive(it) }))
                put("csvFixtures", JsonObject(fixtures.mapValues { JsonPrimitive(it.value) }))
                put("bitwardenFixture", bitwarden)
                put("bitwardenProtected", bwProtected)
                put("dedupeFixture", dedupeFixture)
            })
            runTs("tx1", file)
            val st = readState(file)
            val phone = device(u)
            phone.unlock(MASTER, fromB64u(st.getValue("secretKey").jsonPrimitive.content))

            // Importers agree with the web client's, field for field.
            fun comparable(b: org.promptly.sync.passwords.core.ItemBody): JsonObject = JsonObject(b.fields.filterKeys { it !in setOf("createdAt", "updatedAt", "v") })
            fun tsComparable(o: JsonObject): JsonObject = JsonObject(o.filterKeys { it !in setOf("createdAt", "updatedAt", "v") })
            val cases = st.getValue("csvCases").jsonObject
            for ((name, text) in fixtures) {
                val mine = org.promptly.sync.passwords.core.Importers.importFile(name, text.toByteArray())
                val theirs = cases.getValue(name).jsonObject
                assertEquals(name, theirs.getValue("format").jsonPrimitive.content, mine.format)
                val ts = theirs.getValue("items").jsonArray
                assertEquals(name, ts.size, mine.items.size)
                for ((i, it) in mine.items.withIndex()) {
                    assertEquals(name, stableOf(tsComparable(ts[i].jsonObject.getValue("body").jsonObject)), stableOf(comparable(it.body)))
                    assertEquals(name, (ts[i].jsonObject["folder"] as? JsonPrimitive)?.takeIf { p -> p.isString }?.content, it.folder)
                }
            }
            val bw = org.promptly.sync.passwords.core.Importers.importFile("b.json", bitwarden.toByteArray())
            assertEquals("Bitwarden", bw.format)
            val bwTs = st.getValue("bw").jsonObject.getValue("items").jsonArray
            assertEquals(bwTs.size, bw.items.size)
            for ((i, it) in bw.items.withIndex()) {
                assertEquals(it.body.title, stableOf(tsComparable(bwTs[i].jsonObject.getValue("body").jsonObject)), stableOf(comparable(it.body)))
                assertEquals((bwTs[i].jsonObject["folder"] as? JsonPrimitive)?.takeIf { p -> p.isString }?.content, it.folder)
            }
            assertThrows(org.promptly.sync.passwords.core.NeedsPasswordError::class.java) { org.promptly.sync.passwords.core.Importers.importFile("p.json", bwProtected.toByteArray()) }
            assertThrows(IllegalArgumentException::class.java) { org.promptly.sync.passwords.core.Importers.importFile("p.json", bwProtected.toByteArray(), "wrong") }
            assertEquals(st.getValue("bwOpened").jsonArray.map { it.jsonPrimitive.content }, org.promptly.sync.passwords.core.Importers.importFile("p.json", bwProtected.toByteArray(), "bw-file-password").items.map { it.body.title })
            val (fresh, dups) = org.promptly.sync.passwords.core.Importers.dedupe(org.promptly.sync.passwords.core.Importers.fromGenericCsv(dedupeFixture).items, emptyList())
            assertEquals(st.getValue("dupFresh").jsonPrimitive.content.toInt(), fresh.size)
            assertEquals(st.getValue("dupCount").jsonPrimitive.content.toInt(), dups)

            // Export: byte-identical CSV, and TS's encrypted file opens here.
            val items = phone.exportable()
            val plainCsvOf = org.promptly.sync.passwords.core.Exporter.plainCsv(items.sortedBy { i -> st.getValue("plainCsv").jsonPrimitive.content.indexOf(i.body.title) })
            assertEquals(st.getValue("plainCsv").jsonPrimitive.content, plainCsvOf)
            val tsFile = st.getValue("tsEncrypted").jsonPrimitive.content
            assertThrows(NeedsPw::class.java) {
                try {
                    org.promptly.sync.passwords.core.Importers.importFile("e.json", tsFile.toByteArray())
                } catch (e: org.promptly.sync.passwords.core.NeedsPasswordError) {
                    throw NeedsPw()
                }
            }
            assertEquals(4, org.promptly.sync.passwords.core.Importers.importFile("e.json", tsFile.toByteArray(), "ts-export-password").items.size)
            assertThrows(IllegalArgumentException::class.java) { org.promptly.sync.passwords.core.Importers.importFile("e.json", tsFile.toByteArray(), "wrong") }
            // A plain re-import of its own file adds nothing new.
            val plainAgain = org.promptly.sync.passwords.core.Importers.importFile("plain.json", org.promptly.sync.passwords.core.Exporter.plainJson(items).toByteArray())
            assertEquals(0, org.promptly.sync.passwords.core.Importers.dedupe(plainAgain.items, items.map { it.body }).first.size)

            // Security check against the same items as the web client's.
            useSimpleBaseDomains()
            val h = org.promptly.sync.passwords.core.Health.run(phone.allItems())
            val tsH = st.getValue("health").jsonObject
            assertEquals(tsH.getValue("checked").jsonPrimitive.content.toInt(), h.checked)
            assertEquals(tsH.getValue("reused").jsonPrimitive.content.toInt(), h.reusedCount)
            assertEquals(tsH.getValue("http").jsonPrimitive.content.toInt(), h.http.size)
            assertEquals(tsH.getValue("old").jsonPrimitive.content.toInt(), h.old.size)
            assertEquals(tsH.getValue("weak").jsonPrimitive.content.toInt(), h.weak.size)
            // The real breach route: "password" is in every list there is.
            val breached = org.promptly.sync.passwords.core.Health.run(phone.allItems(), { phone.api.breachRange(it) })
            if (breached.breachSkipped == null) assertTrue("password should be breached", breached.breached.any { it.first.body.title == "Weak one" })
            println("BREACH: " + (breached.breachSkipped ?: "checked, ${breached.breached.size} hits"))

            // Strength next to zxcvbn-ts on the same list. Reported, and held to a floor.
            val scores = st.getValue("scores").jsonObject
            var sameWeak = 0
            val differs = ArrayList<String>()
            for (pw in strengthList) {
                val ts = scores.getValue(pw).jsonPrimitive.content.toInt()
                val mine = org.promptly.sync.passwords.core.StrengthCheck.check(pw).score
                if ((ts <= 1) == (mine <= 1)) sameWeak++ else differs += "$pw ts=$ts kt=$mine"
            }
            println("STRENGTH: weak/not-weak agrees on $sameWeak of ${strengthList.size}. Differs: $differs")
            assertTrue("agrees on only $sameWeak of ${strengthList.size}: $differs", sameWeak >= strengthList.size * 8 / 10)

            // Android's own files and Sends, read by the web client.
            val ktFile = org.promptly.sync.passwords.core.Exporter.encrypted(phone.exportable(), "kt-export-password")
            val send1 = org.promptly.sync.passwords.core.SecureSend.create(phone.api, org.promptly.sync.passwords.core.SecureSend.textPayload("From Android", "send text \uD83D\uDD11"), 7, null, null)
            val send2 = org.promptly.sync.passwords.core.SecureSend.create(phone.api, org.promptly.sync.passwords.core.SecureSend.textPayload("With a password", "secret text"), 1, 2, "send-password")
            val send3 = org.promptly.sync.passwords.core.SecureSend.create(phone.api, org.promptly.sync.passwords.core.SecureSend.filePayload("A file", "note.txt", "text/plain", "file body".toByteArray()), 1, null, null)
            assertTrue(phone.api.sends().any { it.id == send2.id && it.hasPassword })
            writeState(file, JsonObject(st + mapOf(
                "ktEncrypted" to JsonPrimitive(ktFile),
                "ktSend" to JsonPrimitive(send1.link),
                "ktSendPw" to JsonPrimitive(send2.link),
                "ktSendFile" to JsonPrimitive(send3.link),
            )))
            runTs("tx2", file)
            phone.api.deleteSend(send1.id)
            assertTrue(phone.api.sends().none { it.id == send1.id })
        }
    }

    private class NeedsPw : Exception()

    private fun stableOf(o: JsonObject) = org.promptly.sync.passwords.core.stable(o)

    @Test fun emergencyRefuseAndAlerts() {
        need()
        val aUser = makeUser("emA")
        val bUser = makeUser("emB")
        val a = device(aUser)
        val b = device(bUser)
        setupRetrying(a)
        setupRetrying(b)
        // Bare counts, with a device token and no session.
        val deviceToken = VaultApi(BASE, { null }).registerDevice("Bearer ${aUser.token}", "Alerts test").token
        val alerts = VaultApi(BASE, { deviceToken })
        assertEquals(org.promptly.sync.passwords.core.Alerts(0, 0, 0), alerts.alerts())
        // A new device, an invitation.
        val join = device(aUser).requestDevice("New one")
        assertEquals(1, alerts.alerts().deviceRequests)
        join.hashCode()
        val v = b.createSharedVault("For A")
        b.addMember(v, aUser.id, "view")
        assertEquals(1, alerts.alerts().invitations)
        // An emergency: B can ask for A's vault; A is told, and refuses.
        a.emergencyInvite(bUser.id, 1)
        val row = b.api.emergencyList().first { it.grantorId == aUser.id }
        assertEquals("invited", row.state)
        b.api.emergencyAct(row.id, "accept")
        a.sync() // Seals A's keys to the contact, as the web client does.
        val ready = a.api.emergencyList().first { it.id == row.id }
        assertTrue("wrapped: ${ready.wrapped}", ready.wrapped.isNotEmpty())
        assertEquals(a.personalVaultId(), ready.wrapped.keys.first())
        b.api.emergencyAct(row.id, "request")
        assertEquals("requested", a.api.emergencyList().first { it.id == row.id }.state)
        assertEquals(1, alerts.alerts().emergency)
        assertEquals("refused", a.api.emergencyAct(row.id, "refuse").state)
        assertEquals(0, alerts.alerts().emergency)
        a.emergencyEnd(a.api.emergencyList().first { it.id == row.id })
        assertTrue(a.api.emergencyList().isEmpty())
    }

    @Test fun deviceQrBothSidesAndRefusals() {
        need()
        val u = makeUser("qr")
        val stranger = makeUser("qrs")
        withState { file ->
            writeState(file, buildJsonObject { put("token", u.token) })
            runTs("qr1", file)
            val st = readState(file)
            val phone = device(u)
            phone.unlock(MASTER, fromB64u(st.getValue("secretKey").jsonPrimitive.content))
            // The web client's QR, through Android's scanner check.
            val text = st.getValue("qrText").jsonPrimitive.content
            assertEquals(st.getValue("requestId").jsonPrimitive.content, phone.requestForQr(text).id)
            // A different key for the same request: refused, not guessed at.
            val swapped = "pwdev:${st.getValue("requestId").jsonPrimitive.content}:${b64u(randomBytes(32))}"
            val mismatch = assertThrows(org.promptly.sync.passwords.core.DeviceQr.Refused::class.java) { phone.requestForQr(swapped) }
            assertTrue(mismatch.message!!, mismatch.message!!.contains("doesn't match"))
            val unknown = assertThrows(org.promptly.sync.passwords.core.DeviceQr.Refused::class.java) { phone.requestForQr("pwdev:${org.promptly.sync.passwords.core.randomUuid()}:${b64u(randomBytes(32))}") }
            assertTrue(unknown.message!!, unknown.message!!.contains("gone"))
            assertThrows(org.promptly.sync.passwords.core.DeviceQr.Refused::class.java) { phone.requestForQr("https://example.com") }
            // Someone else's request looks the same as none at all.
            val other = device(stranger)
            setupRetrying(other)
            val strangers = other.requestDevice("Theirs")
            assertThrows(org.promptly.sync.passwords.core.DeviceQr.Refused::class.java) { phone.requestForQr(strangers.qrText) }

            // Android as the joining device, the web client's scanner approving it.
            val joining = device(u)
            val join = joining.requestDevice("Android joining")
            writeState(file, JsonObject(readState(file) + ("androidQr" to JsonPrimitive(join.qrText))))
            runTs("qr2", file)
            var state = join.poll()
            val end = System.currentTimeMillis() + 10_000
            while (state.status != "approved" && System.currentTimeMillis() < end) {
                Thread.sleep(300)
                state = join.poll()
            }
            assertEquals("approved", state.status)
            assertEquals(readState(file).getValue("tsApprovalWords").jsonArray.map { it.jsonPrimitive.content }, state.words)
            joining.unlock(MASTER)
            assertTrue(joining.unlocked)
        }
    }

    @Test fun secretKeyRotationBothWays() {
        need()
        val u = makeUser("rot")
        val first = device(u)
        val sk = setupRetrying(first)
        val item = first.saveNew(first.personalVaultId(), newBody("login", "T").withText("password", "x"))
        first.sync()
        val other = device(u)
        other.unlock(MASTER, sk)
        other.lock()
        withState { file ->
            writeState(file, buildJsonObject {
                put("token", u.token)
                put("secretKey", b64u(sk))
            })
            // The web client rotates. This device still holds the old key.
            runTs("rot1", file)
            val rotated = fromB64u(readState(file).getValue("rotatedKey").jsonPrimitive.content)
            val out = assertThrows(WrongPasswordError::class.java) { other.unlock(MASTER) }
            assertTrue("It should say this was changed elsewhere", out.changedElsewhere)
            // Offline, the old copy still opens: nothing online to compare with, and it's old data.
            // Rejoin with the new key.
            other.keeper.clear()
            other.unlock(MASTER, rotated)
            assertEquals("x", other.get(item.id)!!.body.password)
            // A plain wrong password on a device that's up to date doesn't blame another device.
            other.lock()
            val plainWrong = assertThrows(WrongPasswordError::class.java) { other.unlock("not it") }
            assertFalse(plainWrong.changedElsewhere)

            // Now Android rotates.
            other.unlock(MASTER)
            val fresh = other.rotateSecretKey(MASTER)
            assertFalse(fresh.contentEquals(rotated))
            assertTrue(other.keeper.load()!!.contentEquals(fresh))
            writeState(file, JsonObject(readState(file) + ("ktRotated" to JsonPrimitive(b64u(fresh)))))
            runTs("rot2", file)
            // Same device, new key, still opens.
            other.lock()
            other.unlock(MASTER)
            assertEquals("x", other.get(item.id)!!.body.password)
        }
    }

    @Test fun kdfCalibrationAndTheServersMinimum() {
        need()
        val u = makeUser("kdf1")
        val c = device(u)
        // A raised setting, as a quick phone picks at setup.
        val sk = run {
            while (true) {
                try {
                    return@run c.setup(MASTER, org.promptly.sync.passwords.core.calibrateKdf(100L))
                } catch (e: ApiError) {
                    if (e.status != 429) throw e
                    Thread.sleep(((e.retryAfter ?: 30) + 1) * 1000L)
                }
            }
            @Suppress("UNREACHABLE_CODE") ByteArray(0)
        }
        assertEquals(262144, c.currentKdf()!!.m)
        val item = c.saveNew(c.personalVaultId(), newBody("note", "Raised"))
        c.sync()
        withState { file ->
            writeState(file, buildJsonObject {
                put("token", u.token)
                put("secretKey", b64u(sk))
                put("itemId", item.id)
                put("expectM", 262144)
            })
            runTs("kdf", file)
        }
        // A server asking for more than the device picked: setup uses the larger.
        val minimum = rewriting { path, body ->
            if (path.endsWith("/account") && body.contains("min_kdf")) {
                val o = Json.parseToJsonElement(body).jsonObject
                JsonObject(o + ("min_kdf" to Json.parseToJsonElement("""{"alg":"argon2id","m":131072,"t":4,"p":1}"""))).toString()
            } else {
                null
            }
        }
        val raised = device(makeUser("kdf2"), minimum)
        while (true) {
            try {
                raised.setup(MASTER)
                break
            } catch (e: ApiError) {
                if (e.status != 429) throw e
                Thread.sleep(((e.retryAfter ?: 30) + 1) * 1000L)
            }
        }
        assertEquals(131072, raised.currentKdf()!!.m)
        assertEquals(4, raised.currentKdf()!!.t)
        assertFalse(raised.kdfBelowMinimum())

        // An account below what the server now asks for is told, and can catch up.
        val belowUser = makeUser("kdf3")
        val plain = device(belowUser)
        val belowKey = setupRetrying(plain)
        val told = device(belowUser, minimum)
        told.unlock(MASTER, belowKey)
        assertTrue(told.kdfBelowMinimum())
        told.upgradeKdf(MASTER)
        assertFalse(told.kdfBelowMinimum())
        assertEquals(131072, told.currentKdf()!!.m)
        told.lock()
        told.unlock(MASTER)
        assertTrue(told.unlocked)
    }

    @Test fun travelModeTakesAVaultOffTheDevice() {
        need()
        val u = makeUser("trav")
        val c = device(u)
        setupRetrying(c)
        val v = c.createSharedVault("Trip")
        val item = c.saveNew(v, newBody("login", "Hidden").withText("password", "x"))
        val keep = c.saveNew(c.personalVaultId(), newBody("login", "Kept").withText("password", "y"))
        c.sync()
        c.setTravelHidden(listOf(v))
        assertNull(c.get(item.id))
        assertTrue(c.store.getItems(v).isEmpty())
        assertEquals("y", c.get(keep.id)!!.body.password)
        c.sync()
        assertNull(c.get(item.id))
        assertThrows(WrongPasswordError::class.java) { c.endTravel("not it") }
        c.endTravel(MASTER)
        assertEquals("x", c.get(item.id)!!.body.password)
    }

    // ---- Importers: one file, the same items from both ----

    /** A body without the times it was read at, which are all that's allowed to differ. */
    private fun comparable(body: JsonObject): JsonObject {
        val out = LinkedHashMap(body)
        out.remove("createdAt")
        out.remove("updatedAt")
        (out["passkeys"] as? JsonArray)?.let { list -> out["passkeys"] = JsonArray(list.map { k -> JsonObject(k.jsonObject.filterKeys { it != "createdAt" }) }) }
        return Json.parseToJsonElement(JsonObject(out).toString()).jsonObject
    }

    @Test fun importersReadTheSameFilesIntoTheSameItemsAsTheTypeScript() {
        need()
        val fixtures = ImportFixtures
        val dir = Files.createTempDirectory("pw-imports").toFile()
        val password = fixtures.KDBX_PASSWORD
        val quick = KdbxWriter.Argon2(id = true)
        // name to (bytes, password). Every format, and every way a KDBX can be made.
        val files = LinkedHashMap<String, Pair<ByteArray, String?>>()
        for (n in listOf("lastpass.csv", "chrome.csv", "firefox.csv", "apple.csv", "odd-columns.csv", "bitwarden.json", "proton.json", "cxf.json", "aegis.json", "twofas.json", "google-migration.txt", "keepass.xml")) files[n] = fixtures.bytes(n) to null
        files["kotlin.1pux"] = fixtures.onePux() to null
        files["kotlin-dashlane.zip"] = fixtures.dashlane() to null
        files["fixture.kdbx"] = fixtures.kdbx to password
        files["chacha-argon2id.kdbx"] = fixtures.bytes("chacha-argon2id.kdbx") to password
        files["large.kdbx"] = fixtures.bytes("large.kdbx") to password
        // Where the two are known to differ, and why. See "Differences from importers.ts and kdbx.ts"
        // in ANDROID_NOTES.md. Each is tested for what Kotlin should do in ImportersTest.
        val known = mapOf(
            "doctype-only.xml" to "only a DOCTYPE with an entity is refused on the web",
            "android-url.csv" to "Android keeps an app's id as androidapp://, and the web as it came",
        )
        files["lastpass-name-only.csv"] = utf8("url,username,password,totp,extra,name,grouping,fav\n,,,,,Only a name,,0\nhttp://sn,,,,text,A note,,0\nhttps://a.example,u,keep-this,,,Real login,,0\n") to null
        files["doctype-only.xml"] = utf8("<!DOCTYPE KeePassFile><KeePassFile><Root><Group><Entry><String><Key>Title</Key><Value>T</Value></String></Entry></Group></Root></KeePassFile>") to null
        files["android-url.csv"] = utf8("name,url,username,password\nApp,android://HASH@com.acme.app/,u,p\n") to null
        files["written-argon2d.kdbx"] = KdbxWriter.write(KdbxWriter.Argon2(id = false)) to password
        files["written-chacha.kdbx"] = KdbxWriter.write(quick, KdbxWriter.CHACHA) to password
        files["written-aeskdf.kdbx"] = KdbxWriter.write(KdbxWriter.AesRounds(2000), compress = false) to password
        files["written-history.kdbx"] = KdbxWriter.write(KdbxWriter.AesRounds(100), KdbxWriter.CHACHA, xml = { p ->
            "<?xml version=\"1.0\"?><KeePassFile><Root><Group><Name>R</Name><Group><Name>Sub</Name><Entry><String><Key>Title</Key><Value>T</Value></String><String><Key>Password</Key><Value Protected=\"True\">${p("new")}</Value></String><History><Entry><String><Key>Password</Key><Value Protected=\"True\">${p("old")}</Value></String></Entry></History><String><Key>Other</Key><Value Protected=\"True\">${p("after-history")}</Value></String></Entry></Group></Group></Root></KeePassFile>"
        }) to password
        // Both have to refuse these.
        val refused = linkedMapOf(
            "bad.json" to "{\"items\":[",
            "encrypted-aegis.json" to "{\"db\":\"x\",\"header\":{\"slots\":[{}]}}",
            "encrypted-2fas.json" to "{\"services\":[],\"servicesEncrypted\":\"x\"}",
            "locked-bitwarden.json" to "{\"encrypted\":true,\"data\":\"2.y\"}",
            "unknown.json" to "{\"something\":1}",
            "entities.xml" to "<!DOCTYPE x [<!ENTITY a \"b\">]><KeePassFile><Root/></KeePassFile>",
            "external.xml" to "<!DOCTYPE x [<!ENTITY a SYSTEM \"file:///etc/passwd\">]><KeePassFile><Root/></KeePassFile>",
            "broken.xml" to "<KeePassFile><Root></KeePassFile>",
            "other.xml" to "<html></html>",
            "deep.xml" to "<KeePassFile><Root>" + "<Group><Name>x</Name>".repeat(100) + "</Group>".repeat(100) + "</Root></KeePassFile>",
            "columns.csv" to "colour,size\nred,big\n",
            "bare-word.json" to "{\"services\":[{\"secret\":AAAA}]}",
            "leading-zero.json" to "{\"services\":[{\"otp\":{\"digits\":06}}]}",
            "trailing-comma.json" to "{\"services\":[],}",
            "trailing-text.json" to "{\"services\":[]} x",
            "raw-line-end.json" to "{\"services\":[{\"secret\":\"a\nb\"}]}",
            "single-quotes.json" to "{'services':[]}",
            "not-migration.txt" to "otpauth-migration://offline",
        )
        for ((n, text) in refused) files[n] = utf8(text) to null
        files["no-password.kdbx"] = fixtures.kdbx to null
        files["wrong-password.kdbx"] = KdbxWriter.write(KdbxWriter.AesRounds(100)) to "wrong"
        files["kdf-over-the-ceiling.kdbx"] = KdbxWriter.headerOnly(KdbxWriter.Argon2(m = 8L * 1024 * 1024 * 1024 + 1)) to password
        files["cut.1pux"] = fixtures.onePux().let { it.copyOf(it.size / 2) } to null
        files["cut.kdbx"] = KdbxWriter.write(KdbxWriter.AesRounds(100)).let { it.copyOf(it.size - 40) } to password

        for ((n, f) in files) File(dir, n).writeBytes(f.first)
        val stateFile = File(dir, "state.json")
        writeState(stateFile, buildJsonObject {
            put("dir", dir.absolutePath)
            put("fixtures", fixtures.dir.absolutePath)
            put("files", JsonArray(files.map { (n, f) -> buildJsonObject { put("name", n); f.second?.let { p -> put("password", p) } } }))
        })
        runTs("imp", stateFile)
        val results = readState(stateFile).getValue("results").jsonObject
        files["fflate.1pux"] = File(dir, "fflate.1pux").readBytes() to null
        files["fflate-dashlane.zip"] = File(dir, "fflate-dashlane.zip").readBytes() to null

        val problems = ArrayList<String>()
        var compared = 0
        val differed = HashMap<String, Int>()
        for ((n, f) in files) {
            val theirs = results.getValue(n).jsonObject
            val mine = runCatching { org.promptly.sync.passwords.core.Importers.importFile(n, f.first, f.second) }
            val error = theirs["error"]?.jsonPrimitive?.content
            if (error != null) {
                val refusedHere = mine.exceptionOrNull()
                if (refusedHere == null) problems += "$n: TypeScript refused it ($error), Kotlin read it"
                else if (n in known) problems += "$n no longer differs: both refuse it"
                else if (refusedHere.message != error) println("$n: refused by both. TypeScript: $error. Kotlin: ${refusedHere.message}")
                continue
            }
            val r = mine.getOrElse {
                if (n in known) differed[n] = 1 else problems += "$n: Kotlin refused it (${it.message}), TypeScript read it"
                continue
            }
            if (r.format != theirs.getValue("format").jsonPrimitive.content) problems += "$n: format ${r.format}, TypeScript ${theirs["format"]}"
            val tsWarnings = theirs.getValue("warnings").jsonArray.map { it.jsonPrimitive.content }
            if (r.warnings != tsWarnings) problems += "$n: warnings ${r.warnings}, TypeScript $tsWarnings"
            val tsItems = theirs.getValue("items").jsonArray.map { it.jsonObject }
            if (r.items.size != tsItems.size) {
                if (n in known) differed[n] = 1 else problems += "$n: ${r.items.size} items, TypeScript ${tsItems.size}"
            }
            for ((i, pair) in r.items.zip(tsItems).withIndex()) {
                val (item, ts) = pair
                val folder = ts["folder"]?.jsonPrimitive?.content
                if (item.folder != folder) problems += "$n item $i: folder ${item.folder}, TypeScript $folder"
                val a = comparable(JsonObject(item.body.fields))
                val b = comparable(ts.getValue("body").jsonObject)
                if (a != b) {
                    if (n in known) differed[n] = (differed[n] ?: 0) + 1 else problems += "$n item $i:\n  Kotlin     $a\n  TypeScript $b"
                    continue
                }
                compared++
            }
        }
        // Printed, not asserted: fixing the web side should turn this quiet, not fail a test.
        for ((n, why) in known) println("Known difference, $n: ${differed[n] ?: 0} items differ. $why")
        dir.deleteRecursively()
        assertTrue("Differences:\n" + problems.joinToString("\n"), problems.isEmpty())
        assertTrue("Compared $compared", compared > 60)
    }

    // ---- Where the vault meets the rest of Promptly ----

    private val plain = OkHttpClient.Builder().readTimeout(60, TimeUnit.SECONDS).build()
    private fun bearerGet(u: StackUser, path: String): String =
        plain.newCall(okhttp3.Request.Builder().url("$BASE$path").header("Authorization", "Bearer ${u.token}").build()).execute().use { it.body.string() }

    @Test fun theActivityLogReadsTheRealServer() {
        need()
        val u = makeUser("activity")
        val phone = device(u)
        setupRetrying(phone)
        val rows = phone.api.activity()
        assertTrue("got ${rows.map { it.event }}", rows.any { it.event == "vault_created" })
        assertTrue(rows.all { org.promptly.sync.passwords.core.parseInstant(it.at) != null })
    }

    /** The Today card comes from what's posted here, and goes when it's taken back. */
    @Test fun todayCountsReachTheTodayCardAndGoAwayWhenTurnedOff() {
        need()
        val u = makeUser("today")
        val phone = device(u)
        setupRetrying(phone)
        val card = "\"passwords\":{\"attention\":"
        assertFalse(bearerGet(u, "/api/today").contains(card))
        phone.api.putHealth(org.promptly.sync.passwords.core.CoarseCounts(2, 3, 1, 9))
        assertTrue("Weak, reused and breached count, and old doesn't", bearerGet(u, "/api/today").contains(card + "6"))
        phone.api.deleteHealth()
        assertFalse(bearerGet(u, "/api/today").contains(card))
    }
}
