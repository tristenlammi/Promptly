package org.promptly.sync.maps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PageLocationPolicyTest {
    @Test
    fun `gps only while a page is asking`() {
        val p = PageLocationPolicy(0)
        assertFalse(p.gps)
        p.heard(false, 2_000)
        assertFalse(p.gps)
        p.heard(true, 4_000)
        assertTrue(p.gps)
        assertEquals(1000L, p.pause())
        p.heard(false, 5_000)
        assertFalse("off the moment nobody's asking", p.gps)
        assertEquals(2000L, p.pause())
    }

    @Test
    fun `it ends forty seconds after anyone last asked`() {
        val p = PageLocationPolicy(0)
        p.heard(true, 10_000)
        p.heard(false, 30_000)
        assertFalse(p.finished(49_000))
        assertTrue(p.finished(50_001))
    }

    @Test
    fun `started and never asked ends the same way`() {
        val p = PageLocationPolicy(1_000)
        p.heard(false, 30_000)
        assertFalse(p.finished(40_000))
        assertTrue(p.finished(41_001))
        assertFalse(p.gps)
    }

    @Test
    fun `a short loss of signal keeps the gps, a long one doesn't`() {
        val p = PageLocationPolicy(0)
        p.heard(true, 1_000)
        p.heard(null, 6_000)
        assertTrue(p.gps)
        p.heard(null, 17_000)
        assertFalse(p.gps)
        p.heard(true, 20_000)
        assertTrue("back when the server can be heard again", p.gps)
    }
}
