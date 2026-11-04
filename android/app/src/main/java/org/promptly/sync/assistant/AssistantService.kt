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
import org.promptly.sync.maps.Voice

/** Android keeps this running while Promptly is your digital assistant. Being
 *  that is also what lets "Hey Promptly" open the microphone and the sheet from
 *  the background, and bring itself back after a restart. */
class PromptlyAssistantService : VoiceInteractionService() {
    override fun onReady() {
        super.onReady()
        instance = this
        // Promptly doesn't look at your screen: Android need not collect it for us.
        setDisabledShowContext(VoiceInteractionSession.SHOW_WITH_ASSIST or VoiceInteractionSession.SHOW_WITH_SCREENSHOT)
        Nav.init(this)
        if (Voice.listensAnywhere(this)) Voice.start(this)
    }

    override fun onShutdown() {
        instance = null
        // You picked another assistant: only a trip keeps the microphone open now.
        if (!Nav.onTrip() && !Voice.inCar) Voice.stop(this)
        super.onShutdown()
    }

    companion object {
        @Volatile private var instance: PromptlyAssistantService? = null

        /** Show the sheet for what the wake word's service is already hearing. */
        fun showSheet(): Boolean {
            val service = instance ?: return false
            return runCatching {
                service.showSession(Bundle().apply { putBoolean(AssistantActivity.EXTRA_PASSIVE, true) }, 0)
            }.isSuccess
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
            val passive = args?.getBoolean(AssistantActivity.EXTRA_PASSIVE) == true
            runCatching {
                startAssistantActivity(Intent(context, AssistantActivity::class.java).putExtra(AssistantActivity.EXTRA_PASSIVE, passive))
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
