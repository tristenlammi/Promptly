// The passkey PIN's rules, verifier and wrong-try count (D-PIN-1), mirroring passkeypin.test.ts.
// The fixed vector is the same one, so a PIN set on Android works in the extension and back.
package org.promptly.sync.passwords

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.KdfParams
import org.promptly.sync.passwords.core.MemoryStore
import org.promptly.sync.passwords.core.PasskeyPin
import org.promptly.sync.passwords.core.PinCheck
import org.promptly.sync.passwords.core.b64u
import org.promptly.sync.passwords.core.newBody
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class PasskeyPinTest {
    private val salt = ByteArray(16) { it.toByte() }

    @Test fun takesFourToTwelveDigits() {
        for (ok in listOf("4821", "482913", "482913570264")) assertNull(ok, PasskeyPin.problem(ok))
        for (bad in listOf("482", "4829135702641", "48a1", " 4821", "", "４８２１")) assertEquals(bad, "Use 4 to 12 digits.", PasskeyPin.problem(bad))
    }

    @Test fun refusesTheObviousOnes() {
        for (p in listOf("0000", "1111", "999999", "1234", "123456", "1234567890", "4321", "9876", "8901", "0987", "1212", "4545", "123123", "2580", "1122", "6969")) {
            assertEquals(p, "That PIN is too easy to guess. Try another.", PasskeyPin.problem(p))
        }
        for (p in listOf("1235", "2468013", "7391", "1221", "0901")) assertNull(p, PasskeyPin.problem(p))
    }

    @Test fun matchesOnlyItsOwnPinAndHoldsNothingReadable() {
        val v = PasskeyPin.make("4821")
        assertFalse(v.toJson().toString().contains("4821"))
        assertEquals(KdfParams.FLOOR, v.kdf)
        assertTrue(PasskeyPin.matches(v, "4821"))
        assertFalse(PasskeyPin.matches(v, "4822"))
        assertFalse(PasskeyPin.matches(v, "04821"))
        assertFalse(PasskeyPin.matches(v, ""))
        val again = PasskeyPin.make("4821")
        assertNotEquals(v.salt, again.salt)
        assertNotEquals(v.check, again.check)
        assertThrows(IllegalArgumentException::class.java) { PasskeyPin.make("1234") }
    }

    /** The same numbers as passkeypin.test.ts. */
    @Test fun givesTheSharedVector() {
        val v = PasskeyPin.make("4821", salt = salt, setAt = "2026-11-08T00:00:00.000Z")
        assertEquals(b64u(salt), v.salt)
        assertEquals("Cgg9Re5GWzCmi3T5Cv_TDZ93PDwlrkzb_RPe4_w-A9M", v.check)
        // And one written by the extension reads and matches here.
        val fromWeb = PasskeyPin.read(kotlinx.serialization.json.Json.parseToJsonElement(
            """{"v":1,"kdf":{"alg":"argon2id","m":65536,"t":3,"p":1},"salt":"${b64u(salt)}","check":"Cgg9Re5GWzCmi3T5Cv_TDZ93PDwlrkzb_RPe4_w-A9M","setAt":"2026-11-08T00:00:00.000Z"}""",
        ))
        assertNotNull(fromWeb)
        assertTrue(PasskeyPin.matches(fromWeb!!, "4821"))
    }

    @Test fun readsOnlyWellFormedRecordsInsideTheKdfLimits() {
        val good = PasskeyPin.make("4821").toJson()
        assertNotNull(PasskeyPin.read(good))
        assertNull(PasskeyPin.read(null))
        assertNull(PasskeyPin.read(JsonPrimitive("x")))
        assertNull(PasskeyPin.read(JsonObject(good + ("v" to JsonPrimitive(2)))))
        val weak = JsonObject(mapOf("alg" to JsonPrimitive("argon2id"), "m" to JsonPrimitive(1024), "t" to JsonPrimitive(1), "p" to JsonPrimitive(1)))
        assertNull(PasskeyPin.read(JsonObject(good + ("kdf" to weak))))
        val huge = JsonObject(mapOf("alg" to JsonPrimitive("argon2id"), "m" to JsonPrimitive(1 shl 30), "t" to JsonPrimitive(3), "p" to JsonPrimitive(1)))
        assertNull(PasskeyPin.read(JsonObject(good + ("kdf" to huge))))
        assertNull(PasskeyPin.read(JsonObject(good + ("check" to JsonPrimitive("AAAA")))))
    }

    @Test fun takenFromThePersonalVaultOnlyNewestFirstAndNeverFromTheTrash() {
        val older = PasskeyPin.make("4821", setAt = "2026-01-01T00:00:00.000Z")
        val newer = PasskeyPin.make("7391", setAt = "2026-02-01T00:00:00.000Z")
        val planted = PasskeyPin.make("5550", setAt = "2026-03-01T00:00:00.000Z")
        fun row(vault: String, v: Any, deleted: Boolean = false) =
            Item(java.util.UUID.randomUUID().toString(), vault, 1, deleted, "", newBody("prefs", PasskeyPin.TITLE, "passkeyPin" to (v as org.promptly.sync.passwords.core.PinVerifier).toJson()))
        val items = listOf(row("mine", older), row("mine", newer), row("shared", planted), row("mine", planted, deleted = true))
        assertEquals(newer.check, PasskeyPin.verifierOf(items, "mine")?.check)
        assertNull(PasskeyPin.verifierOf(items, "nobody"))
        assertTrue(newBody("prefs", PasskeyPin.TITLE).isSystem)
    }

    @Test fun countsWrongTriesResetsOnARightOneAndLocksOutAtFive() {
        val store = MemoryStore()
        val v = PasskeyPin.make("4821")
        assertEquals(PinCheck.Wrong(4), PasskeyPin.check(store, v, "0001"))
        assertEquals(PinCheck.Wrong(3), PasskeyPin.check(store, v, "0002"))
        assertEquals(2, PasskeyPin.tries(store))
        assertEquals(PinCheck.Ok, PasskeyPin.check(store, v, "4821"))
        assertEquals(0, PasskeyPin.tries(store))
        for (left in listOf(4, 3, 2, 1)) assertEquals(PinCheck.Wrong(left), PasskeyPin.check(store, v, "0000"))
        assertFalse(PasskeyPin.lockedOut(store))
        assertEquals(PinCheck.Wrong(0), PasskeyPin.check(store, v, "0000"))
        assertTrue(PasskeyPin.lockedOut(store))
        // Locked out, even the right PIN does nothing until the master password clears it.
        assertEquals(PinCheck.Wrong(0), PasskeyPin.check(store, v, "4821"))
        PasskeyPin.clearTries(store)
        assertEquals(PinCheck.Ok, PasskeyPin.check(store, v, "4821"))
    }

    @Test fun guessesSentAtOnceCantGetPastTheLimit() {
        val store = MemoryStore()
        val v = PasskeyPin.make("4821")
        val pool = Executors.newFixedThreadPool(8)
        val results = (0 until 8).map { i -> pool.submit<PinCheck> { PasskeyPin.check(store, v, (1000 + i).toString()) } }.map { it.get(60, TimeUnit.SECONDS) }
        pool.shutdown()
        assertEquals(4, results.count { it == PinCheck.Wrong(0) })
        assertEquals(PasskeyPin.TRIES, PasskeyPin.tries(store))
    }

    @Test fun junkCountIsNoneAndAHugeOneIsLockedOut() {
        val store = MemoryStore()
        store.setMeta(PasskeyPin.TRIES_META, JsonPrimitive("lots"))
        assertEquals(0, PasskeyPin.tries(store))
        store.setMeta(PasskeyPin.TRIES_META, JsonPrimitive(99))
        assertTrue(PasskeyPin.lockedOut(store))
    }

    @Test fun triesTextSaysWhatsLeft() {
        assertEquals("That PIN isn't right. 4 tries left.", PasskeyPin.triesText(4))
        assertEquals("That PIN isn't right. One more wrong and your vault locks.", PasskeyPin.triesText(1))
    }
}
