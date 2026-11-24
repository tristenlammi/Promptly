package org.promptly.sync.maps

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** The timeline and live location on this phone: `promptlymaps://timeline?server=…&code=…`,
 *  or the service's notification. Android only lets a location be read in the background
 *  if you pick "Allow all the time", so this walks through that; then it shows what is
 *  really happening (running or not, the last position, what's waiting, what went wrong),
 *  not just what was asked for. */
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

/** What the screen says, worked out from what's really so. */
internal data class TrackView(
    val timeline: Boolean,
    val sharing: Boolean,
    val running: Boolean,
    val fixAt: Long,
    val sentAt: Long,
    val liveAt: Long,
    val waiting: Int,
    val problem: Problem?,
) {
    /** The headline: is it going or not. */
    fun headline(): String = when {
        !timeline && !sharing -> "Off. Nothing is recorded or sent."
        !running -> "Not running. " + (if (timeline) "Nothing is being recorded" else "Your location isn't being sent") + " right now."
        timeline && sharing -> "Recording your timeline and sharing your location."
        sharing -> "Sharing your location."
        else -> "Recording. It uses a little more battery."
    }

    /** The details under it, a line each. */
    fun lines(now: Long): List<String> = buildList {
        if (!timeline && !sharing) return@buildList
        add(if (fixAt == 0L) "No position from this phone yet." else "Last position: ${Ago.words(now - fixAt)}.")
        if (timeline) {
            add(if (sentAt == 0L) "Nothing sent to your server yet." else "Last sent to your server: ${Ago.words(now - sentAt)}.")
            add(if (waiting == 0) "Nothing waiting to send." else "$waiting ${if (waiting == 1) "position" else "positions"} waiting to send.")
        }
        if (sharing) add(if (liveAt == 0L) "The people you share with haven't been sent anything yet." else "Last sent to the people you share with: ${Ago.words(now - liveAt)}.")
    }

    companion object {
        fun of(context: Context): TrackView {
            val s = TrackStatus(context)
            return TrackView(s.timeline, s.sharing, TimelineService.running != null, s.fixAt, s.sentAt, s.liveAt, LocationKeeper.queue(context).size(), s.problem)
        }
    }
}

@SuppressLint("BatteryLife")
@Composable
private fun Screen(server: String?, code: String?, onDone: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    fun has(p: String) = ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED
    var fine by remember { mutableStateOf(has(Manifest.permission.ACCESS_FINE_LOCATION)) }
    var background by remember { mutableStateOf(has(Manifest.permission.ACCESS_BACKGROUND_LOCATION)) }
    var unrestricted by remember { mutableStateOf(LocationKeeper.unrestricted(context)) }
    var view by remember { mutableStateOf(TrackView.of(context)) }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    var problem by remember { mutableStateOf<String?>(null) }
    var signedIn by remember { mutableStateOf(false) }

    suspend fun look() {
        view = withContext(Dispatchers.IO) { TrackView.of(context) }
        now = System.currentTimeMillis()
    }

    LaunchedEffect(Unit) {
        runCatching { Maps.signIn(context, server, code) }
            .onSuccess {
                signedIn = true
                // Linked (perhaps again): hear what's wanted, start it, send what's waiting.
                withContext(Dispatchers.IO) {
                    runCatching { LocationKeeper.checkIn(context, force = true) }
                    LocationKeeper.ensure(context)
                    if (TrackStatus(context).timeline) runCatching { LocationKeeper.upload(context) }
                }
            }
            .onFailure { problem = it.message ?: "Couldn't sign in." }
        while (true) {
            look()
            delay(2_000)
        }
    }
    LifecycleResumeEffect(Unit) {
        fine = has(Manifest.permission.ACCESS_FINE_LOCATION)
        background = has(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        unrestricted = LocationKeeper.unrestricted(context)
        // Back from Settings with the permission: this is the moment it can start.
        LocationKeeper.ensure(context)
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
                    // Off, and not sharing with anyone: the service stops itself. Sharing: it carries on for that.
                    if (value || !LocationKeeper.wanted(context)) {
                        if (value) TimelineService.start(context) else TimelineService.stop(context)
                    }
                    problem = null
                    look()
                }
                .onFailure { problem = "Couldn't reach your server." }
        }
    }

    fun restart() {
        scope.launch(Dispatchers.IO) {
            runCatching { LocationKeeper.checkIn(context, force = true) }
            LocationKeeper.ensure(context)
            if (TrackStatus(context).timeline) runCatching { LocationKeeper.upload(context) }
            delay(600)
            look()
        }
    }

    Column(Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Your timeline", fontWeight = FontWeight.SemiBold, fontSize = 24.sp)
        Text("P Maps can keep a private history of where you go, like Google Timeline. It goes only to your Promptly server, and you can pause it or delete any of it. The same service sends where you are to the people you share your location with, while you're sharing.")
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
            else -> {
                Text(view.headline(), fontWeight = FontWeight.Medium)
                view.lines(now).forEach { Text(it, fontSize = 14.sp) }
                view.problem?.let { Text(it.words, color = MaterialTheme.colorScheme.error) }
                if ((view.timeline || view.sharing) && !view.running) {
                    Button(onClick = { restart() }) { Text("Start it again") }
                } else if (view.waiting > 0 || view.problem != null) {
                    OutlinedButton(onClick = { restart() }) { Text("Try sending now") }
                }
                if (view.timeline) {
                    OutlinedButton(onClick = { setOn(false) }) { Text("Pause the timeline") }
                } else {
                    Button(onClick = { setOn(true) }) { Text("Start recording") }
                }
                if (!unrestricted) {
                    Text("Android stops apps in the background to save battery, and after an update. To let this start again by itself and keep sending with the phone asleep, allow Promptly to run in the background without limits.", fontSize = 14.sp)
                    // The Play build never asks Android for the exemption directly (Play's
                    // rules): it opens the list, and says what to pick there.
                    val ask = backgroundAsk()
                    ask.hint?.let { Text(it, fontSize = 14.sp) }
                    OutlinedButton(onClick = { ask.open(context) }) { Text(ask.button) }
                }
            }
        }
        OutlinedButton(onClick = onDone) { Text("Done") }
    }
}
