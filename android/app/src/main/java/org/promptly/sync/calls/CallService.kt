package org.promptly.sync.calls

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.twilio.audioswitch.AudioDevice
import io.livekit.android.AudioOptions
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.AudioTrackPublishDefaults
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.Track
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import org.promptly.sync.BuildConfig
import org.promptly.sync.R
import org.promptly.sync.voice.DropKind
import org.promptly.sync.voice.VoiceProtocol
import org.promptly.sync.voice.userOfIdentity
import java.io.IOException

/**
 * A DM call's audio on this phone (Calls WP-D3), built like the voice-channel
 * [org.promptly.sync.voice.VoiceService]: a foreground service holding one
 * LiveKit connection, audio only, that keeps going with the screen off or in
 * other apps, with an ongoing call notification (Mute, Speaker, Hang up).
 *
 * It answers with the ring's token (`POST /api/calls/answer`), then lives on
 * the call session from the answer: fresh tokens from `session/refresh`, hang
 * up with `session/leave`. Telecom ([CallTelecom]) routes the audio when it
 * holds the call; otherwise LiveKit's AudioSwitch does (headset › wired ›
 * earpiece, or the loudspeaker for video). Cameras and screens are the page's
 * (`POST /api/calls/{id}/view`), opened by the call screen.
 */
class CallService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var server = ""
    private var api: CallApi? = null
    private var callId: String? = null
    private var ringToken: String? = null
    private var title = "Call"
    private var video = false
    private var group = false
    private var join: CallJoin? = null
    private var session: String? = null
    private var room: Room? = null
    private var roomJob: Job? = null
    private var connectJob: Job? = null
    private var routeJob: Job? = null
    private val micLock = Mutex()
    private var status = CallNote.Status.CONNECTING
    private var muted = false
    private var speaker = false
    private var connectedAt = 0L
    private var others = 0
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private var foreground = false
    private var stopping = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        CallCenter.init(this)
        current = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_ANSWER -> start(intent)
            ACTION_MUTE -> if (callId != null) setMuted(!muted) else stopSelf()
            ACTION_SPEAKER -> if (callId != null) setSpeaker(!speaker) else stopSelf()
            ACTION_HANG_UP -> callId?.let { CallCenter.hangUp(it) } ?: stopSelf()
            else -> if (callId == null) stopSelf()
        }
        // Not sticky: a call can't come back on its own, and the server
        // notices we've gone.
        return START_NOT_STICKY
    }

    // ================================================================ answering

    private fun start(intent: Intent) {
        val newServer = intent.getStringExtra(EXTRA_SERVER) ?: return stopIfIdle()
        val token = intent.getStringExtra(EXTRA_TOKEN) ?: return stopIfIdle()
        val id = intent.getStringExtra(EXTRA_CALL) ?: return stopIfIdle()
        if (id == callId) return
        if (callId != null) {
            // End and answer: the center hung the old one up (its leave is on
            // its way); this service carries on with the new call.
            closeRoom()
            connectJob?.cancel()
        }
        stopping = false
        server = newServer
        api = CallApi(newServer)
        callId = id
        ringToken = token
        title = intent.getStringExtra(EXTRA_TITLE) ?: "Call"
        video = intent.getBooleanExtra(EXTRA_VIDEO, false)
        group = intent.getBooleanExtra(EXTRA_GROUP, false)
        session = null
        join = null
        status = CallNote.Status.CONNECTING
        muted = false
        speaker = Routing.startsOnSpeaker(video)
        connectedAt = 0L
        others = 0
        publish()
        if (!goForeground()) return
        holdLocks()
        answer(id, token)
    }

    private fun stopIfIdle() {
        if (callId == null) stopSelf()
    }

    private fun hasMic() = ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** True when we're a foreground service (Android may refuse). */
    private fun goForeground(): Boolean {
        val mic = if (hasMic()) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        val tries = if (Build.VERSION.SDK_INT >= 30) {
            listOf(ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or mic, mic or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            listOf(0)
        }
        for (types in tries) {
            try {
                ServiceCompat.startForeground(this, NOTE, buildNote(), types)
                foreground = true
                return true
            } catch (e: RuntimeException) {
                // ForegroundServiceStartNotAllowedException / SecurityException.
                Log.w(TAG, "can't run in the foreground as $types", e)
            }
        }
        val id = callId
        callId = null
        if (id != null) CallCenter.ended(id, "failed")
        stopSelf()
        return false
    }

    /** Redeem the ring's token; network trouble is retried while it lives. */
    private fun answer(id: String, token: String) {
        connectJob?.cancel()
        connectJob = scope.launch {
            val a = api ?: return@launch
            val deadline = (AnswerToken.expiresAt(token) ?: (System.currentTimeMillis() + 60_000))
            var wait = 1_000L
            while (isActive) {
                try {
                    val j = a.answer(token)
                    join = j
                    session = j.session
                    CallCenter.setMedia(CallCenter.media.value.copy(callId = id, roomId = j.roomId, group = j.group))
                    if (connect(j)) return@launch
                } catch (_: CallApi.Over) {
                    // Answered elsewhere, ended, or the token died: no call here.
                    finish("failed")
                    return@launch
                } catch (e: IOException) {
                    Log.i(TAG, "answer: ${e.message}")
                } catch (e: IllegalArgumentException) {
                    Log.w(TAG, "answer", e)
                }
                if (session != null) {
                    // Answered, but the connection failed: the session's ours now.
                    rejoin()
                    return@launch
                }
                if (System.currentTimeMillis() + wait >= deadline) {
                    finish("failed")
                    return@launch
                }
                status = CallNote.Status.CONNECTING
                note()
                delay(wait)
                wait = (wait * 2).coerceAtMost(4_000)
            }
        }
    }

    // ================================================================ connecting

    private fun rejoin() {
        connectJob?.cancel()
        connectJob = scope.launch {
            val plan = CallRejoin(SystemClock.elapsedRealtime())
            while (isActive) {
                val s = session ?: return@launch
                val a = api ?: return@launch
                val step = when (val got = plan.next(a.refresh(s), SystemClock.elapsedRealtime())) {
                    is CallRejoin.Step.Connect -> if (connect(got.join)) return@launch else plan.connectFailed(SystemClock.elapsedRealtime())
                    else -> got
                }
                when (step) {
                    is CallRejoin.Step.Retry -> {
                        status = CallNote.Status.RECONNECTING
                        note()
                        publish()
                        delay(step.inMs)
                    }
                    is CallRejoin.Step.Stop -> {
                        finish(step.why)
                        return@launch
                    }
                    is CallRejoin.Step.Connect -> Unit
                }
            }
        }
    }

    private suspend fun connect(j: CallJoin): Boolean {
        val id = callId ?: return false
        closeRoom()
        join = j
        session = j.session
        val telecom = CallCenter.telecomHolds(id)
        val r = LiveKit.create(
            applicationContext,
            RoomOptions(audioTrackPublishDefaults = AudioTrackPublishDefaults(audioBitrate = 32_000, dtx = true, red = true)),
            // Telecom routes and focuses a call's audio itself.
            if (telecom) LiveKitOverrides(audioOptions = AudioOptions(audioHandler = NoAudioHandler())) else LiveKitOverrides(),
        )
        r.audioSwitchHandler?.apply {
            preferredDeviceList = if (speaker) {
                listOf(AudioDevice.BluetoothHeadset::class.java, AudioDevice.WiredHeadset::class.java, AudioDevice.Speakerphone::class.java, AudioDevice.Earpiece::class.java)
            } else {
                listOf(AudioDevice.BluetoothHeadset::class.java, AudioDevice.WiredHeadset::class.java, AudioDevice.Earpiece::class.java, AudioDevice.Speakerphone::class.java)
            }
        }
        room = r
        roomJob = scope.launch { r.events.collect { onEvent(r, it) } }
        try {
            r.connect(VoiceProtocol.signalUrl(server, j.url), j.token, ConnectOptions(autoSubscribe = false))
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            Log.w(TAG, "couldn't connect", e)
            if (room === r) closeRoom()
            return false
        }
        if (room !== r) return false
        status = CallNote.Status.CONNECTED
        if (connectedAt == 0L) connectedAt = System.currentTimeMillis()
        reconcile()
        countPeople()
        syncMic()
        if (telecom) {
            // Telecom's own mute (the car's or a headset's mute button) follows here.
            routeJob?.cancel()
            routeJob = scope.launch {
                var system: Boolean? = null
                CallCenter.audio.collectLatest { a ->
                    if (room !== r) return@collectLatest
                    if (system != null && a.muted != system) setMuted(a.muted)
                    system = a.muted
                    // Where Telecom put the sound (a headset that just connected wins).
                    a.current?.let { k ->
                        val on = k == Routing.Kind.SPEAKER
                        if (on != speaker) {
                            speaker = on
                            note(now = true)
                            publish()
                        }
                    }
                }
            }
            if (speaker) CallCenter.telecomSpeaker(id, true)
        }
        CallCenter.connected(id)
        checkSoon(60_000)
        publish()
        note(now = true)
        if (BuildConfig.DEBUG) watchLevels()
        return true
    }

    private fun closeRoom() {
        val r = room ?: return
        room = null
        roomJob?.cancel()
        roomJob = null
        routeJob?.cancel()
        routeJob = null
        runCatching { r.disconnect() }
        runCatching { r.release() }
    }

    private fun onEvent(r: Room, e: RoomEvent) {
        if (room !== r) return
        when (e) {
            is RoomEvent.ParticipantConnected, is RoomEvent.ParticipantDisconnected -> {
                reconcile()
                countPeople()
                note()
                publish()
                // Alone now: ask the server whether the call's over (a 1:1 ends
                // when the other person goes) rather than wait for LiveKit.
                if (e is RoomEvent.ParticipantDisconnected && others == 0) checkSoon(1_500)
            }
            is RoomEvent.TrackPublished -> reconcile()
            // The page showing the call's video, as a remote control.
            is RoomEvent.DataReceived -> when (CallProtocol.parseControl(e.data, e.topic, fromServer = e.participant == null)) {
                CallProtocol.Control.MUTE -> setMuted(true)
                CallProtocol.Control.UNMUTE -> setMuted(false)
                CallProtocol.Control.SPEAKER_ON -> setSpeaker(true)
                CallProtocol.Control.SPEAKER_OFF -> setSpeaker(false)
                null -> Unit
            }
            is RoomEvent.Reconnecting -> {
                status = CallNote.Status.RECONNECTING
                note()
                publish()
            }
            is RoomEvent.Reconnected -> {
                status = CallNote.Status.CONNECTED
                note()
                publish()
            }
            is RoomEvent.Disconnected -> onDropped(e.reason.name)
            else -> Unit
        }
    }

    /** Is the call still on for this session? Ends it here when not. Also
     *  every minute while the call's on, in case LiveKit says nothing. */
    private var checkJob: Job? = null

    private fun checkSoon(inMs: Long) {
        checkJob?.cancel()
        checkJob = scope.launch {
            delay(inMs)
            while (isActive && room != null) {
                val s = session ?: return@launch
                val a = api ?: return@launch
                if (a.refresh(s) is CallRefresh.Gone) {
                    finish("ended")
                    return@launch
                }
                delay(60_000)
            }
        }
    }

    private fun onDropped(reason: String) {
        Log.i(TAG, "dropped: $reason")
        when (DropKind.of(reason)) {
            DropKind.OURS -> Unit
            // Taken over on another device of yours.
            DropKind.REPLACED -> finish("replaced")
            // The call ended (the room closed), or the network: the refresh says which.
            DropKind.REMOVED, DropKind.NETWORK -> {
                closeRoom()
                status = CallNote.Status.RECONNECTING
                note()
                publish()
                rejoin()
            }
        }
    }

    /** Hear everyone's microphone and nothing else (video is the page's). */
    private fun reconcile() {
        val r = room ?: return
        for (p in r.remoteParticipants.values) {
            if (userOfIdentity(p.identity?.value ?: "") == null) continue
            for (pub in p.trackPublications.values) {
                val rp = pub as? RemoteTrackPublication ?: continue
                val want = rp.source == Track.Source.MICROPHONE || rp.source == Track.Source.SCREEN_SHARE_AUDIO
                if (rp.subscribed != want) rp.setSubscribed(want)
                (rp.track as? RemoteAudioTrack)?.setVolume(1.0)
            }
        }
    }

    private fun countPeople() {
        val r = room ?: return
        others = r.remoteParticipants.values.count { userOfIdentity(it.identity?.value ?: "") != null }
    }

    // ================================================================ mute and speaker

    fun setMuted(on: Boolean) {
        if (muted == on) return
        muted = on
        syncMic()
        note(now = true)
        publish()
    }

    fun setSpeaker(on: Boolean) {
        speaker = on
        val id = callId
        if (id == null || !CallCenter.telecomSpeaker(id, on)) {
            val sw = room?.audioSwitchHandler
            if (sw != null) {
                val devices = sw.availableAudioDevices
                val pick = if (on) {
                    devices.firstOrNull { it is AudioDevice.Speakerphone }
                } else {
                    devices.firstOrNull { it is AudioDevice.BluetoothHeadset } ?: devices.firstOrNull { it is AudioDevice.WiredHeadset } ?: devices.firstOrNull { it is AudioDevice.Earpiece }
                }
                if (pick != null) sw.selectDevice(pick)
            }
        }
        note(now = true)
        publish()
    }

    private fun syncMic() {
        val r = room ?: return
        scope.launch {
            micLock.withLock {
                if (room !== r || !hasMic()) return@withLock
                try {
                    r.localParticipant.setMicrophoneEnabled(!muted)
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    Log.w(TAG, "microphone", e)
                }
            }
        }
    }

    // ================================================================ leaving

    /** Hang up (the center decided): leave on the server, then stop. */
    fun leave(id: String) {
        if (id != callId) return
        val s = session
        val a = api
        closeRoom()
        if (s == null || a == null) {
            finish("left")
            return
        }
        scope.launch {
            withTimeoutOrNull(4_000) { runCatching { a.leave(s) } }
            // End and answer: the new call may already be here; leave it be.
            if (callId == id) finish("left")
        }
    }

    private fun finish(why: String) {
        if (stopping) return
        stopping = true
        Log.i(TAG, "finished: $why")
        val id = callId
        connectJob?.cancel()
        checkJob?.cancel()
        closeRoom()
        releaseLocks()
        callId = null
        session = null
        join = null
        if (id != null) CallCenter.ended(id, why)
        CallCenter.setMedia(CallCenter.Media())
        if (foreground) ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        foreground = false
        stopSelf()
    }

    override fun onDestroy() {
        if (!stopping) {
            // Killed mid-call: hang up properly so nobody waits for us.
            val s = session
            val a = api
            if (s != null && a != null) CoroutineScope(Dispatchers.IO).launch { runCatching { a.leave(s) } }
            callId?.let { CallCenter.ended(it, "lost") }
        }
        closeRoom()
        releaseLocks()
        if (current === this) current = null
        scope.cancel()
        super.onDestroy()
    }

    // ================================================================ state for the screen and the notification

    private fun publish() {
        CallCenter.setMedia(
            CallCenter.Media(
                callId = callId,
                roomId = join?.roomId,
                connectedAt = connectedAt,
                status = status,
                muted = muted,
                speaker = speaker,
                others = others,
                group = group,
            ),
        )
    }

    private fun notifications() = getSystemService(NotificationManager::class.java)

    private var lastNoteAt = 0L
    private var noteJob: Job? = null

    private fun note(now: Boolean = false) {
        if (!foreground || stopping) return
        val wait = 350 - (SystemClock.elapsedRealtime() - lastNoteAt)
        if (now || wait <= 0) {
            noteJob?.cancel()
            noteJob = null
            lastNoteAt = SystemClock.elapsedRealtime()
            notifications().notify(NOTE, buildNote())
            return
        }
        if (noteJob?.isActive == true) return
        noteJob = scope.launch {
            delay(wait)
            noteJob = null
            note(now = true)
        }
    }

    private fun buildNote(): Notification {
        val seconds = if (connectedAt > 0) (System.currentTimeMillis() - connectedAt) / 1000 else 0
        val n = CallNote.of(title, video, status, muted, speaker, seconds, others, group)
        val open = PendingIntent.getActivity(
            this, 20, CallActivity.intent(this, callId ?: "", answer = false),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val person = Person.Builder().setName(title).setImportant(true).apply {
            CallCenter.picture(callId ?: "")?.let { runCatching { setIcon(androidx.core.graphics.drawable.IconCompat.createFromIcon(this@CallService, it)) } }
        }.build()
        val b = NotificationCompat.Builder(this, RingNotes.CHANNEL_ONGOING)
            .setSmallIcon(R.drawable.ic_call_status)
            .setColor(RingNotes.ACCENT)
            .setContentTitle(n.title)
            .setContentText(if (status == CallNote.Status.CONNECTED) (if (muted) "You're muted" else null) else n.text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(open)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, action(ACTION_HANG_UP, 3)).setIsVideo(video))
            .addAction(R.drawable.ic_call_mic_off, n.muteLabel, action(ACTION_MUTE, 1))
            .addAction(R.drawable.ic_call_speaker, n.speakerLabel, action(ACTION_SPEAKER, 2))
        if (status == CallNote.Status.CONNECTED && connectedAt > 0) {
            b.setWhen(connectedAt).setShowWhen(true).setUsesChronometer(true)
        } else {
            b.setShowWhen(false)
        }
        return b.build()
    }

    private fun action(what: String, code: Int): PendingIntent = PendingIntent.getService(
        this, code, Intent(this, CallService::class.java).setAction(what),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    // ================================================================ locks

    private fun holdLocks() {
        if (wake == null) {
            wake = (getSystemService(POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "promptly:call")
                .apply { setReferenceCounted(false); acquire() }
        }
        if (wifi == null) {
            val wm = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            wifi = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "promptly:call")
                .apply { setReferenceCounted(false); acquire() }
        }
    }

    private fun releaseLocks() {
        runCatching { wake?.release() }
        wake = null
        runCatching { wifi?.release() }
        wifi = null
    }

    // ================================================================ debug

    /** Debug builds: log the audio each way every 2 s, so a test can see it flow. */
    private var levelJob: Job? = null

    private fun watchLevels() {
        levelJob?.cancel()
        levelJob = scope.launch {
            while (isActive) {
                delay(2_000)
                val r = room ?: break
                r.getSubscriberRTCStats { report ->
                    val ins = report.statsMap.values.filter { it.type == "inbound-rtp" && it.members["kind"] == "audio" }
                    val packets = ins.sumOf { (it.members["packetsReceived"] as? Number)?.toLong() ?: 0L }
                    Log.d(TAG, "audio in: tracks=${ins.size} packets=$packets")
                }
                r.getPublisherRTCStats { report ->
                    val outs = report.statsMap.values.filter { it.type == "outbound-rtp" && it.members["kind"] == "audio" }
                    val packets = outs.sumOf { (it.members["packetsSent"] as? Number)?.toLong() ?: 0L }
                    Log.d(TAG, "audio out: muted=$muted packets=$packets")
                }
            }
        }
    }

    companion object {
        private const val TAG = "PromptlyCall"
        const val ACTION_ANSWER = "org.promptly.calls.ANSWER"
        const val ACTION_MUTE = "org.promptly.calls.MUTE"
        const val ACTION_SPEAKER = "org.promptly.calls.SPEAKER"
        const val ACTION_HANG_UP = "org.promptly.calls.HANG_UP"
        private const val EXTRA_SERVER = "server"
        private const val EXTRA_TOKEN = "token"
        private const val EXTRA_CALL = "call"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_VIDEO = "video"
        private const val EXTRA_GROUP = "group"
        private const val NOTE = 4302

        /** The service while a call's on (same process: the center and the screen talk to it). */
        @Volatile
        var current: CallService? = null
            private set

        fun answer(context: Context, server: String, ring: Ring) {
            val i = Intent(context, CallService::class.java)
                .setAction(ACTION_ANSWER)
                .putExtra(EXTRA_SERVER, server)
                .putExtra(EXTRA_TOKEN, ring.token)
                .putExtra(EXTRA_CALL, ring.callId)
                .putExtra(EXTRA_TITLE, ring.title)
                .putExtra(EXTRA_VIDEO, ring.video)
                .putExtra(EXTRA_GROUP, ring.group)
            ContextCompat.startForegroundService(context, i)
        }

        fun leave(context: Context, callId: String) {
            current?.leave(callId)
        }

        fun mute(on: Boolean) = current?.setMuted(on)
        fun speaker(on: Boolean) = current?.setSpeaker(on)
    }
}
