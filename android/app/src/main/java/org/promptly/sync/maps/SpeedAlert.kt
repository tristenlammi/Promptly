package org.promptly.sync.maps

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

/** When to beep for going over the limit. Off unless you turn it on. */
enum class SpeedWarning(val over: Int?) {
    OFF(null),
    AT_LIMIT(0),
    FIVE_OVER(5),
    TEN_OVER(10);

    val label: String
        get() = when (this) {
            OFF -> "Off"
            AT_LIMIT -> "At the limit"
            FIVE_OVER -> "5 km/h over"
            TEN_OVER -> "10 km/h over"
        }
}

/** Decides when a beep is due: once when you go over (and stay over for a moment, so a
 *  GPS blip isn't a telling-off), then not again until you've dropped back under and
 *  gone over again, the limit has changed, or you've stayed over for a couple of
 *  minutes. No known limit or speed, no beep. */
class SpeedAlert {
    private var overSince: Long? = null
    private var beepedAt = 0L
    private var beeped = false
    private var limitWas: Int? = null

    @Synchronized
    fun reset() {
        overSince = null
        beeped = false
        limitWas = null
    }

    /** True when a beep is due now. [over] is how far past the limit is allowed. */
    @Synchronized
    fun check(kmh: Double?, limit: Int?, over: Int, nowMs: Long): Boolean {
        if (kmh == null || limit == null || limit !in 5..150) {
            reset()
            return false
        }
        if (limit != limitWas) {
            // A new limit is a new question: 80 in what has just become a 60 beeps again.
            limitWas = limit
            overSince = null
            beeped = false
        }
        val threshold = limit + over
        if (kmh <= threshold) {
            // Hovering right at the line doesn't re-arm it; properly back under does.
            if (kmh <= threshold - BACK_UNDER) beeped = false
            overSince = null
            return false
        }
        val since = overSince ?: nowMs.also { overSince = it }
        if (nowMs - since < HOLD_MS) return false
        if (beeped && nowMs - beepedAt < AGAIN_MS) return false
        beeped = true
        beepedAt = nowMs
        return true
    }

    companion object {
        const val HOLD_MS = 1_500L
        const val AGAIN_MS = 120_000L
        const val BACK_UNDER = 2
    }
}

/** The beep itself: two short pips, made here so there's no sound file to ship. */
internal object Beep {
    private const val RATE = 22_050
    private const val PIP_MS = 110
    private const val GAP_MS = 70
    const val MILLIS = PIP_MS * 2 + GAP_MS

    fun samples(): ShortArray {
        val pip = RATE * PIP_MS / 1000
        val gap = RATE * GAP_MS / 1000
        val fade = RATE * 8 / 1000
        val out = ShortArray(pip * 2 + gap)
        for (start in intArrayOf(0, pip + gap)) {
            for (i in 0 until pip) {
                // Faded in and out, so it's a pip and not a click.
                val envelope = min(1.0, min(i, pip - 1 - i).toDouble() / fade)
                out[start + i] = (sin(2 * PI * 1568.0 * i / RATE) * envelope * 0.6 * Short.MAX_VALUE).toInt().toShort()
            }
        }
        return out
    }

    fun track(attributes: AudioAttributes): AudioTrack {
        val pcm = samples()
        val track = AudioTrack.Builder()
            .setAudioAttributes(attributes)
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(pcm.size * 2)
            .build()
        track.write(pcm, 0, pcm.size)
        return track
    }
}
