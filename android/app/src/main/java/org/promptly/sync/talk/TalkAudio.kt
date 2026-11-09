package org.promptly.sync.talk

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.util.Log
import java.util.concurrent.Executor
import java.util.concurrent.locks.LockSupport
import kotlin.concurrent.thread
import kotlin.math.sqrt

/** Where Talk's answers are played. [CALL] plays them as call audio
 *  (`USAGE_VOICE_COMMUNICATION`), which is what the phone's echo canceller listens
 *  to, so talking over it works on the speaker. [ASSISTANT] plays them as assistant
 *  audio: often louder, and through Bluetooth music headphones, but the canceller may
 *  not hear it, so on the speaker it can hear itself (the server's self-echo filter
 *  catches most of that). Switchable in the assistant's settings until real phones
 *  say which should be the default (the WP-T0 owner check). [GUIDANCE] is the car's
 *  (WP-T8): navigation apps speak as `USAGE_ASSISTANCE_NAVIGATION_GUIDANCE`, which
 *  Android Auto plays on the car's speakers over the music, as the car library's
 *  navigation guide says; never call mode in the car. */
enum class PlaybackRoute { CALL, ASSISTANT, GUIDANCE }

/** A source of microphone audio: the phone's microphone, or (debug builds) a file. */
interface MicSource {
    /** Fill [into] with 16 kHz PCM16; returns samples read, or <= 0 when it's gone. Blocks. */
    fun read(into: ShortArray): Int
    fun close()
}

/** The phone's microphone for Talk: `VOICE_COMMUNICATION`, which turns on the phone's
 *  echo cancelling and noise suppression, plus the effects themselves where offered. */
class PhoneMic private constructor(private val record: AudioRecord) : MicSource {
    private val effects = ArrayList<android.media.audiofx.AudioEffect>()

    init {
        val id = record.audioSessionId
        if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(id)?.let { it.enabled = true; effects += it }
        if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(id)?.let { it.enabled = true; effects += it }
        record.startRecording()
    }

    override fun read(into: ShortArray): Int = record.read(into, 0, into.size)

    override fun close() {
        effects.forEach { runCatching { it.release() } }
        runCatching { record.stop() }
        record.release()
    }

    companion object {
        /** Null when the microphone can't be had (no permission, or busy). */
        @SuppressLint("MissingPermission")
        fun open(): PhoneMic? {
            val rate = TalkProtocol.MIC_RATE
            val size = maxOf(AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), rate / 5 * 2)
            val record = try {
                AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size)
            } catch (e: Exception) {
                Log.w(TAG, "No microphone", e)
                return null
            }
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                record.release()
                return null
            }
            return runCatching { PhoneMic(record) }.getOrElse {
                Log.w(TAG, "Couldn't start the microphone", it)
                record.release()
                null
            }
        }
    }
}

/** An `AudioTrack` as [Playback] sees it: 24 kHz PCM16 mono, streamed, small buffer. */
class PhoneTrack(route: PlaybackRoute) : Track {
    private val track: AudioTrack

    init {
        val rate = TalkProtocol.SPEECH_RATE
        val min = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        track = AudioTrack.Builder()
            .setAudioAttributes(attributes(route))
            .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setTransferMode(AudioTrack.MODE_STREAM)
            // About 120 ms: enough not to stutter, little enough to stop at once.
            .setBufferSizeInBytes(maxOf(min, TalkProtocol.SPEECH_FRAME_BYTES * 6))
            .apply { if (Build.VERSION.SDK_INT >= 26) setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY) }
            .build()
        track.play()
    }

    override fun write(bytes: ByteArray, offset: Int, size: Int): Int =
        track.write(bytes, offset, size, AudioTrack.WRITE_NON_BLOCKING).coerceAtLeast(0)

    override fun head(): Long = track.playbackHeadPosition.toLong() and 0xFFFFFFFFL

    override fun drop() {
        runCatching {
            track.pause()
            track.flush()
            track.play()
        }
    }

    override fun volume(gain: Float) {
        runCatching { track.setVolume(gain) }
    }

    fun release() {
        runCatching { track.stop() }
        track.release()
    }

    companion object {
        fun attributes(route: PlaybackRoute): AudioAttributes = AudioAttributes.Builder()
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .setUsage(
                when (route) {
                    PlaybackRoute.CALL -> AudioAttributes.USAGE_VOICE_COMMUNICATION
                    PlaybackRoute.ASSISTANT -> AudioAttributes.USAGE_ASSISTANT
                    PlaybackRoute.GUIDANCE -> AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE
                },
            )
            .build()
    }
}

/** The speaker side for [TalkCore]: [Playback] fed by its own writer thread. */
class PhoneSpeaker(route: PlaybackRoute, private val tones: Boolean = true, private val onPlaying: (Boolean) -> Unit) : Speaker {
    private val track = PhoneTrack(route)
    private val playback = Playback(track)

    /** See [Playback.hold]: the car waits for directions and close turns. */
    var hold: (() -> Boolean)?
        get() = playback.hold
        set(value) {
            playback.hold = value
        }
    @Volatile private var open = true
    private val writer: Thread

    init {
        playback.onPlaying = { onPlaying(it) }
        writer = thread(name = "talk-speaker", priority = Thread.MAX_PRIORITY) {
            while (open) {
                val busy = runCatching { playback.pump() }.getOrDefault(false)
                // Woken early by new speech; otherwise a short nap.
                if (open) LockSupport.parkNanos(if (busy) 5_000_000L else 40_000_000L)
            }
        }
    }

    override fun push(pcm: ByteArray) {
        playback.push(pcm)
        LockSupport.unpark(writer)
    }

    override fun startReply() = playback.startReply()
    override fun stop(): Long? = playback.stop()
    override fun playedMs(): Long? = playback.playedMs()
    override val playing: Boolean get() = playback.playing
    override fun duck() = playback.duck()
    override fun unduck() = playback.unduck()
    override val ducked: Boolean get() = playback.ducked

    override fun endTone() {
        // In the car the conversation just lapses after two quiet minutes: no tone.
        if (!tones) return
        runCatching {
            val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 50)
            tone.startTone(ToneGenerator.TONE_PROP_ACK, 150)
            Thread { Thread.sleep(250); tone.release() }.start()
        }
    }

    fun close() {
        open = false
        LockSupport.unpark(writer)
        runCatching { writer.join(200) }
        playback.stop()
        track.release()
    }
}

/** The phone's audio while a conversation is on: focus (a call or another app's
 *  voice takes it, and Talk waits quietly), call mode for the echo canceller, and
 *  which speaker or headset that uses. Everything is given back at the end. */
class AudioRoute(context: Context, private val route: PlaybackRoute, private val onYield: (Boolean) -> Unit, private val main: Executor) {
    private val audio = context.getSystemService(AudioManager::class.java)
    private var request: AudioFocusRequest? = null
    private var oldMode: Int? = null
    private var setDevice = false
    private var speakerOn = false
    private var modeListener: Any? = null

    fun open() {
        val am = audio ?: return
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(PhoneTrack.attributes(route))
            // A notification's ping only ducks it (Android does that); a call, a voice
            // channel or another assistant takes the audio, and Talk waits.
            .setWillPauseWhenDucked(false)
            .setOnAudioFocusChangeListener({ change ->
                when (change) {
                    AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> onYield(true)
                    AudioManager.AUDIOFOCUS_GAIN -> onYield(false)
                }
            }, android.os.Handler(android.os.Looper.getMainLooper()))
            .build()
        request = req
        if (am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_FAILED) onYield(true)
        if (route == PlaybackRoute.CALL) {
            // Call mode: the echo canceller's reference is this audio. The phone's
            // own call (ringing, in a call) keeps its mode; Talk doesn't take it over.
            if (am.mode == AudioManager.MODE_NORMAL) {
                oldMode = am.mode
                runCatching { am.mode = AudioManager.MODE_IN_COMMUNICATION }
            }
            pickDevice(am)
        }
        if (Build.VERSION.SDK_INT >= 31) {
            val l = AudioManager.OnModeChangedListener { mode ->
                // A phone call ringing or answered: wait quietly.
                if (mode == AudioManager.MODE_RINGTONE || mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_CALL_SCREENING) onYield(true)
            }
            runCatching { am.addOnModeChangedListener(main, l) }
            modeListener = l
        }
    }

    /** A headset if one's plugged in or connected, else the loudspeaker (call audio
     *  would otherwise come out of the earpiece). */
    @Suppress("DEPRECATION")
    private fun pickDevice(am: AudioManager) {
        if (Build.VERSION.SDK_INT >= 31) {
            val devices = am.availableCommunicationDevices
            val order = listOf(
                AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_BLE_HEADSET,
                AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
            )
            val pick = order.firstNotNullOfOrNull { type -> devices.firstOrNull { it.type == type } }
            if (pick != null) setDevice = runCatching { am.setCommunicationDevice(pick) }.getOrDefault(false)
        } else {
            val headset = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
                it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                    it.type == AudioDeviceInfo.TYPE_USB_HEADSET || it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
            }
            if (!headset) {
                speakerOn = true
                am.isSpeakerphoneOn = true
            }
        }
    }

    /** Take the audio back after a call or another app (the Unmute button). */
    fun regain() {
        val am = audio ?: return
        request?.let { am.requestAudioFocus(it) }
    }

    @Suppress("DEPRECATION")
    fun close() {
        val am = audio ?: return
        request?.let { runCatching { am.abandonAudioFocusRequest(it) } }
        request = null
        if (Build.VERSION.SDK_INT >= 31) {
            (modeListener as? AudioManager.OnModeChangedListener)?.let { runCatching { am.removeOnModeChangedListener(it) } }
            if (setDevice) runCatching { am.clearCommunicationDevice() }
        }
        if (speakerOn) runCatching { am.isSpeakerphoneOn = false }
        oldMode?.let { mode -> if (am.mode == AudioManager.MODE_IN_COMMUNICATION) runCatching { am.mode = mode } }
        oldMode = null
        modeListener = null
        setDevice = false
        speakerOn = false
    }
}

/** RMS of a frame, 0..1. */
fun levelOf(frame: ShortArray, count: Int): Double {
    if (count <= 0) return 0.0
    var sum = 0.0
    for (i in 0 until count) {
        val v = frame[i] / 32768.0
        sum += v * v
    }
    return sqrt(sum / count)
}

private const val TAG = "PromptlyTalk"
