package org.promptly.sync.maps

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import com.stadiamaps.ferrostar.core.SpokenInstructionObserver
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import uniffi.ferrostar.SpokenInstruction
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/** What the trip says out loud. */
enum class Sound {
    /** Directions and warnings. */
    ALL,

    /** Cameras, hazards and faster routes, but no turn-by-turn. */
    ALERTS,

    /** Nothing, unless you asked the assistant something. */
    MUTE;

    fun next(): Sound = entries[(ordinal + 1) % entries.size]

    val label: String
        get() = when (this) {
            ALL -> "Sound on"
            ALERTS -> "Alerts only"
            MUTE -> "Muted"
        }
}

/** Keeps count of what's being said, so your music is turned down for exactly as long
 *  as there is something to hear: down when the first sentence is queued, back up when
 *  the last one has finished, failed or been cut off. Nothing to say, nothing turned down. */
class Ducking(private val duck: () -> Unit, private val restore: () -> Unit) {
    private val speaking = HashSet<String>()

    val ducked: Boolean
        @Synchronized get() = speaking.isNotEmpty()

    @Synchronized
    fun begin(id: String) {
        if (speaking.isEmpty()) duck()
        speaking += id
    }

    /** Finished, failed or stopped: all the same to the music. */
    @Synchronized
    fun end(id: String?) {
        if (id != null && speaking.remove(id) && speaking.isEmpty()) restore()
    }

    @Synchronized
    fun endAll() {
        if (speaking.isEmpty()) return
        speaking.clear()
        restore()
    }
}

/** The one voice of a trip: turn-by-turn directions and Nav's own warnings.
 *
 *  Ours rather than the navigation library's because that one turned the music down
 *  for every direction even with the voice muted (when nothing is said, nothing ever
 *  finishes, so the music stayed down for the rest of the trip), and never turned it
 *  back up after a sentence was cut off. */
class NavVoice(context: Context) : SpokenInstructionObserver {
    private val app = context.applicationContext
    private val audio = app.getSystemService(AudioManager::class.java)
    private val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(attributes)
        .build()
    internal val ducking = Ducking(
        duck = { runCatching { audio?.requestAudioFocus(focus) } },
        restore = { runCatching { audio?.abandonAudioFocusRequest(focus) } },
    )
    private val main = Handler(Looper.getMainLooper())
    private val after = ConcurrentHashMap<String, () -> Unit>()
    private val saying = ConcurrentHashMap.newKeySet<String>()

    // Asked for before the phone's voice was ready.
    private val waiting = ArrayList<Pair<String, String>>()
    private var ready = false
    private var failed = false
    internal var tts: TextToSpeech? = null
        private set

    private val muted = MutableStateFlow(false)
    override val muteState: StateFlow<Boolean> = muted.asStateFlow()

    init {
        tts = TextToSpeech(app) { status ->
            val queued = synchronized(waiting) {
                ready = status == TextToSpeech.SUCCESS
                failed = !ready
                waiting.toList().also { waiting.clear() }
            }
            if (status == TextToSpeech.SUCCESS) {
                tts?.language = Locale.forLanguageTag("en-AU")
                tts?.setAudioAttributes(attributes)
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) = Unit
                    override fun onDone(utteranceId: String?) = finished(utteranceId)

                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) = finished(utteranceId)
                    override fun onError(utteranceId: String?, errorCode: Int) = finished(utteranceId)
                    override fun onStop(utteranceId: String?, interrupted: Boolean) = finished(utteranceId)
                })
                queued.forEach { (id, text) -> utter(text, id) }
            } else {
                Log.w(TAG, "The phone's voice didn't start: $status")
                queued.forEach { (id, _) -> finished(id) }
            }
        }
    }

    /** A direction from the route. Muted, it isn't said, and the music isn't touched. */
    override fun onSpokenInstructionTrigger(spokenInstruction: SpokenInstruction) {
        if (muted.value) return
        say(spokenInstruction.text, spokenInstruction.utteranceId.toString())
    }

    /** Say this now (after anything already being said); [done] runs when it has been
     *  said, or couldn't be. */
    fun say(text: String, id: String, done: (() -> Unit)? = null) {
        if (done != null) after[id] = done
        val now = synchronized(waiting) {
            when {
                ready -> true
                failed -> null
                else -> {
                    waiting += id to text
                    false
                }
            }
        }
        when (now) {
            true -> utter(text, id)
            null -> finished(id)
            false -> Unit
        }
    }

    private fun utter(text: String, id: String) {
        saying += id
        ducking.begin(id)
        // A voice engine that dies mid-sentence never says it has finished.
        main.postAtTime({ finished(id) }, id, SystemClock.uptimeMillis() + GIVE_UP_MS)
        val result = runCatching { tts?.speak(text, TextToSpeech.QUEUE_ADD, null, id) }.getOrNull()
        if (result != TextToSpeech.SUCCESS) {
            Log.w(TAG, "Couldn't speak: $result")
            finished(id)
        }
    }

    private fun finished(id: String?) {
        id ?: return
        main.removeCallbacksAndMessages(id)
        saying -= id
        ducking.end(id)
        after.remove(id)?.invoke()
    }

    /** Stop talking, and give the music back. */
    override fun stopAndClearQueue() {
        synchronized(waiting) { waiting.toList().also { waiting.clear() } }.forEach { (id, _) -> finished(id) }
        runCatching { tts?.stop() }
        // Not every voice engine says a stopped sentence has stopped.
        saying.toList().forEach(::finished)
        ducking.endAll()
    }

    override fun setMuted(isMuted: Boolean) {
        muted.value = isMuted
    }

    private companion object {
        const val TAG = "PromptlyNavVoice"
        const val GIVE_UP_MS = 60_000L
    }
}
