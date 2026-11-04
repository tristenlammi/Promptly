package org.promptly.sync.maps

import android.Manifest
import android.app.NotificationChannel
import android.app.role.RoleManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.promptly.sync.R
import org.promptly.sync.assistant.PhoneActions
import org.promptly.sync.assistant.PromptlyAssistantService
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.max
import kotlin.math.sqrt

/** "Hey Promptly". The wake word is heard on this phone and no sound leaves it
 *  until then. Only what you say next goes to your own server. */
object Voice {
    private const val TAG = "PromptlyVoice"
    private const val PREFS = "maps_voice"
    private const val UNHEARD = "Sorry, I didn't catch that."
    const val SAMPLE_RATE = 16000

    enum class State { OFF, LISTENING, HEARD, THINKING }

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

    fun enabled(context: Context): Boolean = prefs(context).getBoolean("on", true)

    fun asked(context: Context): Boolean = prefs(context).getBoolean("asked", false)

    fun markAsked(context: Context) {
        prefs(context).edit().putBoolean("asked", true).apply()
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun allowed(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    fun setEnabled(context: Context, on: Boolean) {
        prefs(context).edit().putBoolean("on", on).apply()
        if (on) {
            start(context)
        } else {
            // Off means off, wherever it was asked for.
            prefs(context).edit().putBoolean("anywhere", false).apply()
            stop(context)
        }
    }

    /** "Hey Promptly" away from the car: your choice, and off until you make it. */
    fun anywhere(context: Context): Boolean = prefs(context).getBoolean("anywhere", false)

    fun setAnywhere(context: Context, on: Boolean) {
        prefs(context).edit().putBoolean("anywhere", on).apply()
        if (on) start(context) else if (!Nav.onTrip() && !inCar) stop(context)
    }

    /** Android only lets the microphone open from the background for the phone's assistant. */
    fun holdsRole(context: Context): Boolean =
        context.getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_ASSISTANT) == true

    fun listensAnywhere(context: Context): Boolean = anywhere(context) && holdsRole(context)

    /** The notification's Turn off: only for now if that's what's keeping it on. */
    internal fun turnOff(context: Context) {
        if (Nav.onTrip() || inCar) setEnabled(context, false) else setAnywhere(context, false)
    }

    /** Start listening, if you've allowed it. Android can refuse from the background. */
    fun start(context: Context) {
        if (!(enabled(context) || listensAnywhere(context)) || !allowed(context) || _state.value != State.OFF) return
        Nav.init(context)
        runCatching {
            ContextCompat.startForegroundService(context, Intent(context, VoiceService::class.java))
        }.onFailure { Log.w(TAG, "Couldn't start listening", it) }
    }

    fun stop(context: Context) {
        context.stopService(Intent(context, VoiceService::class.java))
        setState(State.OFF)
    }

    internal fun setState(value: State) {
        _state.value = value
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
        // The moment before the wake word was recognised: people don't wait for the beep.
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
                    Nav.say(UNHEARD)
                }
            }
        } finally {
            runCatching { record.stop() }
            record.release()
            release()
            setState(was)
        }
    }

    private fun answered(context: Context, words: String) {
        Nav.init(context)
        _reply.value = words
        Nav.say(words) { _spoken.value += 1 }
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
            answered(context, if (refused) "This phone needs linking to your Promptly again." else "Sorry, I can't reach your server.")
        } finally {
            setState(was)
        }
    }

    fun clearReply() {
        _reply.value = null
    }
}

/** Keeps the microphone open for the wake word during a drive, with a notification
 *  saying so. Stops when the trip ends or you turn it off. */
class VoiceService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    @Volatile private var running = false
    private var thread: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Hey Promptly", NotificationManager.IMPORTANCE_LOW))
        val off = PendingIntent.getService(this, 0, Intent(this, VoiceService::class.java).setAction(ACTION_OFF), PendingIntent.FLAG_IMMUTABLE)
        val note = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_map_status)
            .setContentTitle("Listening for \"Hey Promptly\"")
            .setContentText("Sound stays on this phone until you say it.")
            .setOngoing(true)
            .addAction(0, "Turn off", off)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                startForeground(NOTE, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(NOTE, note)
            }
        } catch (e: Exception) {
            // Android doesn't allow opening the microphone from the background.
            Log.w(TAG, "Not allowed to listen right now", e)
            Voice.setState(Voice.State.OFF)
            stopSelf()
            return
        }
        running = true
        thread = Thread(::listen, "wake-word").also { it.start() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_OFF) Voice.turnOff(this)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        thread?.join(1500)
        Voice.setState(Voice.State.OFF)
        super.onDestroy()
    }

    private fun spotter(): KeywordSpotter {
        val model = OnlineModelConfig(
            transducer = OnlineTransducerModelConfig(
                encoder = "kws/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
                decoder = "kws/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
                joiner = "kws/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
            ),
            tokens = "kws/tokens.txt",
            numThreads = 1,
            modelType = "zipformer2",
        )
        val config = KeywordSpotterConfig(
            featConfig = FeatureConfig(sampleRate = Voice.SAMPLE_RATE, featureDim = 80),
            modelConfig = model,
            keywordsFile = "kws/keywords.txt",
            keywordsScore = 1.0f,
            keywordsThreshold = 0.35f,
            numTrailingBlanks = 1,
        )
        return KeywordSpotter(assets, config)
    }

    private fun listen() {
        val spot = runCatching { spotter() }.getOrElse {
            Log.w(TAG, "Couldn't load the wake word", it)
            stopSelf()
            return
        }
        val size = max(AudioRecord.getMinBufferSize(Voice.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), Voice.SAMPLE_RATE)
        val record = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, Voice.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size)
        } catch (e: SecurityException) {
            Log.w(TAG, "No microphone permission", e)
            stopSelf()
            return
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            Log.w(TAG, "The microphone is in use")
            record.release()
            stopSelf()
            return
        }
        var stream = spot.createStream()
        val frame = ShortArray(Voice.SAMPLE_RATE / 10)
        val samples = FloatArray(frame.size)
        var floor = 200.0
        val recent = ArrayDeque<ByteArray>()
        record.startRecording()
        Voice.setState(Voice.State.LISTENING)
        try {
            while (running) {
                val n = record.read(frame, 0, frame.size)
                if (n <= 0) continue
                // While someone else has the mic or the answer's coming, ignore it.
                if (paused) continue
                var sum = 0.0
                for (i in 0 until n) {
                    samples[i] = frame[i] / 32768f
                    sum += frame[i].toDouble() * frame[i]
                }
                // Only the background: your voice shouldn't count as how loud the car is.
                val level = sqrt(sum / n)
                if (level < floor * 2) floor = floor * 0.97 + level * 0.03 else floor = floor * 1.002
                val keep = ByteBuffer.allocate(n * 2).order(ByteOrder.LITTLE_ENDIAN)
                for (i in 0 until n) keep.putShort(frame[i])
                recent.addLast(keep.array())
                while (recent.size > 12) recent.removeFirst()
                stream.acceptWaveform(if (n == samples.size) samples else samples.copyOf(n), Voice.SAMPLE_RATE)
                var woke = false
                while (spot.isReady(stream)) {
                    spot.decode(stream)
                    if (spot.getResult(stream).keyword.isNotEmpty()) {
                        spot.reset(stream)
                        woke = true
                        break
                    }
                }
                if (woke) {
                    answer(record, floor, recent.fold(ByteArray(0)) { all, part -> all + part })
                    recent.clear()
                    stream.release()
                    stream = spot.createStream()
                    Voice.setState(Voice.State.LISTENING)
                }
            }
        } finally {
            runCatching { record.stop() }
            record.release()
            stream.release()
            spot.release()
        }
    }


    private fun answer(record: AudioRecord, floor: Double, before: ByteArray) {
        // Away from a drive nothing personal is said on a locked phone. Driving, you
        // set off with it on purpose, and the car's screen often leaves it locked.
        val driving = Nav.onTrip() || Voice.inCar
        if (!driving && PhoneActions.locked(this)) {
            Nav.say("Unlock your phone first.")
            return
        }
        if (!driving) {
            Voice.newConversation()
            PromptlyAssistantService.showSheet()
        }
        Voice.setState(Voice.State.HEARD)
        val release = Voice.holdFocus(this)
        try {
            Voice.chime()
            val clip = Voice.capture(floor, before) { buffer -> if (running) record.read(buffer, 0, buffer.size) else -1 }
            if (clip != null) Voice.ask(this, clip)
        } finally {
            release()
        }
    }

    companion object {
        private const val TAG = "PromptlyVoice"
        private const val CHANNEL = "voice"
        private const val NOTE = 4411
        private const val ACTION_OFF = "org.promptly.sync.maps.VOICE_OFF"
        // The car's own microphone is being used.
        @Volatile var paused = false
    }
}
