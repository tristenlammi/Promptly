package org.promptly.sync.passwords

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle

/** Copy a secret: marked sensitive so the keyboard and the clipboard preview leave it
 *  alone, and cleared after the set time if it's still ours. */
object Clip {
    private val main = Handler(Looper.getMainLooper())

    fun copySecret(context: Context, label: String, value: String) {
        val cm = context.getSystemService(ClipboardManager::class.java)
        val clip = ClipData.newPlainText(label, value)
        clip.description.extras = PersistableBundle().apply {
            // ClipDescription.EXTRA_IS_SENSITIVE is API 33; older phones ignore it.
            putBoolean(if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE", true)
        }
        cm.setPrimaryClip(clip)
        val seconds = Pw.prefs.clipboardSeconds
        if (seconds <= 0) return
        main.postDelayed({
            // Only if what's there is still what we put there. Reading is allowed only when
            // the app has focus, so otherwise clear by time alone, which is what was asked.
            val now = runCatching { cm.primaryClip?.getItemAt(0)?.text?.toString() }.getOrNull()
            if (now == null || now == value) runCatching { cm.clearPrimaryClip() }
        }, seconds * 1000L)
    }

    fun copyPlain(context: Context, label: String, value: String) {
        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText(label, value))
    }
}
