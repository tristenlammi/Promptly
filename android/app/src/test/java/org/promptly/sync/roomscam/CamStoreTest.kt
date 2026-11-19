package org.promptly.sync.roomscam

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

@RunWith(RobolectricTestRunner::class)
@org.robolectric.annotation.Config(sdk = [34])
class CamStoreTest {
    private val ctx: Context get() = ApplicationProvider.getApplicationContext()

    private fun shot(file: File, id: String = "id-1") =
        PendingShot(id, "https://home.example", "t.t.t", file.absolutePath, "Photo.jpg", "image/jpeg", "Look, a quince tree", video = false)

    @Test fun `a shot on its way survives being written down`() {
        val f = CamStore.newFile(ctx, "jpg").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        val s = shot(f)
        CamStore.save(ctx, s)
        assertEquals(s, CamStore.load(ctx, "id-1"))
        assertNull(CamStore.load(ctx, "someone-else"))
        assertNull(PendingShot.from(org.json.JSONObject("""{"id":"x"}""")))
    }

    @Test fun `once sent nothing of it stays in the app`() {
        val f = CamStore.newFile(ctx, "jpg").apply { writeBytes(byteArrayOf(1)) }
        val s = shot(f, "id-2")
        CamStore.save(ctx, s)
        CamStore.forget(ctx, s)
        assertFalse(f.exists())
        assertNull(CamStore.load(ctx, "id-2"))
    }

    @Test fun `the sweep takes old strays and leaves what a send still needs`() {
        val day = 24 * 3600 * 1000L
        val now = System.currentTimeMillis()
        val stray = CamStore.newFile(ctx, "jpg").apply { writeBytes(byteArrayOf(1)); setLastModified(now - 2 * day) }
        val fresh = CamStore.newFile(ctx, "mp4").apply { writeBytes(byteArrayOf(1)) }
        val waiting = CamStore.newFile(ctx, "jpg").apply { writeBytes(byteArrayOf(1)); setLastModified(now - 2 * day) }
        CamStore.save(ctx, shot(waiting, "id-3"))
        CamStore.sweep(ctx, now)
        assertFalse(stray.exists())
        assertTrue(fresh.exists())
        assertTrue(waiting.exists())
        assertEquals(shot(waiting, "id-3"), CamStore.load(ctx, "id-3"))
    }

    @Test fun `a send that the file has gone from says so and stops`() {
        val gone = File(CamStore.dir(ctx), "nothing.jpg")
        val state = CamSend.send(shot(gone, "id-4"), {})
        assertTrue(state is SendState.Failed && !state.again)
    }
}
