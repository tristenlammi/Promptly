package org.promptly.sync.capture

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min

/** Where a voice note's recording is. */
enum class Phase { IDLE, RECORDING, PAUSED, SAVING }

/**
 * One recording, as the screen and the notification show it. Times are
 * `elapsedRealtime` milliseconds (they don't jump when the clock changes).
 * [samples]: the level every [RecorderLogic.SAMPLE_MS] while recording, for
 * the waveform. [error]: what went wrong, in plain words.
 */
data class RecState(
    val phase: Phase = Phase.IDLE,
    val file: File? = null,
    val startedWall: Long = 0,
    val recordedBefore: Long = 0,
    val runSince: Long = 0,
    val level: Float = 0f,
    val samples: List<Float> = emptyList(),
    val error: String? = null,
) {
    /** How long it is so far (pauses not counted). */
    fun elapsed(now: Long): Long = recordedBefore + if (phase == Phase.RECORDING) max(0L, now - runSince) else 0L
}

/** The recording's rules, apart from MediaRecorder and the service (tested on their own). */
object RecorderLogic {
    const val SAMPLE_MS = 100L
    /** Three hours: as much as the server transcribes in one go. */
    const val MAX_MS = 3L * 60 * 60 * 1000
    /** Shorter than this is a slip of the thumb, not a note. */
    const val MIN_MS = 800L
    const val MAX_PEAKS = 200
    /** Samples kept for the waveform (a long recording is thinned as it goes). */
    private const val KEEP = 4000

    fun start(file: File, now: Long, wall: Long) = RecState(Phase.RECORDING, file, startedWall = wall, runSince = now)

    fun pause(s: RecState, now: Long): RecState =
        if (s.phase != Phase.RECORDING) s else s.copy(phase = Phase.PAUSED, recordedBefore = s.elapsed(now), runSince = 0, level = 0f)

    fun resume(s: RecState, now: Long): RecState =
        if (s.phase != Phase.PAUSED) s else s.copy(phase = Phase.RECORDING, runSince = now)

    /** Stop counting: what it came to. */
    fun stop(s: RecState, now: Long): RecState = s.copy(phase = Phase.SAVING, recordedBefore = s.elapsed(now), runSince = 0, level = 0f)

    /** MediaRecorder's max amplitude (0…32767) as a 0…1 level that looks right to the eye (log scale, ~45 dB of range). */
    fun level(amplitude: Int): Float {
        if (amplitude <= 0) return 0f
        val db = 20.0 * ln(amplitude / 32767.0) / ln(10.0)
        return min(1f, max(0f, ((db + 45.0) / 45.0).toFloat()))
    }

    fun sample(s: RecState, amplitude: Int): RecState {
        if (s.phase != Phase.RECORDING) return s
        val l = level(amplitude)
        var samples = s.samples + l
        if (samples.size > KEEP) samples = samples.chunked(2).map { it.max() } // halve: the shape stays
        return s.copy(level = l, samples = samples)
    }

    /** The waveform the note's player draws: at most [MAX_PEAKS] levels, the loudest of each stretch. */
    fun peaks(samples: List<Float>): List<Float> {
        if (samples.isEmpty()) return emptyList()
        if (samples.size <= MAX_PEAKS) return samples
        val per = samples.size.toDouble() / MAX_PEAKS
        return (0 until MAX_PEAKS).map { i ->
            val from = (i * per).toInt()
            val to = min(samples.size, max(from + 1, ((i + 1) * per).toInt()))
            samples.subList(from, to).max()
        }
    }

    /** "0:07", "12:45", "1:02:03". */
    fun clock(ms: Long): String {
        val s = ms / 1000
        val h = s / 3600
        val m = (s % 3600) / 60
        val sec = s % 60
        return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
    }

    /** Over the limit: save it now. */
    fun full(s: RecState, now: Long): Boolean = s.phase == Phase.RECORDING && s.elapsed(now) >= MAX_MS
}

/** The one recording this app makes at a time — the screen and the service both read it. */
object Recorder {
    private val _state = MutableStateFlow(RecState())
    val state: StateFlow<RecState> = _state

    /** The last note saved, for the screen to confirm ("Saved on this phone — will sync"). */
    val saved = MutableStateFlow<String?>(null)

    internal fun set(s: RecState) {
        _state.value = s
    }

    internal fun update(f: (RecState) -> RecState) {
        _state.value = f(_state.value)
    }
}
