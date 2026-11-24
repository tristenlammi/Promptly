package org.promptly.sync

import android.app.Application

class SyncApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // The "Hey Promptly" listener has a process of its own (WakeService), so that
        // nothing it does can stop the app. It needs none of what follows: only to
        // leave a note if it falls over.
        if (getProcessName().endsWith(":wake")) {
            org.promptly.sync.assistant.Crashes.watch(this, listenerOnly = true)
            return
        }
        org.promptly.sync.assistant.Crashes.watch(this)
        Sync.channel(this)
        Sync.upgrade(this)
        // DM calls: Chrome hands call pushes to the app (Delegation), which rings.
        org.promptly.sync.calls.CallCenter.init(this)
        org.promptly.sync.widgets.Widgets.upgrade(this)
        // Notifications shown by the app itself, once this phone is linked.
        org.promptly.sync.push.NativePush.start(this)
        // "Hey Promptly", if you've turned it on (off unless you have).
        org.promptly.sync.assistant.WakeWord.init(this)
        // The timeline and live location: start the background service again if it
        // should be running (Android stops it on every update, and now and then).
        org.promptly.sync.maps.LocationKeeper.init(this)
    }
}
