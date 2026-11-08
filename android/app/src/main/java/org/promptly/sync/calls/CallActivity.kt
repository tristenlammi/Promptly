package org.promptly.sync.calls

import android.Manifest
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.delay
import org.promptly.sync.R

/**
 * The call screen (Calls WP-D3): the ring that fills a locked phone's screen
 * (Answer, Decline, or End and answer while you're on a call), then the call
 * itself (Mute, Speaker, Hang up and a timer). A video call answered on an
 * unlocked phone goes on in the conversation's page, which shows the
 * cameras; on the lock screen, "Show video" unlocks first.
 */
class CallActivity : ComponentActivity() {
    private var callId: String = ""
    private var answerAsked = false
    private var openedPage = false

    private val askMic = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
        // Without the microphone the call still connects: you hear them, and
        // the screen says why they can't hear you.
        CallCenter.answer(callId)
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
        val want = buildList {
            if (!has(Manifest.permission.RECORD_AUDIO)) add(Manifest.permission.RECORD_AUDIO)
            // Bluetooth headsets and the car.
            if (Build.VERSION.SDK_INT >= 31 && !has(Manifest.permission.BLUETOOTH_CONNECT)) add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (want.isEmpty()) CallCenter.answer(callId) else askMic.launch(want.toTypedArray())
    }

    private fun locked(): Boolean = getSystemService(KeyguardManager::class.java).isKeyguardLocked

    /** The conversation's page in P Rooms (Promptly when P Rooms is hidden): it shows the video. */
    private fun openPage(roomId: String) {
        val path = CallProtocol.pagePath(roomId, callId)
        val rooms = Intent().setClassName(this, ROOMS_LAUNCHER)
        val target = if (packageManager.resolveActivity(rooms, 0) != null) rooms else Intent().setClassName(this, MAIN_LAUNCHER)
        target.putExtra(OPEN_PATH, path).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        openedPage = true
        startActivity(target)
        finish()
    }

    private fun showVideo(roomId: String) {
        if (!locked()) return openPage(roomId)
        getSystemService(KeyguardManager::class.java).requestDismissKeyguard(
            this,
            object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() = openPage(roomId)
            },
        )
    }

    @Composable
    private fun Screen() {
        val state by CallCenter.state.collectAsState()
        val media by CallCenter.media.collectAsState()
        val scheme = darkColorScheme(primary = Color(0xFFE08B6D), onPrimary = Color(0xFF3A1A0E), background = BG, surface = BG)
        MaterialTheme(colorScheme = scheme) {
            Surface(color = BG, modifier = Modifier.fillMaxSize()) {
                val ring = when (val s = state) {
                    is CallState.Ringing -> s.ring.takeIf { it.callId == callId }
                    is CallState.Active -> s.waiting?.takeIf { it.callId == callId }
                    CallState.Idle -> null
                }
                val active = (state as? CallState.Active)?.takeIf { it.callId == callId }
                when {
                    ring != null -> Ringing(ring)
                    active != null -> InCall(active, media)
                    else -> Ended()
                }
            }
        }
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
                Text(it, color = Color(0xFFFBD38D), fontSize = 15.sp, textAlign = TextAlign.Center)
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
    private fun InCall(active: CallState.Active, media: CallCenter.Media) {
        var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
        LaunchedEffect(Unit) {
            while (true) {
                delay(1_000)
                now = System.currentTimeMillis()
            }
        }
        val connected = media.callId == active.callId && media.status == CallNote.Status.CONNECTED && media.connectedAt > 0
        val seconds = if (connected) (now - media.connectedAt) / 1000 else 0
        val note = CallNote.of(active.title, active.video, if (media.callId == active.callId) media.status else CallNote.Status.CONNECTING, media.muted, media.speaker, seconds, media.others, media.group)
        val roomId = media.roomId
        // A video call answered on an unlocked phone: on to the page with the cameras.
        LaunchedEffect(active.video, roomId, connected) {
            if (active.video && roomId != null && connected && !openedPage && !locked()) openPage(roomId)
        }
        Column(
            Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(48.dp))
            Avatar(active.title)
            Spacer(Modifier.height(20.dp))
            Title(active.title)
            Spacer(Modifier.height(8.dp))
            Text(
                note.text,
                color = MUTED,
                fontSize = 17.sp,
                modifier = Modifier.semantics { contentDescription = if (connected) "On the call for ${CallNote.elapsed(seconds)}" else note.text },
            )
            if (!has(Manifest.permission.RECORD_AUDIO)) {
                Spacer(Modifier.height(12.dp))
                Text(
                    "They can't hear you: Promptly can't use your microphone. Allow it in Settings → Apps → Promptly.",
                    color = Color(0xFFFBD38D), fontSize = 15.sp, textAlign = TextAlign.Center,
                )
            }
            if (active.video && roomId != null) {
                Spacer(Modifier.height(20.dp))
                Button(
                    onClick = { showVideo(roomId) },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2A2523), contentColor = Color.White),
                    shape = RoundedCornerShape(24.dp),
                ) { Text("Show video", fontSize = 16.sp) }
            }
            Spacer(Modifier.weight(1f))
            Row(Modifier.fillMaxWidth().padding(bottom = 24.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                RoundButton(R.drawable.ic_call_mic_off, note.muteLabel, if (media.muted) Color.White else Color(0xFF3A3431), dark = media.muted) {
                    CallService.mute(!media.muted)
                }
                RoundButton(R.drawable.ic_call_speaker, if (media.speaker) "Speaker on" else "Speaker", if (media.speaker) Color.White else Color(0xFF3A3431), dark = media.speaker) {
                    CallService.speaker(!media.speaker)
                }
                RoundButton(R.drawable.ic_call_decline, "Hang up", RED) { CallCenter.hangUp(active.callId) }
            }
        }
    }

    @Composable
    private fun Ended() {
        LaunchedEffect(Unit) {
            delay(1_200)
            if (!openedPage) finish()
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
            Modifier.fillMaxWidth().padding(bottom = 24.dp).clip(RoundedCornerShape(16.dp)).background(Color(0xFF2A2523)).padding(16.dp),
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
    private fun Avatar(name: String) {
        val letter = name.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?"
        Box(
            Modifier.size(112.dp).clip(CircleShape).background(Color(0xFFD97757)),
            contentAlignment = Alignment.Center,
        ) {
            Text(letter, color = Color.White, fontSize = 48.sp, fontWeight = FontWeight.SemiBold)
        }
    }

    @Composable
    private fun Title(name: String) {
        Text(name, color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
    }

    @Composable
    private fun RoundButton(icon: Int, label: String, color: Color, dark: Boolean = false, onClick: () -> Unit) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(96.dp)) {
            Button(
                onClick = onClick,
                modifier = Modifier.size(72.dp).semantics { contentDescription = label },
                shape = CircleShape,
                colors = ButtonDefaults.buttonColors(containerColor = color, contentColor = if (dark) Color(0xFF1C1917) else Color.White),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
            ) {
                Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(32.dp))
            }
            Spacer(Modifier.height(8.dp))
            Text(label, color = Color.White, fontSize = 14.sp, textAlign = TextAlign.Center, maxLines = 2)
        }
    }

    companion object {
        private const val EXTRA_CALL = "call"
        private const val EXTRA_ANSWER = "answer"
        private val BG = Color(0xFF1C1917)
        private val MUTED = Color(0xFFD6CFCB)
        private val GREEN = Color(0xFF15803D)
        private val RED = Color(0xFFDC2626)
        private const val ROOMS_LAUNCHER = "org.promptly.app.RoomsLauncher"
        private const val MAIN_LAUNCHER = "org.promptly.app.PromptlyLauncher"
        private const val OPEN_PATH = "org.promptly.app.OPEN_PATH"

        fun intent(context: Context, callId: String, answer: Boolean): Intent =
            Intent(context, CallActivity::class.java)
                .putExtra(EXTRA_CALL, callId)
                .putExtra(EXTRA_ANSWER, answer)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                // Distinct per call and button, so PendingIntents don't merge.
                .setAction("org.promptly.calls.SCREEN/$callId/${if (answer) "answer" else "open"}")
    }
}
