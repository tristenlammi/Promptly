// One proof per passkey (A74): which single thing is asked for, and when the unlock that came
// just before a pick counts for it.
package org.promptly.sync.passwords

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.promptly.sync.passwords.core.PasskeyProof
import org.promptly.sync.passwords.core.ProofAsk
import org.promptly.sync.passwords.core.ProofGrants
import org.promptly.sync.passwords.core.ProofKind

class ProofTest {
    @Test fun aProofJustGivenIsNeverFollowedByAnother() {
        for (kind in ProofKind.values()) for (bio in listOf(true, false)) for (reprompt in listOf(true, false)) {
            assertEquals("$kind bio=$bio reprompt=$reprompt", ProofAsk.NOTHING, PasskeyProof.next(kind, bio, reprompt))
        }
    }

    @Test fun anOpenVaultAsksForExactlyOneThing() {
        // Biometric unlock set up: one touch, "ask again" item or not.
        assertEquals(ProofAsk.BIOMETRIC, PasskeyProof.next(null, biometricReady = true, reprompt = false))
        assertEquals(ProofAsk.BIOMETRIC, PasskeyProof.next(null, biometricReady = true, reprompt = true))
        // None: the passkey PIN, as before.
        assertEquals(ProofAsk.PIN, PasskeyProof.next(null, biometricReady = false, reprompt = false))
        // None, and the item is "ask again": the master password alone. A PIN is never enough for it,
        // and it isn't asked for on top.
        assertEquals(ProofAsk.MASTER, PasskeyProof.next(null, biometricReady = false, reprompt = true))
    }

    @Test fun anUnlockCountsForThePickThatFollowsIt() {
        val g = ProofGrants(lifeMs = 60_000)
        g.give(ProofKind.BIOMETRIC, "com.shop", listOf("shop.example"), passwords = false, now = 1_000)
        assertTrue(g.waiting)
        assertEquals(ProofKind.BIOMETRIC, g.take("com.shop", "shop.example", now = 5_000))
        // Once.
        assertFalse(g.waiting)
        assertNull(g.take("com.shop", "shop.example", now = 5_001))
    }

    @Test fun notForAnotherAppAnotherSiteOrLater() {
        val g = ProofGrants(lifeMs = 60_000)
        g.give(ProofKind.MASTER, "com.shop", listOf("shop.example"), passwords = false, now = 0)
        assertNull("another app", g.take("com.other", "shop.example", now = 10))
        // A wrong try uses it up: nobody gets a second go at guessing.
        assertNull(g.take("com.shop", "shop.example", now = 11))

        g.give(ProofKind.MASTER, "com.shop", listOf("shop.example"), passwords = false, now = 0)
        assertNull("another site", g.take("com.shop", "bank.example", now = 10))

        g.give(ProofKind.MASTER, "com.shop", listOf("shop.example"), passwords = false, now = 0)
        assertNull("a minute on", g.take("com.shop", "shop.example", now = 60_000))

        g.give(ProofKind.MASTER, "com.shop", listOf("shop.example"), passwords = false, now = 0)
        assertNull("a password, when only passkeys were asked for", g.take("com.shop", null, now = 10))
    }

    @Test fun aRequestThatDidntSayWhoAskedProvesNothing() {
        val g = ProofGrants()
        g.give(ProofKind.BIOMETRIC, null, listOf("shop.example"), passwords = true, now = 0)
        assertNull(g.take("com.shop", "shop.example", now = 1))
    }

    @Test fun passwordsAreCoveredOnlyWhenTheRequestAskedForThem() {
        val g = ProofGrants()
        g.give(ProofKind.BIOMETRIC, "com.shop", emptyList(), passwords = true, now = 0)
        assertEquals(ProofKind.BIOMETRIC, g.take("com.shop", null, now = 1))
    }

    @Test fun aLockThrowsItAway() {
        val g = ProofGrants()
        g.give(ProofKind.BIOMETRIC, "com.shop", listOf("shop.example"), passwords = false, now = 0)
        g.clear()
        assertNull(g.take("com.shop", "shop.example", now = 1))
    }
}
