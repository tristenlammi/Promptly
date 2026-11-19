package org.promptly.sync.roomscam

import okhttp3.Interceptor
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * A send in pieces against a real Promptly stack with resumable uploads on
 * (tusd and all). Skipped unless told where one is:
 *
 *   CAM_STACK=http://localhost:8140 CAM_TICKET=… CAM_ROOM=… gradlew :app:testServerDebugUnitTest --tests "*CamSendLiveTest*"
 *
 * The emulator's camera can't make a video big enough to need pieces, so this
 * is where that path is proven: a 60 MB file, a connection that drops part
 * of the way, a second try that carries on from where it stopped, one message.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CamSendLiveTest {
    private val stack = System.getenv("CAM_STACK").orEmpty()
    private val ticket = System.getenv("CAM_TICKET").orEmpty()
    private val room = System.getenv("CAM_ROOM").orEmpty()

    @Test fun `a long video goes in pieces, carries on after a dropped connection, and arrives once`() {
        assumeTrue(stack.isNotEmpty() && ticket.isNotEmpty() && room.isNotEmpty())
        val file = File.createTempFile("camsend", ".mp4").apply { deleteOnExit() }
        val size = 60L * 1024 * 1024
        file.outputStream().use { out ->
            val block = ByteArray(1024 * 1024) { (it * 31).toByte() }
            repeat(60) { out.write(block) }
        }
        var shot = PendingShot(
            UUID.randomUUID().toString(), stack, ticket, file.absolutePath, "Video live.mp4", "video/mp4",
            "In pieces ${UUID.randomUUID().toString().take(6)}", video = true, room = room, title = "Bob",
            maxOne = 50L * 1024 * 1024, tus = "/api/files/tus/",
        )
        var patches = 0
        val drops = Interceptor { chain ->
            if (chain.request().method == "PATCH" && ++patches == 3) throw IOException("the signal dropped")
            chain.proceed(chain.request())
        }
        val base = OkHttpClient.Builder().writeTimeout(2, TimeUnit.MINUTES).readTimeout(2, TimeUnit.MINUTES)
        val seen = mutableListOf<Float>()

        val first = CamSend.send(shot, { seen += it }, base.addInterceptor(drops).build(), remember = { shot = it })
        assertTrue("first try: $first", first is SendState.Failed && first.again)
        assertTrue("it remembers where the pieces were going", shot.location.startsWith(stack))
        assertEquals("", shot.attachment)
        val before = seen.maxOrNull() ?: 0f
        assertTrue("two pieces had gone: $before", before > 0.2f && before < 0.5f)

        seen.clear()
        val second = CamSend.send(shot, { seen += it }, OkHttpClient.Builder().writeTimeout(2, TimeUnit.MINUTES).readTimeout(2, TimeUnit.MINUTES).build(), remember = { shot = it })
        assertEquals(SendState.Sent, second)
        assertTrue("it carried on, not started again: ${seen.firstOrNull()}", (seen.firstOrNull() ?: 0f) > before)
        assertTrue(shot.attachment.isNotEmpty())

        // Its answer was lost and it's tried again: still that one message, with nothing sent twice.
        seen.clear()
        assertEquals(SendState.Sent, CamSend.send(shot, { seen += it }, OkHttpClient(), remember = { shot = it }))
        assertTrue(seen.isEmpty())
        println("CAMSEND_LIVE ok size=$size attachment=${shot.attachment} caption=${shot.caption}")
    }
}
