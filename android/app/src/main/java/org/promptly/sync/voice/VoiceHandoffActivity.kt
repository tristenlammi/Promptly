package org.promptly.sync.voice

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
 * `promptly://voice/join?server=…&session=…&room=…&channel=…&space=…`, opened
 * by Join in P Rooms on this phone. Invisible: asks for the microphone (and
 * notifications, and Bluetooth for headsets) when needed, starts
 * [VoiceService] and closes, leaving you on the channel page.
 *
 * Only a session for the server this app is set up with is taken. The first
 * time (and whenever a different account hands over) it asks before using
 * the microphone, so no web page can quietly put your phone in a channel.
 */
class VoiceHandoffActivity : ComponentActivity() {
    private var handoff: VoiceHandoff? = null

    private val ask = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { got ->
        val mic = got[Manifest.permission.RECORD_AUDIO] ?: has(Manifest.permission.RECORD_AUDIO)
        if (!mic) Toast.makeText(this, "Listening only: Promptly can't use your microphone. Allow it in Settings → Apps → Promptly.", Toast.LENGTH_LONG).show()
        go(mic)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return // permission prompt in flight across a rotation
        val uri = intent?.data
        val params = uri?.queryParameterNames?.associateWith { uri.getQueryParameter(it) } ?: emptyMap()
        val saved = getSharedPreferences("promptly", Context.MODE_PRIVATE).getString("server", null)
        val h = if (uri?.host == "voice") VoiceProtocol.parseHandoff(params, saved) else null
        if (h == null) {
            Toast.makeText(
                this,
                if (saved == null) "Set up the Promptly app first: open P Rooms from your home screen." else "That voice channel is on another server than this app's.",
                Toast.LENGTH_LONG,
            ).show()
            finish()
            return
        }
        handoff = h
        val user = VoiceProtocol.sessionUser(h.session)
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (user != null && prefs.getString(KEY_USER, null) == user) {
            permissionsThenGo()
            return
        }
        val where = "🔊 ${h.channel}" + if (h.space.isNotBlank()) " · ${h.space}" else ""
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Join $where on this phone?")
            .setMessage(
                "The Promptly app keeps you in the channel with the screen off or while you use other apps. " +
                    "It uses your microphone only while you're in a channel, with a notification to mute, deafen or leave.",
            )
            .setPositiveButton("Join") { _, _ ->
                if (user != null) prefs.edit().putString(KEY_USER, user).apply()
                permissionsThenGo()
            }
            .setNegativeButton("Not now") { _, _ -> declined(h) }
            .setOnCancelListener { declined(h) }
            .show()
    }

    private fun permissionsThenGo() {
        val want = buildList {
            if (!has(Manifest.permission.RECORD_AUDIO)) add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33 && !has(Manifest.permission.POST_NOTIFICATIONS)) add(Manifest.permission.POST_NOTIFICATIONS)
            // Bluetooth headsets and the car: AudioSwitch needs it to see them.
            if (Build.VERSION.SDK_INT >= 31 && !has(Manifest.permission.BLUETOOTH_CONNECT)) add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (want.isEmpty()) go(true) else ask.launch(want.toTypedArray())
    }

    private fun go(mic: Boolean) {
        val h = handoff ?: return finish()
        try {
            VoiceService.start(this, h, mic)
        } catch (e: RuntimeException) {
            Toast.makeText(this, "Couldn't start voice on this phone.", Toast.LENGTH_LONG).show()
            declined(h)
            return
        }
        finish()
    }

    /** "Not now": end the session the page made, so it stops waiting. */
    private fun declined(h: VoiceHandoff) {
        CoroutineScope(Dispatchers.IO).launch { runCatching { VoiceApi(h.server).leave(h.session) } }
        finish()
    }

    private fun has(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    companion object {
        private const val PREFS = "voice"
        private const val KEY_USER = "handoff_user"
    }
}
