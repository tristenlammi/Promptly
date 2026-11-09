package org.promptly.sync.capture

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.promptly.sync.R
import org.promptly.sync.widgets.WidgetStore
import org.promptly.sync.widgets.WidgetSync
import org.promptly.sync.widgets.Widgets
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/**
 * Records a voice note. A foreground service of type `microphone`, running
 * only while a recording is being made (so the screen can lock and you can
 * leave the recording screen), with a notification that says so and can
 * pause or save it. Nothing listens otherwise.
 *
 * The recording is AAC in .m4a (mono, 48 kbps — about 21 MB an hour), kept
 * in the app's own storage. "Stop & save" puts it in the widgets' outbox as a
 * new voice note: it goes up with tus whenever there's signal, and the
 * server attaches and transcribes it.
 */
class RecorderService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var recorder: MediaRecorder? = null
    private var ticker: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val channel = NotificationChannel(CHANNEL, "Voice notes", NotificationManager.IMPORTANCE_LOW)
        channel.description = "Shown while a voice note is recording"
        channel.setSound(null, null)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> start()
            ACTION_PAUSE -> pause()
            ACTION_RESUME -> resume()
            ACTION_SAVE -> finish(save = true)
            ACTION_DISCARD -> finish(save = false)
            else -> if (Recorder.state.value.phase == Phase.IDLE) stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun foreground() {
        val n = notification()
        try {
            if (Build.VERSION.SDK_INT >= 30) startForeground(NOTE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            else startForeground(NOTE, n)
        } catch (e: RuntimeException) {
            // Android said no (started from the background): nothing records.
            Log.w(TAG, "Couldn't start recording in the foreground", e)
            throw e
        }
    }

    private fun start() {
        if (Recorder.state.value.phase != Phase.IDLE) {
            foreground() // already going: just make sure it's shown
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            Recorder.set(RecState(error = "Promptly needs the microphone to record. Allow it, then try again."))
            stopSelf()
            return
        }
        val file = Capture.newFile(this, "m4a")
        Recorder.set(RecorderLogic.start(file, SystemClock.elapsedRealtime(), System.currentTimeMillis()))
        try {
            foreground()
        } catch (e: RuntimeException) {
            Recorder.set(RecState(error = "Couldn't start recording. Open the recorder and try again."))
            file.delete()
            stopSelf()
            return
        }
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioChannels(1)
            r.setAudioSamplingRate(44_100)
            r.setAudioEncodingBitRate(48_000)
            r.setOutputFile(file.absolutePath)
            r.setOnErrorListener { _, what, extra ->
                Log.w(TAG, "MediaRecorder error $what/$extra")
                scope.launch { finish(save = true) } // keep what was recorded
            }
            r.prepare()
            r.start()
        } catch (e: Exception) {
            Log.w(TAG, "Couldn't start the microphone", e)
            runCatching { r.release() }
            file.delete()
            Recorder.set(RecState(error = "The microphone is busy or unavailable. Close any app that's using it and try again."))
            stopForegroundCompat()
            stopSelf()
            return
        }
        recorder = r
        tick()
    }

    private fun tick() {
        ticker?.cancel()
        ticker = scope.launch {
            var lastShown = -1L
            while (isActive) {
                delay(RecorderLogic.SAMPLE_MS)
                val r = recorder ?: break
                val amp = runCatching { r.maxAmplitude }.getOrDefault(0)
                Recorder.update { RecorderLogic.sample(it, amp) }
                val now = SystemClock.elapsedRealtime()
                val s = Recorder.state.value
                if (RecorderLogic.full(s, now)) {
                    finish(save = true)
                    break
                }
                val sec = s.elapsed(now) / 1000
                if (sec != lastShown && sec % 5 == 0L) {
                    lastShown = sec
                    notify(notification())
                }
            }
        }
    }

    private fun pause() {
        val r = recorder ?: return
        if (Recorder.state.value.phase != Phase.RECORDING) return
        runCatching { r.pause() }.onFailure { Log.w(TAG, "pause", it) }
        Recorder.update { RecorderLogic.pause(it, SystemClock.elapsedRealtime()) }
        notify(notification())
    }

    private fun resume() {
        val r = recorder ?: return
        if (Recorder.state.value.phase != Phase.PAUSED) return
        runCatching { r.resume() }.onFailure { Log.w(TAG, "resume", it) }
        Recorder.update { RecorderLogic.resume(it, SystemClock.elapsedRealtime()) }
        notify(notification())
    }

    private fun finish(save: Boolean) {
        val s = Recorder.state.value
        if (s.phase == Phase.IDLE || s.phase == Phase.SAVING) {
            if (s.phase == Phase.IDLE) {
                stopForegroundCompat()
                stopSelf()
            }
            return
        }
        ticker?.cancel()
        val stopped = RecorderLogic.stop(s, SystemClock.elapsedRealtime())
        Recorder.set(stopped)
        val r = recorder
        recorder = null
        val ok = r != null && runCatching { r.stop() }.isSuccess
        runCatching { r?.release() }
        val file = stopped.file
        val app = applicationContext
        val keep = save && ok && file != null && file.length() > 0 && stopped.recordedBefore >= RecorderLogic.MIN_MS
        if (!keep) {
            file?.delete()
            if (save) Toast.makeText(app, "Too short to keep — nothing was saved.", Toast.LENGTH_SHORT).show()
            Recorder.set(RecState())
            stopForegroundCompat()
            stopSelf()
            return
        }
        scope.launch {
            val name = "Voice note " + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH.mm")) + ".m4a"
            val ref = Capture.ref(file!!, name, "audio/mp4", stopped.recordedBefore, RecorderLogic.peaks(stopped.samples))
            val op = WidgetStore.addNote(app, "text", "", "", emptyList(), "voice", listOf(ref), System.currentTimeMillis())
            Widgets.redraw(app)
            WidgetSync.now(app)
            Toast.makeText(app, if (Online.now(app)) "Voice note saved" else "Saved on this phone — will sync", Toast.LENGTH_SHORT).show()
            Recorder.saved.value = op.id
            Recorder.set(RecState())
            stopForegroundCompat()
            stopSelf()
        }
    }

    private fun stopForegroundCompat() {
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    private fun notify(n: Notification) {
        runCatching { getSystemService(NotificationManager::class.java).notify(NOTE, n) }
    }

    private fun action(action: String, code: Int): PendingIntent = PendingIntent.getService(
        this, code, Intent(this, RecorderService::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun notification(): Notification {
        val s = Recorder.state.value
        val now = SystemClock.elapsedRealtime()
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, VoiceNoteActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val paused = s.phase == Phase.PAUSED
        val b = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_map_mic)
            .setContentTitle(if (paused) "Voice note paused" else "Recording a voice note")
            .setContentText(if (paused) RecorderLogic.clock(s.elapsed(now)) + " so far" else "Tap to see it, or save it from here.")
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        if (!paused && s.phase == Phase.RECORDING) {
            // The system counts up from when it would have started, pauses taken off.
            b.setUsesChronometer(true).setShowWhen(true).setWhen(System.currentTimeMillis() - s.elapsed(now))
        }
        b.addAction(0, if (paused) "Resume" else "Pause", action(if (paused) ACTION_RESUME else ACTION_PAUSE, 1))
        b.addAction(0, "Stop & save", action(ACTION_SAVE, 2))
        return b.build()
    }

    override fun onDestroy() {
        // Killed mid-recording (rare: a foreground service): keep what there is.
        if (recorder != null) {
            val s = Recorder.state.value
            runCatching { recorder?.stop() }
            runCatching { recorder?.release() }
            recorder = null
            val file = s.file
            if (file != null && file.length() > 0) {
                val stopped = RecorderLogic.stop(s, SystemClock.elapsedRealtime())
                val app = applicationContext
                val ref = Capture.ref(file, "Voice note.m4a", "audio/mp4", stopped.recordedBefore, RecorderLogic.peaks(stopped.samples))
                Widgets.scope.launch {
                    WidgetStore.addNote(app, "text", "", "", emptyList(), "voice", listOf(ref), System.currentTimeMillis())
                    WidgetSync.now(app)
                }
            }
            Recorder.set(RecState())
        }
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "PromptlyVoice"
        private const val CHANNEL = "voice_notes"
        private const val NOTE = 7311
        const val ACTION_START = "org.promptly.sync.capture.RECORD"
        const val ACTION_PAUSE = "org.promptly.sync.capture.PAUSE"
        const val ACTION_RESUME = "org.promptly.sync.capture.RESUME"
        const val ACTION_SAVE = "org.promptly.sync.capture.SAVE"
        const val ACTION_DISCARD = "org.promptly.sync.capture.DISCARD"

        fun send(ctx: Context, action: String) {
            val i = Intent(ctx, RecorderService::class.java).setAction(action)
            if (action == ACTION_START) ContextCompat.startForegroundService(ctx, i) else ctx.startService(i)
        }
    }
}
