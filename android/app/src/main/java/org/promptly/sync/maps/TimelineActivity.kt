package org.promptly.sync.maps

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Turning the timeline on: `promptlymaps://timeline?server=…&code=…`. Android
 *  only lets a location be read in the background if you pick "Allow all the
 *  time", so this walks through that. */
class TimelineActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri: Uri? = intent?.data
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme(primary = Color(0xFFE08B6D), onPrimary = Color(0xFF3A1A0E)) else lightColorScheme(primary = Color(0xFFD97757), onPrimary = Color.White)) {
                Surface(Modifier.fillMaxSize()) { Screen(uri?.getQueryParameter("server"), uri?.getQueryParameter("code")) { finish() } }
            }
        }
    }
}

@Composable
private fun Screen(server: String?, code: String?, onDone: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    fun has(p: String) = ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED
    var fine by remember { mutableStateOf(has(Manifest.permission.ACCESS_FINE_LOCATION)) }
    var background by remember { mutableStateOf(has(Manifest.permission.ACCESS_BACKGROUND_LOCATION)) }
    var on by remember { mutableStateOf(TimelineService.wanted(context)) }
    var problem by remember { mutableStateOf<String?>(null) }
    var signedIn by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        runCatching { Maps.signIn(context, server, code) }
            .onSuccess { signedIn = true }
            .onFailure { problem = it.message ?: "Couldn't sign in." }
    }
    LifecycleResumeEffect(Unit) {
        fine = has(Manifest.permission.ACCESS_FINE_LOCATION)
        background = has(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        onPauseOrDispose { }
    }
    val askFine = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        fine = it[Manifest.permission.ACCESS_FINE_LOCATION] == true
    }

    fun setOn(value: Boolean) {
        scope.launch(Dispatchers.IO) {
            runCatching { Maps.send(context, "PUT", "/api/maps/timeline/settings", JSONObject().put("timeline_on", value)) }
                .onSuccess {
                    TimelineService.setWanted(context, value)
                    if (value) TimelineService.start(context) else TimelineService.stop(context)
                    on = value
                }
                .onFailure { problem = "Couldn't reach your server." }
        }
    }

    Column(Modifier.safeDrawingPadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Your timeline", fontWeight = FontWeight.SemiBold, fontSize = 24.sp)
        Text("P Maps can keep a private history of where you go, like Google Timeline. It goes only to your Promptly server, and you can pause it or delete any of it.")
        problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        when {
            !signedIn -> Text("Signing in…")
            !fine -> Button(onClick = {
                val wanted = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
                if (Build.VERSION.SDK_INT >= 33) wanted += Manifest.permission.POST_NOTIFICATIONS
                askFine.launch(wanted.toTypedArray())
            }) { Text("Allow location") }
            !background -> {
                Text("Next, choose \"Allow all the time\" under Permissions → Location. Without it, recording stops when the screen goes off.")
                Button(onClick = {
                    context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
                }) { Text("Open settings") }
            }
            on -> {
                Text("Recording. It uses a little more battery.")
                OutlinedButton(onClick = { setOn(false) }) { Text("Pause the timeline") }
            }
            else -> Button(onClick = { setOn(true) }) { Text("Start recording") }
        }
        OutlinedButton(onClick = onDone) { Text("Done") }
    }
}
