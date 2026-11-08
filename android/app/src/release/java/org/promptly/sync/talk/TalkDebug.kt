package org.promptly.sync.talk

import android.content.Context

/** Nothing in a release build: Talk always listens to the real microphone. */
object TalkDebug {
    @Suppress("UNUSED_PARAMETER")
    fun mic(context: Context): MicSource? = null
}
