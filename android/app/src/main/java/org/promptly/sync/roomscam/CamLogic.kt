package org.promptly.sync.roomscam

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import org.promptly.sync.voice.VoiceProtocol
import java.util.Base64
import java.util.Locale
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.roundToInt

/*
 * The Rooms camera's rules, with no Android in them (so they have plain
 * tests): what a hand-off from the page may be, the zoom buttons, tap or
 * hold, the recording ring, how big a video may get, and where a send is up
 * to.
 */

/** A conversation the page asked the camera to send to. */
data class CamHandoff(
    val server: String,
    val ticket: String,
    val room: String,
    val user: String,
    /** Who it's going to, for the Send button. */
    val title: String,
    val expiresAt: Long,
    /** The most the server takes in one request. */
    val maxBytes: Long,
    /** The most it takes in pieces (resumable uploads), or 0 when those are off. */
    val bigBytes: Long = 0,
    /** Where the pieces go (a path on [server]), or "" when resumable uploads are off. */
    val tus: String = "",
) {
    /** The biggest file this camera may make. */
    val limit: Long get() = if (tus.isNotEmpty()) maxOf(maxBytes, bigBytes) else maxBytes
}

object CamHandoffs {
    private val json = Json { ignoreUnknownKeys = true }
    private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    data class Claims(val user: String, val room: String, val expiresAt: Long)

    /** One request to the server carries at most this (`rooms/uploads.py::DIRECT_MAX_BYTES`). */
    const val DEFAULT_MAX_BYTES = 50L * 1024 * 1024

    /** The most this camera will ever make, whatever a page says (`rooms/camera.py::BIG_MAX_BYTES`). */
    const val MAX_BIG_BYTES = 150L * 1024 * 1024
    private val TUS_PATH = Regex("^/api/[A-Za-z0-9/_-]{1,80}/$")

    /**
     * The page's hand-off (`promptly://rooms/camera?server=…&ticket=…&room=…&title=…`),
     * or null when it mustn't be taken: another server than this app's (a
     * page elsewhere can't point your camera at its own server), not a
     * camera ticket, a ticket for another conversation, run out, or junk.
     * The ticket itself is checked by the server; this only refuses what
     * could never be right.
     */
    fun parse(params: Map<String, String?>, savedServer: String?, now: Long): CamHandoff? {
        val server = VoiceProtocol.origin(params["server"]) ?: return null
        val saved = VoiceProtocol.origin(savedServer) ?: return null
        if (server != saved) return null
        val ticket = params["ticket"]?.takeIf { it.length in 20..2000 } ?: return null
        val room = params["room"]?.takeIf { UUID.matches(it) }?.lowercase() ?: return null
        val claims = claims(ticket) ?: return null
        if (claims.room != room || claims.expiresAt <= now) return null
        val title = params["title"]?.trim()?.take(80)?.ifBlank { null } ?: "this conversation"
        val max = (params["max"]?.toLongOrNull() ?: DEFAULT_MAX_BYTES).coerceIn(5L * 1024 * 1024, DEFAULT_MAX_BYTES)
        // In pieces only to the server's own upload path: never an address a page made up.
        val tus = params["tus"]?.takeIf { TUS_PATH.matches(it) } ?: ""
        val big = if (tus.isEmpty()) 0L else (params["big"]?.toLongOrNull() ?: 0L).coerceIn(0L, MAX_BIG_BYTES)
        return CamHandoff(server, ticket, room, claims.user, title, claims.expiresAt, max, big, if (big > max) tus else "")
    }

    /** A camera ticket's claims (a JWT, `typ: "rooms-camera"`), unverified. */
    fun claims(token: String): Claims? {
        val parts = token.split('.')
        if (parts.size != 3) return null
        val raw = parts[1]
        val payload = runCatching { String(Base64.getUrlDecoder().decode(raw + "=".repeat((4 - raw.length % 4) % 4))) }.getOrNull() ?: return null
        val o = runCatching { json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: return null
        if (o.str("typ") != "rooms-camera") return null
        val user = o.str("sub") ?: return null
        val room = o.str("room")?.lowercase() ?: return null
        val exp = (o["exp"] as? JsonPrimitive)?.longOrNull ?: return null
        return Claims(user, room, exp * 1000)
    }

    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
}

// ==================================================================== zoom

object CamZoom {
    /** Steps a phone camera offers, when the lens range reaches them. */
    private val STEPS = listOf(2f, 3f, 5f, 10f)

    /**
     * The zoom buttons for a camera whose zoom goes from [min] to [max]
     * (1 = the main lens). Below 1 is the wide lens, shown as what it really
     * is (".5", ".6"). At most four buttons, always including 1; a camera
     * that can't zoom gets none.
     */
    fun presets(min: Float, max: Float): List<Float> {
        if (!(max > min) || max < 1.5f && min > 0.95f) return emptyList()
        val out = mutableListOf<Float>()
        if (min <= 0.95f) out += (min * 10).roundToInt() / 10f
        out += 1f
        for (s in STEPS) if (s <= max + 0.01f && out.size < 4) out += s
        return if (out.size < 2) emptyList() else out
    }

    /** ".5", "1", "2", "2.5": what's on a zoom button and in the readout. */
    fun label(ratio: Float): String {
        val r = (ratio * 10).roundToInt() / 10f
        return when {
            r < 1f -> String.format(Locale.US, "%.1f", r).removePrefix("0")
            abs(r - r.roundToInt()) < 0.05f -> r.roundToInt().toString()
            else -> String.format(Locale.US, "%.1f", r)
        }
    }

    /** The button that's lit: the nearest preset at or below [ratio]. */
    fun active(presets: List<Float>, ratio: Float): Float? = presets.lastOrNull { it <= ratio + 0.05f } ?: presets.firstOrNull()

    fun clamp(ratio: Float, min: Float, max: Float): Float = ratio.coerceIn(min, maxOf(min, max))

    /** A pinch: the fingers' spread multiplies the zoom. */
    fun pinch(current: Float, scale: Float, min: Float, max: Float): Float =
        if (scale.isNaN() || scale <= 0f) current else clamp(current * scale, min, max)

    /**
     * Sliding a finger up while holding the button zooms in, evenly to the
     * eye (each centimetre multiplies): [start] at no travel, [max] after
     * [fullTravelPx]. Sliding back down comes back to [start], never under.
     */
    fun slide(start: Float, upPx: Float, fullTravelPx: Float, max: Float): Float {
        if (fullTravelPx <= 0f || max <= start || upPx <= 0f) return start
        val t = (upPx / fullTravelPx).coerceIn(0f, 1f)
        return exp(ln(start) + t * (ln(max) - ln(start))).coerceIn(start, max)
    }
}

// ==================================================================== tap or hold

/** How long a press is before it's a hold (and a video starts). */
const val HOLD_MS = 280L

/** The longest video. */
const val MAX_VIDEO_MS = 60_000L

/** A recording shorter than this was a slip: nothing to keep. */
const val MIN_VIDEO_MS = 600L

object CamPress {
    enum class Was { PHOTO, VIDEO, NOTHING }

    /** What letting go means, [heldMs] after pressing; [recording] if a video did start. */
    fun released(heldMs: Long, recording: Boolean): Was = when {
        recording -> Was.VIDEO
        heldMs < HOLD_MS -> Was.PHOTO
        // Held long enough for a video, but one couldn't start: not a photo by surprise.
        else -> Was.NOTHING
    }

    /** How full the ring round the button is. */
    fun ring(elapsedMs: Long): Float = (elapsedMs.toFloat() / MAX_VIDEO_MS).coerceIn(0f, 1f)

    /** "0:07". */
    fun clock(elapsedMs: Long): String {
        val s = (elapsedMs.coerceAtLeast(0) / 1000).coerceAtMost(MAX_VIDEO_MS / 1000)
        return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
    }
}

// ==================================================================== video size

object CamVideo {
    const val AUDIO_BITS = 128_000

    /** What a phone's own camera uses for 1080p is about this; more is wasted on a chat. */
    const val BEST_BITS = 12_000_000

    /** Never so squeezed it looks like a web page's camera again. */
    const val LEAST_BITS = 3_000_000

    /**
     * The video bit rate that keeps the longest video under [maxBytes] (what
     * the server takes in one go), with a little room for the file's own
     * overhead. As good as the limit allows, up to [BEST_BITS].
     */
    fun bits(maxBytes: Long, maxMs: Long = MAX_VIDEO_MS): Int {
        if (maxBytes <= 0 || maxMs <= 0) return LEAST_BITS
        val room = (maxBytes * 8 * 0.93 / (maxMs / 1000.0)).toLong() - AUDIO_BITS
        return room.coerceIn(LEAST_BITS.toLong(), BEST_BITS.toLong()).toInt()
    }

    /**
     * A 16:9 video is cut from the middle of the 4:3 picture the viewfinder
     * shows: the share of the viewfinder's short side each edge loses. Drawn
     * as two soft bars while recording, so what you see is what's kept.
     */
    fun cropEachSide(viewLong: Float = 4f, viewShort: Float = 3f, videoLong: Float = 16f, videoShort: Float = 9f): Float {
        val kept = (videoShort / videoLong) / (viewShort / viewLong)
        return ((1f - kept) / 2f).coerceIn(0f, 0.5f)
    }
}

// ==================================================================== the phone's own processing

object CamExt {
    enum class Mode { AUTO, HDR, NIGHT }

    /**
     * Which of the phone maker's own photo processing to use, from what this
     * camera offers. Auto first: it chooses HDR or night by the scene, as the
     * phone's own camera does. Without it, HDR. Night only when asked for
     * ([nightAsked]: the Night button, shown only where there's no Auto to
     * do it by itself). None of them: null, the plain full-quality picture.
     */
    fun pick(auto: Boolean, hdr: Boolean, night: Boolean, nightAsked: Boolean): Mode? = when {
        nightAsked && night && !auto -> Mode.NIGHT
        auto -> Mode.AUTO
        hdr -> Mode.HDR
        else -> null
    }

    /** The Night button is worth showing only where Night exists and Auto doesn't. */
    fun nightButton(auto: Boolean, night: Boolean): Boolean = night && !auto
}

// ==================================================================== sending in pieces

object CamPieces {
    /** One piece: small enough to lose little when the signal drops, and to move the progress ring. */
    const val PIECE = 8L * 1024 * 1024

    /** In one request, or in pieces? */
    fun inPieces(size: Long, maxOne: Long, tus: String): Boolean = tus.isNotEmpty() && size > maxOne

    /** The next piece's length from [offset]. */
    fun next(offset: Long, size: Long): Long = minOf(PIECE, size - offset).coerceAtLeast(0)

    /** `filename <b64>,filetype <b64>,room_id <b64>`: what tus calls Upload-Metadata. */
    fun metadata(name: String, mime: String, room: String): String =
        listOf("filename" to name, "filetype" to mime, "room_id" to room)
            .joinToString(",") { (k, v) -> "$k ${Base64.getEncoder().encodeToString(v.toByteArray())}" }
}

// ==================================================================== names

object CamNames {
    /** "Photo 2026-11-19 18.43.07.jpg": what the file is called in the conversation. */
    fun file(video: Boolean, at: java.util.Date, ext: String): String {
        val f = java.text.SimpleDateFormat("yyyy-MM-dd HH.mm.ss", Locale.US)
        return "${if (video) "Video" else "Photo"} ${f.format(at)}.$ext"
    }

    fun mime(ext: String): String = when (ext.lowercase()) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "heic" -> "image/heic"
        "heif" -> "image/heif"
        "gif" -> "image/gif"
        "mp4" -> "video/mp4"
        "webm" -> "video/webm"
        "mov" -> "video/quicktime"
        "3gp" -> "video/3gpp"
        else -> "application/octet-stream"
    }
}

// ==================================================================== sending

/** Where a send is up to. */
sealed interface SendState {
    data object Idle : SendState
    data class Sending(val fraction: Float) : SendState
    data object Sent : SendState

    /** [again]: trying the same thing once more could work (no signal, a server hiccup). */
    data class Failed(val why: String, val again: Boolean) : SendState
}

object CamSendRules {
    /**
     * What a failed send says, and whether Try again is worth offering.
     * [status] is the server's answer, or null when it never answered.
     */
    fun failure(status: Int?, detail: String?): SendState.Failed = when {
        status == null -> SendState.Failed("No connection. It's kept here: try again when you're back online.", again = true)
        status == 401 -> SendState.Failed("This camera has been open too long. Go back to the conversation and open it again; your picture is saved to this phone.", again = false)
        status == 404 -> SendState.Failed("You're not in that conversation any more. Your picture is saved to this phone.", again = false)
        status == 413 -> SendState.Failed(detail ?: "That's too big to send, or your storage is full.", again = false)
        status == 415 -> SendState.Failed("That isn't a photo or a video.", again = false)
        status == 429 -> SendState.Failed(detail ?: "Too many at once. Wait a moment and try again.", again = true)
        status in 400..499 -> SendState.Failed(detail ?: "The server wouldn't take it ($status).", again = false)
        else -> SendState.Failed("The server had a problem. It's kept here: try again in a moment.", again = true)
    }

    /** One run's tries: at once, then after these waits. */
    val QUICK_WAITS_MS = listOf(0L, 4_000L, 10_000L)

    /**
     * Try again within the same run? Only for a send nobody is watching (the
     * camera screen shows a failure at once and offers Try again itself), and
     * only when the server never answered.
     */
    fun quickRetry(state: SendState, watched: Boolean): Boolean =
        !watched && state is SendState.Failed && state.again && state.why.startsWith("No connection")

    /** A background try that failed: keep trying, or stop and keep the picture. */
    fun retryInBackground(failed: SendState.Failed, attempt: Int): Boolean = failed.again && attempt < 8

    fun fraction(sent: Long, total: Long): Float = if (total <= 0) 0f else (sent.toFloat() / total).coerceIn(0f, 1f)
}
