// Against the isolated :8092 stack, with throwaway users made by a script piped into the
// backend container. Skipped unless -Dpw.stack=http://localhost:8092 is passed.
//   gradlew :app:testDebugUnitTest --tests "*StackTests*" -Dpw.stack=http://localhost:8092
package org.promptly.sync.passwords

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
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

private fun device(u: StackUser, http: OkHttpClient? = null) = VaultClient(VaultApi(BASE, { u.token }, http), MemoryStore(), MemoryKeeper())

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
        old.finishApproval(req.id, req.devicePub)
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
}
