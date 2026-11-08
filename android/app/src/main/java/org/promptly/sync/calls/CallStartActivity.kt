package org.promptly.sync.calls

import android.Manifest
import android.app.AlertDialog
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * `promptly://call/start?server=…&session=…&call=…&video=0|1&title=…`, opened
 * by Call or Video call on the page on a phone with this app (Calls WP-D5).
 * The page has already started the call on the server for this phone; this
 * hands it to [CallService], so the ringback plays here and the call keeps
 * going with the screen locked, in other apps, or with the page closed, the
 * same as a call you answer. Then the call screen opens.
 *
 * The same safety as the voice hand-off ([org.promptly.sync.voice.VoiceHandoffActivity]):
 * only a call session for the server this app is set up with is taken
 * ([CallHandoffs.parse]), and the first time (or when a different account
 * hands over) it asks before using the microphone, so no web page can
 * quietly start a call from your phone. "Not now" cancels the call.
 */
class CallStartActivity : ComponentActivity() {
    private var handoff: CallHandoff? = null

    private val ask = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { got ->
        val mic = got[Manifest.permission.RECORD_AUDIO] ?: has(Manifest.permission.RECORD_AUDIO)
        if (!mic) Toast.makeText(this, "They won't hear you: Promptly can't use your microphone. Allow it in Settings → Apps → Promptly.", Toast.LENGTH_LONG).show()
        go()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return // a permission prompt in flight across a rotation
        val uri = intent?.data
        val params = uri?.queryParameterNames?.associateWith { uri.getQueryParameter(it) } ?: emptyMap()
        val saved = CallCenter.server(this)
        val h = if (uri?.host == "call" && uri.path == "/start") CallHandoffs.parse(params, saved, System.currentTimeMillis()) else null
        if (h == null) {
            Toast.makeText(
                this,
                if (saved == null) "Set up the Promptly app first: open P Rooms from your home screen." else "That call isn't from this app's server, or it's already over.",
                Toast.LENGTH_LONG,
            ).show()
            finish()
            return
        }
        handoff = h
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString(KEY_USER, null) == h.user) {
            permissionsThenGo()
            return
        }
        val what = if (h.video) "Video call" else "Call"
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("$what ${h.title} from this phone?")
            .setMessage(
                "The Promptly app holds your calls, so they keep going with the screen off or while you use other apps. " +
                    "It uses your microphone (and camera, for video) only during a call, with a notification to mute or hang up.",
            )
            .setPositiveButton("Call") { _, _ ->
                prefs.edit().putString(KEY_USER, h.user).apply()
                permissionsThenGo()
            }
            .setNegativeButton("Not now") { _, _ -> declined(h) }
            .setOnCancelListener { declined(h) }
            .show()
    }

    private fun permissionsThenGo() {
        val h = handoff ?: return finish()
        val want = buildList {
            if (!has(Manifest.permission.RECORD_AUDIO)) add(Manifest.permission.RECORD_AUDIO)
            if (h.video && !has(Manifest.permission.CAMERA)) add(Manifest.permission.CAMERA)
            if (Build.VERSION.SDK_INT >= 33 && !has(Manifest.permission.POST_NOTIFICATIONS)) add(Manifest.permission.POST_NOTIFICATIONS)
            // Bluetooth headsets and the car.
            if (Build.VERSION.SDK_INT >= 31 && !has(Manifest.permission.BLUETOOTH_CONNECT)) add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (want.isEmpty()) go() else ask.launch(want.toTypedArray())
    }

    private fun go() {
        val h = handoff ?: return finish()
        try {
            // From the front (Android 14 starts a microphone service only then).
            CallCenter.startOutgoing(this, h)
            startActivity(CallActivity.intent(this, h.callId, answer = false))
        } catch (e: RuntimeException) {
            Toast.makeText(this, "Couldn't start the call on this phone.", Toast.LENGTH_LONG).show()
            declined(h)
            return
        }
        finish()
    }

    /** "Not now": cancel the call the page started, so it stops ringing them. */
    private fun declined(h: CallHandoff) {
        CoroutineScope(Dispatchers.IO).launch { runCatching { CallApi(h.server).leave(h.session) } }
        finish()
    }

    private fun has(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    companion object {
        private const val PREFS = "calls"
        private const val KEY_USER = "handoff_user"
    }
}
