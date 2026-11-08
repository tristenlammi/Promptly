package org.promptly.sync.calls

import android.app.Notification
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Debug builds: what Chrome does when a call push arrives, from adb, for the
 * emulator (which has no Chrome to deliver pushes to here):
 *
 *     adb shell am broadcast -n org.promptly.app/org.promptly.sync.calls.DebugRing \
 *         --es tag 'p#http://10.0.2.2:8095#0call:<id>|r|a|0|0|<answer token>' \
 *         --es title ann --es text 'Incoming call'
 *
 * `--es cancel 1` plays Chrome closing that notification instead.
 */
class DebugRing : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        CallCenter.init(context)
        val tag = intent.getStringExtra("tag") ?: return
        if (intent.getStringExtra("cancel") == "1") {
            CallCenter.onCancel(context, tag)
            Log.i("PromptlyDebugRing", "cancel $tag")
            return
        }
        val n = Notification.Builder(context, "debug")
            .setSmallIcon(android.R.drawable.sym_def_app_icon)
            .setContentTitle(intent.getStringExtra("title") ?: "Someone")
            .setContentText(intent.getStringExtra("text") ?: "Incoming call")
            .build()
        val handled = CallCenter.onNotify(context, tag, n)
        Log.i("PromptlyDebugRing", "handled=$handled")
    }
}
