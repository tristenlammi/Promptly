package org.promptly.sync.assistant

import android.content.Context
import java.io.File
import java.util.concurrent.Executors

/** The voice breadcrumb for crash reports: what the assistant was doing (listening,
 *  thinking, speaking...), which path (Talk on the phone, the one-question sheet, the
 *  car), and how long the conversation had been going. A crash can't write anything,
 *  so each change is written as it happens, and [Crashes] matches a report to the
 *  last line before it. A few short lines in the app's own storage: no words, no audio. */
object VoiceTrail {
    private const val FILE = "voice_trail.txt"
    private const val KEEP = 40
    /** A crash this long after the last voice change isn't put down to voice. */
    private const val STALE_MS = 15 * 60_000L

    data class Mark(val at: Long, val path: String, val state: String, val since: Long)

    private val writer = Executors.newSingleThreadExecutor { r -> Thread(r, "voice-trail").apply { isDaemon = true } }
    private val lines = ArrayDeque<String>()
    @Volatile private var file: File? = null
    @Volatile private var last: Pair<String, String>? = null

    fun init(context: Context) {
        if (file != null) return
        val f = File(context.applicationContext.filesDir, FILE)
        file = f
        writer.execute {
            runCatching { f.takeIf { it.exists() }?.readLines()?.takeLast(KEEP)?.let { synchronized(lines) { lines.addAll(it) } } }
        }
    }

    /** [path]: "talk", "sheet" or "car". [since]: when that conversation started (0 if not known). */
    fun note(path: String, state: String, since: Long = 0L, now: Long = System.currentTimeMillis()) {
        // The same state twice in a row says nothing new.
        if (last == path to state) return
        last = path to state
        val line = line(Mark(now, path, state, since))
        val f = file ?: return
        writer.execute {
            runCatching {
                val text = synchronized(lines) {
                    lines.addLast(line)
                    while (lines.size > KEEP) lines.removeFirst()
                    lines.joinToString("\n", postfix = "\n")
                }
                f.writeText(text)
            }
        }
    }

    internal fun line(m: Mark) = "${m.at}|${m.path.filter { it.isLetterOrDigit() }}|${m.state.filter { it.isLetterOrDigit() || it == '_' }}|${m.since}"

    internal fun parse(line: String): Mark? {
        val p = line.trim().split('|')
        if (p.size != 4) return null
        return Mark(p[0].toLongOrNull() ?: return null, p[1], p[2], p[3].toLongOrNull() ?: 0L)
    }

    internal fun marks(context: Context): List<Mark> =
        runCatching { File(context.filesDir, FILE).readLines().mapNotNull(::parse) }.getOrDefault(emptyList())

    /** What voice was doing when something went wrong at [at], in words, or null if
     *  nothing was going on. */
    fun describe(marks: List<Mark>, at: Long): String? {
        val m = marks.filter { it.at <= at }.maxByOrNull { it.at } ?: return null
        if (m.state == "off" || m.state == "ended") return null
        if (at - m.at > STALE_MS) return null
        val path = when (m.path) {
            "talk" -> "Talk"
            "car" -> "car assistant"
            else -> "phone assistant"
        }
        val age = if (m.since > 0) ", conversation ${span(at - m.since)} old" else ""
        return "Voice: $path ${m.state.replace('_', ' ')}$age, last change ${span(at - m.at)} before"
    }

    private fun span(ms: Long): String {
        val s = maxOf(0L, ms / 1000)
        return if (s < 60) "${s}s" else "${s / 60}m ${s % 60}s"
    }
}
