package org.promptly.sync.assistant

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.os.Bundle
import android.provider.ContactsContract
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import org.promptly.sync.MainActivity
import org.promptly.sync.maps.Maps
import org.promptly.sync.maps.Nav
import org.promptly.sync.maps.Voice
import org.promptly.sync.maps.VoiceService
import kotlin.concurrent.thread

/** The sheet the assistant gesture opens: listening, thinking, the answer. It can
 *  appear over the lock screen only to ask you to unlock: nothing is heard or
 *  shown until you do, and it can't come back on the lock screen afterwards. */
class AssistantActivity : ComponentActivity() {
    /** What has to be sorted out before it can listen. */
    private enum class Gate { UNLOCK, NOT_LINKED, NO_MIC, OPEN }

    private val gate = mutableStateOf(Gate.UNLOCK)
    @Volatile private var alive = true
    @Volatile private var busy = false
    @Volatile private var hearing = false
    private var unlocking = false
    private var picking = false
    private var askingMic = false
    private var pickingFor: JSONObject? = null

    private val askMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        askingMic = false
        if (ok) begin(false) else gate.value = Gate.NO_MIC
    }

    private val contactPicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        picking = false
        val wanted = pickingFor
        pickingFor = null
        val uri = result.data?.data
        if (result.resultCode == Activity.RESULT_OK && uri != null && wanted != null) {
            // Android lets the app read just this one, because you picked it.
            val number = runCatching {
                contentResolver.query(uri, arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER), null, null, null)?.use { row ->
                    if (row.moveToFirst()) row.getString(0) else null
                }
            }.getOrNull()
            if (number != null && PhoneActions.open(this, wanted, number.trim())) finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Nav.init(this)
        current = this
        // What's said on this sheet, including the answer, isn't a wake word.
        VoiceService.paused = true
        enableEdgeToEdge()
        setContent { Sheet() }
        arrive(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // You walked away from a picker and started again.
        picking = false
        arrive(intent)
    }

    private fun arrive(intent: Intent?) {
        val passive = intent?.getBooleanExtra(EXTRA_PASSIVE, false) == true
        val keyguard = getSystemService(KeyguardManager::class.java)
        if (keyguard == null || !keyguard.isKeyguardLocked) {
            begin(passive)
            return
        }
        gate.value = Gate.UNLOCK
        unlocking = true
        keyguard.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() {
                unlocking = false
                begin(passive)
            }

            override fun onDismissCancelled() {
                unlocking = false
                finish()
            }

            override fun onDismissError() {
                unlocking = false
                finish()
            }
        })
    }

    private fun begin(passive: Boolean) {
        // From here on it's your answers: lock the phone and they're gone.
        setShowWhenLocked(false)
        if (Maps.server(this) == null) {
            gate.value = Gate.NOT_LINKED
            return
        }
        if (passive) {
            gate.value = Gate.OPEN
            return
        }
        if (!Voice.allowed(this)) {
            askForMic()
            return
        }
        gate.value = Gate.OPEN
        Voice.newConversation()
        listen()
    }

    private fun askForMic() {
        askingMic = true
        askMic.launch(Manifest.permission.RECORD_AUDIO)
    }

    private fun work(job: () -> Unit) {
        if (busy) return
        busy = true
        Nav.hush()
        thread(name = "assistant") {
            try {
                job()
            } finally {
                busy = false
            }
        }
    }

    private fun listen() {
        hearing = true
        work { Voice.listenOnce(applicationContext) { alive && hearing } }
    }

    /** A tap on Yes or No answers it straight away, even while it's listening for one. */
    private fun tapped(words: String) {
        hearing = false
        Nav.hush()
        thread(name = "assistant") {
            while (busy) Thread.sleep(20)
            busy = true
            try {
                Voice.ask(applicationContext, null, words)
            } finally {
                busy = false
            }
        }
    }

    /** You said a name your server has no number for: choose them. */
    fun pickContact(action: JSONObject) {
        runOnUiThread {
            pickingFor = action
            picking = true
            contactPicker.launch(Intent(Intent.ACTION_PICK, ContactsContract.CommonDataKinds.Phone.CONTENT_URI))
        }
    }

    private fun dismiss() {
        alive = false
        Nav.hush()
        finish()
    }

    override fun onStop() {
        super.onStop()
        // Gone from the screen, including when the phone locks: so is the answer.
        if (!unlocking && !picking && !askingMic && !isChangingConfigurations) {
            alive = false
            finish()
        }
    }

    override fun onDestroy() {
        alive = false
        if (current === this) current = null
        VoiceService.paused = false
        super.onDestroy()
    }

    @Composable
    private fun Sheet() {
        val scheme = if (isSystemInDarkTheme()) {
            darkColorScheme(primary = Color(0xFFE08B6D), onPrimary = Color(0xFF3A1A0E))
        } else {
            lightColorScheme(primary = Color(0xFFD97757), onPrimary = Color.White)
        }
        MaterialTheme(colorScheme = scheme) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.25f))
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { dismiss() },
                contentAlignment = Alignment.BottomCenter,
            ) {
                Surface(
                    Modifier
                        .fillMaxWidth()
                        // Tapping the sheet itself shouldn't close it.
                        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { },
                    shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
                    color = MaterialTheme.colorScheme.surface,
                    tonalElevation = 3.dp,
                ) {
                    Column(
                        Modifier.navigationBarsPadding().padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        when (gate.value) {
                            Gate.UNLOCK -> Status("Unlock your phone to ask Promptly", false)
                            Gate.NOT_LINKED -> {
                                Text("Link this phone to your Promptly first.", style = MaterialTheme.typography.titleMedium)
                                Button(onClick = {
                                    startActivity(Intent(this@AssistantActivity, MainActivity::class.java))
                                    finish()
                                }) { Text("Link this phone") }
                            }
                            Gate.NO_MIC -> {
                                Text("Promptly needs the microphone to hear you.", style = MaterialTheme.typography.titleMedium)
                                Button(onClick = ::askForMic) { Text("Allow microphone") }
                            }
                            Gate.OPEN -> Talking()
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun Talking() {
        val state by Voice.state.collectAsState()
        val reply by Voice.reply.collectAsState()
        val heard by Voice.heard.collectAsState()
        val question by Voice.question.collectAsState()
        val spoken by Voice.spoken.collectAsState()
        val working = state == Voice.State.HEARD || state == Voice.State.THINKING

        // Read back and waiting for a yes: listen once it's finished asking.
        LaunchedEffect(spoken) {
            if (question != null && alive) listen()
        }

        when (state) {
            Voice.State.HEARD -> Status("Listening…", true)
            Voice.State.THINKING -> Status("Thinking…", true)
            else -> Unit
        }
        heard?.takeIf { it.isNotEmpty() }?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        reply?.let {
            Text(
                it,
                Modifier.fillMaxWidth().heightIn(max = 260.dp).verticalScroll(rememberScrollState()),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Medium,
            )
        }
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (question != null) {
                Button(onClick = { tapped("yes") }, enabled = state != Voice.State.THINKING) { Text("Yes") }
                OutlinedButton(onClick = { tapped("no") }, enabled = state != Voice.State.THINKING) { Text("No") }
            } else {
                Button(onClick = { listen() }, enabled = !working) { Text("Ask") }
            }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { startActivity(Intent(this@AssistantActivity, AssistantSettingsActivity::class.java)) }) { Text("Settings") }
        }
    }

    @Composable
    private fun Status(words: String, moving: Boolean) {
        val pulse by rememberInfiniteTransition(label = "pulse").animateFloat(
            initialValue = 0.35f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(650), RepeatMode.Reverse),
            label = "pulse",
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.size(14.dp).alpha(if (moving) pulse else 1f).background(MaterialTheme.colorScheme.primary, CircleShape))
            Text(words, style = MaterialTheme.typography.titleMedium)
        }
    }

    companion object {
        const val EXTRA_PASSIVE = "org.promptly.sync.assistant.PASSIVE"

        /** The sheet that's open right now, if any. */
        @Volatile var current: AssistantActivity? = null
            private set

        /** Something else is on screen now: the answer can finish in the background. */
        fun leave() {
            current?.let { sheet -> sheet.runOnUiThread { sheet.finish() } }
        }
    }
}
