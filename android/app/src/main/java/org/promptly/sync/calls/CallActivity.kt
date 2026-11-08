package org.promptly.sync.calls

import android.Manifest
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.delay
import livekit.org.webrtc.RendererCommon
import org.promptly.sync.R

/**
 * The call screen (Calls WP-D3; video in WP-D5): the ring that fills a
 * locked phone's screen (Answer, Decline, or End and answer while you're on
 * a call), then the call itself, with everyone's video drawn natively, so a
 * video call works with the phone locked or the page closed. Mute, Camera,
 * Flip, Speaker, Hang up and a timer. Leaving it during a video call
 * (Home, another app) shrinks it to picture-in-picture ([PipPlan]).
 */
class CallActivity : ComponentActivity() {
    private var callId: String = ""
    private var answerAsked = false
    private var inPip by mutableStateOf(false)
    private var pipWanted = false

    private val askMic = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
        // Without the microphone the call still connects: you hear them, and
        // the screen says why they can't hear you.
        CallService.permissionsChanged()
        CallCenter.answer(callId)
    }

    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        CallService.permissionsChanged()
        if (granted) CallService.current?.setCamera(true)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CallCenter.init(this)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        take(intent, fresh = savedInstanceState == null)
        setContent { Screen() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        take(intent, fresh = true)
    }

    private fun take(i: Intent?, fresh: Boolean) {
        callId = i?.getStringExtra(EXTRA_CALL) ?: callId
        if (fresh && i?.getBooleanExtra(EXTRA_ANSWER, false) == true) answer()
    }

    private fun has(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun answer() {
        if (answerAsked) return
        answerAsked = true
        val video = (CallCenter.state.value as? CallState.Ringing)?.ring?.video == true ||
            (CallCenter.state.value as? CallState.Active)?.waiting?.video == true
        val want = buildList {
            if (!has(Manifest.permission.RECORD_AUDIO)) add(Manifest.permission.RECORD_AUDIO)
            if (video && !has(Manifest.permission.CAMERA)) add(Manifest.permission.CAMERA)
            // Bluetooth headsets and the car.
            if (Build.VERSION.SDK_INT >= 31 && !has(Manifest.permission.BLUETOOTH_CONNECT)) add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (want.isEmpty()) CallCenter.answer(callId) else askMic.launch(want.toTypedArray())
    }

    private fun toggleCamera(state: CameraState) {
        if (!state.buttonOn && !has(Manifest.permission.CAMERA)) {
            askCamera.launch(Manifest.permission.CAMERA)
            return
        }
        CallService.toggleCamera()
    }

    // ================================================================ picture-in-picture

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (PipPlan.enterOnLeave(Build.VERSION.SDK_INT, pipWanted)) {
            runCatching { enterPictureInPictureMode(pipParams(pipWanted, null)) }
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        inPip = isInPictureInPictureMode
    }

    private fun updatePip(wanted: Boolean, aspect: Pair<Int, Int>?) {
        pipWanted = wanted
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return
        runCatching { setPictureInPictureParams(pipParams(wanted, aspect)) }
    }

    private fun pipParams(wanted: Boolean, aspect: Pair<Int, Int>?): PictureInPictureParams {
        val (w, h) = PipPlan.aspect(aspect?.first ?: 0, aspect?.second ?: 0)
        val b = PictureInPictureParams.Builder()
            .setAspectRatio(Rational(w, h))
            .setActions(
                listOf(
                    remote(CallService.ACTION_MUTE, 31, R.drawable.ic_call_mic_off, "Mute"),
                    remote(CallService.ACTION_HANG_UP, 33, R.drawable.ic_call_decline, "Hang up"),
                ),
            )
        if (Build.VERSION.SDK_INT >= 31) {
            b.setAutoEnterEnabled(PipPlan.autoEnter(Build.VERSION.SDK_INT, wanted))
            b.setSeamlessResizeEnabled(true)
        }
        return b.build()
    }

    private fun remote(action: String, code: Int, icon: Int, label: String): RemoteAction {
        val pi = PendingIntent.getService(
            this, code, Intent(this, CallService::class.java).setAction(action),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return RemoteAction(Icon.createWithResource(this, icon), label, label, pi)
    }

    // ================================================================ the screen

    @Composable
    private fun Screen() {
        val state by CallCenter.state.collectAsState()
        val media by CallCenter.media.collectAsState()
        val video by CallService.video.collectAsState()
        val scheme = darkColorScheme(primary = Color(0xFFE08B6D), onPrimary = Color(0xFF3A1A0E), background = BG, surface = BG)
        MaterialTheme(colorScheme = scheme) {
            Surface(color = BG, modifier = Modifier.fillMaxSize()) {
                val ring = when (val s = state) {
                    is CallState.Ringing -> s.ring.takeIf { it.callId == callId }
                    is CallState.Active -> s.waiting?.takeIf { it.callId == callId }
                    CallState.Idle -> null
                }
                val active = (state as? CallState.Active)?.takeIf { it.callId == callId }
                val mine = active != null && media.callId == active.callId
                val pictures = mine && (video.local != null || video.remotes.any { it.camera != null || it.screen != null })
                val main = if (mine) mainPicture(video, media.group) else null
                val wanted = PipPlan.wanted(
                    inCall = active != null,
                    ringing = ring != null,
                    connected = mine && media.status == CallNote.Status.CONNECTED,
                    videoCall = active?.video == true,
                    pictures = pictures,
                )
                LaunchedEffect(wanted, main?.aspect) { updatePip(wanted, main?.aspect) }
                when {
                    ring != null -> Ringing(ring)
                    active != null && inPip -> PipView(active, main, video.room)
                    active != null -> InCall(active, media, if (mine) video else CallService.CallVideo(), pictures)
                    else -> Ended()
                }
            }
        }
    }

    /** The big picture: a shared screen, else the other person's camera
     *  (1:1), else your own camera (while it rings them). */
    private data class Pic(val track: VideoTrack, val name: String, val screen: Boolean, val mine: Boolean, val aspect: Pair<Int, Int>?)

    private fun mainPicture(v: CallService.CallVideo, group: Boolean): Pic? {
        v.remotes.firstOrNull { it.screen != null }?.let { return Pic(it.screen!!, it.name, screen = true, mine = false, aspect = it.aspect) }
        if (!group) v.remotes.firstOrNull { it.camera != null }?.let { return Pic(it.camera!!, it.name, screen = false, mine = false, aspect = it.aspect) }
        if (v.remotes.none { it.camera != null }) v.local?.let { return Pic(it, "You", screen = false, mine = true, aspect = null) }
        return null
    }

    @Composable
    private fun Ringing(ring: Ring) {
        Column(
            Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(48.dp))
            Avatar(ring.title)
            Spacer(Modifier.height(20.dp))
            Title(ring.title)
            Spacer(Modifier.height(8.dp))
            Text(ring.text, color = MUTED, fontSize = 17.sp, textAlign = TextAlign.Center)
            CallNote.busyLine(ring)?.let {
                Spacer(Modifier.height(12.dp))
                Text(it, color = AMBER, fontSize = 15.sp, textAlign = TextAlign.Center)
            }
            Spacer(Modifier.weight(1f))
            FullScreenTip()
            Row(Modifier.fillMaxWidth().padding(bottom = 24.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                RoundButton(R.drawable.ic_call_decline, "Decline", RED) { CallCenter.decline(ring.callId) }
                RoundButton(R.drawable.ic_call_answer, CallNote.answerLabel(ring), GREEN) { answer() }
            }
        }
    }

    @Composable
    private fun InCall(active: CallState.Active, media: CallCenter.Media, video: CallService.CallVideo, pictures: Boolean) {
        var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
        LaunchedEffect(Unit) {
            while (true) {
                delay(1_000)
                now = System.currentTimeMillis()
            }
        }
        val mine = media.callId == active.callId
        val connected = mine && media.status == CallNote.Status.CONNECTED && media.connectedAt > 0
        val seconds = if (connected) (now - media.connectedAt) / 1000 else 0
        val note = CallNote.of(
            active.title, active.video,
            if (mine) media.status else CallNote.Status.CONNECTING,
            media.muted, media.speaker, seconds, media.others, media.group,
            calling = mine && media.calling, held = mine && media.held, peerHeld = mine && media.peerHeld,
        )
        val room = video.room
        if (pictures && room != null) {
            VideoCall(active, media, video, room, note, connected, seconds)
        } else {
            Column(
                Modifier.fillMaxSize().safeDrawingPadding().padding(horizontal = 16.dp, vertical = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.height(48.dp))
                Avatar(active.title)
                Spacer(Modifier.height(20.dp))
                Title(active.title)
                Spacer(Modifier.height(8.dp))
                StatusLine(note.text, connected, seconds)
                Problems(media)
                Spacer(Modifier.weight(1f))
                Controls(active, media, note)
            }
        }
    }

    @Composable
    private fun StatusLine(text: String, connected: Boolean, seconds: Long, shadow: Boolean = false) {
        Text(
            text,
            color = if (shadow) Color.White else MUTED,
            style = if (shadow) TextStyle(shadow = Shadow(Color.Black, blurRadius = 8f)) else TextStyle.Default,
            fontSize = 17.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { contentDescription = if (connected) "On the call for ${CallNote.elapsed(seconds)}" else text },
        )
    }

    @Composable
    private fun Problems(media: CallCenter.Media) {
        if (!has(Manifest.permission.RECORD_AUDIO)) {
            Spacer(Modifier.height(12.dp))
            Text(
                "They can't hear you: Promptly can't use your microphone. Allow it in Settings → Apps → Promptly.",
                color = AMBER, fontSize = 15.sp, textAlign = TextAlign.Center,
            )
        }
        if (media.camera.paused) {
            Spacer(Modifier.height(8.dp))
            Text("Your camera is paused", color = MUTED, fontSize = 14.sp, textAlign = TextAlign.Center)
        }
    }

    /** A call with pictures: the big one, yourself small, a grid for groups. */
    @Composable
    private fun VideoCall(active: CallState.Active, media: CallCenter.Media, v: CallService.CallVideo, room: Room, note: CallNote, connected: Boolean, seconds: Long) {
        val main = mainPicture(v, media.group)
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            if (main != null) {
                VideoView(main.track, room, mirror = main.mine && v.front, fill = !main.screen, modifier = Modifier.fillMaxSize(), label = if (main.mine) "Your camera" else "${main.name}'s ${if (main.screen) "screen" else "camera"}")
            } else {
                // A group: everyone's camera in a grid.
                LazyVerticalGrid(
                    columns = GridCells.Fixed(if (v.remotes.size <= 1) 1 else 2),
                    modifier = Modifier.fillMaxSize().safeDrawingPadding().padding(top = 72.dp, bottom = 120.dp, start = 6.dp, end = 6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(v.remotes, key = { it.userId }) { r ->
                        Box(Modifier.aspectRatio(3f / 4f).clip(RoundedCornerShape(14.dp)).background(Color(0xFF2A2523)), contentAlignment = Alignment.Center) {
                            val cam = r.camera
                            if (cam != null) {
                                VideoView(cam, room, mirror = false, fill = true, modifier = Modifier.fillMaxSize(), label = "${r.name}'s camera")
                            } else {
                                Avatar(r.name, 64.dp)
                            }
                            Text(
                                r.name + if (r.held) " · on hold" else if (r.micMuted) " · muted" else "",
                                color = Color.White, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.align(Alignment.BottomStart).padding(8.dp).background(Color(0x99000000), RoundedCornerShape(8.dp)).padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                        }
                    }
                }
            }
            // Yourself, small, when someone else is the big picture.
            val self = v.local
            if (self != null && main?.mine != true) {
                Box(
                    Modifier.safeDrawingPadding().padding(top = 72.dp, end = 12.dp).align(Alignment.TopEnd).width(104.dp).aspectRatio(3f / 4f)
                        .clip(RoundedCornerShape(14.dp)).background(Color(0xFF2A2523)),
                ) {
                    VideoView(self, room, mirror = v.front, fill = true, modifier = Modifier.fillMaxSize(), label = "Your camera")
                }
            }
            Column(
                Modifier.fillMaxWidth().safeDrawingPadding().padding(top = 12.dp, start = 16.dp, end = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(active.title, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, style = TextStyle(shadow = Shadow(Color.Black, blurRadius = 8f)))
                StatusLine(note.text, connected, seconds, shadow = true)
                media.videoNote?.let { Text(it, color = AMBER, fontSize = 13.sp, style = TextStyle(shadow = Shadow(Color.Black, blurRadius = 8f))) }
                if (media.camera.paused) Text("Your camera is paused", color = Color.White, fontSize = 13.sp)
            }
            Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().safeDrawingPadding().padding(horizontal = 8.dp, vertical = 16.dp)) {
                Controls(active, media, note)
            }
        }
    }

    @Composable
    private fun Controls(active: CallState.Active, media: CallCenter.Media, note: CallNote) {
        val cam = media.camera
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.Top) {
            RoundButton(R.drawable.ic_call_mic_off, note.muteLabel, if (media.muted) Color.White else KEY, dark = media.muted, size = 60.dp) {
                CallService.mute(!media.muted)
            }
            RoundButton(
                if (cam.buttonOn) R.drawable.ic_call_video else R.drawable.ic_call_video_off,
                if (cam.buttonOn) "Camera off" else "Camera",
                if (cam.buttonOn) Color.White else KEY,
                dark = cam.buttonOn,
                size = 60.dp,
            ) { toggleCamera(cam) }
            if (cam.live) {
                RoundButton(R.drawable.ic_call_flip, "Flip", KEY, size = 60.dp) { CallService.flipCamera() }
            }
            RoundButton(R.drawable.ic_call_speaker, if (media.speaker) "Speaker on" else "Speaker", if (media.speaker) Color.White else KEY, dark = media.speaker, size = 60.dp) {
                CallService.speaker(!media.speaker)
            }
            RoundButton(R.drawable.ic_call_decline, "Hang up", RED, size = 60.dp) { CallCenter.hangUp(active.callId) }
        }
    }

    /** Picture-in-picture: just the picture (or who it's with). */
    @Composable
    private fun PipView(active: CallState.Active, main: Pic?, room: Room?) {
        Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
            if (main != null && room != null) {
                VideoView(main.track, room, mirror = main.mine, fill = !main.screen, modifier = Modifier.fillMaxSize(), label = active.title)
            } else {
                Avatar(active.title, 56.dp)
            }
        }
    }

    /** One video, drawn with LiveKit's renderer (made for this room). */
    @Composable
    private fun VideoView(track: VideoTrack, room: Room, mirror: Boolean, fill: Boolean, modifier: Modifier, label: String) {
        key(room, track) {
            var view by remember { mutableStateOf<TextureViewRenderer?>(null) }
            AndroidView(
                factory = { ctx ->
                    TextureViewRenderer(ctx).also { r ->
                        room.initVideoRenderer(r)
                        r.setEnableHardwareScaler(true)
                        view = r
                    }
                },
                update = { r ->
                    r.setMirror(mirror)
                    r.setScalingType(if (fill) RendererCommon.ScalingType.SCALE_ASPECT_FILL else RendererCommon.ScalingType.SCALE_ASPECT_FIT)
                },
                onRelease = { r -> runCatching { r.release() } },
                modifier = modifier.semantics { contentDescription = label },
            )
            val r = view
            if (r != null) {
                DisposableEffect(r) {
                    track.addRenderer(r)
                    onDispose { track.removeRenderer(r) }
                }
            }
        }
    }

    @Composable
    private fun Ended() {
        LaunchedEffect(Unit) {
            delay(1_200)
            finish()
        }
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Call ended", color = MUTED, fontSize = 20.sp)
        }
    }

    /** Once, on the call screen: full-screen rings are off (Android 14+). */
    @Composable
    private fun FullScreenTip() {
        var show by remember { mutableStateOf(!RingNotes.canRingFullScreen(this) && !RingNotes.askedFullScreen(this)) }
        if (!show) return
        Column(
            Modifier.fillMaxWidth().padding(bottom = 24.dp).clip(RoundedCornerShape(16.dp)).background(KEY).padding(16.dp),
        ) {
            Text("Let calls ring on your lock screen", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
            Spacer(Modifier.height(4.dp))
            Text("Right now a call only shows as a notification when your phone is locked.", color = MUTED, fontSize = 14.sp)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { RingNotes.markAskedFullScreen(this@CallActivity); show = false }) { Text("Not now") }
                TextButton(onClick = {
                    RingNotes.markAskedFullScreen(this@CallActivity)
                    show = false
                    runCatching { startActivity(RingNotes.fullScreenSettings(this@CallActivity)) }
                }) { Text("Allow") }
            }
        }
    }

    @Composable
    private fun Avatar(name: String, size: Dp = 112.dp) {
        val letter = name.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?"
        Box(
            Modifier.size(size).clip(CircleShape).background(Color(0xFFD97757)),
            contentAlignment = Alignment.Center,
        ) {
            Text(letter, color = Color.White, fontSize = (size.value * 0.43f).sp, fontWeight = FontWeight.SemiBold)
        }
    }

    @Composable
    private fun Title(name: String) {
        Text(name, color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
    }

    @Composable
    private fun RoundButton(icon: Int, label: String, color: Color, dark: Boolean = false, size: Dp = 72.dp, onClick: () -> Unit) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(size + 16.dp)) {
            Button(
                onClick = onClick,
                modifier = Modifier.size(size).semantics { contentDescription = label },
                shape = CircleShape,
                colors = ButtonDefaults.buttonColors(containerColor = color, contentColor = if (dark) Color(0xFF1C1917) else Color.White),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
            ) {
                Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(size * 0.44f))
            }
            Spacer(Modifier.height(8.dp))
            Text(label, color = Color.White, fontSize = 13.sp, textAlign = TextAlign.Center, maxLines = 2, style = TextStyle(shadow = Shadow(Color.Black, blurRadius = 6f)))
        }
    }

    companion object {
        private const val EXTRA_CALL = "call"
        private const val EXTRA_ANSWER = "answer"
        private val BG = Color(0xFF1C1917)
        private val KEY = Color(0xFF3A3431)
        private val MUTED = Color(0xFFD6CFCB)
        private val AMBER = Color(0xFFFBD38D)
        private val GREEN = Color(0xFF15803D)
        private val RED = Color(0xFFDC2626)

        fun intent(context: Context, callId: String, answer: Boolean): Intent =
            Intent(context, CallActivity::class.java)
                .putExtra(EXTRA_CALL, callId)
                .putExtra(EXTRA_ANSWER, answer)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                // Distinct per call and button, so PendingIntents don't merge.
                .setAction("org.promptly.calls.SCREEN/$callId/${if (answer) "answer" else "open"}")
    }
}
