package org.promptly.sync.assistant

/** When "Hey Promptly" may listen, as plain rules with no Android in them, so they
 *  can be tested on their own ([WakeRulesTest]).
 *
 *  The switch is per phone and off until you turn it on. Even when it's on, the
 *  microphone is let go of completely while any [Hold] applies, and picked up again
 *  when none does. The two halves of the app each know some of the facts: the
 *  app's own process knows about a P Maps trip and a Talk conversation
 *  ([appHold]); the listening process sees the rest for itself ([ownHold]), so it
 *  still backs off if the app's process isn't running. */
object WakeRules {
    /** Why it isn't listening right now. The order is the order they're checked in. */
    enum class Hold(val says: String) {
        NO_MIC("Promptly isn't allowed to use the microphone"),
        NOT_ASSISTANT("Promptly isn't your phone's assistant any more"),
        DRIVING("Paused while you drive"),
        CAR("Paused while connected to a car"),
        CALL("Paused during a call"),
        TALKING("Paused while you're talking to Promptly"),
        MIC_BUSY("Paused while another app uses the microphone"),
    }

    /** What the app's own process knows. */
    data class AppFacts(
        val micAllowed: Boolean,
        val assistant: Boolean,
        /** A P Maps trip is on (on the phone or the car's screen). */
        val trip: Boolean,
        /** P Maps is on a car's screen. */
        val carScreen: Boolean,
        /** A Promptly call is ringing or on, or you're in a voice room. */
        val promptlyCall: Boolean,
        /** A Talk conversation (the sheet, or the car's button). */
        val talk: Boolean,
    )

    fun appHold(f: AppFacts): Hold? = when {
        !f.micAllowed -> Hold.NO_MIC
        !f.assistant -> Hold.NOT_ASSISTANT
        f.trip -> Hold.DRIVING
        f.carScreen -> Hold.CAR
        f.promptlyCall -> Hold.CALL
        f.talk -> Hold.TALKING
        else -> null
    }

    /** What the listening process can see for itself. */
    data class OwnFacts(
        /** Android Auto or a car's own system is connected, or the phone is in car mode. */
        val car: Boolean,
        /** Any app's call: ringing, on, or a voice chat (Android's audio mode). */
        val call: Boolean,
        /** Someone else is recording, or Android has silenced our recording for them. */
        val otherRecording: Boolean,
    )

    fun ownHold(f: OwnFacts): Hold? = when {
        f.car -> Hold.CAR
        f.call -> Hold.CALL
        f.otherRecording -> Hold.MIC_BUSY
        else -> null
    }

    /** The app's reason comes first: it's the more specific one ("while you drive"). */
    fun hold(fromApp: Hold?, own: OwnFacts): Hold? = fromApp ?: ownHold(own)

    /** Android's audio modes that mean a call of some kind (`AudioManager.MODE_*`:
     *  ringtone 1, in call 2, in communication 3, call screening 4, and the two
     *  redirect modes 5 and 6). */
    fun callMode(mode: Int): Boolean = mode in 1..6

    // ------------------------------------------------------------ after the phrase
    /** After "Hey Promptly": did speech follow? Nothing is sent anywhere, and the
     *  music isn't touched, until it has. Fed 20 ms levels (RMS of 16-bit samples).
     *
     *  [floor] is how loud the room was just before the phrase (the listening
     *  process measured it), so music playing on the phone doesn't count as you. */
    class Follow(floor: Double, private val waitMs: Long = WAIT_MS, private val frameMs: Int = 20) {
        enum class Verdict { WAITING, SPEECH, QUIET }

        private val bar = maxOf(SPEECH_MIN, floor * OVER_FLOOR)
        private var heardMs = 0L
        private var loud = 0
        private var done: Verdict? = null

        fun feed(rms: Double): Verdict {
            done?.let { return it }
            heardMs += frameMs
            // The chime is ours, not you.
            if (heardMs <= SETTLE_MS) return Verdict.WAITING
            loud = if (rms >= bar) loud + 1 else maxOf(0, loud - 1)
            if (loud >= LOUD_FRAMES) return Verdict.SPEECH.also { done = it }
            if (heardMs >= waitMs) return Verdict.QUIET.also { done = it }
            return Verdict.WAITING
        }

        companion object {
            const val WAIT_MS = 6_000L
            const val SETTLE_MS = 260L
            /** Quieter than this (of 32768) is never speech, however silent the room. */
            const val SPEECH_MIN = 500.0
            const val OVER_FLOOR = 2.2
            /** 120 ms of it, near enough together. */
            const val LOUD_FRAMES = 6
        }
    }

    // ------------------------------------------------------------ when it goes wrong
    /** The listening process stopping unexpectedly: a few times in a short while
     *  and the switch turns itself off, so it can't go round in circles. */
    class Faults(private val most: Int = MOST, private val withinMs: Long = WITHIN_MS) {
        private val times = ArrayDeque<Long>()

        /** Note one at [now]; true when that's too many and it should switch off. */
        fun note(now: Long): Boolean {
            times.addLast(now)
            while (times.isNotEmpty() && now - times.first() > withinMs) times.removeFirst()
            return times.size >= most
        }

        /** How long to wait before starting it again after the [nth] in a row. */
        fun backoffMs(nth: Int): Long = (5_000L shl (nth - 1).coerceIn(0, 4))

        fun restore(saved: List<Long>) {
            times.clear()
            times.addAll(saved)
        }

        fun saved(): List<Long> = times.toList()

        companion object {
            const val MOST = 3
            const val WITHIN_MS = 10 * 60_000L
        }
    }

    // ------------------------------------------------------------ the phrase itself
    /** The one phrase, in the model's own pieces (`assets/kws/tokens.txt`). Bare
     *  "Promptly" isn't here on purpose: it went off too easily. [THRESHOLD] is how
     *  sure it must be. Measured with this model on 30 spoken "Hey Promptly"s and 180
     *  near misses ("promptly" alone, "hey prompt me", "hey probably", ordinary
     *  sentences) in two computer voices at three speeds: at 0.4 it heard all 30 (25
     *  with hiss added) and none of the 180; at 0.5 it missed a third of the real
     *  ones; a higher boost heard fewer and let one near miss through. */
    const val KEYWORD = "▁HE Y ▁PRO M P T LY"
    const val THRESHOLD = 0.4f
    const val BOOST = 1.0f

    fun keywordLine(): String = "$KEYWORD :$BOOST #$THRESHOLD @HEY_PROMPTLY"

    /** Every piece of [KEYWORD] must be in the model's list, or it can never fire. */
    fun keywordFits(tokens: Set<String>): Boolean = KEYWORD.split(' ').all { it in tokens }
}
