package org.promptly.sync.capture

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

/** Is there a working connection right now (for "Saved" vs "Saved on this phone — will sync"). */
object Online {
    fun now(ctx: Context): Boolean = runCatching {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }.getOrDefault(false)
}
