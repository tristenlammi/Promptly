package org.promptly.sync

import android.app.Application

class SyncApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Sync.channel(this)
        Sync.upgrade(this)
    }
}
