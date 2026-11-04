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

/** Making Promptly the phone's assistant, and "Hey Promptly" away from the car. */
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

    @Composable
    private fun Screen() {
        val context = this@AssistantSettingsActivity
        val isAssistant = remember(tick) { Voice.holdsRole(context) }
        val listening = remember(tick) { Voice.anywhere(context) }
        val turnOn = {
            Voice.setAnywhere(context, true)
            tick++
        }
        val askNotify = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { _ -> turnOn() }
        val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
            when {
                !ok -> tick++
                Build.VERSION.SDK_INT >= 33 -> askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
                else -> turnOn()
            }
        }
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
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("\"Hey Promptly\" anywhere", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                        Switch(
                            checked = isAssistant && listening,
                            enabled = isAssistant,
                            onCheckedChange = { on ->
                                when {
                                    !on -> {
                                        Voice.setAnywhere(context, false)
                                        tick++
                                    }
                                    !Voice.allowed(context) -> askMic.launch(Manifest.permission.RECORD_AUDIO)
                                    Build.VERSION.SDK_INT >= 33 -> askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
                                    else -> turnOn()
                                }
                            },
                        )
                    }
                    Text("Off by default. You don't need it for the assistant gesture, and P Maps listens during a drive either way.")
                    Text("With it on, the microphone stays open whenever your phone is on. That uses battery all day, and Android shows a notification and its microphone indicator for as long as it's listening. The wake word is heard on this phone and no sound leaves it until you say it.")
                    Text("It only works while Promptly is your assistant. It won't answer while your phone is locked, and it may miss you in a noisy room or if Android stops it to save battery.")
                }
            }
        }
    }
}
