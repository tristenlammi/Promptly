package org.promptly.sync

import android.app.Application

class SyncApp : Application() {
    override fun onCreate() {
        super.onCreate()
        org.promptly.sync.assistant.Crashes.watch(this)
        Sync.channel(this)
        Sync.upgrade(this)
        // DM calls: Chrome hands call pushes to the app (Delegation), which rings.
        org.promptly.sync.calls.CallCenter.init(this)
        org.promptly.sync.widgets.Widgets.upgrade(this)
        // Notifications shown by the app itself, once this phone is linked.
        org.promptly.sync.push.NativePush.start(this)
    }
}
