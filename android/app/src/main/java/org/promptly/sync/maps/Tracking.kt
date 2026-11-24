package org.promptly.sync.maps

import java.io.File
import java.time.Instant
import java.util.Locale

/*
 * The thinking behind the timeline and live location, with no Android in it, so
 * every rule here is tested (TrackingTest): what's kept and how it's sent, when the
 * phone counts as moving, how often a position goes to the people you share with,
 * and the plain words for what's wrong.
 */

/** What's wrong, by a name the server knows ([code]) and in words for the screen. */
enum class Problem(val code: String, val words: String) {
    PERMISSION("permission", "Promptly isn't allowed to use this phone's location."),
    BACKGROUND("background", "Location is only allowed while the app is open. Choose \"Allow all the time\" so it keeps going with the screen off."),
    LOCATION_OFF("location_off", "Location is switched off on this phone."),
    BLOCKED("blocked", "Android stopped it and wouldn't let it start again by itself. It starts again whenever you open Promptly."),
    SIGNED_OUT("signed_out", "This phone isn't linked to your server any more. Open Your timeline in P Maps on this phone to link it again."),
    NO_SIGNAL("no_signal", "Couldn't reach your server. It keeps what it has and tries again."),
    SERVER("server", "Your server had a problem. It keeps what it has and tries again."),
    ;

    companion object {
        fun of(code: String?): Problem? = entries.firstOrNull { it.code == code }
    }
}

/** How a request to the server went. */
sealed class Sent {
    /** Taken. [timelineOn] false: the timeline was paused somewhere else. */
    data class Ok(val timelineOn: Boolean = true, val sharing: Boolean = false) : Sent()

    /** The server understood and said no to what was sent (a 4xx that isn't about who's asking). */
    object Refused : Sent()

    /** The phone's sign-in isn't good any more (401, 403). */
    object SignedOut : Sent()

    /** No answer, or the server fell over: the same thing again later is right. */
    data class Later(val problem: Problem) : Sent()

    companion object {
        /** From an HTTP status. */
        fun of(code: Int): Sent = when {
            code in 200..299 -> Ok()
            code == 401 || code == 403 -> SignedOut
            code == 408 || code == 429 || code >= 500 -> Later(Problem.SERVER)
            else -> Refused
        }
    }
}

object TrackRows {
    /** One position as the line that's kept and sent, or null for one that makes no sense
     *  (it would only be refused). An odd accuracy or speed is left out, not fatal. */
    fun row(atMs: Long, lat: Double, lon: Double, accuracy: Float?, speed: Float?): String? {
        if (lat.isNaN() || lon.isNaN() || lat < -90 || lat > 90 || lon < -180 || lon > 180 || atMs <= 0) return null
        val out = StringBuilder("{\"at\":\"").append(Instant.ofEpochMilli(atMs)).append("\",\"lat\":").append(num(lat)).append(",\"lon\":").append(num(lon))
        if (accuracy != null && accuracy.isFinite() && accuracy >= 0f) out.append(",\"accuracy\":").append(num(accuracy.toDouble(), 1))
        if (speed != null && speed.isFinite() && speed >= 0f) out.append(",\"speed\":").append(num(speed.toDouble(), 2))
        return out.append('}').toString()
    }

    private fun num(v: Double, places: Int = 7): String = String.format(Locale.US, "%.${places}f", v)

    /** A line worth sending: one whole row, as [row] writes them. A half-written line
     *  (the app was killed mid-write) or two run together is not. */
    fun whole(line: String): Boolean =
        line.startsWith("{\"at\":\"") && line.endsWith("}") && line.indexOf('{', 1) < 0 && line.indexOf('}') == line.length - 1 &&
            line.contains("\",\"lat\":") && line.contains(",\"lon\":")

    /** When a fix was taken. The phone's own clock, less how old the fix is: a GPS chip
     *  with the wrong date (it happens after a week-number rollover) would otherwise file
     *  the position years away, on a day nobody looks at. */
    fun fixTime(fixMs: Long, ageMs: Long, nowMs: Long): Long {
        val byClock = nowMs - ageMs.coerceIn(0, 10 * 60_000L)
        return if (kotlin.math.abs(fixMs - byClock) <= 2 * 60_000L) fixMs else byClock
    }

    /** Whether a new position adds anything to the timeline: [metres] from the last
     *  one kept, [sinceMs] after it. Not one every second because another app has the
     *  GPS on; not a pile of the same spot while you wait at the lights; but still one
     *  every couple of minutes where you're staying, which is what shows a stay. */
    fun worthKeeping(metres: Float, sinceMs: Long): Boolean =
        sinceMs >= 120_000L || (sinceMs >= 20_000L && metres >= 15f)

    fun body(lines: List<String>): String = lines.joinToString(",", "{\"points\":[", "]}")
}

/** Positions waiting to be sent, one a line, in a file that outlives the app being
 *  stopped, updated or the phone restarting. Oldest first. */
class TrackQueue(private val file: File, private val most: Int = 100_000) {
    /** Keep one more. Past [most] (about a month of driving all day with no signal), the oldest go. */
    fun add(line: String) = synchronized(LOCK) {
        file.parentFile?.mkdirs()
        // A file that ends mid-line (the last write was cut short) gets its line ended
        // first, so this row isn't glued to the broken one and lost with it.
        val glue = file.length().let { n -> n > 0 && file.inputStream().use { it.skip(n - 1); it.read() } != '\n'.code }
        file.appendText((if (glue) "\n" else "") + line + "\n")
        added++
        if (added % 500 == 0 && rows().size > most) write(rows().takeLast(most))
    }

    private var added = 0

    /** Every whole row waiting. Anything else in the file is ignored (and goes at the next [drop]). */
    fun rows(): List<String> = synchronized(LOCK) {
        if (!file.exists()) emptyList() else file.readLines().filter { TrackRows.whole(it) }
    }

    fun size(): Int = rows().size

    /** These went (or can never go): forget them. Rows added meanwhile stay. */
    fun drop(lines: Collection<String>) = synchronized(LOCK) {
        if (lines.isEmpty()) return@synchronized
        val gone = lines.groupingBy { it }.eachCount().toMutableMap()
        write(rows().filter { row ->
            val n = gone[row] ?: 0
            if (n > 0) gone[row] = n - 1
            n == 0
        })
    }

    fun clear() = synchronized(LOCK) { file.delete(); Unit }

    private fun write(rows: List<String>) {
        if (rows.isEmpty()) {
            file.delete()
            return
        }
        // Written beside it and swapped in, so being stopped half-way loses nothing.
        val fresh = File(file.parentFile, file.name + ".new")
        fresh.writeText(rows.joinToString("") { it + "\n" })
        if (!fresh.renameTo(file)) {
            file.writeText(fresh.readText())
            fresh.delete()
        }
    }

    private companion object {
        /** One lock for every queue in the app: the service and the periodic check share the file. */
        val LOCK = Any()
    }
}

/** What a go at sending the queue came to. */
data class Flushed(val sent: Int, val dropped: Int, val left: Int, val problem: Problem?, val paused: Boolean)

object Uploader {
    private val busy = Any()

    /**
     * Send what's waiting, oldest first, [batch] at a time. One at a time across the app.
     *
     * - Taken: those rows go from the queue.
     * - Refused: the batch is halved until the row the server won't have is alone, and
     *   only that one is dropped. A bad row can't hold the rest back for ever.
     * - Signed out, no signal, server trouble: stop, keep everything, say which.
     * - "The timeline is paused": stop and forget what's waiting, as you asked elsewhere.
     */
    fun flush(queue: TrackQueue, batch: Int = 500, send: (List<String>) -> Sent): Flushed = synchronized(busy) {
        var sent = 0
        var dropped = 0
        var problem: Problem? = null
        var paused = false
        val waiting = ArrayDeque(queue.rows().chunked(batch))
        loop@ while (waiting.isNotEmpty()) {
            val rows = waiting.removeFirst()
            when (val answer = try { send(rows) } catch (e: Exception) { Sent.Later(Problem.NO_SIGNAL) }) {
                is Sent.Ok -> {
                    queue.drop(rows)
                    sent += rows.size
                    if (!answer.timelineOn) {
                        queue.clear()
                        paused = true
                        break@loop
                    }
                }
                Sent.Refused -> if (rows.size == 1) {
                    queue.drop(rows)
                    dropped++
                } else {
                    val half = rows.size / 2
                    waiting.addFirst(rows.subList(half, rows.size))
                    waiting.addFirst(rows.subList(0, half))
                }
                Sent.SignedOut -> {
                    problem = Problem.SIGNED_OUT
                    break@loop
                }
                is Sent.Later -> {
                    problem = answer.problem
                    break@loop
                }
            }
        }
        Flushed(sent, dropped, queue.size(), problem, paused)
    }
}

/** Whether the phone is going somewhere or staying put. Moving: GPS every half minute.
 *  Still for ten minutes: a look every few minutes, to go easy on the battery. */
class Motion(startedAt: Long, moving: Boolean = true) {
    var moving = moving
        private set
    private var movedAt = startedAt
    private var lat = Double.NaN
    private var lon = Double.NaN

    /** A fix at [now], [metres] of doubt around it. Returns true if [moving] changed.
     *  It only counts as having gone somewhere when it's further than the doubt: a
     *  phone on a desk hopping between Wi-Fi guesses isn't driving. */
    fun fix(now: Long, lat: Double, lon: Double, metres: Float): Boolean {
        val far = !this.lat.isNaN() && distance(this.lat, this.lon, lat, lon) > maxOf(MOVED_METRES, metres.toDouble() * 1.5)
        if (this.lat.isNaN() || far) {
            // Where "here" is, to measure the next from. Not every fix: a slow walk
            // would never be 100 m from the one before.
            this.lat = lat
            this.lon = lon
        }
        if (far) {
            movedAt = now
            if (!moving) {
                moving = true
                return true
            }
        }
        return tick(now)
    }

    /** Time passing with or without a fix (a parked car's GPS, set to speak only after
     *  25 m, says nothing at all). Returns true if [moving] changed. */
    fun tick(now: Long): Boolean {
        if (moving && now - movedAt > STILL_AFTER_MS) {
            moving = false
            return true
        }
        return false
    }

    companion object {
        const val MOVED_METRES = 100.0
        const val STILL_AFTER_MS = 10 * 60_000L

        fun distance(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
            val r = 6_371_000.0
            val dLat = Math.toRadians(lat2 - lat1)
            val dLon = Math.toRadians(lon2 - lon1)
            val a = Math.sin(dLat / 2).let { it * it } + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.sin(dLon / 2).let { it * it }
            return 2 * r * Math.asin(Math.sqrt(a))
        }
    }
}

/** How often your position goes to the people you're sharing with. */
object LiveBeat {
    /** Moving: every minute. */
    const val MOVING_MS = 60_000L

    /** Staying put: the same place again every three minutes, so the people watching
     *  see "updated 2 min ago" and know the phone is still there. */
    const val STILL_MS = 3 * 60_000L

    /** Sharing with nobody: ask the server now and then whether that's changed. */
    const val ASK_MS = 5 * 60_000L

    /** The last one didn't get through: again soon, with wherever you are by then. */
    const val RETRY_MS = 30_000L

    /** A position this old isn't "where you are" for someone on the move. */
    const val MOVING_FIX_GOOD_MS = 2 * 60_000L

    /** How long after the last go (at [lastTry], which [worked] or didn't) the next is due. */
    fun gap(sharing: Boolean, moving: Boolean, worked: Boolean): Long = when {
        !sharing -> ASK_MS
        !worked -> RETRY_MS
        moving -> MOVING_MS
        else -> STILL_MS
    }

    fun due(now: Long, lastTry: Long, sharing: Boolean, moving: Boolean, worked: Boolean): Boolean =
        lastTry == 0L || now - lastTry >= gap(sharing, moving, worked)

    /** Whether a position taken [fixAgeMs] ago may be sent as where you are now. Staying
     *  put, yes: that's the heartbeat. Moving, only a recent one: an old place sent with
     *  a fresh time would tell people you're somewhere you've left. */
    fun sendable(moving: Boolean, fixAgeMs: Long): Boolean = !moving || fixAgeMs <= MOVING_FIX_GOOD_MS

    /** How often the phone looks at all (GPS when moving; anything cheaper when still). */
    fun fixEvery(moving: Boolean): Long = if (moving) 30_000L else STILL_MS
}

/** What the phone should be doing in the background, from what you've switched on. */
object Wanted {
    /** The service runs for either: recording the timeline, or sending to people. */
    fun running(timeline: Boolean, sharing: Boolean): Boolean = timeline || sharing

    /** Sharing as last heard from the server holds until then ([until], 0 for "until
     *  you stop"); after, the phone stops by itself even if it can't ask. */
    fun sharing(saidSharing: Boolean, until: Long, now: Long): Boolean = saidSharing && (until == 0L || now < until)
}

/** How the timeline screen offers "run in the background without battery limits".
 *  The APK from your own server asks Android directly ([direct]: its one-tap dialog).
 *  The Google Play build must not (Play only allows that for a few kinds of app): it
 *  opens Android's battery list instead, with a line ([hint]) saying what to pick. */
data class BackgroundAsk(val direct: Boolean, val button: String, val hint: String?) {
    companion object {
        /** [ownApk]: the build your server hands out (BuildConfig.SELF_UPDATE), not Play's. */
        fun of(ownApk: Boolean): BackgroundAsk =
            if (ownApk) {
                BackgroundAsk(direct = true, button = "Allow running in the background", hint = null)
            } else {
                BackgroundAsk(
                    direct = false,
                    button = "Open battery settings",
                    hint = "In the list that opens, choose \"All apps\", find Promptly and pick \"Don't optimise\" (some phones say \"Unrestricted\").",
                )
            }
    }
}

/** "2 min ago", "3 h ago", for the screen. */
object Ago {
    fun words(ms: Long): String = when {
        ms < 0 -> "just now"
        ms < 60_000L -> "just now"
        ms < 3_600_000L -> "${ms / 60_000L} min ago"
        ms < 48 * 3_600_000L -> "${ms / 3_600_000L} h ago"
        else -> "${ms / (24 * 3_600_000L)} days ago"
    }
}
