package org.promptly.sync.assistant

import android.content.Intent
import android.os.Bundle
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
import android.util.Log
import org.promptly.sync.maps.Nav

/** Android keeps this around while Promptly is your digital assistant. It doesn't
 *  listen: the sheet opens, and the microphone with it, only on your gesture. */
class PromptlyAssistantService : VoiceInteractionService() {
    override fun onReady() {
        super.onReady()
        // Promptly doesn't look at your screen: Android need not collect it for us.
        setDisabledShowContext(VoiceInteractionSession.SHOW_WITH_ASSIST or VoiceInteractionSession.SHOW_WITH_SCREENSHOT)
        Nav.init(this)
        instance = this
        // "Hey Promptly", if you've turned it on: Android lets the assistant start
        // listening from here, with no screen open (after a restart, say).
        WakeWord.init(this)
    }

    override fun onShutdown() {
        instance = null
        super.onShutdown()
    }

    companion object {
        @Volatile private var instance: PromptlyAssistantService? = null

        /** Open the sheet as the gesture does, from anywhere. Only the phone's
         *  assistant can: false when Promptly isn't it, or Android isn't ready. */
        fun showSheet(args: Bundle): Boolean {
            val service = instance ?: return false
            return runCatching {
                service.showSession(args, 0)
                true
            }.getOrElse {
                Log.w("PromptlyVoice", "Couldn't show the assistant", it)
                false
            }
        }
    }
}

class PromptlySessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession = Session(this)

    /** All of it happens on the sheet, so the session's only job is to open it. */
    private class Session(service: VoiceInteractionSessionService) : VoiceInteractionSession(service) {
        override fun onPrepareShow(args: Bundle?, showFlags: Int) {
            super.onPrepareShow(args, showFlags)
            setUiEnabled(false)
        }

        override fun onShow(args: Bundle?, showFlags: Int) {
            super.onShow(args, showFlags)
            runCatching {
                // No window animation at all: the panel does its own arriving.
                val open = Intent(context, AssistantActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
                // "Hey Promptly" opened it: it waits for you to speak before anything else.
                if (args?.getBoolean(WakeWord.EXTRA_WAKE, false) == true) {
                    open.putExtra(WakeWord.EXTRA_WAKE, true).putExtra(WakeWord.EXTRA_FLOOR, args.getDouble(WakeWord.EXTRA_FLOOR, 200.0))
                }
                startAssistantActivity(open)
            }.onFailure { Log.w("PromptlyVoice", "Couldn't open the assistant", it) }
            hide()
        }
    }
}

/** Android needs a recogniser named before it lists an assistant. It only uses it
 *  on Android 10 and 11, where other apps would be told it's unavailable. */
class PromptlyRecognitionService : RecognitionService() {
    override fun onStartListening(recognizerIntent: Intent?, listener: Callback) {
        runCatching { listener.error(SpeechRecognizer.ERROR_RECOGNIZER_BUSY) }
    }

    override fun onCancel(listener: Callback) = Unit

    override fun onStopListening(listener: Callback) = Unit
}
