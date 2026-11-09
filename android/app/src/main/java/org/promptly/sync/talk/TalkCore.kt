package org.promptly.sync.talk

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import org.json.JSONObject

/** One exchange on the screen: what you said, and what it said back. */
data class Exchange(
    val key: Int,
    val you: String = "",
    val youFinal: Boolean = false,
    val typed: Boolean = false,
    val reply: String = "",
    /** How much of [reply] has started playing. */
    val spoken: Int = 0,
    val replyDone: Boolean = false,
    val interrupted: Boolean = false,
    val messageId: String? = null,
)

/** A change (or a command) waiting for a yes. */
data class PendingAsk(val question: String, val approvalId: String, val expiresAt: Long, val ttlMs: Long)

/** Something worth a look from a tool: a route, an event, photos. */
data class TalkCard(val key: Int, val kind: String, val title: String, val url: String?)

enum class Phase { OFF, STARTING, LIVE, RECONNECTING, ENDED }

data class TalkUi(
    val phase: Phase = Phase.OFF,
    /** The server's: listening, thinking, speaking or muted. */
    val state: String = "listening",
    val muted: Boolean = false,
    /** Another app (a call, a voice channel) has the audio: it's waiting quietly. */
    val paused: Boolean = false,
    val exchanges: List<Exchange> = emptyList(),
    val tool: String? = null,
    val ask: PendingAsk? = null,
    val cards: List<TalkCard> = emptyList(),
    val notice: String? = null,
    val problem: TalkProblem? = null,
    val turnMode: String = "hands_free",
    val interruptMode: String = "talk",
    /** Tap to talk: the microphone is open for your turn. */
    val talking: Boolean = false,
    val hearing: Boolean = false,
    val weak: Boolean = false,
    val captions: Boolean = true,
    val endReason: String? = null,
    val startedAt: Long = 0L,
)

/** Plays the server's speech: [Playback] over an `AudioTrack` on the phone. */
interface Speaker {
    fun push(pcm: ByteArray)
    fun startReply()
    /** Stop now; how much of the reply was heard, in ms. */
    fun stop(): Long?
    fun playedMs(): Long?
    val playing: Boolean
    fun duck()
    fun unduck()
    val ducked: Boolean
    /** The soft tone at the end of a conversation. */
    fun endTone()
}

/** Carries out a device action (`PhoneActions` on the phone). Returns what went
 *  wrong, to show, or null when it's done or handed to you to finish. */
fun interface ActionSink {
    fun carry(action: JSONObject): String?
}

/** Where the last voice state goes, for crash reports ([org.promptly.sync.assistant.VoiceTrail]). */
fun interface Trail {
    fun note(state: String, since: Long)
}

/** Told about the turn as it goes, for a driver of the microphone that isn't always
 *  open: the car's one press, one turn ([CarTurn]). Called on the [Ticker]'s thread. */
interface TurnWatcher {
    /** The server's state: listening, thinking, speaking or muted. */
    fun state(state: String) {}
    /** Words of yours are coming through. */
    fun words() {}
    /** It asked something; [listenS] is how long the microphone may open for the answer. */
    fun asked(listenS: Int) {}
    /** The question was answered, expired or dropped. */
    fun askDone() {}
    /** Its speech started or ran out on the speaker. */
    fun playing(now: Boolean) {}
    fun finished() {}
}

/** A Talk conversation on the phone, without the Android parts: the screen's state,
 *  the microphone's level meter (instant duck while you talk over it), interrupts,
 *  the yes/no card, device actions, yielding to calls, and the breadcrumb. Every
 *  call hops onto the [Ticker]'s one thread, so the socket, the microphone and the
 *  buttons never race. */
class TalkCore(
    private val ticker: Ticker,
    private val speaker: Speaker,
    private val actions: ActionSink,
    private val trail: Trail,
    opener: SocketOpener,
    hello: () -> JSONObject,
) {
    private val _ui = MutableStateFlow(TalkUi())
    val ui: StateFlow<TalkUi> = _ui.asStateFlow()

    /** Told when the conversation is over (to stop the service, drop the audio route). */
    var onFinished: (() -> Unit)? = null

    /** The car's turn driver, when there is one. */
    var watcher: TurnWatcher? = null

    private var keys = 0
    private var loudFrames = 0
    private var lastVoiceAt = 0L
    private var duckedAt: Long? = null
    private var mutedForYield = false
    private var cancelAskTimer: (() -> Unit)? = null
    private var awaitingSound = false

    private val client = TalkClient(opener, ticker, hello, object : TalkClient.Listener {
        override fun onEvent(event: TalkEvent) = event(event)
        override fun onSpeech(pcm: ByteArray) {
            if (_ui.value.phase == Phase.ENDED) return
            speaker.push(pcm)
        }
        override fun onLink(link: TalkClient.Link) {
            when (link) {
                TalkClient.Link.CONNECTING -> set { copy(phase = Phase.STARTING) }
                TalkClient.Link.RECONNECTING -> {
                    speaker.stop()
                    set { copy(phase = Phase.RECONNECTING, talking = false) }
                }
                TalkClient.Link.LIVE -> set { copy(phase = Phase.LIVE) }
            }
            noteTrail()
        }
        override fun onEnded(problem: TalkProblem?) = finished(problem)
        override fun onWeak() = set { copy(weak = true) }
    })

    private fun set(change: TalkUi.() -> TalkUi) = _ui.update(change)

    val live: Boolean get() = _ui.value.phase.let { it != Phase.OFF && it != Phase.ENDED }

    /** [tapped]: the car's way, one press per turn. What you say while the socket
     *  opens is kept for the turn you pressed for. */
    fun start(captions: Boolean = true, tapped: Boolean = false) = ticker.run {
        _ui.value = TalkUi(phase = Phase.STARTING, captions = captions, startedAt = ticker.now(), turnMode = if (tapped) "tap" else "hands_free")
        client.sendEarly = tapped
        noteTrail()
        client.start()
    }

    // ------------------------------------------------------------ the server
    private fun event(ev: TalkEvent) {
        when (ev) {
            is TalkEvent.Ready -> {
                set {
                    copy(
                        phase = Phase.LIVE,
                        turnMode = ev.turnMode,
                        interruptMode = ev.interruptMode,
                        problem = null,
                        notice = if (phase == Phase.RECONNECTING && !ev.resumed) "Reconnected. Say that again?" else null,
                    )
                }
                client.handsFree = ev.turnMode == "hands_free"
                // Picked up again while paused for a call: keep it quiet.
                if (_ui.value.paused || _ui.value.muted) client.send(JSONObject().put("type", "mute"))
            }
            is TalkEvent.State -> {
                val was = _ui.value.state
                set { copy(state = ev.state, muted = if (mutedForYield) muted else ev.muted, tool = if (ev.state == "listening") null else tool) }
                if (ev.state == "thinking" && was != "thinking") replyComing()
                if (ev.state == "listening") awaitingSound = false
                noteTrail()
                watcher?.state(ev.state)
            }
            is TalkEvent.Partial -> {
                set {
                    val last = exchanges.lastOrNull()
                    if (last != null && !last.youFinal) copy(exchanges = exchanges.dropLast(1) + last.copy(you = ev.text))
                    else copy(exchanges = (exchanges + Exchange(++keys, you = ev.text)).takeLast(MAX_EXCHANGES))
                }
                if (ev.text.isNotBlank()) watcher?.words()
            }
            is TalkEvent.Heard -> {
                replyComing()
                set {
                    var list = exchanges
                    val same = ev.messageId?.let { id -> list.indexOfFirst { it.messageId == id } } ?: -1
                    list = if (same >= 0) {
                        // More of the same turn: one turn, one answer.
                        list.take(same) + list[same].copy(you = ev.text, youFinal = true, reply = "", spoken = 0, replyDone = false)
                    } else {
                        val last = list.lastOrNull()
                        // A partial settling, or what you typed coming back as heard: the same turn.
                        val same = last != null && last.reply.isEmpty() && (!last.youFinal || (last.typed && last.messageId == null))
                        if (same) list.dropLast(1) + last!!.copy(you = ev.text, youFinal = true, messageId = ev.messageId)
                        else list + Exchange(++keys, you = ev.text, youFinal = true, messageId = ev.messageId)
                    }
                    copy(exchanges = list.takeLast(MAX_EXCHANGES), notice = null)
                }
            }
            is TalkEvent.Reply -> set {
                val last = exchanges.lastOrNull()
                if (last == null || last.replyDone || last.interrupted) {
                    if (last != null && last.replyDone && !last.interrupted && last.reply == ev.text) this
                    else copy(exchanges = (exchanges + Exchange(++keys, youFinal = true, reply = ev.text, replyDone = ev.done)).takeLast(MAX_EXCHANGES))
                } else {
                    copy(exchanges = exchanges.dropLast(1) + last.copy(reply = ev.text, replyDone = ev.done, youFinal = true))
                }
            }
            is TalkEvent.Spoken -> set {
                val last = exchanges.lastOrNull() ?: return@set this
                copy(exchanges = exchanges.dropLast(1) + last.copy(spoken = ev.chars))
            }
            is TalkEvent.Tool -> set { copy(tool = ev.label.ifBlank { null }) }
            is TalkEvent.Card -> {
                val meta = ev.meta
                val title = meta.optString("title").ifBlank { meta.optString("summary") }.ifBlank { cardLabel(ev.kind, meta) }
                val url = meta.optString("url").takeIf { it.isNotBlank() }
                set { copy(cards = (cards + TalkCard(++keys, ev.kind, title.take(120), url)).takeLast(4)) }
            }
            is TalkEvent.Ask -> {
                val ttl = ev.expiresIn * 1000L
                // The server's clock starts once the question has been said; give the
                // card the same window from when it's shown.
                val ask = PendingAsk(ev.question, ev.approvalId, ticker.now() + ttl + 3000, ttl)
                set { copy(ask = ask) }
                cancelAskTimer?.invoke()
                cancelAskTimer = ticker.after(ttl + 3000) {
                    set { if (this.ask?.approvalId == ask.approvalId) copy(ask = null) else this }
                }
                watcher?.asked(ev.listenS)
            }
            is TalkEvent.AskDone -> {
                set { copy(ask = if (ask?.approvalId == ev.approvalId) null else ask) }
                watcher?.askDone()
            }
            is TalkEvent.Action -> {
                val problem = runCatching { actions.carry(ev.action) }.getOrElse { "This phone couldn't do that." }
                if (problem != null) set { copy(notice = problem) }
            }
            TalkEvent.StopAudio -> {
                speaker.stop()
                awaitingSound = false
                set {
                    val last = exchanges.lastOrNull()
                    if (last != null && last.reply.isNotEmpty() && !last.interrupted) {
                        copy(exchanges = exchanges.dropLast(1) + last.copy(interrupted = true, replyDone = true))
                    } else this
                }
            }
            is TalkEvent.Error -> set {
                copy(notice = ev.show ?: ev.say ?: "Something went wrong.", ask = if (ev.code == "nothing_to_confirm") null else ask)
            }
            is TalkEvent.Bye -> set { copy(endReason = ev.reason) }
            is TalkEvent.Pong, is TalkEvent.Unknown -> Unit
        }
    }

    private fun cardLabel(kind: String, meta: JSONObject): String = when {
        meta.has("map_card") || meta.optBoolean("map") -> "Map"
        meta.has("photos") -> "Photos"
        meta.has("count") -> "${meta.optInt("count")} results"
        else -> kind.replace('_', ' ').replaceFirstChar { it.uppercase() }
    }

    private fun replyComing() {
        if (!awaitingSound) {
            awaitingSound = true
            speaker.startReply()
        }
    }

    private fun finished(problem: TalkProblem?) {
        cancelAskTimer?.invoke()
        val reason = _ui.value.endReason
        if (reason == "goodbye" || reason == "idle") speaker.endTone()
        speaker.stop()
        set { copy(phase = Phase.ENDED, problem = problem, ask = null, tool = null, talking = false, hearing = false, endReason = reason ?: if (problem != null) "error" else "bye") }
        trail.note("ended", _ui.value.startedAt)
        watcher?.finished()
        onFinished?.invoke()
    }

    private fun noteTrail() {
        val s = _ui.value
        val state = when {
            s.phase == Phase.STARTING -> "starting"
            s.phase == Phase.RECONNECTING -> "reconnecting"
            s.phase == Phase.ENDED -> "ended"
            s.paused -> "paused"
            s.muted -> "muted"
            else -> s.state
        }
        trail.note(state, s.startedAt)
    }

    // ------------------------------------------------------------ the microphone
    /** 20 ms of microphone (16 kHz PCM16) and its level (RMS, 0..1). */
    fun mic(pcm: ByteArray, level: Double) = ticker.run {
        val s = _ui.value
        if (s.phase == Phase.ENDED || s.phase == Phase.OFF) return@run
        val now = ticker.now()
        val quietHere = s.muted || s.paused
        val loud = level > SPEECH_RMS && !quietHere
        if (loud) {
            lastVoiceAt = now
            loudFrames++
        } else {
            loudFrames = 0
        }
        if (loud != s.hearing) set { copy(hearing = loud) }
        // Talking over it: quieter at once; the server decides whether it stops.
        if (speaker.playing && s.interruptMode == "talk" && s.turnMode == "hands_free" && loudFrames >= DUCK_FRAMES && duckedAt == null) {
            speaker.duck()
            duckedAt = now
        }
        if (duckedAt != null && now - lastVoiceAt > UNDUCK_MS) {
            speaker.unduck()
            duckedAt = null
        }
        if (quietHere) return@run
        if (s.turnMode == "tap" && !s.talking) return@run
        client.audio(pcm)
    }

    /** The speaker started or ran out. */
    fun playing(now: Boolean) = ticker.run {
        if (now) awaitingSound = false
        if (!now && duckedAt != null) {
            speaker.unduck()
            duckedAt = null
        }
        watcher?.playing(now)
    }

    /** The car's microphone opened ([on]) or closed. Closing it with [flush] tells the
     *  server you've finished, so whatever you said is answered now. Works while the
     *  socket is still opening: those words are kept for this turn. */
    fun listen(on: Boolean, flush: Boolean = false) = ticker.run {
        val s = _ui.value
        if (s.phase == Phase.ENDED || s.phase == Phase.OFF) return@run
        if (on) {
            if (s.muted) unmute()
            set { copy(talking = true) }
        } else {
            set { copy(talking = false, hearing = false) }
            if (flush) {
                replyComing()
                client.send(JSONObject().put("type", "end_turn"))
            }
        }
    }

    /** Where the trip is now (the car, before each turn). */
    fun trip(trip: JSONObject) = ticker.run { client.send(TalkProtocol.trip(trip)) }

    // ------------------------------------------------------------ buttons
    /** Stop it talking (what you heard stays in the conversation). */
    fun interrupt() = ticker.run {
        val played = speaker.stop()
        client.send(JSONObject().put("type", "interrupt").apply { played?.let { put("played_ms", it) } })
    }

    /** Stop: interrupts while it talks or thinks, otherwise ends. */
    fun stop() = ticker.run {
        val s = _ui.value
        if (s.state == "speaking" || s.state == "thinking" || speaker.playing) interrupt() else end()
    }

    fun mute() = ticker.run {
        mutedForYield = false
        client.send(JSONObject().put("type", "mute"))
        set { copy(muted = true, talking = false) }
        noteTrail()
    }

    fun unmute() = ticker.run {
        mutedForYield = false
        if (_ui.value.paused) set { copy(paused = false) }
        client.send(JSONObject().put("type", "unmute"))
        set { copy(muted = false) }
        noteTrail()
    }

    fun toggleMute() = ticker.run { if (_ui.value.muted || _ui.value.paused) unmute() else mute() }

    /** A headset's button: stop it talking, or else mute / unmute. */
    fun headset() = ticker.run {
        val s = _ui.value
        if (!live) return@run
        if (s.turnMode == "tap" && !s.muted) {
            if (s.talking) releaseTalk() else pressTalk()
            return@run
        }
        if (speaker.playing || s.state == "speaking") interrupt() else toggleMute()
    }

    /** Tap to talk: your turn starts. */
    fun pressTalk() = ticker.run {
        val s = _ui.value
        if (s.turnMode != "tap" || s.talking || s.phase != Phase.LIVE) return@run
        if (s.muted) unmute()
        if (s.state == "speaking" || s.state == "thinking") interrupt()
        set { copy(talking = true) }
    }

    /** Tap to talk: you've finished. */
    fun releaseTalk() = ticker.run {
        if (!_ui.value.talking) return@run
        set { copy(talking = false) }
        replyComing()
        client.send(JSONObject().put("type", "end_turn"))
    }

    /** Type instead. */
    fun text(words: String) = ticker.run {
        val t = words.trim()
        if (t.isEmpty() || !live) return@run
        set { copy(exchanges = (exchanges + Exchange(++keys, you = t, youFinal = true, typed = true)).takeLast(MAX_EXCHANGES)) }
        if (speaker.playing) interrupt()
        replyComing()
        client.send(JSONObject().put("type", "text").put("words", t))
    }

    /** The Yes / No buttons: the same as saying it. */
    fun confirm(yes: Boolean) = ticker.run {
        val ask = _ui.value.ask ?: return@run
        cancelAskTimer?.invoke()
        client.send(JSONObject().put("type", "confirm").put("answer", if (yes) "yes" else "no"))
        set {
            copy(
                ask = null,
                exchanges = (exchanges + Exchange(++keys, you = if (yes) "Yes" else "No", youFinal = true, typed = true)).takeLast(MAX_EXCHANGES),
            )
        }
        if (ask.approvalId.isNotEmpty()) replyComing()
    }

    fun captions(on: Boolean) = set { copy(captions = on) }

    fun clearNotice() = set { copy(notice = null) }

    /** A call is ringing or another app took the audio: stop talking and listening,
     *  and say nothing. [resume] picks it up again when the audio comes back. */
    fun yieldAudio() = ticker.run {
        val s = _ui.value
        if (!live || s.paused) return@run
        if (speaker.playing || s.state == "speaking" || s.state == "thinking") interrupt()
        if (!s.muted) {
            mutedForYield = true
            client.send(JSONObject().put("type", "mute"))
        }
        set { copy(paused = true, talking = false, hearing = false) }
        noteTrail()
    }

    fun resume() = ticker.run {
        val s = _ui.value
        if (!live || !s.paused) return@run
        set { copy(paused = false) }
        if (mutedForYield) {
            mutedForYield = false
            client.send(JSONObject().put("type", "unmute"))
            set { copy(muted = false) }
        }
        noteTrail()
    }

    fun end() = ticker.run {
        if (!live) return@run
        client.end()
    }

    companion object {
        /** Level (RMS of a frame, 0..1) that counts as you talking. */
        const val SPEECH_RMS = 0.03
        /** Talking over it this many frames (20 ms each) ducks it. */
        const val DUCK_FRAMES = 3
        const val UNDUCK_MS = 1500L
        const val MAX_EXCHANGES = 20
    }
}
