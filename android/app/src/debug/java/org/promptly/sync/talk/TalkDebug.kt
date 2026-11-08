package org.promptly.sync.talk

import android.content.Context
import java.io.File
import java.io.RandomAccessFile

/** Debug builds only (src/release has the empty twin). The emulator's microphone is
 *  silent, so a test speaks to Talk with files: once the app's `files/talk-inject`
 *  folder exists, Talk listens to it instead of the microphone. Each 16 kHz mono
 *  PCM16 WAV dropped in is "said" once, in real time, then deleted; silence between.
 *  `adb shell run-as org.promptly.app mkdir -p files/talk-inject`, then
 *  `adb shell run-as org.promptly.app cp /data/local/tmp/q.wav files/talk-inject/`. */
object TalkDebug {
    fun mic(context: Context): MicSource? {
        val dir = File(context.filesDir, "talk-inject")
        return if (dir.isDirectory) FileMic(dir) else null
    }

    private class FileMic(private val dir: File) : MicSource {
        private var file: File? = null
        private var raf: RandomAccessFile? = null
        private var next = System.nanoTime()
        private val bytes = ByteArray(TalkProtocol.MIC_FRAME_BYTES)
        @Volatile private var open = true

        override fun read(into: ShortArray): Int {
            if (!open) return -1
            // Real time: one frame every 20 ms, like a microphone.
            next += into.size * 1_000_000_000L / TalkProtocol.MIC_RATE
            val wait = (next - System.nanoTime()) / 1_000_000
            if (wait > 0) Thread.sleep(wait) else if (wait < -200) next = System.nanoTime()
            into.fill(0)
            val r = raf ?: start() ?: return into.size
            val want = minOf(bytes.size, into.size * 2)
            val got = r.read(bytes, 0, want)
            if (got <= 0) {
                finish()
                return into.size
            }
            for (i in 0 until got / 2) into[i] = ((bytes[i * 2 + 1].toInt() shl 8) or (bytes[i * 2].toInt() and 0xFF)).toShort()
            return into.size
        }

        private fun start(): RandomAccessFile? {
            val f = dir.listFiles { x -> x.name.endsWith(".wav") }?.minByOrNull { it.name } ?: return null
            // Give the copy a moment to finish landing.
            if (System.currentTimeMillis() - f.lastModified() < 300) return null
            return runCatching {
                val r = RandomAccessFile(f, "r")
                r.seek(dataStart(r))
                file = f
                raf = r
                r
            }.getOrNull()
        }

        /** Where the samples start: after the "data" chunk header. */
        private fun dataStart(r: RandomAccessFile): Long {
            r.seek(12)
            val head = ByteArray(8)
            while (r.filePointer + 8 <= r.length()) {
                r.readFully(head)
                val id = String(head, 0, 4, Charsets.US_ASCII)
                val size = (head[4].toLong() and 0xFF) or ((head[5].toLong() and 0xFF) shl 8) or ((head[6].toLong() and 0xFF) shl 16) or ((head[7].toLong() and 0xFF) shl 24)
                if (id == "data") return r.filePointer
                r.seek(r.filePointer + size + (size and 1))
            }
            return 44
        }

        private fun finish() {
            runCatching { raf?.close() }
            file?.delete()
            raf = null
            file = null
        }

        override fun close() {
            open = false
            // Said (or cut off) in this conversation: not again in the next.
            finish()
        }
    }
}
