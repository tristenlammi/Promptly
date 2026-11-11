package org.promptly.sync.assistant

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.promptly.sync.maps.Voice
import org.promptly.sync.talk.PlaybackRoute
import org.promptly.sync.talk.Talk
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.RadioButton
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.Role

/** Making Promptly the phone's assistant, and what went wrong lately. */
class AssistantSettingsActivity : ComponentActivity() {
    // Android's own settings can change while you're away from this screen.
    private var tick by mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val scheme = if (isSystemInDarkTheme()) {
                darkColorScheme(primary = Color(0xFFE08B6D), onPrimary = Color(0xFF3A1A0E))
            } else {
                lightColorScheme(primary = Color(0xFFD97757), onPrimary = Color.White)
            }
            MaterialTheme(colorScheme = scheme) {
                Surface(Modifier.fillMaxSize()) { Screen() }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        tick++
    }

    private fun openAndroidSettings() {
        for (action in listOf(Settings.ACTION_VOICE_INPUT_SETTINGS, Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS, Settings.ACTION_SETTINGS)) {
            try {
                startActivity(Intent(action))
                return
            } catch (_: ActivityNotFoundException) {
                continue
            }
        }
    }

    /** Talk: conversations, and where the answers are played. */
    @Composable
    private fun TalkSettings() {
        val context = this@AssistantSettingsActivity
        var tap by remember { mutableStateOf(Talk.tapToTalk(context)) }
        var route by remember { mutableStateOf(Talk.playbackRoute(context)) }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Talking", style = MaterialTheme.typography.titleMedium)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text("Tap to talk")
                        Text(
                            if (tap) "Press the button when it's your turn, and again when you've finished. Better in noisy places."
                            else "Just talk: it answers when you pause, and you can talk over it. Say \"that's all\" to finish. Nothing is saved as a chat.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(checked = tap, onCheckedChange = {
                        tap = it
                        Talk.setTapToTalk(context, it)
                    })
                }
                run {
                    Text("Play answers as", style = MaterialTheme.typography.labelLarge)
                    RouteChoice(
                        "Call audio (recommended)",
                        "So it doesn't hear itself on the speaker, and you can talk over it.",
                        route == PlaybackRoute.CALL,
                    ) {
                        route = PlaybackRoute.CALL
                        Talk.setPlaybackRoute(context, it)
                    }
                    RouteChoice(
                        "Assistant audio",
                        "Can be louder, and goes to music headphones. On the speaker it may hear itself.",
                        route == PlaybackRoute.ASSISTANT,
                    ) {
                        route = PlaybackRoute.ASSISTANT
                        Talk.setPlaybackRoute(context, it)
                    }
                    Text(
                        "Your voice, speaking speed, captions and how you take turns are in your Promptly account under Voice.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }

    @Composable
    private fun RouteChoice(title: String, detail: String, selected: Boolean, pick: (PlaybackRoute) -> Unit) {
        val which = if (title.startsWith("Call")) PlaybackRoute.CALL else PlaybackRoute.ASSISTANT
        Row(
            Modifier.fillMaxWidth().selectable(selected = selected, role = Role.RadioButton) { pick(which) },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            RadioButton(selected = selected, onClick = null)
            Column {
                Text(title)
                Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }

    @Composable
    private fun Screen() {
        val context = this@AssistantSettingsActivity
        val isAssistant = remember(tick) { Voice.holdsRole(context) }
        Column(
            Modifier.fillMaxSize().systemBarsPadding().verticalScroll(rememberScrollState()).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Phone assistant", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (isAssistant) {
                        Text("Promptly is your assistant", style = MaterialTheme.typography.titleMedium)
                        Text("Use your phone's assistant gesture: usually holding the home button, or holding the power button if your phone is set to that. What you say goes to your own server, nowhere else.")
                        OutlinedButton(onClick = { startActivity(Intent(context, AssistantActivity::class.java)) }) { Text("Try it") }
                    } else {
                        Text("Make Promptly your assistant", style = MaterialTheme.typography.titleMedium)
                        Text("In Android's settings, under Default apps, choose Digital assistant app, then Promptly. Then your phone's assistant gesture opens Promptly instead.")
                        Button(onClick = ::openAndroidSettings) { Text("Open Android's settings") }
                    }
                }
            }
            TalkSettings()
            Text("Nothing listens in the background. The microphone only opens when you use that gesture, the Quick Settings tile, the Talk shortcut on the Promptly icon, or the button in P Maps or on your car's screen, and it closes when the conversation ends.")
            val problems = remember(tick) { Crashes.recent(context) }
            if (problems.isNotEmpty()) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Recent problems", style = MaterialTheme.typography.titleMedium)
                        Text("Promptly stopped unexpectedly. Reports like these go to your Promptly server for its admin to see, and hold what the app was doing, not your data.")
                        OutlinedButton(onClick = {
                            context.getSystemService(android.content.ClipboardManager::class.java)
                                ?.setPrimaryClip(android.content.ClipData.newPlainText("Promptly problems", problems.joinToString("\n\n")))
                        }) { Text("Copy") }
                        problems.take(5).forEach { Text(it.lineSequence().take(4).joinToString("\n").take(400), style = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
        }
    }
}
