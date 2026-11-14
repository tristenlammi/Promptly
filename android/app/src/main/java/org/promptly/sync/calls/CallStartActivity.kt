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
import androidx.lifecycle.lifecycleScope
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
 *
 * "Call back" on a missed call's notification comes here too ([callBack]):
 * the app asks the server to start the call with the token the missed
 * call's push carried, then carries on the same way. It's the app's own
 * button, so there's nothing to confirm.
 */
class CallStartActivity : ComponentActivity() {
    private var handoff: CallHandoff? = null
    private var back: Back? = null

    private class Back(val server: String, val token: String, val video: Boolean, val title: String)

    private val ask = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { got ->
        val mic = got[Manifest.permission.RECORD_AUDIO] ?: has(Manifest.permission.RECORD_AUDIO)
        if (!mic) Toast.makeText(this, "They won't hear you: Promptly can't use your microphone. Allow it in Settings → Apps → Promptly.", Toast.LENGTH_LONG).show()
        go()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return // a permission prompt in flight across a rotation
        if (intent?.action == ACTION_CALL_BACK) {
            val token = intent.getStringExtra(EXTRA_TOKEN)
            val server = CallCenter.server(this)
            if (token.isNullOrBlank() || server == null) return finish()
            back = Back(server, token, intent.getBooleanExtra(EXTRA_VIDEO, false), intent.getStringExtra(EXTRA_TITLE) ?: "Call")
            // You're dealing with it: the "Missed call" notification goes.
            intent.getStringExtra(EXTRA_TAG)?.let { org.promptly.sync.push.PushNotes.cancel(this, it) }
            permissionsThenGo()
            return
        }
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
        val video = handoff?.video ?: back?.video ?: return finish()
        val want = buildList {
            if (!has(Manifest.permission.RECORD_AUDIO)) add(Manifest.permission.RECORD_AUDIO)
            if (video && !has(Manifest.permission.CAMERA)) add(Manifest.permission.CAMERA)
            if (Build.VERSION.SDK_INT >= 33 && !has(Manifest.permission.POST_NOTIFICATIONS)) add(Manifest.permission.POST_NOTIFICATIONS)
            // Bluetooth headsets and the car.
            if (Build.VERSION.SDK_INT >= 31 && !has(Manifest.permission.BLUETOOTH_CONNECT)) add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (want.isEmpty()) go() else ask.launch(want.toTypedArray())
    }

    private fun go() {
        val b = back
        if (b != null && handoff == null) return callBack(b)
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

    /** Ask the server to start the call, then hold it like one the page handed over.
     *  This screen stays in front meanwhile: Android starts a microphone service only from there. */
    private fun callBack(b: Back) {
        lifecycleScope.launch {
            val h = try {
                CallHandoffs.fromJoin(b.server, CallApi(b.server).callBack(b.token, b.video), b.title, System.currentTimeMillis())
            } catch (e: CallApi.Over) {
                null
            } catch (e: java.io.IOException) {
                Toast.makeText(this@CallStartActivity, "Couldn't call back: no connection to your server.", Toast.LENGTH_LONG).show()
                return@launch finish()
            } catch (e: IllegalArgumentException) {
                null
            }
            if (h == null) {
                Toast.makeText(this@CallStartActivity, "Couldn't call back from here. Open the conversation and call from there.", Toast.LENGTH_LONG).show()
                return@launch finish()
            }
            handoff = h
            go()
        }
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
        private const val ACTION_CALL_BACK = "org.promptly.sync.calls.CALL_BACK"
        private const val EXTRA_TOKEN = "token"
        private const val EXTRA_VIDEO = "video"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_TAG = "tag"

        /** "Call back" on a missed call's notification. */
        fun callBack(context: Context, token: String, video: Boolean, title: String, tag: String): android.content.Intent =
            android.content.Intent(context, CallStartActivity::class.java)
                .setAction(ACTION_CALL_BACK)
                .putExtra(EXTRA_TOKEN, token)
                .putExtra(EXTRA_VIDEO, video)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_TAG, tag)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
