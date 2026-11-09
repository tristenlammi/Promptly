package org.promptly.sync.maps

import android.Manifest
import android.app.role.RoleManager
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.promptly.sync.assistant.PhoneActions
import org.promptly.sync.assistant.VoiceTrail
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.max
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.math.sqrt

/** The assistant's voice. The microphone only opens when you ask it to: the button
 *  in P Maps or on the car's screen, or your phone's assistant gesture. Nothing
 *  listens in the background. What you say goes to your own server. */
object Voice {
    private const val TAG = "PromptlyVoice"
    private const val UNHEARD = "Sorry, I didn't catch that."
    private const val NO_SIGNAL_DRIVING = "No signal. I can't help with that right now, but directions keep going."
    private const val NO_SIGNAL = "No signal. I can't help with that right now."
    const val SAMPLE_RATE = 16000

    enum class State { OFF, HEARD, THINKING }

    private val _state = MutableStateFlow(State.OFF)
    val state = _state.asStateFlow()

    /** The last thing said back, for the screens to show. */
    private val _reply = MutableStateFlow<String?>(null)
    val reply = _reply.asStateFlow()

    /** What it heard you say, for the sheet. */
    private val _heard = MutableStateFlow<String?>(null)
    val heard = _heard.asStateFlow()

    /** The question it read back, while it's waiting for a yes or no. */
    private val _question = MutableStateFlow<String?>(null)
    val question = _question.asStateFlow()

    /** Goes up each time an answer has finished being said. */
    private val _spoken = MutableStateFlow(0)
    val spoken = _spoken.asStateFlow()

    /** The car's screen is connected: the phone is probably locked, and in a pocket. */
    @Volatile var inCar = false

    private val history = ArrayDeque<Pair<String, String>>()
    // A change that was read back, waiting for you to say yes.
    private var pending: JSONObject? = null

    fun allowed(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** Is Promptly the phone's assistant? */
    fun holdsRole(context: Context): Boolean =
        context.getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_ASSISTANT) == true

    private val pressed = AtomicBoolean(false)
    @Volatile private var wanted = false

    /** The button: listen once, then answer. Pressed while listening, it stops. */
    fun press(context: Context) {
        if (_state.value == State.HEARD) {
            wanted = false
            return
        }
        val app = context.applicationContext
        // The assistant needs your server: with no signal, say so rather than listen.
        if (!org.promptly.sync.maps.offline.Offline.online(app)) {
            Nav.init(app)
            answered(app, if (Nav.onTrip()) NO_SIGNAL_DRIVING else NO_SIGNAL, offline = true)
            return
        }
        if (!pressed.compareAndSet(false, true)) return
        wanted = true
        Nav.init(app)
        Nav.hush()
        thread(name = "assistant-button") {
            try {
                listenOnce(app) { wanted }
            } catch (e: Exception) {
                Log.w(TAG, "Couldn't listen", e)
            } finally {
                wanted = false
                pressed.set(false)
            }
        }
    }

    /** When this conversation started, for the crash breadcrumb. */
    @Volatile private var since = 0L

    internal fun setState(value: State) {
        _state.value = value
        if (value != State.OFF && since == 0L) since = System.currentTimeMillis()
        val path = if (inCar) "car" else "sheet"
        when (value) {
            State.HEARD -> VoiceTrail.note(path, "listening", since)
            State.THINKING -> VoiceTrail.note(path, "thinking", since)
            State.OFF -> VoiceTrail.note(path, if (SpokenAnswer.speaking) "speaking" else "off", since)
        }
    }

    /** The answer has been said (or stopped): nothing voice is going on now. */
    internal fun quiet() {
        if (_state.value == State.OFF && !SpokenAnswer.speaking) {
            VoiceTrail.note(if (inCar) "car" else "sheet", "off", since)
            since = 0L
        }
    }

    /** Silence at this level of background noise: from the sound before you spoke. */
    private fun level(frame: ShortArray, count: Int): Double {
        var sum = 0.0
        for (i in 0 until count) sum += frame[i].toDouble() * frame[i]
        return sqrt(sum / max(1, count))
    }

    /** What you say next, up to the pause after it. Null if you said nothing. */
    internal fun capture(floor: Double, before: ByteArray = ByteArray(0), read: (ShortArray) -> Int): ByteArray? {
        val out = ByteArrayOutputStream()
        // What it already heard: people don't wait for the beep.
        out.write(before)
        val frame = ShortArray(SAMPLE_RATE / 10)
        val bytes = ByteBuffer.allocate(frame.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        val speech = max(floor * 2.2, 180.0)
        var heard = false
        var quiet = 0
        for (tenth in 0 until 100) { // ten seconds at most
            val n = read(frame)
            if (n <= 0) break
            bytes.clear()
            for (i in 0 until n) bytes.putShort(frame[i])
            out.write(bytes.array(), 0, n * 2)
            if (level(frame, n) > speech) {
                heard = true
                quiet = 0
            } else {
                quiet++
            }
            if (heard && quiet >= 12) break // a pause of over a second
            if (!heard && tenth >= 50) return null
        }
        return if (heard) wav(out.toByteArray()) else null
    }

    private fun wav(pcm: ByteArray): ByteArray {
        val head = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        head.put("RIFF".toByteArray()).putInt(36 + pcm.size).put("WAVE".toByteArray())
        head.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1)
        head.putInt(SAMPLE_RATE).putInt(SAMPLE_RATE * 2).putShort(2).putShort(16)
        head.put("data".toByteArray()).putInt(pcm.size)
        return head.array() + pcm
    }

    /** Duck the music while you talk. Returns how to give it back. */
    internal fun holdFocus(context: Context): () -> Unit {
        val audio = context.getSystemService(AudioManager::class.java) ?: return {}
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(
                AudioAttributes.Builder().setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE).build(),
            )
            .build()
        audio.requestAudioFocus(request)
        return { audio.abandonAudioFocusRequest(request) }
    }

    internal fun chime() {
        runCatching {
            val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 70)
            tone.startTone(ToneGenerator.TONE_PROP_BEEP, 120)
            Thread.sleep(140)
            tone.release()
        }
    }

    /** A fresh start on the sheet: nothing carried over from last time. */
    fun newConversation() {
        history.clear()
        pending = null
        _question.value = null
        _heard.value = null
        _reply.value = null
    }

    /** Listen once on the sheet, then answer. Blocks until done. */
    internal fun listenOnce(context: Context, wanted: () -> Boolean) {
        val size = max(AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), SAMPLE_RATE)
        val record = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size)
        } catch (e: SecurityException) {
            Log.w(TAG, "No microphone permission", e)
            return
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            _reply.value = "The microphone is busy."
            return
        }
        val was = _state.value
        val release = holdFocus(context)
        try {
            setState(State.HEARD)
            chime()
            record.startRecording()
            // A moment of the room first, to tell when you've stopped speaking.
            val room = ShortArray(SAMPLE_RATE / 5)
            val got = max(0, record.read(room, 0, room.size))
            val before = ByteBuffer.allocate(got * 2).order(ByteOrder.LITTLE_ENDIAN)
            for (i in 0 until got) before.putShort(room[i])
            val floor = minOf(level(room, got), 400.0) // you may already be talking
            val clip = capture(floor, before.array()) { buffer -> if (wanted()) record.read(buffer, 0, buffer.size) else -1 }
            if (!wanted()) return
            when {
                clip != null -> ask(context, clip)
                // Still asking: the question and its buttons stay. Don't keep on at you.
                pending == null -> {
                    _reply.value = UNHEARD
                    Nav.init(context)
                    SpokenAnswer.say(context, UNHEARD)
                }
            }
        } finally {
            runCatching { record.stop() }
            record.release()
            release()
            setState(was)
        }
    }

    private fun answered(context: Context, words: String, offline: Boolean = false) {
        Nav.init(context)
        _reply.value = words
        if (offline) Nav.say(words) { _spoken.value += 1 } else SpokenAnswer.say(context, words) { _spoken.value += 1 }
    }

    /** Send what you said, say the answer, do what it says. Blocks until done. */
    internal fun ask(context: Context, clip: ByteArray?, words: String? = null) {
        Nav.init(context)
        val was = _state.value
        setState(State.THINKING)
        try {
            val state = Nav.assistantState()
            if (!state.has("lat")) {
                PhoneActions.lastPosition(context)?.let { state.put("lat", it.latitude).put("lon", it.longitude) }
            }
            state.put("history", JSONArray().also { rows ->
                history.forEach { (heard, said) -> rows.put(JSONObject().put("heard", heard.take(500)).put("said", said.take(500))) }
            })
            pending?.let { state.put("pending", it) }
            val answer = runBlocking { Maps.assistant(context, clip, words, state) }
            pending = answer.optJSONObject("pending")
            _question.value = pending?.optString("question")
            val heard = answer.optString("heard")
            _heard.value = heard
            // If the phone can't do it, say that instead of "done".
            val problem = answer.optJSONObject("action")?.let { PhoneActions.carry(context, it) }
            val say = problem ?: answer.optString("say")
            if (heard.isNotEmpty() && say.isNotEmpty()) {
                history.addLast(heard to say)
                while (history.size > 3) history.removeFirst()
            }
            if (say.isNotEmpty()) answered(context, say)
        } catch (e: Exception) {
            Log.w(TAG, "Couldn't reach the server", e)
            val refused = e.message.orEmpty().let { "said 401" in it || "said 403" in it || "Not signed in" in it }
            val words = when {
                refused -> "This phone needs linking to your Promptly again."
                !org.promptly.sync.maps.offline.Offline.online(context) -> if (Nav.onTrip()) NO_SIGNAL_DRIVING else NO_SIGNAL
                else -> "Sorry, I can't reach your server."
            }
            answered(context, words, offline = true)
        } finally {
            setState(was)
        }
    }

    fun clearReply() {
        _reply.value = null
    }
}
