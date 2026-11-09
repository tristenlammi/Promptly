package org.promptly.sync.talk

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
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
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import org.promptly.sync.Store
import org.promptly.sync.assistant.PhoneActions
import org.promptly.sync.assistant.VoiceTrail
import org.promptly.sync.maps.Voice
import java.io.IOException
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** Talk on the phone (Voice Phase 3, WP-T5): a spoken conversation with your server
 *  over `/api/talk/ws`, started from the assistant sheet (gesture, Quick Settings
 *  tile, the icon's Talk shortcut). It keeps going when the screen locks, with Mute
 *  and End on the lock-screen notification ([TalkService]). Nothing is saved: the
 *  server keeps a hidden conversation only while it lasts. The microphone opens
 *  only when you start one, and closes when it ends. */
object Talk {
    private const val TAG = "PromptlyTalk"
    private const val PREFS = "talk"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val _ui = MutableStateFlow(TalkUi())
    val ui: StateFlow<TalkUi> = _ui.asStateFlow()

    /** One conversation and everything it holds, let go of together. */
    private class Live(val core: TalkCore, val ticker: ExecutorTicker, val speaker: PhoneSpeaker, val route: AudioRoute, val mic: MicSource)

    @Volatile private var current: Live? = null
    private val core: TalkCore? get() = current?.core
    private var mirror: Job? = null
    @Volatile private var starting = false

    /** A conversation is on, or still letting go of the microphone. */
    val live: Boolean get() = _ui.value.phase.let { it != Phase.OFF && it != Phase.ENDED } || starting || current != null

    // ------------------------------------------------------------ settings
    /** Tap to talk on this phone (WP-T14: what the old "Hands-free conversations"
     *  switch became). Off: the account's own choice (hands-free by default). The
     *  one-question-at-a-time sheet is only the fallback now, for a server
     *  without Talk. */
    fun tapToTalk(context: Context): Boolean = prefs(context).getBoolean("tap", false)

    fun setTapToTalk(context: Context, on: Boolean) = prefs(context).edit().putBoolean("tap", on).apply()

    /** Account -> Voice: may a Bluetooth button start Talk while the phone is locked?
     *  Remembered from the server each time Talk starts (WP-T13; off by default). */
    fun bluetoothLocked(context: Context): Boolean = prefs(context).getBoolean("bt_locked", false)

    fun playbackRoute(context: Context): PlaybackRoute =
        if (prefs(context).getString("route", "call") == "assistant") PlaybackRoute.ASSISTANT else PlaybackRoute.CALL

    fun setPlaybackRoute(context: Context, route: PlaybackRoute) =
        prefs(context).edit().putString("route", if (route == PlaybackRoute.ASSISTANT) "assistant" else "call").apply()

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ------------------------------------------------------------ starting
    /** Start a conversation. Call it from the visible sheet: the microphone's
     *  foreground service may only start from there (or the tile, a notification). */
    /** [locked]: started by a car's or headset's Bluetooth button on a locked phone,
     *  which you allowed in Account -> Voice: private reads stay behind the lock. */
    fun start(context: Context, locked: Boolean = false) {
        val app = context.applicationContext
        synchronized(this) {
            if (live) return
            starting = true
        }
        _ui.value = TalkUi(phase = Phase.STARTING, startedAt = System.currentTimeMillis())
        VoiceTrail.note("talk", "starting", _ui.value.startedAt)
        thread(name = "talk-start") {
            try {
                begin(app, locked)
            } catch (e: Exception) {
                Log.w(TAG, "Talk couldn't start", e)
                failed(app, TalkProblem("failed", "Talk couldn't start.", true))
            } finally {
                starting = false
            }
        }
    }

    private fun begin(app: Context, locked: Boolean) {
        val account = Store(app).account
        if (account == null) {
            failed(app, TalkProblem("not_linked", "Link this phone to your Promptly first.", false))
            return
        }
        val auth = Credentials.basic(account.username, account.password)
        val http = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()

        // What the server says about Talk for you.
        val config = try {
            http.newBuilder().readTimeout(10, TimeUnit.SECONDS).build()
                .newCall(Request.Builder().url("${account.server}/api/talk/config").header("Authorization", auth).build())
                .execute().use { r ->
                    when {
                        r.code == 404 -> return failed(app, TalkProblem("no_talk", "Your server doesn't have live Talk yet.", true))
                        r.code == 401 || r.code == 403 -> return failed(app, TalkProblem("not_signed_in", "This phone needs linking to your Promptly again.", false))
                        !r.isSuccessful -> throw IOException("Server said ${r.code}")
                        else -> JSONObject(r.body.string())
                    }
                }
        } catch (e: IOException) {
            failed(app, TalkProblem("offline", "Couldn't reach your server.", true))
            return
        }
        if (!config.optBoolean("enabled", false)) {
            failed(app, TalkProblem("talk_off", config.optString("reason").ifBlank { "Talk isn't turned on for your account." }, true))
            return
        }
        val captions = config.optJSONObject("prefs")?.optBoolean("captions", true) ?: true
        prefs(app).edit().putBoolean("bt_locked", config.optJSONObject("prefs")?.optBoolean("bluetooth_locked", false) ?: false).apply()

        // The phone's audio, then the microphone (call mode before a call-mode recording).
        val audio = AudioRoute(
            app, playbackRoute(app), { lost -> core?.let { if (lost) it.yieldAudio() else it.resume() } }, { Handler(Looper.getMainLooper()).post(it) },
            notice = { said -> core?.notice(said) },
            carProjection = { carConnected(app) },
        )
        audio.open()
        val source = TalkDebug.mic(app) ?: PhoneMic.open()
        if (source == null) {
            audio.close()
            failed(app, TalkProblem("mic_busy", "The microphone is busy. Another app may be using it.", false))
            return
        }

        val tick = ExecutorTicker()
        val main = Handler(Looper.getMainLooper())
        lateinit var made: TalkCore
        val out = PhoneSpeaker(playbackRoute(app)) { playing -> made.playing(playing) }
        val opener = OkHttpOpener(http, account.server, auth)
        val inCar = Voice.inCar
        made = TalkCore(
            ticker = tick,
            speaker = out,
            actions = ActionSink { action -> PhoneActions.carry(app, action, PhoneActions.locked(app)) },
            trail = Trail { state, since -> VoiceTrail.note("talk", state, since) },
            opener = opener,
            hello = {
                // From the car's screen nothing can be pressed on the phone.
                val caps = if (inCar) TalkProtocol.PHONE_CAPS.filter { it !in setOf("dial", "message", "open_app") } else TalkProtocol.PHONE_CAPS
                TalkProtocol.hello(
                    caps, TimeZone.getDefault().id, Locale.getDefault().toLanguageTag(),
                    turnMode = if (tapToTalk(app)) "tap" else null,
                    locked = locked,
                )
            },
        )
        val session = Live(made, tick, out, audio, source)
        made.onFinished = { main.post { teardown(app, session) } }
        current = session
        mirror?.cancel()
        // Its first (empty) state is skipped: this one already says "starting".
        mirror = scope.launch { made.ui.collect { if (it.phase != Phase.OFF) _ui.value = it } }

        made.start(captions)
        thread(name = "talk-mic", priority = Thread.MAX_PRIORITY) {
            val frame = ShortArray(TalkProtocol.MIC_FRAME_BYTES / 2)
            while (current === session) {
                val n = runCatching { source.read(frame) }.getOrDefault(-1)
                if (n <= 0) {
                    if (current === session) Thread.sleep(20)
                    continue
                }
                val bytes = ByteArray(n * 2)
                for (i in 0 until n) {
                    bytes[i * 2] = frame[i].toInt().toByte()
                    bytes[i * 2 + 1] = (frame[i].toInt() shr 8).toByte()
                }
                made.mic(bytes, levelOf(frame, n))
            }
        }
    }

    /** Android Auto is connected (P Maps on the car's screen, or the phone in car mode). */
    fun carConnected(context: Context): Boolean =
        Voice.inCar || context.getSystemService(android.app.UiModeManager::class.java)?.currentModeType == android.content.res.Configuration.UI_MODE_TYPE_CAR

    private fun failed(app: Context, problem: TalkProblem) {
        _ui.value = _ui.value.copy(phase = Phase.ENDED, problem = problem, endReason = "error")
        VoiceTrail.note("talk", "ended", _ui.value.startedAt)
        TalkService.stop(app)
    }

    private fun teardown(app: Context, which: Live) {
        synchronized(this) {
            if (current !== which) return
            current = null
        }
        runCatching { which.mic.close() }
        which.route.close()
        // Let the end tone and the last words go before the speaker closes.
        thread(name = "talk-close") {
            Thread.sleep(400)
            which.speaker.close()
            which.ticker.shutdown()
        }
        TalkService.stop(app)
    }

    // ------------------------------------------------------------ controls
    fun end() {
        core?.end() ?: run {
            if (_ui.value.phase != Phase.OFF) _ui.value = _ui.value.copy(phase = Phase.ENDED)
        }
    }

    fun stop() = core?.stop()
    fun interrupt() = core?.interrupt()
    fun toggleMute() {
        if (_ui.value.paused || _ui.value.muted) current?.let { it.route.regain() }
        core?.toggleMute()
    }
    fun headset() = core?.headset()
    fun confirm(yes: Boolean) = core?.confirm(yes)
    fun text(words: String) = core?.text(words)
    fun pressTalk() = core?.pressTalk()
    fun releaseTalk() = core?.releaseTalk()
    fun captions(on: Boolean) = core?.captions(on)
    fun clearNotice() = core?.clearNotice()

    /** The sheet has shown an ended conversation: back to nothing. */
    fun dismissEnded() {
        if (_ui.value.phase == Phase.ENDED) _ui.value = TalkUi()
    }
}

/** One thread for everything a conversation does, and its timers. */
class ExecutorTicker : Ticker {
    private val exec: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "talk").apply { isDaemon = true } }

    override fun now(): Long = System.currentTimeMillis()

    override fun run(job: () -> Unit) {
        if (exec.isShutdown) return
        runCatching {
            exec.execute {
                try {
                    job()
                } catch (e: Exception) {
                    Log.w("PromptlyTalk", "Talk step failed", e)
                }
            }
        }
    }

    override fun after(ms: Long, job: () -> Unit): () -> Unit {
        if (exec.isShutdown) return {}
        val f = runCatching { exec.schedule({ runCatching(job) }, ms, TimeUnit.MILLISECONDS) }.getOrNull()
        return { f?.cancel(false) }
    }

    fun shutdown() = exec.shutdown()
}

/** The Talk socket over OkHttp, signed in with this phone's app password. */
class OkHttpOpener(private val http: OkHttpClient, private val server: String, private val auth: String) : SocketOpener {
    override fun open(query: Map<String, String>, listener: TalkSocketListener): TalkSocket {
        val q = query.entries.joinToString("&") { (k, v) -> "$k=${java.net.URLEncoder.encode(v, "UTF-8")}" }
        val base = server.trimEnd('/').replaceFirst(Regex("^http"), "ws")
        val request = Request.Builder().url("$base/api/talk/ws${if (q.isEmpty()) "" else "?$q"}").header("Authorization", auth).build()
        val ws = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()
            override fun onMessage(webSocket: WebSocket, text: String) = listener.onText(text)
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) = listener.onBytes(bytes.toByteArray())
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                listener.onClosed(code)
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = listener.onFailure()
        })
        return object : TalkSocket {
            override fun sendText(text: String) = ws.send(text)
            override fun sendBytes(bytes: ByteArray) = ws.send(bytes.toByteString())
            override fun close(code: Int) {
                ws.close(code, null)
            }
        }
    }
}
