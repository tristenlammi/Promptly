// Tabs a browser sent to this phone (passwords/SYNC.md). The 30-minute alerts poll says one is
// waiting, with no address; unlocking Passwords opens each in the default browser, once.
package org.promptly.sync.passwords

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.promptly.sync.passwords.core.isWebAddress

object SentTabs {
    suspend fun openWaiting(context: Context) {
        val client = Pw.client() ?: return
        if (!client.unlocked) return
        val urls = withContext(Dispatchers.IO) { runCatching { client.takeSentTabs() }.getOrDefault(emptyList()) }
        if (urls.isEmpty()) return
        context.getSystemService(NotificationManager::class.java)?.cancel("pw-alert", 5)
        context.applicationContext.getSharedPreferences("pw_alerts", Context.MODE_PRIVATE).edit().putInt("sent", 0).apply()
        for (url in urls) {
            if (!isWebAddress(url)) continue
            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
    }
}
