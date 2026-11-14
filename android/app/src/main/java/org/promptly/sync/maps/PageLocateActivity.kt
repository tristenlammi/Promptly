package org.promptly.sync.maps

import android.Manifest
import android.app.AlertDialog
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

/**
 * The P Maps page's location button, when Chrome can't tell the page where you are
 * (`promptly://maps/locate`): starts [PageLocationService] and goes straight back to the page.
 *
 * It has to be a screen, however brief: Android lets an app start using location only while
 * it's showing. The first time, it asks for the permission in plain words.
 *
 * The link carries nothing. Whatever opens it, the position only ever goes to the server this
 * app was set up with, and that server only shows it to the page this app opened.
 */
class PageLocateActivity : ComponentActivity() {
    private val ask = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted.values.any { it }) go() else {
            Toast.makeText(this, "Location is off for Promptly. Allow it in Settings → Apps → Promptly → Permissions.", Toast.LENGTH_LONG).show()
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return // a permission prompt across a rotation
        val server = PageLocationService.server(this)
        if (!isOurs(intent?.data) || server == null) {
            finish()
            return
        }
        if (PageLocationService.allowed(this)) {
            go()
            return
        }
        val host = Uri.parse(server).host ?: server
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Show where you are on the map?")
            .setMessage(
                "The Promptly app will pass this phone's location to the P Maps page, by way of $host and nowhere else. " +
                    "Only while the map is open, and nothing is kept.",
            )
            .setPositiveButton("Continue") { _, _ ->
                ask.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            }
            .setNegativeButton("Not now") { _, _ -> finish() }
            .setOnCancelListener { finish() }
            .show()
    }

    private fun go() {
        PageLocationService.used(this, true)
        PageLocationService.start(this)
        finish()
    }

    companion object {
        fun isOurs(uri: Uri?): Boolean = uri != null && uri.scheme == "promptly" && uri.host == "maps" && uri.path == "/locate"
    }
}
