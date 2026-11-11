package org.promptly.sync.talk

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.car.app.CarContext
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.Credentials
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import org.promptly.sync.Store
import org.promptly.sync.assistant.PhoneActions
import org.promptly.sync.assistant.VoiceTrail
import org.promptly.sync.maps.Nav
import org.promptly.sync.maps.Voice
import java.io.IOException
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** Talk in the car (Talk phase 2, WP-T8): the car screen's microphone button and P
 *  Maps' driving-screen pill, on the same Talk engine as the phone, so the car gets
 *  the voice tools, the read-back and the strict yes.
 *
 *  **One press, one turn** ([CarTurn]): nothing listens on its own, no wake word. The
 *  conversation stays open for the server's two quiet minutes, so the next press can
 *  say "and Friday?"; then it lapses. Nothing is saved (a phone conversation).
 *
 *  The answer plays on the car's guidance channel with the music ducked, and waits
 *  while a direction is being said or a turn is under 200 m away ([Nav.promptPlaying],
 *  [Nav.metresToTurn]). A question shows as the car's Yes / No alert ([question]).
 *  The screens follow [Voice.state] (the microphone icon, the pill) and [Voice.reply]
 *  (the answer's first line as a toast). The breadcrumb path is `cartalk`.
 *
 *  A server without Talk (`/api/talk` is 404, or Talk is off for you) gets the old
 *  one-question path ([oneShot]). */
object CarTalk {
    private const val TAG = "PromptlyCarTalk"

    /** A question on the car's screen: [id] is its approval id. */
    data class Question(val id: String, val text: String)

    private val _question = MutableStateFlow<Question?>(null)
    val question: StateFlow<Question?> = _question.asStateFlow()

    private class Live(
        val core: TalkCore,
        val turn: CarTurn,
        val ticker: ExecutorTicker,
        val speaker: PhoneSpeaker,
        val mic: CarMic,
        val focus: GuidanceFocus,
        val car: Boolean,
    )

    @Volatile private var current: Live? = null
    @Volatile private var starting = false
    private var mirror: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val main = Handler(Looper.getMainLooper())
    /** Whether this server has Talk for you, once asked (asked again after a restart). */
    @Volatile private var hasTalk: Boolean? = null
    private var since = 0L

    val live: Boolean get() = current != null || starting

    /** The microphone button. [car]: pressed on the car's screen (its microphone);
     *  null: the phone on the dash. [oneShot]: what to do instead on a server
     *  without Talk. Returns a short line to show when nothing could start. */
    fun press(context: Context, car: CarContext?, oneShot: () -> Unit): String? {
        val app = context.applicationContext
        // Talk needs your server: with no signal, say so (offline), and don't listen.
        if (!org.promptly.sync.maps.offline.Offline.online(app)) {
            Voice.press(app)
            return null
        }
        if (ContextCompat.checkSelfPermission(app, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return "Allow the microphone on your phone first"
        }
        current?.let { live ->
            if (live.car == (car != null)) {
                Nav.tripForTalk()?.let { live.core.trip(it) }
                live.turn.press()
                return null
            }
            // From the car to the dash or back: start afresh there.
            live.core.end()
        }
        if (hasTalk == false) {
            oneShot()
            return null
        }
        synchronized(this) {
            if (starting) return null
            starting = true
        }
        thread(name = "car-talk-start") {
            try {
                when (check(app)) {
                    true -> main.post { begin(app, car) }
                    false -> main.post(oneShot)
                    null -> main.post { Voice.showReply("Couldn't reach your server.") }
                }
            } finally {
                starting = false
            }
        }
        return null
    }

    /** Does this server have Talk for you? Null: couldn't ask. */
    private fun check(app: Context): Boolean? {
        hasTalk?.let { return it }
        val account = Store(app).account ?: return false
        val http = OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS).build()
        return try {
            http.newCall(
                Request.Builder().url("${account.server}/api/talk/config").header("Authorization", Credentials.basic(account.username, account.password)).build(),
            ).execute().use { r ->
                when {
                    r.code == 404 -> false.also { hasTalk = false }
                    !r.isSuccessful -> null
                    else -> JSONObject(r.body.string()).optBoolean("enabled", false)
                }
            }
        } catch (e: IOException) {
            null
        }
    }

    private fun begin(app: Context, car: CarContext?) {
        val account = Store(app).account ?: return
        val auth = Credentials.basic(account.username, account.password)
        val http = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
        val tick = ExecutorTicker()
        lateinit var core: TalkCore
        lateinit var turn: CarTurn
        lateinit var focus: GuidanceFocus
        val speaker = PhoneSpeaker(PlaybackRoute.GUIDANCE, tones = false) { playing ->
            if (playing) focus.take() else main.postDelayed({ if (current?.speaker?.playing != true) focus.give() }, 300)
            core.playing(playing)
        }
        speaker.hold = { Nav.promptPlaying() || (Nav.metresToTurn()?.let { it < NEAR_TURN_M } ?: false) }
        focus = GuidanceFocus(app) { turn.audioLost() }
        val mic = CarMic(
            app, car,
            sink = { pcm, level -> core.mic(pcm, level) },
            gone = { turn.micGone() },
            lost = { turn.audioLost() },
        )
        since = System.currentTimeMillis()
        core = TalkCore(
            ticker = tick,
            speaker = speaker,
            actions = ActionSink { action -> PhoneActions.carry(app, action) },
            trail = Trail { state, _ -> VoiceTrail.note(TRAIL, state, since) },
            opener = OkHttpOpener(http, account.server, auth),
            hello = { TalkProtocol.carHello(TimeZone.getDefault().id, Locale.getDefault().toLanguageTag(), Nav.tripForTalk()) },
        )
        turn = CarTurn(tick, core, mic, GuidanceTones()) { said -> Voice.showReply(said) }
        core.watcher = turn
        turn.onMic = { m -> main.post { Voice.setState(if (m == CarTurn.Mic.CLOSED) Voice.State.OFF else Voice.State.HEARD) } }
        val live = Live(core, turn, tick, speaker, mic, focus, car != null)
        core.onFinished = { main.post { teardown(live) } }
        current = live
        if (car != null) Voice.inCar = true
        mirror?.cancel()
        var shown: Int? = null
        mirror = scope.launch {
            core.ui.collect { ui ->
                if (current !== live) return@collect
                // The microphone icon: thinking while it works out the answer.
                val thinking = ui.state == "thinking" && turn.mic == CarTurn.Mic.CLOSED
                main.post {
                    if (turn.mic == CarTurn.Mic.CLOSED) Voice.setState(if (thinking) Voice.State.THINKING else Voice.State.OFF)
                }
                // The answer's first line, once, on the screen.
                val last = ui.exchanges.lastOrNull()
                if (last != null && last.replyDone && !last.interrupted && last.reply.isNotBlank() && shown != last.key) {
                    shown = last.key
                    val line = last.reply.split(Regex("(?<=[.!?])\\s+")).first().take(120)
                    main.post { Voice.showReply(line) }
                }
                ui.notice?.let { n -> main.post { Voice.showReply(n.take(120)) }; core.clearNotice() }
                _question.value = ui.ask?.let { Question(it.approvalId, it.question) }
            }
        }
        core.start(captions = false, tapped = true)
        turn.press()
    }

    private fun teardown(which: Live) {
        synchronized(this) {
            if (current !== which) return
            current = null
        }
        mirror?.cancel()
        mirror = null
        _question.value = null
        which.mic.close()
        which.focus.give()
        Voice.setState(Voice.State.OFF)
        thread(name = "car-talk-close") {
            Thread.sleep(300)
            which.speaker.close()
            which.ticker.shutdown()
        }
        VoiceTrail.note(TRAIL, "ended", since)
    }

    /** The Yes / No on the car's alert: the same as saying it. */
    fun confirm(yes: Boolean) {
        current?.core?.confirm(yes)
        _question.value = null
    }

    /** The car's screen went away: the conversation ends. */
    fun carGone() {
        current?.takeIf { it.car }?.core?.end()
    }

    /** Server came back with Talk (after an upgrade): ask again next time. */
    fun forget() {
        hasTalk = null
    }

    private const val TRAIL = "cartalk"
    /** The answer waits while a turn is closer than this. */
    const val NEAR_TURN_M = 200.0

    internal fun log(msg: String) = Log.i(TAG, msg)
}
