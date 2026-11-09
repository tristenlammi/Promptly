package org.promptly.sync.talk

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.car.app.CarContext
import androidx.car.app.media.CarAudioRecord
import kotlin.concurrent.thread
import kotlin.math.PI
import kotlin.math.sin

/** The microphone for one car turn (WP-T8).
 *
 *  **In the car** it's Android Auto's own microphone, `CarAudioRecord` (car API level
 *  5+, `RECORD_AUDIO` granted on the phone): the host records and hands the app 16 kHz
 *  PCM16, shows its recording indicator, and keeps nothing. **On the dash** (P Maps'
 *  driving screen) it's the phone's microphone, tuned for speech recognition.
 *
 *  While it's open it holds the audio exclusively (`AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE`,
 *  as the car library's microphone guide does): the music pauses rather than being
 *  recorded under your voice. Losing that focus (a call) stops the turn. The car's
 *  microphone isn't the phone's `AudioRecord`, so no foreground service is needed while
 *  the car screen shows P Maps (WP-T7). Frames go to [sink] in 20 ms pieces with their
 *  level; a read of −1 (the driver dismissed the indicator) calls [gone]. */
class CarMic(
    private val app: Context,
    private val car: CarContext?,
    private val sink: (ByteArray, Double) -> Unit,
    private val gone: () -> Unit,
    private val lost: () -> Unit,
) : CarMicControl {
    private val audio = app.getSystemService(AudioManager::class.java)
    @Volatile private var open = false
    private var focus: AudioFocusRequest? = null
    private var reader: Thread? = null
    private var carRecord: CarAudioRecord? = null
    private var phoneRecord: AudioRecord? = null

    @SuppressLint("MissingPermission")
    override fun open(): Boolean {
        if (open) return true
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setOnAudioFocusChangeListener({ change ->
                if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) lost()
            }, Handler(Looper.getMainLooper()))
            .build()
        if (audio != null && audio.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_FAILED) return false
        focus = req
        val read: (ByteArray) -> Int = try {
            if (car != null) {
                val r = CarAudioRecord.create(car)
                r.startRecording()
                carRecord = r
                { buf -> fill(buf) { b, off, len -> r.read(b, off, len) } }
            } else {
                val size = maxOf(AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), RATE / 5 * 2)
                val r = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size)
                if (r.state != AudioRecord.STATE_INITIALIZED) {
                    r.release()
                    throw IllegalStateException("microphone busy")
                }
                r.startRecording()
                phoneRecord = r
                { buf -> fill(buf) { b, off, len -> r.read(b, off, len) } }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Couldn't open the microphone", e)
            release()
            return false
        }
        open = true
        reader = thread(name = "car-mic", priority = Thread.MAX_PRIORITY) {
            val frame = ByteArray(TalkProtocol.MIC_FRAME_BYTES)
            while (open) {
                val n = runCatching { read(frame) }.getOrDefault(-1)
                if (!open) break
                if (n < 0) {
                    gone()
                    break
                }
                if (n == frame.size) sink(frame.copyOf(), level(frame))
            }
        }
        return true
    }

    /** One whole 20 ms frame from reads of whatever size the recorder gives
     *  (the car's are 512 bytes at most). −1 when it's gone. */
    private fun fill(buf: ByteArray, read: (ByteArray, Int, Int) -> Int): Int {
        var got = 0
        while (got < buf.size && open) {
            val n = read(buf, got, buf.size - got)
            if (n < 0) return -1
            if (n == 0) continue
            got += n
        }
        return got
    }

    override fun close() {
        if (!open && focus == null) return
        open = false
        release()
        reader?.let { if (it !== Thread.currentThread()) runCatching { it.join(300) } }
        reader = null
    }

    private fun release() {
        carRecord?.let { runCatching { it.stopRecording() } }
        carRecord = null
        phoneRecord?.let {
            runCatching { it.stop() }
            it.release()
        }
        phoneRecord = null
        focus?.let { f -> runCatching { audio?.abandonAudioFocusRequest(f) } }
        focus = null
    }

    private fun level(frame: ByteArray): Double {
        val shorts = ShortArray(frame.size / 2) { i -> ((frame[i * 2 + 1].toInt() shl 8) or (frame[i * 2].toInt() and 0xFF)).toShort() }
        return levelOf(shorts, shorts.size)
    }

    companion object {
        private const val TAG = "PromptlyCarTalk"
        const val RATE = TalkProtocol.MIC_RATE
    }
}

/** The tones either side of a car turn, on the car's guidance channel so they come
 *  out of the car's speakers like the answer does. Made here, not loaded: a short
 *  sweep up as the microphone opens, down as it closes. */
class GuidanceTones : CarSounds {
    override fun opening() = play(rising = true)
    override fun closing() = play(rising = false)

    private fun play(rising: Boolean) {
        thread(name = "car-tone") {
            runCatching {
                val pcm = sweep(if (rising) 620.0 else 880.0, if (rising) 880.0 else 620.0)
                val track = AudioTrack.Builder()
                    .setAudioAttributes(PhoneTrack.attributes(PlaybackRoute.GUIDANCE))
                    .setAudioFormat(AudioFormat.Builder().setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .setBufferSizeInBytes(pcm.size)
                    .build()
                track.write(pcm, 0, pcm.size)
                track.play()
                Thread.sleep(MS + 80L)
                runCatching { track.stop() }
                track.release()
            }
        }
    }

    companion object {
        private const val RATE = 24_000
        private const val MS = 150

        /** A soft sine sweep with faded ends. */
        fun sweep(from: Double, to: Double): ByteArray {
            val n = RATE * MS / 1000
            val out = ByteArray(n * 2)
            var phase = 0.0
            for (i in 0 until n) {
                val f = from + (to - from) * i / n
                phase += 2 * PI * f / RATE
                val fade = minOf(1.0, i / (n * 0.15), (n - i) / (n * 0.25))
                val v = (sin(phase) * fade * 0.35 * Short.MAX_VALUE).toInt()
                out[i * 2] = v.toByte()
                out[i * 2 + 1] = (v shr 8).toByte()
            }
            return out
        }
    }
}

/** Guidance focus while the car's answer plays: the music ducks under it, as it
 *  does for directions; a call taking the audio stops it ([lost]). */
class GuidanceFocus(context: Context, private val lost: () -> Unit) {
    private val audio = context.getSystemService(AudioManager::class.java)
    private var held: AudioFocusRequest? = null

    fun take() {
        if (held != null || audio == null) return
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(PhoneTrack.attributes(PlaybackRoute.GUIDANCE))
            .setOnAudioFocusChangeListener({ change ->
                if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) lost()
            }, Handler(Looper.getMainLooper()))
            .build()
        audio.requestAudioFocus(req)
        held = req
    }

    fun give() {
        val req = held ?: return
        held = null
        runCatching { audio?.abandonAudioFocusRequest(req) }
    }
}
