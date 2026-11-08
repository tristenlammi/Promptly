package org.promptly.sync

import android.app.Application

class SyncApp : Application() {
    override fun onCreate() {
        super.onCreate()
        org.promptly.sync.assistant.Crashes.watch(this)
        Sync.channel(this)
        Sync.upgrade(this)
        org.promptly.sync.widgets.Widgets.upgrade(this)
    }
}
