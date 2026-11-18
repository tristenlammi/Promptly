package org.promptly.sync.assistant

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.UiModeManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Binder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.car.app.connection.CarConnection
import androidx.lifecycle.Observer
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import org.promptly.sync.R
import kotlin.math.max
import kotlin.math.sqrt

/** Listens for "Hey Promptly", and nothing else. It's off unless you turn it on
 *  ([WakeWord]).
 *
 *  **Its own process (`:wake`).** The listening is native code running all day. If
 *  it ever falls over, it takes only this process with it: not the app, not a trip,
 *  not the car's screen. The app notices and starts it again a few times, then
 *  switches it off ([WakeRules.Faults]).
 *
 *  **Nothing leaves the phone.** The sound is matched here against one phrase and
 *  thrown away. When the phrase is heard this lets go of the microphone and tells the
 *  app, which opens the assistant's sheet; that is the first moment anything could be
 *  sent, and only once you speak ([WakeRules.Follow]).
 *
 *  **It gets out of the way.** While you drive, while the phone is connected to a
 *  car, during any app's call, and while another app records, the microphone is
 *  released outright (the green dot goes), not just ignored. This process checks
 *  the car, calls and other recordings itself; the app tells it about a P Maps trip
 *  and a Talk conversation ([ACTION_SET]).
 *
 *  **It never touches the volume or the music.** No audio focus is asked for here. */
class WakeService : Service() {
    @Volatile private var running = false
    @Volatile private var appHold: WakeRules.Hold? = null
    /** The phrase was heard and the app has the microphone until it says otherwise. */
    @Volatile private var handedAt = 0L
    @Volatile private var carType = CarConnection.CONNECTION_TYPE_NOT_CONNECTED
    @Volatile private var shown: String? = null
    /** What the app was last told (it asks again whenever it starts this). */
    @Volatile private var told: String? = null
    private var thread: Thread? = null
    private var car: CarConnection? = null
    private val carWatch = Observer<Int> { carType = it }
    private val main = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder = Binder()

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(CHANNEL, "Hey Promptly", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        if (!foreground(LISTENING)) {
            // Android said not now (the app had only just been started in the
            // background, say). That isn't a fault: the app asks again shortly.
            tell(WakeReceiver.ACTION_REFUSED)
            stopSelf()
            return
        }
        runCatching {
            car = CarConnection(applicationContext).also { it.type.observeForever(carWatch) }
        }.onFailure { Log.i(TAG, "Can't tell whether a car is connected: ${it.javaClass.simpleName}") }
        running = true
        thread = Thread({
            try {
                listen()
            } catch (e: Throwable) {
                // Anything at all: say so and stop. The app decides whether to try again.
                Log.w(TAG, "Listening stopped", e)
                tell(WakeReceiver.ACTION_FAULT) { putExtra(WakeReceiver.EXTRA_WHY, "${e.javaClass.simpleName}: ${e.message}".take(300)) }
                main.post { stopSelf() }
            }
        }, "wake-word").also { it.start() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Every start asks for the notification again: Android insists on it.
        if (running) foreground(shown ?: LISTENING)
        told = null
        when (intent?.action) {
            ACTION_SET -> {
                appHold = intent.getStringExtra(EXTRA_HOLD)?.let { name -> WakeRules.Hold.entries.firstOrNull { it.name == name } }
                if (intent.getBooleanExtra(EXTRA_RESUME, false)) handedAt = 0L
            }
            // The app flips the switch and stops this, so it isn't taken for a fault.
            ACTION_OFF -> tell(WakeReceiver.ACTION_TURNED_OFF)
        }
        // Not restarted behind your back: only the app starts it, when it's allowed to.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        runCatching { car?.type?.removeObserver(carWatch) }
        thread?.join(1500)
        super.onDestroy()
    }

    private fun foreground(text: String): Boolean = try {
        startForeground(NOTE, note(text), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        shown = text
        true
    } catch (e: Exception) {
        // Android only lets the microphone open from the background for the phone's
        // assistant. Not allowed just now: stop quietly, and the app tries later.
        Log.w(TAG, "Not allowed to listen right now: ${e.javaClass.simpleName}")
        false
    }

    private fun note(text: String): Notification {
        val off = PendingIntent.getService(this, 0, Intent(this, WakeService::class.java).setAction(ACTION_OFF), PendingIntent.FLAG_IMMUTABLE)
        val open = PendingIntent.getActivity(this, 1, Intent(this, AssistantSettingsActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val listening = text == LISTENING
        // Paused: the reason goes underneath, where there's room for all of it.
        val why = text.removePrefix("Paused ").replaceFirstChar { it.uppercase() }
        val body = if (listening) "Sound stays on this phone until you say it." else "$why. It starts listening again by itself."
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_promptly_status)
            .setContentTitle(if (listening) text else PAUSED)
            .setContentText(if (listening) body else why)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Turn off", off).build())
            .build()
    }

    private fun show(text: String) {
        if (shown != text) {
            shown = text
            runCatching { getSystemService(NotificationManager::class.java).notify(NOTE, note(text)) }
        }
        if (told != text) {
            told = text
            tell(WakeReceiver.ACTION_STATE) { putExtra(WakeReceiver.EXTRA_WHY, text) }
        }
    }

    private fun tell(action: String, more: Intent.() -> Unit = {}) {
        runCatching { sendBroadcast(Intent(this, WakeReceiver::class.java).setAction(action).apply(more)) }
    }

    // ------------------------------------------------------------ what it can see
    private fun own(recording: AudioRecord?): WakeRules.OwnFacts {
        val audio = getSystemService(AudioManager::class.java)
        val carMode = getSystemService(UiModeManager::class.java)?.currentModeType == Configuration.UI_MODE_TYPE_CAR
        val mine = recording?.audioSessionId
        val others = runCatching {
            audio.activeRecordingConfigurations.any { it.clientAudioSessionId != mine || it.isClientSilenced }
        }.getOrDefault(false)
        return WakeRules.OwnFacts(
            car = carMode || carType != CarConnection.CONNECTION_TYPE_NOT_CONNECTED,
            call = WakeRules.callMode(audio.mode),
            otherRecording = others,
        )
    }

    // ------------------------------------------------------------ listening
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
            featConfig = FeatureConfig(sampleRate = RATE, featureDim = 80),
            modelConfig = model,
            keywordsFile = "kws/keywords.txt",
            keywordsScore = WakeRules.BOOST,
            keywordsThreshold = WakeRules.THRESHOLD,
            numTrailingBlanks = 1,
        )
        return KeywordSpotter(assets, config)
    }

    @SuppressLint("MissingPermission")
    private fun open(): AudioRecord? {
        val size = max(AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), RATE)
        val record = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size)
        } catch (e: Exception) {
            Log.i(TAG, "No microphone: ${e.javaClass.simpleName}")
            return null
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            return null
        }
        return try {
            record.startRecording()
            if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) throw IllegalStateException("didn't start")
            record
        } catch (e: Exception) {
            record.release()
            null
        }
    }

    private fun close(record: AudioRecord?) {
        if (record == null) return
        runCatching { record.stop() }
        record.release()
    }

    private fun listen() {
        val spot = spotter()
        var stream: OnlineStream = spot.createStream()
        var record: AudioRecord? = null
        // Debug builds only: a test's sound files in place of the microphone.
        val test = org.promptly.sync.talk.TalkDebug.wakeMic(this)
        val part = ShortArray(RATE / 50)
        val frame = ShortArray(RATE / 10)
        val samples = FloatArray(frame.size)
        var floor = 200.0
        var quietFrames = 0
        var before: FloatArray? = null
        var checkAt = 0L
        var facts = own(null)
        try {
            while (running) {
                val now = SystemClock.elapsedRealtime()
                // The app has the microphone after the phrase: until it says it's done,
                // or twenty seconds at most if it never does.
                if (handedAt != 0L && now - handedAt > HANDED_MS) handedAt = 0L
                if (now - checkAt >= CHECK_MS) {
                    checkAt = now
                    facts = own(record)
                }
                val hold = if (handedAt != 0L) WakeRules.Hold.TALKING else WakeRules.hold(appHold, facts)
                if (hold != null) {
                    // Let go of it altogether: the green dot goes too.
                    close(record)
                    record = null
                    show(hold.says)
                    Thread.sleep(PAUSED_SLEEP_MS)
                    continue
                }
                if (record == null && test == null) {
                    record = open()
                    if (record == null) {
                        show(WakeRules.Hold.MIC_BUSY.says)
                        Thread.sleep(BUSY_SLEEP_MS)
                        continue
                    }
                    spot.reset(stream)
                    quietFrames = 0
                }
                show(LISTENING)
                val n = if (test != null) {
                    var got = 0
                    repeat(5) {
                        val k = test.read(part)
                        if (k > 0) {
                            part.copyInto(frame, got, 0, k)
                            got += k
                        }
                    }
                    got
                } else {
                    record!!.read(frame, 0, frame.size)
                }
                if (n <= 0) {
                    close(record)
                    record = null
                    Thread.sleep(PAUSED_SLEEP_MS)
                    continue
                }
                var sum = 0.0
                for (i in 0 until n) {
                    samples[i] = frame[i] / 32768f
                    sum += frame[i].toDouble() * frame[i]
                }
                val level = sqrt(sum / n)
                // Only the background counts as how loud the room is, not a voice.
                floor = if (level < floor * 2) floor * 0.97 + level * 0.03 else floor * 1.002
                // A silent room isn't matched against anything: easier on the battery.
                val wasSilent = quietFrames > SILENT_FRAMES
                quietFrames = if (level < SILENT_RMS) quietFrames + 1 else 0
                if (quietFrames > SILENT_FRAMES) {
                    if (quietFrames == SILENT_FRAMES + 1) spot.reset(stream)
                    before = samples.copyOf(n)
                    continue
                }
                // Coming out of silence: the tenth of a second before it too, so the
                // start of the phrase isn't clipped.
                if (wasSilent) before?.let { stream.acceptWaveform(it, RATE) }
                before = null
                stream.acceptWaveform(if (n == samples.size) samples else samples.copyOf(n), RATE)
                var woke = false
                while (spot.isReady(stream)) {
                    spot.decode(stream)
                    if (spot.getResult(stream).keyword.isNotEmpty()) {
                        woke = true
                        break
                    }
                }
                if (woke) {
                    close(record)
                    record = null
                    stream.release()
                    stream = spot.createStream()
                    handedAt = SystemClock.elapsedRealtime()
                    val was = floor
                    tell(WakeReceiver.ACTION_HEARD) { putExtra(WakeReceiver.EXTRA_FLOOR, was) }
                }
            }
        } finally {
            close(record)
            runCatching { test?.close() }
            runCatching { stream.release() }
            runCatching { spot.release() }
        }
    }

    companion object {
        private const val TAG = "PromptlyWake"
        private const val CHANNEL = "wake"
        private const val NOTE = 4141
        private const val RATE = 16_000
        const val LISTENING = "Listening for \"Hey Promptly\""
        const val PAUSED = "\"Hey Promptly\" is paused"
        const val ACTION_SET = "org.promptly.wake.SET"
        const val ACTION_OFF = "org.promptly.wake.OFF"
        const val EXTRA_HOLD = "hold"
        const val EXTRA_RESUME = "resume"
        private const val CHECK_MS = 500L
        private const val PAUSED_SLEEP_MS = 700L
        private const val BUSY_SLEEP_MS = 2_000L
        private const val HANDED_MS = 20_000L
        /** Quieter than this (of 32768) for [SILENT_FRAMES] tenths of a second: a silent room. */
        private const val SILENT_RMS = 90.0
        private const val SILENT_FRAMES = 15

        fun intent(context: Context, hold: WakeRules.Hold?, resume: Boolean = false): Intent =
            Intent(context, WakeService::class.java).setAction(ACTION_SET).putExtra(EXTRA_HOLD, hold?.name).putExtra(EXTRA_RESUME, resume)
    }
}
