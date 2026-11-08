package org.promptly.sync.assistant

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import org.promptly.sync.Api
import org.promptly.sync.BuildConfig
import org.promptly.sync.maps.Maps
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.concurrent.thread
import kotlin.math.abs

/** What went wrong, for your server's admin to see under Admin, Console. A crashed
 *  app can't send anything, so it's sent the next time the app runs. Android keeps
 *  a short list of why this app stopped; our own record adds the full stack for
 *  crashes in Kotlin. It holds what the code was doing, not your data. */
object Crashes {
    private const val TAG = "PromptlyCrash"
    private const val DIR = "crashes"
    private const val PREFS = "crash_reports"
    private const val SENT = "sent_up_to"
    private const val KEEP = 10
    private const val MOST = 20
    private const val STACK_CHARS = 30_000
    private val SIGNAL = Regex("SIG[A-Z]{2,7}")
    private val LIBRARY = Regex("[\\w.+-]+\\.so")
    private val WORDS = Regex("[\\x20-\\x7e]{4,}")

    data class Report(val key: String, val at: Long, val kind: String, val thread: String, val message: String, val stack: String)

    /** Call once, when the app starts. */
    fun watch(context: Context) {
        val app = context.applicationContext
        VoiceTrail.init(app)
        val before = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching {
                val dir = File(app.filesDir, DIR).apply { mkdirs() }
                File(dir, "${System.currentTimeMillis()}.txt").writeText("${thread.name}\n${error.stackTraceToString()}".take(STACK_CHARS))
                dir.listFiles()?.sortedByDescending { it.name }?.drop(KEEP)?.forEach { it.delete() }
            }
            before?.uncaughtException(thread, error)
        }
        // Whatever stopped it last time. Not on the way in: starting up comes first.
        thread(name = "crash-reports") {
            runCatching {
                Thread.sleep(5_000)
                send(app)
            }.onFailure { Log.i(TAG, "Crash reports wait for next time: ${it.javaClass.simpleName}") }
        }
    }

    /** Newest first. */
    fun reports(context: Context): List<Report> {
        val ours = runCatching {
            File(context.filesDir, DIR).listFiles().orEmpty().mapNotNull { file ->
                val at = file.nameWithoutExtension.toLongOrNull() ?: return@mapNotNull null
                val lines = file.readText().split("\n", limit = 2)
                val stack = lines.getOrElse(1) { "" }
                Report("kotlin-$at", at, "crash", lines[0], stack.lineSequence().first(), stack)
            }
        }.getOrDefault(emptyList())
        val system = if (Build.VERSION.SDK_INT >= 30) fromAndroid(context) else emptyList()
        // Android's record of a crash we caught ourselves says less about the same thing.
        // Its time is when the process went, which an "app has stopped" dialog can hold
        // up for 20 s or more after the crash (seen on the emulator).
        val extra = system.filter { row -> row.kind != "crash" || ours.none { abs(it.at - row.at) < 60_000 } }
        // What voice was doing at the time (the car crash is still not root-caused).
        val trail = VoiceTrail.marks(context)
        return (ours + extra).map { r ->
            val voice = VoiceTrail.describe(trail, r.at) ?: return@map r
            r.copy(stack = if (r.stack.isEmpty()) voice else "${r.stack.take(STACK_CHARS - 300)}\n\n$voice")
        }.sortedByDescending { it.at }
    }

    private fun fromAndroid(context: Context): List<Report> {
        val rows = runCatching {
            context.getSystemService(ActivityManager::class.java).getHistoricalProcessExitReasons(context.packageName, 0, 16)
        }.getOrDefault(emptyList())
        return rows.mapNotNull { row ->
            val kind = when (row.reason) {
                ApplicationExitInfo.REASON_CRASH -> "crash"
                ApplicationExitInfo.REASON_CRASH_NATIVE -> "native"
                ApplicationExitInfo.REASON_ANR -> "anr"
                // Being cleared from the background is normal. Not while you were using it.
                ApplicationExitInfo.REASON_LOW_MEMORY -> if (row.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE) "memory" else return@mapNotNull null
                ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "startup"
                else -> return@mapNotNull null
            }
            val trace = if (kind == "native" || kind == "anr") traceOf(row) else ""
            val message = when (kind) {
                "native" -> nativeSummary(trace)
                "anr" -> row.description.orEmpty().ifEmpty { "The app stopped responding" }
                else -> row.description.orEmpty().takeUnless { it == "crash" }.orEmpty()
            }
            Report("exit-${row.timestamp}-${row.pid}", row.timestamp, kind, "", message, trace)
        }
    }

    /** A stopped-responding trace is text. A native one is a binary record, whose
     *  readable parts include the signal and the libraries on the stack. */
    private fun traceOf(row: ApplicationExitInfo): String = runCatching {
        val bytes = row.traceInputStream?.use { it.readBytes() } ?: return@runCatching ""
        val text = String(bytes, Charsets.ISO_8859_1)
        if (row.reason == ApplicationExitInfo.REASON_ANR) {
            text.take(STACK_CHARS)
        } else {
            WORDS.findAll(text).map { it.value }.filter { it.contains(".so") || SIGNAL.containsMatchIn(it) || it.contains("Abort") }
                .distinct().joinToString("\n").take(STACK_CHARS)
        }
    }.getOrDefault("")

    /** "SIGSEGV in libonnxruntime.so": our own libraries before the system's. */
    internal fun nativeSummary(trace: String): String {
        val signal = SIGNAL.find(trace)?.value
        val lines = trace.lineSequence().filter { ".so" in it }.toList()
        val line = lines.firstOrNull { "/data/app" in it } ?: lines.firstOrNull()
        val library = line?.let { LIBRARY.find(it)?.value }
        return when {
            signal != null && library != null -> "$signal in $library"
            library != null -> "Native crash in $library"
            else -> signal ?: ""
        }
    }

    /** Off the main thread. Only marked as sent once your server has it. */
    fun send(context: Context) {
        if (Maps.server(context) == null) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val after = prefs.getLong(SENT, 0L)
        val waiting = reports(context).filter { it.at > after }.take(MOST)
        if (waiting.isEmpty()) return
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }
        val rows = JSONArray()
        waiting.forEach { r ->
            rows.put(
                JSONObject().put("key", r.key.take(64)).put("at", iso.format(Date(r.at))).put("kind", r.kind)
                    .put("thread", r.thread.take(120)).put("message", r.message.take(2000)).put("stack", r.stack.take(STACK_CHARS)),
            )
        }
        val body = JSONObject().put("app_version", BuildConfig.VERSION_NAME).put("device", Api.deviceName().take(120))
            .put("android", Build.VERSION.RELEASE.orEmpty().take(20)).put("reports", rows)
        Maps.send(context, "POST", "/api/devices/crashes", body)
        prefs.edit().putLong(SENT, waiting.maxOf { it.at }).apply()
    }

    /** For the phone's own settings screen. */
    fun recent(context: Context): List<String> = reports(context).map { r ->
        val kind = when (r.kind) {
            "native" -> "Native crash"
            "anr" -> "Stopped responding"
            "memory" -> "Out of memory"
            "startup" -> "Failed to start"
            else -> "Crash"
        }
        "$kind: ${stamp(r.at)}${if (r.message.isNotEmpty()) "\n${r.message}" else ""}${if (r.stack.isNotEmpty() && r.stack != r.message) "\n${r.stack}" else ""}"
    }

    private fun stamp(at: Long) = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).format(Date(at))
}
