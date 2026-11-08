// Browser sync on the phone (passwords/SYNC.md): a tab sent from a browser opens here, byte for
// byte with the TypeScript core (the same vector is in frontend/src/passwords/core/browsersync.test.ts).
package org.promptly.sync.passwords

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.promptly.sync.passwords.core.Alerts
import org.promptly.sync.passwords.core.browserSyncKey
import org.promptly.sync.passwords.core.fromB64u
import org.promptly.sync.passwords.core.fromHex
import org.promptly.sync.passwords.core.isWebAddress
import org.promptly.sync.passwords.core.openSentTab

class BrowserSyncTest {
    private val raw = fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
    private val vault = "8d2f0c4e-6c47-4c1b-9a7c-3a1d2b3c4d5e"
    private val device = "5b0c1f5e-0d1b-4e4f-9a3e-1c2d3e4f5a6b"
    private val slot = "0f1e2d3c-4b5a-4968-8776-655443322110"
    private val blob = fromB64u(BLOB)

    @Test fun aTabSentFromABrowserOpensHere() {
        assertEquals("https://example.com/sent?x=1", openSentTab(browserSyncKey(raw, vault), vault, device, slot, blob))
    }

    @Test fun itsBoundToThisDeviceAndSlotAndKey() {
        val key = browserSyncKey(raw, vault)
        assertNull(openSentTab(key, vault, "another-device", slot, blob))
        assertNull(openSentTab(key, vault, device, "another-slot", blob))
        assertNull(openSentTab(browserSyncKey(ByteArray(32), vault), vault, device, slot, blob))
        assertNull(openSentTab(browserSyncKey(raw, "11111111-2222-4333-8444-555555555555"), vault, device, slot, blob))
        val bent = blob.copyOf().also { it[40] = (it[40].toInt() xor 1).toByte() }
        assertNull(openSentTab(key, vault, device, slot, bent))
    }

    @Test fun onlyWebAddressesOpen() {
        assertTrue(isWebAddress("https://example.com/"))
        assertTrue(isWebAddress("HTTP://localhost:8080/x"))
        for (bad in listOf("javascript:alert(1)", "intent://x#Intent;end", "file:///sdcard/x", "content://x/y", "data:text/html,x", "https://", "https://" + "a".repeat(5000) + ".com")) assertFalse(bad, isWebAddress(bad))
    }

    @Test fun aSentTabIsNewsOnlyWhenTheCountGoesUp() {
        assertTrue(AlertDiff.news(Alerts(0, 0, 0, 0), Alerts(0, 0, 0, 1)).sentTabs)
        assertFalse(AlertDiff.news(Alerts(0, 0, 0, 1), Alerts(0, 0, 0, 1)).any)
        assertFalse(AlertDiff.news(Alerts(0, 0, 0, 2), Alerts(0, 0, 0, 0)).any)
    }

    private companion object {
        const val BLOB = "AQFNNlAojcEW4GZUQddQx12DbqIHFSzQIiC1IWmUEP5ueTNIk_pt3BGx4jFBpWMWHcYxiXRd6I93b75rfk8rpY8rAgqsNoCesZfpJX_eXh1GC78_QQWakXL0G83EqXyfz_htffXlJgUckV5ARBXldHT-aGla6kQTv2SNGJB_3rX6fcxHxtDGkkQsMcFQOASGda9U0cI-6OcDiXI833IPLuypvcmu-WupeFb0CvDS7OKJJrdUCEl2emRUkczDbO1raHorsaH7aY_1uX7RToN1GyNZTpSXfMQo-p8zeX8DTndXSSqbMSoYrJ_UXn6NWw4lHSGAFOJr_SVUJYiRZM-63hjsRCFXs7ty4yMrXtDnicRHX7TKXLFDh0el0rmmIg"
    }
}
