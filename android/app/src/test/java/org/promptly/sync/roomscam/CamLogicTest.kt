package org.promptly.sync.roomscam

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class CamLogicTest {
    private val room = "0b3d7f7e-6a53-4c0e-9d0e-5a1f0f3b2c11"
    private val now = 1_800_000_000_000L

    private fun ticket(typ: String = "rooms-camera", room: String = this.room, exp: Long = now / 1000 + 600, sub: String = "u-1"): String {
        fun b64(s: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(s.toByteArray())
        return b64("""{"alg":"HS256","typ":"JWT"}""") + "." +
            b64("""{"typ":"$typ","sub":"$sub","room":"$room","jti":"j","iat":1,"exp":$exp}""") + ".c2lnbmF0dXJl"
    }

    private fun params(server: String = "https://home.example", t: String = ticket(), room: String = this.room, title: String? = "Ann", max: String? = null) =
        mapOf("server" to server, "ticket" to t, "room" to room, "title" to title, "max" to max)

    // ---------------------------------------------------------------- the hand-off

    @Test fun `a hand-off for this app's server is taken`() {
        val h = CamHandoffs.parse(params(), "https://home.example", now)
        assertNotNull(h)
        assertEquals("https://home.example", h!!.server)
        assertEquals(room, h.room)
        assertEquals("u-1", h.user)
        assertEquals("Ann", h.title)
        assertEquals(50L * 1024 * 1024, h.maxBytes)
    }

    @Test fun `the server is compared as an origin, not as text`() {
        assertNotNull(CamHandoffs.parse(params(server = "https://HOME.example:443/rooms"), "https://home.example", now))
        assertNotNull(CamHandoffs.parse(params(server = "http://10.0.2.2:8140"), "http://10.0.2.2:8140/", now))
    }

    @Test fun `another server can't point the camera at itself`() {
        assertNull(CamHandoffs.parse(params(server = "https://evil.example"), "https://home.example", now))
        assertNull(CamHandoffs.parse(params(server = "http://home.example"), "https://home.example", now))
        assertNull(CamHandoffs.parse(params(server = "https://home.example:8443"), "https://home.example", now))
        assertNull(CamHandoffs.parse(params(), null, now))
        assertNull(CamHandoffs.parse(params(server = "javascript:alert(1)"), "https://home.example", now))
    }

    @Test fun `only a camera ticket for that conversation, still good`() {
        val saved = "https://home.example"
        assertNull(CamHandoffs.parse(params(t = ticket(typ = "call")), saved, now))
        assertNull(CamHandoffs.parse(params(t = ticket(room = "11111111-2222-3333-4444-555555555555")), saved, now))
        assertNull(CamHandoffs.parse(params(t = ticket(exp = now / 1000 - 1)), saved, now))
        assertNull(CamHandoffs.parse(params(t = "not.a.ticket-at-all-but-long-enough"), saved, now))
        assertNull(CamHandoffs.parse(params(t = "short"), saved, now))
        assertNull(CamHandoffs.parse(params(room = "not-a-room"), saved, now))
        assertNull(CamHandoffs.parse(params(t = "x".repeat(2001)), saved, now))
    }

    @Test fun `a missing title and a silly size are made safe`() {
        val saved = "https://home.example"
        assertEquals("this conversation", CamHandoffs.parse(params(title = "  "), saved, now)!!.title)
        assertEquals(80, CamHandoffs.parse(params(title = "x".repeat(300)), saved, now)!!.title.length)
        assertEquals(50L * 1024 * 1024, CamHandoffs.parse(params(max = "999999999999"), saved, now)!!.maxBytes)
        assertEquals(5L * 1024 * 1024, CamHandoffs.parse(params(max = "1"), saved, now)!!.maxBytes)
        assertEquals(20L * 1024 * 1024, CamHandoffs.parse(params(max = "${20L * 1024 * 1024}"), saved, now)!!.maxBytes)
        assertEquals(50L * 1024 * 1024, CamHandoffs.parse(params(max = "lots"), saved, now)!!.maxBytes)
    }

    // ---------------------------------------------------------------- zoom

    @Test fun `zoom buttons come from what the lenses can really do`() {
        // Wide, main and a 5x: a recent flagship.
        assertEquals(listOf(0.5f, 1f, 2f, 3f), CamZoom.presets(0.5f, 30f))
        // A wide lens that's really 0.6.
        assertEquals(listOf(0.6f, 1f, 2f, 3f), CamZoom.presets(0.6f, 8f))
        // One lens with digital zoom.
        assertEquals(listOf(1f, 2f, 3f), CamZoom.presets(1f, 4f))
        assertEquals(listOf(1f, 2f), CamZoom.presets(1f, 2f))
        // A front camera that can't zoom: no buttons at all.
        assertEquals(emptyList<Float>(), CamZoom.presets(1f, 1f))
        assertEquals(emptyList<Float>(), CamZoom.presets(1f, 1.2f))
        // Only a wide lens and the main one.
        assertEquals(listOf(0.5f, 1f), CamZoom.presets(0.5f, 1f))
    }

    @Test fun `zoom labels read like a phone's`() {
        assertEquals(".5", CamZoom.label(0.5f))
        assertEquals(".6", CamZoom.label(0.62f))
        assertEquals("1", CamZoom.label(1f))
        assertEquals("2", CamZoom.label(2.04f))
        assertEquals("2.5", CamZoom.label(2.5f))
        assertEquals("10", CamZoom.label(10f))
    }

    @Test fun `the lit button is the lens you're on`() {
        val p = listOf(0.5f, 1f, 2f, 5f)
        assertEquals(0.5f, CamZoom.active(p, 0.5f))
        assertEquals(0.5f, CamZoom.active(p, 0.9f))
        assertEquals(1f, CamZoom.active(p, 1f))
        assertEquals(1f, CamZoom.active(p, 1.9f))
        assertEquals(2f, CamZoom.active(p, 4.9f))
        assertEquals(5f, CamZoom.active(p, 9f))
        assertNull(CamZoom.active(emptyList(), 1f))
    }

    @Test fun `a pinch multiplies and stays inside the lens`() {
        assertEquals(2f, CamZoom.pinch(1f, 2f, 0.5f, 10f), 0.001f)
        assertEquals(10f, CamZoom.pinch(8f, 2f, 0.5f, 10f), 0.001f)
        assertEquals(0.5f, CamZoom.pinch(1f, 0.1f, 0.5f, 10f), 0.001f)
        assertEquals(3f, CamZoom.pinch(3f, Float.NaN, 0.5f, 10f), 0.001f)
        assertEquals(3f, CamZoom.pinch(3f, 0f, 0.5f, 10f), 0.001f)
    }

    @Test fun `sliding up while recording zooms in evenly and never below where it started`() {
        assertEquals(1f, CamZoom.slide(1f, 0f, 500f, 8f), 0.001f)
        assertEquals(1f, CamZoom.slide(1f, -80f, 500f, 8f), 0.001f)
        assertEquals(8f, CamZoom.slide(1f, 500f, 500f, 8f), 0.01f)
        assertEquals(8f, CamZoom.slide(1f, 5000f, 500f, 8f), 0.01f)
        // Half way is the geometric middle (1 -> 8: about 2.83), so it feels even.
        assertEquals(2.828f, CamZoom.slide(1f, 250f, 500f, 8f), 0.01f)
        // Started zoomed in: begins there.
        assertEquals(2f, CamZoom.slide(2f, 0f, 500f, 8f), 0.001f)
        assertEquals(4f, CamZoom.slide(2f, 250f, 500f, 8f), 0.01f)
        // Nothing to zoom to.
        assertEquals(1f, CamZoom.slide(1f, 300f, 500f, 1f), 0.001f)
        assertEquals(1f, CamZoom.slide(1f, 300f, 0f, 8f), 0.001f)
    }

    // ---------------------------------------------------------------- tap or hold

    @Test fun `a quick press is a photo, a hold is a video`() {
        assertEquals(CamPress.Was.PHOTO, CamPress.released(40, recording = false))
        assertEquals(CamPress.Was.PHOTO, CamPress.released(HOLD_MS - 1, recording = false))
        assertEquals(CamPress.Was.VIDEO, CamPress.released(3000, recording = true))
        // Held, but no video could start (asked for the microphone, Night on): not a surprise photo.
        assertEquals(CamPress.Was.NOTHING, CamPress.released(HOLD_MS, recording = false))
        assertEquals(CamPress.Was.NOTHING, CamPress.released(5000, recording = false))
    }

    @Test fun `the ring and the clock`() {
        assertEquals(0f, CamPress.ring(0), 0.0001f)
        assertEquals(0.5f, CamPress.ring(MAX_VIDEO_MS / 2), 0.0001f)
        assertEquals(1f, CamPress.ring(MAX_VIDEO_MS * 3), 0.0001f)
        assertEquals("0:00", CamPress.clock(0))
        assertEquals("0:07", CamPress.clock(7_900))
        assertEquals("0:59", CamPress.clock(59_999))
        assertEquals("1:00", CamPress.clock(60_000))
        assertEquals("1:00", CamPress.clock(90_000))
        assertEquals("0:00", CamPress.clock(-5))
    }

    // ---------------------------------------------------------------- video size

    @Test fun `the longest video always fits in one request`() {
        val max = 50L * 1024 * 1024
        val bits = CamVideo.bits(max)
        val bytes = (bits.toLong() + CamVideo.AUDIO_BITS) * (MAX_VIDEO_MS / 1000) / 8
        assertTrue("a full minute is ${bytes / 1024 / 1024} MB", bytes < max)
        // And it uses the room it has: well over twice the web page's 2.5 megabits.
        assertTrue(bits > 6_000_000)
    }

    @Test fun `bit rate has a ceiling and a floor`() {
        assertEquals(CamVideo.BEST_BITS, CamVideo.bits(1024L * 1024 * 1024))
        assertEquals(CamVideo.LEAST_BITS, CamVideo.bits(5L * 1024 * 1024))
        assertEquals(CamVideo.LEAST_BITS, CamVideo.bits(0))
        assertEquals(CamVideo.LEAST_BITS, CamVideo.bits(50L * 1024 * 1024, maxMs = 0))
    }

    @Test fun `the recording bars cover what a 16 by 9 video leaves out of a 4 by 3 picture`() {
        // 9/16 over 3/4 is three quarters kept: an eighth off each side.
        assertEquals(0.125f, CamVideo.cropEachSide(), 0.0001f)
        assertEquals(0f, CamVideo.cropEachSide(16f, 9f, 16f, 9f), 0.0001f)
    }

    // ---------------------------------------------------------------- names

    @Test fun `files are named for what they are`() {
        val at = java.util.GregorianCalendar(2026, 10, 19, 18, 43, 7).time
        assertEquals("Photo 2026-11-19 18.43.07.jpg", CamNames.file(false, at, "jpg"))
        assertEquals("Video 2026-11-19 18.43.07.mp4", CamNames.file(true, at, "mp4"))
        assertEquals("image/jpeg", CamNames.mime("JPG"))
        assertEquals("video/mp4", CamNames.mime("mp4"))
        assertEquals("image/heic", CamNames.mime("heic"))
        assertEquals("application/octet-stream", CamNames.mime("exe"))
    }

    // ---------------------------------------------------------------- sending

    @Test fun `no answer or a server hiccup is worth trying again`() {
        assertTrue(CamSendRules.failure(null, null).again)
        assertTrue(CamSendRules.failure(500, null).again)
        assertTrue(CamSendRules.failure(502, null).again)
        assertTrue(CamSendRules.failure(429, null).again)
    }

    @Test fun `a refusal is final, and says the picture is safe when it is`() {
        val old = CamSendRules.failure(401, "Open the camera from the conversation again.")
        assertFalse(old.again)
        assertTrue(old.why.contains("saved to this phone"))
        assertFalse(CamSendRules.failure(404, null).again)
        assertFalse(CamSendRules.failure(415, null).again)
        val full = CamSendRules.failure(413, "You've reached your storage limit. Delete some files or ask an admin to raise it.")
        assertFalse(full.again)
        assertEquals("You've reached your storage limit. Delete some files or ask an admin to raise it.", full.why)
        assertFalse(CamSendRules.failure(400, "That file is empty").again)
    }

    @Test fun `in the background it keeps trying only while that could work`() {
        val net = CamSendRules.failure(null, null)
        assertTrue(CamSendRules.retryInBackground(net, 0))
        assertTrue(CamSendRules.retryInBackground(net, 7))
        assertFalse(CamSendRules.retryInBackground(net, 8))
        assertFalse(CamSendRules.retryInBackground(CamSendRules.failure(401, null), 0))
    }

    @Test fun `a blip is retried at once only when nobody is watching and the server never answered`() {
        val net = CamSendRules.failure(null, null)
        assertTrue(CamSendRules.quickRetry(net, watched = false))
        assertFalse(CamSendRules.quickRetry(net, watched = true))
        assertFalse(CamSendRules.quickRetry(CamSendRules.failure(500, null), watched = false))
        assertFalse(CamSendRules.quickRetry(CamSendRules.failure(401, null), watched = false))
        assertFalse(CamSendRules.quickRetry(SendState.Sent, watched = false))
        assertEquals(0L, CamSendRules.QUICK_WAITS_MS.first())
    }

    @Test fun `progress is a share of the file`() {
        assertEquals(0f, CamSendRules.fraction(0, 100), 0.0001f)
        assertEquals(0.25f, CamSendRules.fraction(25, 100), 0.0001f)
        assertEquals(1f, CamSendRules.fraction(500, 100), 0.0001f)
        assertEquals(0f, CamSendRules.fraction(5, 0), 0.0001f)
    }
}
