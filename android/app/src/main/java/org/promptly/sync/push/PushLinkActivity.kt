package org.promptly.sync.push

import android.Manifest
import android.app.AlertDialog
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.promptly.sync.Api
import org.promptly.sync.PairLink
import org.promptly.sync.Store

/**
 * "Get notifications from the Promptly app" on the web app's Account →
 * Notifications (`promptly://notifications?server=…&code=…`): links this
 * phone if it isn't yet (the same one-time code as photo backup's pairing),
 * asks Android's permission to show notifications, and registers.
 *
 * Only for the server this app was set up with, and only after you say yes:
 * a link can't sign the phone in anywhere by itself.
 */
class PushLinkActivity : ComponentActivity() {
    private var link: PairLink? = null

    private val ask = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) turnOn() else {
            Toast.makeText(this, "Notifications are off for Promptly. Allow them in Settings → Apps → Promptly.", Toast.LENGTH_LONG).show()
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return // a permission prompt across a rotation
        val l = parse(intent?.data, getSharedPreferences("promptly", Context.MODE_PRIVATE).getString("server", null))
        if (l == null) {
            Toast.makeText(this, "Open this from Promptly on this phone: Account → Notifications.", Toast.LENGTH_LONG).show()
            finish()
            return
        }
        link = l
        val host = Uri.parse(l.server).host ?: l.server
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Show Promptly's notifications on this phone?")
            .setMessage("Messages, calls and reminders from $host will come from the Promptly app, with its own name and sounds, in place of Chrome's.")
            .setPositiveButton("Turn on") { _, _ ->
                if (Build.VERSION.SDK_INT >= 33 && !has(Manifest.permission.POST_NOTIFICATIONS)) ask.launch(Manifest.permission.POST_NOTIFICATIONS)
                else turnOn()
            }
            .setNegativeButton("Not now") { _, _ -> finish() }
            .setOnCancelListener { finish() }
            .show()
    }

    private fun turnOn() {
        val l = link ?: return finish()
        val app = applicationContext
        CoroutineScope(Dispatchers.Main).launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    val store = Store(app)
                    val have = store.account
                    // Already linked to this server: the code isn't needed (and isn't used).
                    if (have == null || have.server != l.server) {
                        store.account = Api.claim(l, Api.deviceName())
                        store.unlinked = false
                    }
                }.isSuccess
            }
            if (ok) {
                NativePush.start(app, force = true)
                Toast.makeText(app, "Notifications will come from Promptly on this phone.", Toast.LENGTH_LONG).show()
            } else {
                Toast.makeText(app, "Couldn't link this phone. Try again from Account → Notifications.", Toast.LENGTH_LONG).show()
            }
            finish()
        }
    }

    private fun has(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    companion object {
        /** The link, if it's for the server this app is set up with ([saved]); null otherwise. */
        fun parse(uri: Uri?, saved: String?): PairLink? {
            if (uri == null || uri.scheme != "promptly" || uri.host != "notifications" || saved == null) return null
            val server = uri.getQueryParameter("server")?.trimEnd('/') ?: return null
            val code = uri.getQueryParameter("code") ?: return null
            if (server != saved.trimEnd('/') || code.length !in 8..64) return null
            return PairLink(server, code)
        }
    }
}
