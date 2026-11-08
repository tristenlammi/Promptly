package org.promptly.sync.calls

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.widget.Toast
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
import io.livekit.android.room.participant.ConnectionQuality
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.track.CameraPosition
import io.livekit.android.room.track.DataPublishReliability
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoQuality
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
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
 * A DM call on this phone (Calls WP-D3, video and calls you start in WP-D5),
 * built like the voice-channel [org.promptly.sync.voice.VoiceService]: a
 * foreground service holding one LiveKit connection that keeps going with
 * the screen off or in other apps, with an ongoing call notification (Mute,
 * Speaker, Hang up).
 *
 * Two ways in: answering a ring (`POST /api/calls/answer` with the ring's
 * token), or a call you started on the page and handed to this app
 * ([CallHandoff]: the page already started it on the server for this phone,
 * so this connects with the session it made, and plays the ringback until
 * someone answers). Then it lives on the call session: fresh tokens from
 * `session/refresh`, hang up with `session/leave`.
 *
 * Telecom ([CallTelecom]) routes the audio when it holds the call, and can
 * put it on hold when you take a phone call; otherwise LiveKit's AudioSwitch
 * routes it (headset › wired › earpiece, or the loudspeaker for video).
 * Your camera ([CameraMachine]) and everyone's video ([video], drawn by
 * [CallActivity]) are here too, lowered on a weak connection ([VideoPlan]).
 */
class CallService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val main = Handler(Looper.getMainLooper())
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
    private val camLock = Mutex()
    private var status = CallNote.Status.CONNECTING
    private var muted = false
    private var speaker = false
    private var connectedAt = 0L
    private var others = 0
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private var foreground = false
    private var foregroundTypes = -1
    private var stopping = false

    // WP-D5: calls you start, hold, the camera, weak connections, tones.
    private var outgoing = false
    private var answered = true
    private var held = false
    private val peersHeld = mutableSetOf<String>()
    private val camera = CameraMachine()
    private val weak = WeakLink()
    private var dataSaver = false
    private var metered = false
    private var level = VideoLevel.HIGH
    private var tickJob: Job? = null
    private var screenWatch: BroadcastReceiver? = null
    private var netWatch: ConnectivityManager.NetworkCallback? = null
    private var tones: ToneGenerator? = null
    private var holdBeep: Job? = null
    private var toneState = ToneState()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        CallCenter.init(this)
        current = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_ANSWER -> start(intent)
            ACTION_START -> startOutgoing(intent)
            ACTION_MUTE -> if (callId != null) setMuted(!muted) else stopSelf()
            ACTION_SPEAKER -> if (callId != null) setSpeaker(!speaker) else stopSelf()
            ACTION_HANG_UP -> callId?.let { CallCenter.hangUp(it) } ?: stopSelf()
            else -> if (callId == null) stopSelf()
        }
        // Not sticky: a call can't come back on its own, and the server
        // notices we've gone.
        return START_NOT_STICKY
    }

    // ================================================================ answering, starting

    /** Fresh state for a new call on this service. */
    private fun begin(id: String, newServer: String, t: String, v: Boolean, g: Boolean) {
        if (callId != null) {
            // End and answer / a new call from the page: the center hung the
            // old one up (its leave is on its way); this carries on with the new.
            closeRoom()
            connectJob?.cancel()
        }
        stopping = false
        server = newServer
        api = CallApi(newServer)
        callId = id
        title = t
        video = v
        group = g
        session = null
        join = null
        status = CallNote.Status.CONNECTING
        muted = false
        speaker = Routing.startsOnSpeaker(v)
        connectedAt = 0L
        others = 0
        held = false
        peersHeld.clear()
        outgoing = false
        answered = true
        // Video calls start with your camera on, like Messenger.
        camera.reset(CameraState(wanted = v, permitted = hasCamera()))
        toneState = ToneState()
    }

    private fun start(intent: Intent) {
        val newServer = intent.getStringExtra(EXTRA_SERVER) ?: return stopIfIdle()
        val token = intent.getStringExtra(EXTRA_TOKEN) ?: return stopIfIdle()
        val id = intent.getStringExtra(EXTRA_CALL) ?: return stopIfIdle()
        if (id == callId) return
        begin(id, newServer, intent.getStringExtra(EXTRA_TITLE) ?: "Call", intent.getBooleanExtra(EXTRA_VIDEO, false), intent.getBooleanExtra(EXTRA_GROUP, false))
        ringToken = token
        publish()
        if (!goForeground()) return
        holdLocks()
        watchDevice()
        answer(id, token)
    }

    /** A call you started on the page (its hand-off): connect with its session. */
    private fun startOutgoing(intent: Intent) {
        val newServer = intent.getStringExtra(EXTRA_SERVER) ?: return stopIfIdle()
        val s = intent.getStringExtra(EXTRA_SESSION) ?: return stopIfIdle()
        val id = intent.getStringExtra(EXTRA_CALL) ?: return stopIfIdle()
        if (id == callId) return
        begin(id, newServer, intent.getStringExtra(EXTRA_TITLE) ?: "Call", intent.getBooleanExtra(EXTRA_VIDEO, false), false)
        ringToken = null
        outgoing = true
        answered = false
        session = s
        publish()
        if (!goForeground()) return
        holdLocks()
        watchDevice()
        rejoin(first = true)
    }

    private fun stopIfIdle() {
        if (callId == null) stopSelf()
    }

    private fun hasMic() = ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    private fun hasCamera() = ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    /** True when we're a foreground service (Android may refuse). The camera
     *  type is asked for whenever the camera's allowed, so turning it on
     *  later (even from the page) works. */
    private fun goForeground(): Boolean {
        val mic = if (hasMic()) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        val cam = if (hasCamera() && Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA else 0
        val tries = if (Build.VERSION.SDK_INT >= 30) {
            listOf(
                ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or mic or cam,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or mic,
                mic or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            ).distinct()
        } else {
            listOf(0)
        }
        for (types in tries) {
            if (foreground && types == foregroundTypes) return true
            try {
                ServiceCompat.startForeground(this, NOTE, buildNote(), types)
                foreground = true
                foregroundTypes = types
                return true
            } catch (e: RuntimeException) {
                // ForegroundServiceStartNotAllowedException / SecurityException.
                Log.w(TAG, "can't run in the foreground as $types", e)
            }
        }
        if (foreground) return true
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

    /** Fresh token and connect, retried; [first]: a call you just started
     *  (still "Calling…", not "Reconnecting…"). */
    private fun rejoin(first: Boolean = false) {
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
                        status = if (first && connectedAt == 0L) CallNote.Status.CONNECTING else CallNote.Status.RECONNECTING
                        note()
                        publish()
                        delay(step.inMs)
                    }
                    is CallRejoin.Step.Stop -> {
                        finish(if (first && connectedAt == 0L && step.why == "lost") "failed" else step.why)
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
        group = j.group
        j.title?.let { title = it }
        if (outgoing && !answered && j.answeredAt != null) markAnswered()
        val telecom = CallCenter.telecomHolds(id)
        val (w, h, fps) = VideoPlan.capture(level)
        val r = LiveKit.create(
            applicationContext,
            RoomOptions(
                // Video that nobody's looking at isn't downloaded.
                adaptiveStream = true,
                dynacast = true,
                audioTrackPublishDefaults = AudioTrackPublishDefaults(audioBitrate = 32_000, dtx = true, red = true),
                videoTrackCaptureDefaults = LocalVideoTrackOptions(
                    position = if (camera.state.front) CameraPosition.FRONT else CameraPosition.BACK,
                    captureParams = VideoCaptureParameter(w, h, fps),
                ),
                videoTrackPublishDefaults = VideoTrackPublishDefaults(simulcast = true),
            ),
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
        if (outgoing && !answered && others > 0) markAnswered()
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
        if (held) sendHold(true, null)
        cameraEvent(CameraEvent.Connection(true))
        checkSoon(if (outgoing && !answered) 5_000 else 60_000)
        startTicking()
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
        // (The camera goes with the connection; it comes back with the next.)
        camera.on(CameraEvent.Connection(false))
        _video.value = CallVideo()
        runCatching { r.disconnect() }
        runCatching { r.release() }
    }

    private fun onEvent(r: Room, e: RoomEvent) {
        if (room !== r) return
        when (e) {
            is RoomEvent.ParticipantConnected, is RoomEvent.ParticipantDisconnected -> {
                if (e is RoomEvent.ParticipantDisconnected) e.participant.identity?.value?.let { peersHeld.remove(it) }
                reconcile()
                countPeople()
                if (outgoing && !answered && others > 0) markAnswered()
                // Someone joined while Android holds this call: they hear it's on hold.
                if (e is RoomEvent.ParticipantConnected && held) sendHold(true, e.participant.identity)
                note()
                publish()
                // Alone now: ask the server whether the call's over (a 1:1 ends
                // when the other person goes) rather than wait for LiveKit.
                if (e is RoomEvent.ParticipantDisconnected && others == 0) checkSoon(1_500)
            }
            is RoomEvent.TrackPublished, is RoomEvent.TrackUnpublished -> {
                reconcile()
                publishVideo()
            }
            is RoomEvent.TrackSubscribed, is RoomEvent.TrackUnsubscribed, is RoomEvent.TrackMuted, is RoomEvent.TrackUnmuted -> publishVideo()
            // The page showing the call, as a remote control; or someone's hold.
            is RoomEvent.DataReceived -> {
                val from = e.participant
                if (from == null) {
                    when (CallProtocol.parseControl(e.data, e.topic, fromServer = true)) {
                        CallProtocol.Control.MUTE -> setMuted(true)
                        CallProtocol.Control.UNMUTE -> setMuted(false)
                        CallProtocol.Control.SPEAKER_ON -> setSpeaker(true)
                        CallProtocol.Control.SPEAKER_OFF -> setSpeaker(false)
                        CallProtocol.Control.CAMERA_ON -> setCamera(true, fromPage = true)
                        CallProtocol.Control.CAMERA_OFF -> setCamera(false)
                        CallProtocol.Control.FLIP -> flipCamera()
                        null -> Unit
                    }
                } else {
                    val ident = from.identity?.value ?: return
                    if (userOfIdentity(ident) == null) return
                    when (HoldSignal.decode(e.data, e.topic, fromPerson = true)) {
                        true -> peersHeld.add(ident)
                        false -> peersHeld.remove(ident)
                        null -> return
                    }
                    reconcile()
                    note(now = true)
                    publish()
                }
            }
            is RoomEvent.ConnectionQualityChanged -> {
                if (e.participant is io.livekit.android.room.participant.LocalParticipant) {
                    weak.input(qualityOf(e.quality), SystemClock.elapsedRealtime())
                    applyLevel()
                }
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

    private fun markAnswered() {
        if (answered) return
        answered = true
        callId?.let { CallCenter.answeredByThem(it) }
        checkSoon(60_000)
        note(now = true)
        publish()
    }

    /** Is the call still on for this session? Ends it here when not. Every
     *  minute while the call's on (every 5 s while yours rings out), in case
     *  LiveKit says nothing. */
    private var checkJob: Job? = null

    private fun checkSoon(inMs: Long) {
        checkJob?.cancel()
        checkJob = scope.launch {
            delay(inMs)
            while (isActive && room != null) {
                val s = session ?: return@launch
                val a = api ?: return@launch
                when (val got = a.refresh(s)) {
                    CallRefresh.Gone -> {
                        finish("ended")
                        return@launch
                    }
                    is CallRefresh.Ended -> {
                        finish("ended:${got.reason}")
                        return@launch
                    }
                    is CallRefresh.Ok -> if (outgoing && !answered && got.join.answeredAt != null) markAnswered()
                    is CallRefresh.Failed -> Unit
                }
                delay(if (outgoing && !answered) 5_000 else 60_000)
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

    /** Hear everyone's microphone (silent while on hold); take cameras and
     *  screens at the level the connection allows (nobody looking: none). */
    private fun reconcile() {
        val r = room ?: return
        val q = when (level) {
            VideoLevel.HIGH -> VideoQuality.HIGH
            VideoLevel.MEDIUM -> VideoQuality.MEDIUM
            VideoLevel.LOW -> VideoQuality.LOW
        }
        for (p in r.remoteParticipants.values) {
            if (userOfIdentity(p.identity?.value ?: "") == null) continue
            for (pub in p.trackPublications.values) {
                val rp = pub as? RemoteTrackPublication ?: continue
                if (!rp.subscribed) rp.setSubscribed(true)
                when (rp.source) {
                    Track.Source.CAMERA -> rp.setVideoQuality(q)
                    // A shared screen is text more often than not: never below the middle.
                    Track.Source.SCREEN_SHARE -> rp.setVideoQuality(if (q == VideoQuality.HIGH) VideoQuality.HIGH else VideoQuality.MEDIUM)
                    else -> Unit
                }
                (rp.track as? RemoteAudioTrack)?.setVolume(if (held) 0.0 else 1.0)
            }
        }
        publishVideo()
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
                    // On hold, nobody hears you (your mute stays as you left it).
                    r.localParticipant.setMicrophoneEnabled(!muted && !held)
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    Log.w(TAG, "microphone", e)
                }
            }
        }
    }

    // ================================================================ hold

    /** Telecom put this call on hold (you took a phone call), or back. */
    fun setHeld(id: String, on: Boolean) {
        if (id != callId || held == on) return
        held = on
        syncMic()
        reconcile()
        cameraEvent(CameraEvent.Hold(on))
        sendHold(on, null)
        note(now = true)
        publish()
    }

    private fun sendHold(on: Boolean, to: Participant.Identity?) {
        val r = room ?: return
        scope.launch {
            runCatching {
                r.localParticipant.publishData(HoldSignal.encode(on), DataPublishReliability.RELIABLE, HoldSignal.TOPIC, to?.let { listOf(it) })
            }.onFailure { Log.i(TAG, "hold not sent: ${it.message}") }
        }
    }

    // ================================================================ the camera

    /** Turn your camera on or off (the call screen, or the page). */
    fun setCamera(on: Boolean, fromPage: Boolean = false) {
        if (callId == null) return
        if (on && !hasCamera()) {
            // Only the call screen can ask (it's in front); the page can't.
            if (fromPage) Toast.makeText(this, "To use the camera, open the call screen and allow it.", Toast.LENGTH_LONG).show()
            return
        }
        cameraEvent(CameraEvent.Set(on))
    }

    fun toggleCamera() = setCamera(!camera.state.buttonOn)

    fun flipCamera() = cameraEvent(CameraEvent.Flip)

    /** Android's answer about the camera changed (the call screen asked). */
    fun permissionsChanged() {
        if (callId == null) return
        // The camera type for the foreground service, now that it's allowed (we're in front).
        if (foreground) goForeground()
        cameraEvent(CameraEvent.Permission(hasCamera()))
    }

    private fun cameraEvent(e: CameraEvent) {
        val fx = camera.on(CameraEvent.Permission(hasCamera())) + camera.on(e)
        for (f in fx) {
            when (f) {
                is CameraEffect.Publish -> publishCamera(f.on, f.front)
                is CameraEffect.Switch -> switchCamera(f.front)
                // The screen asks before it sends the event; nothing to do here.
                CameraEffect.AskPermission -> Unit
            }
        }
        publish()
    }

    private fun publishCamera(on: Boolean, front: Boolean) {
        val r = room ?: return
        scope.launch {
            camLock.withLock {
                if (room !== r) return@withLock
                try {
                    if (on && !hasCamera()) return@withLock
                    r.localParticipant.setCameraEnabled(on)
                    if (on) {
                        val track = localCamera(r)
                        val want = if (front) CameraPosition.FRONT else CameraPosition.BACK
                        if (track != null && track.options.position != want) track.switchCamera(position = want)
                    }
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    Log.w(TAG, "camera", e)
                    if (on) {
                        camera.on(CameraEvent.Set(false))
                        Toast.makeText(this@CallService, "The camera wouldn't start. Another app may be using it.", Toast.LENGTH_LONG).show()
                    }
                }
            }
            publishVideo()
            publish()
        }
    }

    private fun switchCamera(front: Boolean) {
        val r = room ?: return
        scope.launch {
            camLock.withLock {
                runCatching { localCamera(r)?.switchCamera(position = if (front) CameraPosition.FRONT else CameraPosition.BACK) }
                    .onFailure { Log.w(TAG, "flip", it) }
            }
            publishVideo()
        }
    }

    private fun localCamera(r: Room): LocalVideoTrack? =
        r.localParticipant.getTrackPublication(Track.Source.CAMERA)?.track as? LocalVideoTrack

    /** The pictures for the call screen. */
    private fun publishVideo() {
        val r = room
        if (r == null) {
            _video.value = CallVideo()
            return
        }
        val remotes = r.remoteParticipants.values.mapNotNull { p ->
            val ident = p.identity?.value ?: return@mapNotNull null
            val uid = userOfIdentity(ident) ?: return@mapNotNull null
            val cam = p.getTrackPublication(Track.Source.CAMERA)
            val scr = p.getTrackPublication(Track.Source.SCREEN_SHARE)
            val mic = p.getTrackPublication(Track.Source.MICROPHONE)
            RemoteVideo(
                userId = uid,
                name = p.name?.ifBlank { null } ?: "Someone",
                camera = (cam?.track as? VideoTrack)?.takeIf { !cam.muted },
                screen = (scr?.track as? VideoTrack)?.takeIf { !scr.muted },
                micMuted = mic == null || mic.muted,
                held = ident in peersHeld,
                aspect = (scr?.takeIf { !it.muted && it.track != null } ?: cam)?.dimensions?.let { it.width to it.height },
            )
        }.sortedBy { it.name.lowercase() }
        val local = if (camera.state.live) localCamera(r)?.takeIf { r.localParticipant.isCameraEnabled } else null
        _video.value = CallVideo(room = r, local = local, front = camera.state.front, remotes = remotes)
    }

    // ================================================================ weak connections, data saver, the screen

    private fun qualityOf(q: ConnectionQuality): LinkQuality = when (q) {
        ConnectionQuality.EXCELLENT -> LinkQuality.EXCELLENT
        ConnectionQuality.GOOD -> LinkQuality.GOOD
        ConnectionQuality.POOR -> LinkQuality.POOR
        ConnectionQuality.LOST -> LinkQuality.LOST
        else -> LinkQuality.UNKNOWN
    }

    private fun applyLevel() {
        val next = VideoPlan.level(weak.weak, dataSaver, metered)
        if (next == level) {
            publish()
            return
        }
        level = next
        reconcile()
        // Your camera's capture follows (smaller on a weak link or Data Saver).
        val r = room ?: return publish()
        val (w, h, fps) = VideoPlan.capture(level)
        scope.launch {
            camLock.withLock {
                val track = localCamera(r) ?: return@withLock
                runCatching { track.restartTrack(track.options.copy(captureParams = VideoCaptureParameter(w, h, fps))) }
                    .onFailure { Log.i(TAG, "capture size: ${it.message}") }
            }
        }
        publish()
    }

    private fun startTicking() {
        if (tickJob?.isActive == true) return
        tickJob = scope.launch {
            while (isActive) {
                delay(2_000)
                val was = weak.weak
                if (weak.tick(SystemClock.elapsedRealtime()) != was) applyLevel()
            }
        }
    }

    /** The screen going off pauses your camera; mobile data and Data Saver
     *  lower video. LiveKit itself rejoins across Wi-Fi ↔ mobile data. */
    private fun watchDevice() {
        if (screenWatch == null) {
            val rx = object : BroadcastReceiver() {
                override fun onReceive(c: Context, i: Intent) {
                    when (i.action) {
                        Intent.ACTION_SCREEN_OFF -> cameraEvent(CameraEvent.Screen(false))
                        Intent.ACTION_SCREEN_ON -> cameraEvent(CameraEvent.Screen(true))
                    }
                }
            }
            val f = IntentFilter().apply {
                addAction(Intent.ACTION_SCREEN_OFF)
                addAction(Intent.ACTION_SCREEN_ON)
            }
            ContextCompat.registerReceiver(this, rx, f, ContextCompat.RECEIVER_NOT_EXPORTED)
            screenWatch = rx
        }
        camera.on(CameraEvent.Screen((getSystemService(POWER_SERVICE) as PowerManager).isInteractive))
        if (netWatch == null) {
            val cm = getSystemService(ConnectivityManager::class.java) ?: return
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    val m = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
                    val saver = cm.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED
                    main.post {
                        if (m != metered || saver != dataSaver) {
                            metered = m
                            dataSaver = saver
                            applyLevel()
                        }
                    }
                }
            }
            runCatching { cm.registerDefaultNetworkCallback(cb) }.onSuccess { netWatch = cb }
        }
    }

    private fun unwatchDevice() {
        screenWatch?.let { runCatching { unregisterReceiver(it) } }
        screenWatch = null
        netWatch?.let { cb -> runCatching { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) } }
        netWatch = null
        tickJob?.cancel()
        tickJob = null
    }

    // ================================================================ tones

    private fun tones() {
        val next = ToneState(
            inCall = callId != null && !stopping,
            status = status,
            calling = outgoing && !answered,
            held = held,
            peerHeld = peersHeld.isNotEmpty(),
        )
        val fx = CallTones.diff(toneState, next)
        toneState = next
        for (f in fx) {
            when (f) {
                is ToneFx.Start -> when (f.tone) {
                    CallTone.RINGBACK -> gen()?.startTone(ToneGenerator.TONE_SUP_RINGTONE)
                    CallTone.HOLD -> {
                        holdBeep?.cancel()
                        holdBeep = scope.launch {
                            while (isActive) {
                                gen()?.startTone(ToneGenerator.TONE_PROP_BEEP2, 250)
                                delay(4_000)
                            }
                        }
                    }
                    else -> Unit
                }
                is ToneFx.Stop -> {
                    if (f.tone == CallTone.HOLD) {
                        holdBeep?.cancel()
                        holdBeep = null
                    }
                    tones?.stopTone()
                }
                is ToneFx.Play -> when (f.tone) {
                    CallTone.CONNECTED, CallTone.RECONNECTED -> gen()?.startTone(ToneGenerator.TONE_PROP_ACK, 200)
                    CallTone.RECONNECTING -> gen()?.startTone(ToneGenerator.TONE_PROP_PROMPT, 300)
                    CallTone.ENDED -> {
                        gen()?.startTone(ToneGenerator.TONE_CDMA_CALLDROP_LITE, 600)
                        val t = tones
                        tones = null
                        // Let it finish after the service has gone.
                        main.postDelayed({ runCatching { t?.release() } }, 900)
                    }
                    else -> Unit
                }
            }
        }
    }

    /** The call's tone generator, on the call's own audio (earpiece, headset, speaker). */
    private fun gen(): ToneGenerator? {
        tones?.let { return it }
        tones = runCatching { ToneGenerator(AudioManager.STREAM_VOICE_CALL, 60) }.getOrNull()
        return tones
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
        holdBeep?.cancel()
        closeRoom()
        unwatchDevice()
        releaseLocks()
        if (why != "replaced") tones() else tones?.let { runCatching { it.release() } }
        callId = null
        session = null
        join = null
        if (id != null) CallCenter.ended(id, why)
        CallCenter.setMedia(CallCenter.Media())
        if (foreground) ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        foreground = false
        foregroundTypes = -1
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
        unwatchDevice()
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
                calling = outgoing && !answered,
                held = held,
                peerHeld = peersHeld.isNotEmpty(),
                camera = camera.state,
                videoNote = if (camera.state.live || _video.value.remotes.any { it.camera != null }) VideoPlan.words(weak.weak, dataSaver) else null,
            ),
        )
        tones()
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
        val calling = outgoing && !answered
        val n = CallNote.of(title, video, status, muted, speaker, seconds, others, group, calling = calling, held = held, peerHeld = peersHeld.isNotEmpty())
        val open = PendingIntent.getActivity(
            this, 20, CallActivity.intent(this, callId ?: "", answer = false),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val person = Person.Builder().setName(title).setImportant(true).apply {
            CallCenter.picture(callId ?: "")?.let { runCatching { setIcon(androidx.core.graphics.drawable.IconCompat.createFromIcon(this@CallService, it)) } }
        }.build()
        val plain = status == CallNote.Status.CONNECTED && !calling && !held && peersHeld.isEmpty()
        val b = NotificationCompat.Builder(this, RingNotes.CHANNEL_ONGOING)
            .setSmallIcon(R.drawable.ic_call_status)
            .setColor(RingNotes.ACCENT)
            .setContentTitle(n.title)
            .setContentText(if (plain) (if (muted) "You're muted" else null) else n.text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(open)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, action(ACTION_HANG_UP, 3)).setIsVideo(video))
            .addAction(R.drawable.ic_call_mic_off, n.muteLabel, action(ACTION_MUTE, 1))
            .addAction(R.drawable.ic_call_speaker, n.speakerLabel, action(ACTION_SPEAKER, 2))
        if (status == CallNote.Status.CONNECTED && connectedAt > 0 && !calling) {
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

    /** Someone else's pictures, for the call screen. */
    data class RemoteVideo(
        val userId: String,
        val name: String,
        val camera: VideoTrack?,
        val screen: VideoTrack?,
        val micMuted: Boolean,
        val held: Boolean,
        /** The main picture's width and height, when known (picture-in-picture's shape). */
        val aspect: Pair<Int, Int>? = null,
    )

    /** Everything the call screen draws video with. [room] makes the renderers. */
    data class CallVideo(
        val room: Room? = null,
        val local: VideoTrack? = null,
        val front: Boolean = true,
        val remotes: List<RemoteVideo> = emptyList(),
    )

    companion object {
        private const val TAG = "PromptlyCall"
        const val ACTION_ANSWER = "org.promptly.calls.ANSWER"
        const val ACTION_START = "org.promptly.calls.START"
        const val ACTION_MUTE = "org.promptly.calls.MUTE"
        const val ACTION_SPEAKER = "org.promptly.calls.SPEAKER"
        const val ACTION_HANG_UP = "org.promptly.calls.HANG_UP"
        private const val EXTRA_SERVER = "server"
        private const val EXTRA_TOKEN = "token"
        private const val EXTRA_SESSION = "session"
        private const val EXTRA_CALL = "call"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_VIDEO = "video"
        private const val EXTRA_GROUP = "group"
        private const val NOTE = 4302

        private val _video = MutableStateFlow(CallVideo())

        /** The call's pictures (empty when there's no call). */
        val video: StateFlow<CallVideo> = _video

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

        /** A call you started on the page (its hand-off). */
        fun start(context: Context, h: CallHandoff) {
            val i = Intent(context, CallService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_SERVER, h.server)
                .putExtra(EXTRA_SESSION, h.session)
                .putExtra(EXTRA_CALL, h.callId)
                .putExtra(EXTRA_TITLE, h.title)
                .putExtra(EXTRA_VIDEO, h.video)
            ContextCompat.startForegroundService(context, i)
        }

        fun leave(context: Context, callId: String) {
            current?.leave(callId)
        }

        fun mute(on: Boolean) = current?.setMuted(on)
        fun speaker(on: Boolean) = current?.setSpeaker(on)
        fun toggleCamera() = current?.toggleCamera()
        fun flipCamera() = current?.flipCamera()
        fun permissionsChanged() = current?.permissionsChanged()
    }
}
