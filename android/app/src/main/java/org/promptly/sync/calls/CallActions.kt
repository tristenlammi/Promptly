package org.promptly.sync.calls

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** The ring notification's Decline (no screen needed for it). */
class CallActions : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        CallCenter.init(context)
        val callId = intent.getStringExtra(EXTRA_CALL) ?: return
        when (intent.action) {
            DECLINE -> CallCenter.decline(callId)
        }
    }

    companion object {
        const val DECLINE = "org.promptly.calls.DECLINE"
        private const val EXTRA_CALL = "call"

        fun pending(context: Context, action: String, callId: String, code: Int): PendingIntent = PendingIntent.getBroadcast(
            context,
            callId.hashCode() + code,
            Intent(context, CallActions::class.java).setAction(action).putExtra(EXTRA_CALL, callId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }
}
