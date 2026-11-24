package org.promptly.sync.maps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

/** The rules of the timeline and live location (Tracking.kt): nothing waiting is ever
 *  lost or stuck, and the people you share with hear from the phone every few minutes. */
class TrackingTest {
    @get:Rule
    val dir = TemporaryFolder()

    private fun queue(most: Int = 100_000) = TrackQueue(File(dir.root, "timeline-queue.jsonl"), most)

    private fun row(i: Int) = TrackRows.row(1_790_000_000_000L + i * 30_000L, -27.5 + i * 0.001, 153.0, 5f, 13.9f)!!

    // ---- Rows -------------------------------------------------------------------

    @Test
    fun `a position is one line the server can read`() {
        assertEquals(
            "{\"at\":\"2026-09-21T14:13:20Z\",\"lat\":-27.4689000,\"lon\":153.0235000,\"accuracy\":4.5,\"speed\":13.89}",
            TrackRows.row(1_790_000_000_000L, -27.4689, 153.0235, 4.5f, 13.89f),
        )
    }

    @Test
    fun `an odd accuracy or speed is left out and a position that makes no sense is not kept`() {
        val line = TrackRows.row(1_790_000_000_000L, -27.5, 153.0, -1f, Float.NaN)!!
        assertFalse(line.contains("accuracy") || line.contains("speed"))
        assertTrue(TrackRows.whole(line))
        assertNull(TrackRows.row(1_790_000_000_000L, Double.NaN, 153.0, null, null))
        assertNull(TrackRows.row(1_790_000_000_000L, -91.0, 153.0, null, null))
        assertNull(TrackRows.row(1_790_000_000_000L, -27.5, 181.0, null, null))
        assertNull(TrackRows.row(0L, -27.5, 153.0, null, null))
    }

    @Test
    fun `a gps chip with the wrong date doesnt file the day years away`() {
        val now = 1_790_000_000_000L
        // Right, give or take: the fix's own time stands.
        assertEquals(now - 1_500, TrackRows.fixTime(now - 1_500, 1_000, now))
        // 1024 weeks out (a real fault in older chips): the phone's clock, less the fix's age.
        val rolled = now - 1024L * 7 * 24 * 3600 * 1000
        assertEquals(now - 4_000, TrackRows.fixTime(rolled, 4_000, now))
        assertEquals(now, TrackRows.fixTime(0, 0, now))
    }

    @Test
    fun `the timeline keeps a point when you move or every couple of minutes`() {
        assertFalse("another app has GPS on every second", TrackRows.worthKeeping(20f, 1_000))
        assertTrue(TrackRows.worthKeeping(20f, 30_000))
        assertFalse("waiting at the lights", TrackRows.worthKeeping(3f, 30_000))
        assertTrue("staying somewhere still shows", TrackRows.worthKeeping(0f, 120_000))
    }

    // ---- The queue --------------------------------------------------------------

    @Test
    fun `what is waiting survives the app being stopped`() {
        queue().apply { add(row(1)); add(row(2)) }
        // A new process, a new object, the same file.
        assertEquals(listOf(row(1), row(2)), queue().rows())
    }

    @Test
    fun `a half written line is ignored and doesnt take the next one with it`() {
        val q = queue()
        q.add(row(1))
        // Killed mid-write: no end of line.
        File(dir.root, "timeline-queue.jsonl").appendText("{\"at\":\"2026-09-21T14:1")
        q.add(row(2))
        File(dir.root, "timeline-queue.jsonl").appendText("not json at all\n\n" + row(3) + row(4) + "\n")
        q.add(row(5))
        assertEquals(listOf(row(1), row(2), row(5)), q.rows())
        // And the rubbish is gone from the file after the next send.
        q.drop(listOf(row(1)))
        assertEquals((row(2) + "\n" + row(5) + "\n"), File(dir.root, "timeline-queue.jsonl").readText())
    }

    @Test
    fun `the old apps rows are still good`() {
        // As 1.17 wrote them (org.json, keys in the order they were put).
        File(dir.root, "timeline-queue.jsonl").writeText("{\"at\":\"2026-11-20T01:02:03Z\",\"lat\":-27.5,\"lon\":153.01,\"accuracy\":4.5,\"speed\":12.25}\n{\"at\":\"2026-11-20T01:02:33.120Z\",\"lat\":-27.51,\"lon\":153.02}\n")
        assertEquals(2, queue().size())
    }

    @Test
    fun `only what was sent is dropped`() {
        val q = queue()
        (1..5).forEach { q.add(row(it)) }
        q.drop(listOf(row(1), row(2)))
        q.add(row(6))
        assertEquals(listOf(row(3), row(4), row(5), row(6)), q.rows())
        q.drop(q.rows())
        assertEquals(0, q.size())
        assertFalse(File(dir.root, "timeline-queue.jsonl").exists())
    }

    @Test
    fun `a queue that cant be sent for weeks stops growing and keeps the newest`() {
        val q = queue(most = 600)
        (1..1500).forEach { q.add(row(it)) }
        assertTrue(q.size() <= 1100)
        assertEquals(row(1500), q.rows().last())
    }

    // ---- Sending ----------------------------------------------------------------

    @Test
    fun `everything waiting goes oldest first in batches`() {
        val q = queue()
        (1..1200).forEach { q.add(row(it)) }
        val sizes = mutableListOf<Int>()
        val first = mutableListOf<String>()
        val r = Uploader.flush(q) { rows ->
            sizes += rows.size
            first += rows.first()
            Sent.Ok()
        }
        assertEquals(listOf(500, 500, 200), sizes)
        assertEquals(listOf(row(1), row(501), row(1001)), first)
        assertEquals(Flushed(sent = 1200, dropped = 0, left = 0, problem = null, paused = false), r)
    }

    @Test
    fun `one row the server wont have is dropped alone and the rest go`() {
        val q = queue()
        (1..40).forEach { q.add(row(it)) }
        val bad = row(17)
        var calls = 0
        val r = Uploader.flush(q) { rows ->
            calls++
            if (bad in rows) Sent.Refused else Sent.Ok()
        }
        assertEquals(39, r.sent)
        assertEquals(1, r.dropped)
        assertEquals(0, r.left)
        assertNull(r.problem)
        assertTrue("found by halving, not one request a row", calls < 15)
    }

    @Test
    fun `no signal keeps everything and says so`() {
        val q = queue()
        (1..700).forEach { q.add(row(it)) }
        var calls = 0
        val r = Uploader.flush(q) { rows ->
            calls++
            if (calls == 1) Sent.Ok() else throw IOException("timeout")
        }
        assertEquals(Flushed(sent = 500, dropped = 0, left = 200, problem = Problem.NO_SIGNAL, paused = false), r)
        assertEquals(row(501), q.rows().first())
        // The next go sends the rest.
        assertEquals(200, Uploader.flush(q) { Sent.Ok() }.sent)
    }

    @Test
    fun `a phone that isnt linked any more keeps what it has and says so`() {
        val q = queue()
        (1..10).forEach { q.add(row(it)) }
        val r = Uploader.flush(q) { Sent.of(401) }
        assertEquals(Problem.SIGNED_OUT, r.problem)
        assertEquals(10, r.left)
        assertEquals(Problem.SERVER, Uploader.flush(q) { Sent.of(502) }.problem)
        assertEquals(10, q.size())
    }

    @Test
    fun `paused somewhere else stops and forgets what was waiting`() {
        val q = queue()
        (1..600).forEach { q.add(row(it)) }
        val r = Uploader.flush(q) { Sent.Ok(timelineOn = false) }
        assertTrue(r.paused)
        assertEquals(0, q.size())
    }

    @Test
    fun `what an answer from the server means`() {
        assertEquals(Sent.Ok(), Sent.of(200))
        assertEquals(Sent.SignedOut, Sent.of(401))
        assertEquals(Sent.SignedOut, Sent.of(403))
        assertEquals(Sent.Refused, Sent.of(422))
        assertEquals(Sent.Refused, Sent.of(404))
        assertEquals(Sent.Later(Problem.SERVER), Sent.of(500))
        assertEquals(Sent.Later(Problem.SERVER), Sent.of(429))
    }

    // ---- Moving or staying put ----------------------------------------------------

    @Test
    fun `a parked car goes to the slow mode even when gps says nothing`() {
        val m = Motion(0)
        assertTrue(m.moving)
        m.fix(1_000, -27.5, 153.0, 5f)
        assertFalse(m.tick(9 * 60_000L))
        assertTrue("ten minutes without going anywhere", m.tick(11 * 60_000L))
        assertFalse(m.moving)
        assertFalse(m.tick(12 * 60_000L))
    }

    @Test
    fun `driving off wakes it up and driving keeps it awake`() {
        val m = Motion(0, moving = false)
        m.fix(0, -27.5, 153.0, 5f)
        assertFalse(m.fix(60_000, -27.5001, 153.0, 5f)) // 11 m: still here
        assertTrue(m.fix(120_000, -27.503, 153.0, 5f)) // 330 m: off we go
        assertTrue(m.moving)
        var t = 120_000L
        var lat = -27.503
        repeat(60) {
            t += 30_000
            lat -= 0.004
            assertFalse(m.fix(t, lat, 153.0, 5f))
        }
        assertTrue("half an hour of driving", m.moving)
    }

    @Test
    fun `a slow walk still counts as going somewhere`() {
        val m = Motion(0)
        var lat = -27.5
        var t = 0L
        repeat(40) {
            t += 30_000
            lat -= 0.0003 // about 33 m each half minute
            m.fix(t, lat, 153.0, 8f)
        }
        assertTrue(m.moving)
    }

    @Test
    fun `a phone on a desk hopping between wifi guesses isnt driving`() {
        val m = Motion(0, moving = false)
        m.fix(0, -27.5, 153.0, 400f)
        assertFalse(m.fix(180_000, -27.503, 153.0, 400f)) // 330 m away, give or take 400
        assertFalse(m.moving)
        assertTrue(m.fix(360_000, -27.52, 153.0, 400f)) // 2 km: that's real
    }

    // ---- Live location ------------------------------------------------------------

    @Test
    fun `how often the people you share with hear from the phone`() {
        assertEquals(60_000L, LiveBeat.gap(sharing = true, moving = true, worked = true))
        assertEquals(180_000L, LiveBeat.gap(sharing = true, moving = false, worked = true))
        assertEquals(30_000L, LiveBeat.gap(sharing = true, moving = true, worked = false))
        assertEquals(30_000L, LiveBeat.gap(sharing = true, moving = false, worked = false))
        assertEquals(300_000L, LiveBeat.gap(sharing = false, moving = true, worked = true))
        assertTrue("straight away when it starts", LiveBeat.due(5_000, 0, sharing = true, moving = false, worked = true))
        assertFalse(LiveBeat.due(100_000, 50_000, sharing = true, moving = true, worked = true))
        assertTrue(LiveBeat.due(110_000, 50_000, sharing = true, moving = true, worked = true))
    }

    /** A day as the service lives it: a beat every half minute; count what's sent. */
    private fun sends(minutes: Int, moving: (Long) -> Boolean, works: (Long) -> Boolean = { true }): List<Long> {
        val out = mutableListOf<Long>()
        var lastTry = 0L
        var worked = true
        var t = 1_000L
        while (t <= minutes * 60_000L) {
            if (LiveBeat.due(t, lastTry, sharing = true, moving = moving(t), worked = worked)) {
                lastTry = t
                worked = works(t)
                if (worked) out += t
            }
            t += 30_000
        }
        return out
    }

    @Test
    fun `sitting still for an hour is a heartbeat at least every three and a half minutes`() {
        val at = sends(60, moving = { false })
        assertTrue(at.size >= 18)
        assertTrue(at.zipWithNext { a, b -> b - a }.max() <= 210_000L)
    }

    @Test
    fun `driving for an hour is a position every minute`() {
        val at = sends(60, moving = { true })
        assertTrue(at.size >= 58)
        assertTrue(at.zipWithNext { a, b -> b - a }.max() <= 60_000L)
    }

    @Test
    fun `after a tunnel the newest position goes within half a minute`() {
        // No signal from minute 10 to minute 20.
        val at = sends(30, moving = { true }, works = { it < 10 * 60_000L || it >= 20 * 60_000L })
        val after = at.first { it >= 20 * 60_000L }
        assertTrue(after - 20 * 60_000L <= 30_000L)
    }

    @Test
    fun `an old place is never sent as where you are while you are moving`() {
        assertTrue(LiveBeat.sendable(moving = true, fixAgeMs = 45_000))
        assertFalse(LiveBeat.sendable(moving = true, fixAgeMs = 5 * 60_000L))
        // Staying put, the same place again is exactly the point.
        assertTrue(LiveBeat.sendable(moving = false, fixAgeMs = 40 * 60_000L))
    }

    // ---- What should be running ---------------------------------------------------

    @Test
    fun `the service runs for the timeline or for sharing and stops when neither`() {
        assertTrue(Wanted.running(timeline = true, sharing = false))
        assertTrue("sharing with the timeline off", Wanted.running(timeline = false, sharing = true))
        assertFalse(Wanted.running(timeline = false, sharing = false))
    }

    @Test
    fun `a share that has run out stops by itself even if the phone cant ask`() {
        assertTrue(Wanted.sharing(saidSharing = true, until = 0, now = 5_000))
        assertTrue(Wanted.sharing(saidSharing = true, until = 10_000, now = 5_000))
        assertFalse(Wanted.sharing(saidSharing = true, until = 10_000, now = 10_000))
        assertFalse(Wanted.sharing(saidSharing = false, until = 0, now = 5_000))
    }

    // ---- Words ---------------------------------------------------------------------

    @Test
    fun `the screen says what is really happening`() {
        val now = 1_790_000_000_000L
        val dead = TrackView(timeline = true, sharing = false, running = false, fixAt = now - 3 * 24 * 3_600_000L, sentAt = now - 3 * 24 * 3_600_000L, liveAt = 0, waiting = 412, problem = Problem.BLOCKED)
        assertTrue(dead.headline().startsWith("Not running."))
        assertEquals(
            listOf("Last position: 3 days ago.", "Last sent to your server: 3 days ago.", "412 positions waiting to send."),
            dead.lines(now),
        )
        val fine = TrackView(timeline = true, sharing = true, running = true, fixAt = now - 20_000, sentAt = now - 4 * 60_000L, liveAt = now - 70_000, waiting = 0, problem = null)
        assertEquals("Recording your timeline and sharing your location.", fine.headline())
        assertEquals(
            listOf("Last position: just now.", "Last sent to your server: 4 min ago.", "Nothing waiting to send.", "Last sent to the people you share with: 1 min ago."),
            fine.lines(now),
        )
        val off = TrackView(false, false, false, 0, 0, 0, 0, null)
        assertEquals("Off. Nothing is recorded or sent.", off.headline())
        assertTrue(off.lines(now).isEmpty())
        assertEquals("Sharing your location.", TrackView(false, true, true, now, 0, now, 0, null).headline())
    }

    @Test
    fun `every problem has a name the server knows and plain words`() {
        assertEquals(setOf("permission", "background", "location_off", "blocked", "signed_out", "no_signal", "server"), Problem.entries.map { it.code }.toSet())
        Problem.entries.forEach {
            assertEquals(it, Problem.of(it.code))
            assertTrue(it.words.endsWith("."))
        }
        assertNull(Problem.of("something else"))
        assertNull(Problem.of(null))
    }

    @Test
    fun `ago in words`() {
        assertEquals("just now", Ago.words(20_000))
        assertEquals("12 min ago", Ago.words(12 * 60_000L))
        assertEquals("5 h ago", Ago.words(5 * 3_600_000L))
        assertEquals("4 days ago", Ago.words(4 * 24 * 3_600_000L))
    }
}
