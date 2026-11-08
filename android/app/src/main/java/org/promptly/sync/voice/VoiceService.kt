package org.promptly.sync.voice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.twilio.audioswitch.AudioDevice
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.AudioTrackPublishDefaults
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.participant.ParticipantPermission
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.Track
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import org.promptly.sync.BuildConfig
import org.promptly.sync.R
import java.io.IOException

/**
 * Rooms voice channels on Android: holds your audio in a voice channel with
 * the screen off or while you use other apps, which Chrome (and so the P Rooms
 * page) can't do. The page hands over its Join (`VoiceHandoffActivity`) and
 * stays the UI, as a remote control through the server.
 *
 * One LiveKit connection, audio only (LiveKit Android: WebRTC's echo
 * cancellation, noise suppression and gain, AudioSwitch for Bluetooth /
 * wired / speaker routing). Fresh tokens come from the voice session
 * (`POST /api/rooms/voice/refresh`); the server's commands arrive as LiveKit
 * data on `voice.control`; what the phone does is reported back with the same
 * session (`/api/rooms/voice/session/state|speaking|still-here|leave`), so
 * every page shows it. The rules live in VoiceLogic.kt.
 */
class VoiceService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var server = ""
    private var api: VoiceApi? = null
    private var session: String? = null
    private var roomId = ""
    private var channel = "Voice"
    private var space = ""
    private var join: VoiceJoin? = null
    private var mic = MicState()
    private var status = VoiceNote.Status.CONNECTING
    private var room: Room? = null
    private var roomJob: Job? = null
    private var connectJob: Job? = null
    private val micLock = Mutex()
    private val speaking = SpeakingDebouncer()
    private var speakingJob: Job? = null
    private var speakingHoldUntil = 0L
    private var speakingPending: Boolean? = null
    private var stateJob: Job? = null
    private var noteJob: Job? = null
    private var lastNoteAt = 0L
    private var talking: List<String> = emptyList()
    private var others = 0
    private var duck = 1.0
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private var stopping = false
    private var foreground = false
    private var levelJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        channels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> start(intent)
            ACTION_MUTE -> if (session != null) setMic(mic.toggleMute()) else stopSelf()
            ACTION_DEAFEN -> if (session != null) setMic(mic.toggleDeafen()) else stopSelf()
            ACTION_LEAVE -> leave()
            ACTION_STILL_HERE -> stillHere()
            else -> if (session == null) stopSelf()
        }
        // Not sticky: Android 14+ won't let a microphone service start again
        // from the background, and the server notices we've gone.
        return START_NOT_STICKY
    }

    // ================================================================ starting

    private fun start(intent: Intent) {
        val newServer = intent.getStringExtra(EXTRA_SERVER) ?: return stopIfIdle()
        val newSession = intent.getStringExtra(EXTRA_SESSION) ?: return stopIfIdle()
        if (newSession == session && room != null) {
            note(now = true)
            return
        }
        stopping = false
        server = newServer
        api = VoiceApi(newServer)
        session = newSession
        roomId = intent.getStringExtra(EXTRA_ROOM) ?: ""
        channel = intent.getStringExtra(EXTRA_CHANNEL) ?: "Voice"
        space = intent.getStringExtra(EXTRA_SPACE) ?: ""
        // Like Discord (and the web client), mute and deafen carry over from
        // one channel to the next while the service runs.
        mic = mic.copy(hasMicPermission = intent.getBooleanExtra(EXTRA_MIC, true))
        status = VoiceNote.Status.CONNECTING
        talking = emptyList()
        others = 0
        if (!goForeground()) return
        holdLocks()
        rejoin()
    }

    private fun stopIfIdle() {
        if (session == null) stopSelf()
    }

    /** True when we're a foreground service (Android may refuse). */
    private fun goForeground(): Boolean {
        val types = if (mic.hasMicPermission) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        } else {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        }
        return try {
            ServiceCompat.startForeground(this, NOTE, buildNote(), types)
            foreground = true
            true
        } catch (e: RuntimeException) {
            // ForegroundServiceStartNotAllowedException / SecurityException:
            // started from the background or without the microphone.
            Log.w(TAG, "can't run in the foreground", e)
            val s = session
            val a = api
            session = null
            if (s != null && a != null) CoroutineScope(Dispatchers.IO).launch { runCatching { a.leave(s) } }
            stopSelf()
            false
        }
    }

    // ================================================================ connecting

    /** Get (back) into the channel: refresh the token with the session, then
     *  connect, retrying per [Rejoin] until the server says the session's over. */
    private fun rejoin() {
        connectJob?.cancel()
        connectJob = scope.launch {
            val plan = Rejoin(SystemClock.elapsedRealtime())
            while (isActive) {
                val s = session ?: return@launch
                val a = api ?: return@launch
                val step = when (val got = plan.next(a.refresh(s), SystemClock.elapsedRealtime())) {
                    is Rejoin.Step.Connect -> if (connect(got.join)) return@launch else plan.connectFailed(SystemClock.elapsedRealtime())
                    else -> got
                }
                when (step) {
                    is Rejoin.Step.Retry -> {
                        if (status != VoiceNote.Status.CONNECTING) status = VoiceNote.Status.RECONNECTING
                        note()
                        delay(step.inMs)
                    }
                    is Rejoin.Step.Stop -> {
                        finish(step.why)
                        return@launch
                    }
                    is Rejoin.Step.Connect -> Unit
                }
            }
        }
    }

    private suspend fun connect(j: VoiceJoin): Boolean {
        closeRoom()
        join = j
        session = j.session
        roomId = j.roomId
        channel = j.channelName
        space = j.spaceName
        mic = mic.copy(canTalk = j.canTalk, serverMuted = j.serverMuted, serverDeafened = j.serverDeafened, micGranted = !j.serverMuted && j.canTalk)
        val music = j.quality == "music"
        val r = LiveKit.create(
            applicationContext,
            RoomOptions(
                audioTrackPublishDefaults = AudioTrackPublishDefaults(audioBitrate = j.bitrateKbps * 1000, dtx = !music, red = !music),
            ),
        )
        r.audioSwitchHandler?.apply {
            // A headset or the car first; with nothing connected, the
            // loudspeaker (as Discord does for voice channels), not the earpiece.
            preferredDeviceList = listOf(
                AudioDevice.BluetoothHeadset::class.java,
                AudioDevice.WiredHeadset::class.java,
                AudioDevice.Speakerphone::class.java,
                AudioDevice.Earpiece::class.java,
            )
            registerOnAudioFocusChangeListener(focusListener)
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
        status = VoiceNote.Status.CONNECTED
        readPermissions(r.localParticipant.permissions)
        reconcile()
        countPeople()
        syncMic()
        reportState()
        note(now = true)
        if (BuildConfig.DEBUG) watchLevels()
        return true
    }

    private fun closeRoom() {
        val r = room ?: return
        room = null
        roomJob?.cancel()
        roomJob = null
        levelJob?.cancel()
        r.audioSwitchHandler?.unregisterOnAudioFocusChangeListener(focusListener)
        runCatching { r.disconnect() }
        runCatching { r.release() }
        speakingOff()
    }

    // ================================================================ LiveKit events

    private fun onEvent(r: Room, e: RoomEvent) {
        if (room !== r) return
        when (e) {
            is RoomEvent.DataReceived ->
                VoiceProtocol.parseCommand(e.data, e.topic, fromServer = e.participant == null)?.let { onCommand(it) }
            is RoomEvent.ParticipantConnected, is RoomEvent.ParticipantDisconnected -> {
                reconcile()
                countPeople()
                note()
            }
            is RoomEvent.TrackPublished -> reconcile()
            is RoomEvent.TrackSubscribed -> (e.track as? RemoteAudioTrack)?.setVolume(if (mic.hearing) duck else 0.0)
            is RoomEvent.ActiveSpeakersChanged -> onSpeakers(r, e.speakers)
            is RoomEvent.ParticipantPermissionsChanged -> if (e.participant is LocalParticipant) {
                readPermissions(e.newPermissions)
                reconcile()
                syncMic()
                note()
            }
            is RoomEvent.Reconnecting -> {
                status = VoiceNote.Status.RECONNECTING
                note()
            }
            is RoomEvent.Reconnected -> {
                status = VoiceNote.Status.CONNECTED
                note()
                reportState()
            }
            is RoomEvent.Disconnected -> onDropped(e.reason.name)
            else -> Unit
        }
    }

    /** What LiveKit lets us do now: an admin's server-mute takes the
     *  microphone out of the grant; server-deafen takes subscribing too. */
    private fun readPermissions(p: ParticipantPermission?) {
        if (p == null) return
        val micOk = p.canPublish && (p.canPublishSources.isEmpty() || p.canPublishSources.contains(Track.Source.MICROPHONE))
        mic = mic.copy(
            micGranted = micOk,
            serverMuted = mic.canTalk && !micOk,
            serverDeafened = !p.canSubscribe,
        )
    }

    private fun onDropped(reason: String) {
        when (DropKind.of(reason)) {
            DropKind.OURS -> Unit
            // You joined on another device (or another channel there): it
            // has the session now.
            DropKind.REPLACED -> finish("replaced")
            DropKind.REMOVED, DropKind.NETWORK -> {
                // Removed: the refresh tells whether the session lives on (a
                // move, a closed room) or ended (an admin, leaving elsewhere).
                closeRoom()
                status = VoiceNote.Status.RECONNECTING
                note()
                rejoin()
            }
        }
    }

    private fun onCommand(cmd: VoiceCommand) {
        Log.i(TAG, "command ${cmd::class.simpleName}")
        when (cmd) {
            is VoiceCommand.Leave -> finish(cmd.reason)
            is VoiceCommand.StillThere -> showStillThere(cmd.seconds)
            is VoiceCommand.Move -> {
                // The server already joined us to the new channel: switch the
                // session and connect there (a refresh brings its name too).
                session = cmd.session
                roomId = cmd.roomId
                cancelStillThere()
                closeRoom()
                status = VoiceNote.Status.CONNECTING
                note()
                rejoin()
            }
            else -> setMic(mic.apply(cmd))
        }
    }

    // ================================================================ microphone and hearing

    private fun setMic(next: MicState) {
        val before = mic
        mic = next
        if (before.hearing != next.hearing) reconcile()
        syncMic()
        if (!next.micOn) speakingOff()
        if (before != next) reportState()
        note(now = true)
    }

    /** Publish / mute the microphone to match [mic]. Serialised, and always
     *  converging on the latest state. */
    private fun syncMic() {
        val r = room ?: return
        scope.launch {
            micLock.withLock {
                if (room !== r) return@withLock
                val want = mic.micOn
                val has = r.localParticipant.getTrackPublication(Track.Source.MICROPHONE) != null
                if (!want && !has) return@withLock
                try {
                    r.localParticipant.setMicrophoneEnabled(want)
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    Log.w(TAG, "microphone", e)
                }
            }
        }
    }

    /** Hear everyone's microphone unless deafened; nothing else (cameras and
     *  streams are the page's, over its own listen-only connection). */
    private fun reconcile() {
        val r = room ?: return
        val hear = mic.hearing
        for (p in r.remoteParticipants.values) {
            if (userOfIdentity(p.identity?.value ?: "") == null) continue
            for (pub in p.trackPublications.values) {
                val rp = pub as? RemoteTrackPublication ?: continue
                val want = hear && rp.source == Track.Source.MICROPHONE
                if (rp.subscribed != want) rp.setSubscribed(want)
                (rp.track as? RemoteAudioTrack)?.setVolume(if (want) duck else 0.0)
            }
        }
    }

    private fun countPeople() {
        val r = room ?: return
        others = r.remoteParticipants.values.count { userOfIdentity(it.identity?.value ?: "") != null }
        if (others > 0) cancelStillThere()
    }

    /** Spoken directions (P Maps) and other short sounds duck the channel
     *  instead of cutting it; a phone call silences it until it's over. */
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        scope.launch {
            duck = when (change) {
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> DUCKED
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> 0.0
                // Regained, or lost for good to music: a voice channel keeps
                // playing (people talk over music on Discord too).
                else -> 1.0
            }
            reconcile()
        }
    }

    // ================================================================ speaking rings

    private fun onSpeakers(r: Room, speakers: List<Participant>) {
        val me = r.localParticipant
        talking = speakers.filter { it !== me && userOfIdentity(it.identity?.value ?: "") != null }
            .map { it.name?.ifBlank { null } ?: "Someone" }
        feedSpeaking(mic.micOn && speakers.any { it === me })
        note()
    }

    private fun feedSpeaking(on: Boolean) {
        val due = speaking.input(on, SystemClock.elapsedRealtime())
        speakingJob?.cancel()
        if (due == null) return
        speakingJob = scope.launch {
            delay((due - SystemClock.elapsedRealtime()).coerceAtLeast(0))
            speaking.tick(SystemClock.elapsedRealtime())?.let { sendSpeaking(it) }
        }
    }

    private fun speakingOff() {
        speakingJob?.cancel()
        if (speaking.forceOff()) sendSpeaking(false)
    }

    private fun sendSpeaking(on: Boolean) {
        val s = session ?: return
        val a = api ?: return
        if (SystemClock.elapsedRealtime() < speakingHoldUntil) {
            speakingPending = on
            return
        }
        scope.launch {
            try {
                a.speaking(s, on)
            } catch (_: VoiceApi.Slow) {
                // Over the server's limit: wait, then send where we are now.
                speakingHoldUntil = SystemClock.elapsedRealtime() + 10_000
                speakingPending = on
                delay(10_000)
                speakingPending?.let {
                    speakingPending = null
                    sendSpeaking(it)
                }
            } catch (_: IOException) {
                // A ring missed is fine.
            }
        }
    }

    // ================================================================ reports

    /** Tell the server what the phone is doing (coalesced). */
    private fun reportState() {
        stateJob?.cancel()
        stateJob = scope.launch {
            delay(60)
            val s = session ?: return@launch
            val a = api ?: return@launch
            try {
                a.state(s, mic)
            } catch (_: VoiceApi.Gone) {
                // Not our session any more (moved, left elsewhere): let the
                // refresh decide.
                if (room != null && status == VoiceNote.Status.CONNECTED) {
                    closeRoom()
                    rejoin()
                }
            } catch (e: IOException) {
                Log.i(TAG, "state not sent: ${e.message}")
            }
        }
    }

    private fun stillHere() {
        cancelStillThere()
        val s = session ?: return
        val a = api ?: return
        scope.launch { runCatching { a.stillHere(s) } }
    }

    // ================================================================ leaving

    /** Leave from the notification. */
    private fun leave() {
        val s = session
        val a = api
        if (s == null || a == null) {
            finish("left")
            return
        }
        closeRoom()
        scope.launch {
            withTimeoutOrNull(4_000) { runCatching { a.leave(s) } }
            finish("left")
        }
    }

    /** We're out of the channel: stop everything. [why] picks a last word
     *  for the cases you didn't ask for. */
    private fun finish(why: String) {
        if (stopping) return
        stopping = true
        Log.i(TAG, "finished: $why")
        connectJob?.cancel()
        stateJob?.cancel()
        closeRoom()
        releaseLocks()
        cancelStillThere()
        session = null
        join = null
        lastWord(why)?.let { text ->
            val n = NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_voice_status)
                .setContentTitle("🔊 $channel")
                .setContentText(text)
                .setAutoCancel(true)
                .setTimeoutAfter(5 * 60_000)
                .setContentIntent(openChannel())
                .build()
            notifications().notify(NOTE_ENDED, n)
        }
        if (foreground) ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        foreground = false
        stopSelf()
    }

    private fun lastWord(why: String): String? = when (why) {
        "admin" -> "An admin disconnected you."
        "alone" -> "You left: nobody else was there."
        "lost" -> "Lost the connection. Open the channel to rejoin."
        "deleted" -> "This channel was deleted."
        "voice_off", "access" -> "You can't be in this channel any more."
        else -> null // you left, or joined somewhere else: nothing to say
    }

    override fun onDestroy() {
        if (!stopping) {
            // Killed while in a channel: leave properly so nobody waits for us.
            val s = session
            val a = api
            if (s != null && a != null) CoroutineScope(Dispatchers.IO).launch { runCatching { a.leave(s) } }
        }
        closeRoom()
        releaseLocks()
        scope.cancel()
        super.onDestroy()
    }

    // ================================================================ locks

    private fun holdLocks() {
        if (wake == null) {
            wake = (getSystemService(POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "promptly:voice")
                .apply { setReferenceCounted(false); acquire() }
        }
        if (wifi == null) {
            val wm = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            wifi = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "promptly:voice")
                .apply { setReferenceCounted(false); acquire() }
        }
    }

    private fun releaseLocks() {
        runCatching { wake?.release() }
        wake = null
        runCatching { wifi?.release() }
        wifi = null
    }

    // ================================================================ notifications

    private fun notifications() = getSystemService(NotificationManager::class.java)

    /** Update the ongoing notification; at most ~3 a second (talking changes
     *  often), with the last change always shown. */
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
        val n = VoiceNote.of(channel, space, mic, status, talking, others)
        val b = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_voice_status)
            .setColor(ACCENT)
            .setContentTitle(n.title)
            .setContentText(n.text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openChannel())
        if (n.muteEnabled) b.addAction(R.drawable.ic_voice_mic_off, n.muteLabel, action(ACTION_MUTE, 1))
        b.addAction(R.drawable.ic_voice_headset_off, n.deafenLabel, action(ACTION_DEAFEN, 2))
        b.addAction(R.drawable.ic_voice_leave, "Leave", action(ACTION_LEAVE, 3))
        return b.build()
    }

    private fun action(what: String, code: Int): PendingIntent = PendingIntent.getService(
        this, code, Intent(this, VoiceService::class.java).setAction(what),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /** The channel in P Rooms (or Promptly, when the P Rooms icon is hidden). */
    private fun openChannel(): PendingIntent {
        val path = if (roomId.isNotBlank()) "/rooms/r/$roomId" else "/rooms/"
        val rooms = Intent().setClassName(this, ROOMS_LAUNCHER)
        val target = if (packageManager.resolveActivity(rooms, 0) != null) rooms else Intent().setClassName(this, MAIN_LAUNCHER)
        // A fresh launch (not just the task brought forward), so the page
        // opens at the channel even when P Rooms was showing something else.
        target.putExtra(OPEN_PATH, path).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        return PendingIntent.getActivity(this, 10, target, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun showStillThere(seconds: Int) {
        val n = NotificationCompat.Builder(this, CHANNEL_ALERT)
            .setSmallIcon(R.drawable.ic_voice_status)
            .setColor(ACCENT)
            .setContentTitle("Still there?")
            .setContentText("You're alone in 🔊 $channel. You'll leave in ${seconds / 60} minutes unless you answer.")
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setTimeoutAfter(seconds * 1000L)
            .setContentIntent(openChannel())
            .addAction(R.drawable.ic_voice_status, "I'm here", action(ACTION_STILL_HERE, 4))
            .build()
        notifications().notify(NOTE_STILL_THERE, n)
    }

    private fun cancelStillThere() {
        notifications().cancel(NOTE_STILL_THERE)
    }

    // ================================================================ debug

    /** Debug builds: log the audio going each way, every 2 s (WebRTC's own
     *  stats), so a test can check sound keeps flowing with the screen off. */
    private fun watchLevels() {
        levelJob?.cancel()
        levelJob = scope.launch {
            while (isActive) {
                delay(2_000)
                val r = room ?: break
                r.getSubscriberRTCStats { report ->
                    val ins = report.statsMap.values.filter { it.type == "inbound-rtp" && it.members["kind"] == "audio" }
                    val packets = ins.sumOf { (it.members["packetsReceived"] as? Number)?.toLong() ?: 0L }
                    val level = ins.maxOfOrNull { (it.members["audioLevel"] as? Number)?.toDouble() ?: 0.0 } ?: 0.0
                    Log.d(TAG, "audio in: tracks=${ins.size} packets=$packets level=${"%.3f".format(level)}")
                }
                r.getPublisherRTCStats { report ->
                    val outs = report.statsMap.values.filter { it.type == "outbound-rtp" && it.members["kind"] == "audio" }
                    val sources = report.statsMap.values.filter { it.type == "media-source" && it.members["kind"] == "audio" }
                    val packets = outs.sumOf { (it.members["packetsSent"] as? Number)?.toLong() ?: 0L }
                    val level = sources.maxOfOrNull { (it.members["audioLevel"] as? Number)?.toDouble() ?: 0.0 } ?: 0.0
                    Log.d(TAG, "audio out: mic=${if (mic.micOn) "on" else "off"} packets=$packets level=${"%.3f".format(level)} duck=$duck")
                }
            }
        }
    }

    companion object {
        private const val TAG = "PromptlyVoice"
        const val ACTION_START = "org.promptly.voice.START"
        const val ACTION_MUTE = "org.promptly.voice.MUTE"
        const val ACTION_DEAFEN = "org.promptly.voice.DEAFEN"
        const val ACTION_LEAVE = "org.promptly.voice.LEAVE"
        const val ACTION_STILL_HERE = "org.promptly.voice.STILL_HERE"
        const val EXTRA_SERVER = "server"
        const val EXTRA_SESSION = "session"
        const val EXTRA_ROOM = "room"
        const val EXTRA_CHANNEL = "channel"
        const val EXTRA_SPACE = "space"
        const val EXTRA_MIC = "mic"
        const val CHANNEL = "voice_live"
        const val CHANNEL_ALERT = "voice_alert"
        private const val NOTE = 4201
        private const val NOTE_STILL_THERE = 4202
        private const val NOTE_ENDED = 4203
        private const val DUCKED = 0.3
        private const val ACCENT = 0xFFD97757.toInt()
        // :suite's launchers; P Rooms may be hidden in Choose apps.
        private const val ROOMS_LAUNCHER = "org.promptly.app.RoomsLauncher"
        private const val MAIN_LAUNCHER = "org.promptly.app.PromptlyLauncher"
        private const val OPEN_PATH = "org.promptly.app.OPEN_PATH"

        fun start(context: Context, h: VoiceHandoff, hasMic: Boolean) {
            val i = Intent(context, VoiceService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_SERVER, h.server)
                .putExtra(EXTRA_SESSION, h.session)
                .putExtra(EXTRA_ROOM, h.roomId)
                .putExtra(EXTRA_CHANNEL, h.channel)
                .putExtra(EXTRA_SPACE, h.space)
                .putExtra(EXTRA_MIC, hasMic)
            ContextCompat.startForegroundService(context, i)
        }

        fun channels(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL) == null) {
                nm.createNotificationChannel(
                    // Default importance (not Low): it sits with your other
                    // notifications, opened up with its buttons, not folded
                    // away under "Silent". It never makes a sound.
                    NotificationChannel(CHANNEL, "Voice channels", NotificationManager.IMPORTANCE_DEFAULT).apply {
                        description = "While you're in a Rooms voice channel: who's talking, Mute, Deafen and Leave"
                        setShowBadge(false)
                        setSound(null, null)
                        enableVibration(false)
                    },
                )
            }
            if (nm.getNotificationChannel(CHANNEL_ALERT) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ALERT, "Voice: Still there?", NotificationManager.IMPORTANCE_HIGH).apply {
                        description = "Asks before leaving a channel you've been alone in"
                    },
                )
            }
        }
    }
}
