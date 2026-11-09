package org.promptly.sync.calls

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper
import java.util.Base64

/** What happens when Chrome hands the app a call push's notification
 *  (`Delegation` → [CallCenter]): the ring it shows, and what stops it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CallRingTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val nm get() = context.getSystemService(NotificationManager::class.java)
    private val call = "0b6f1d2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b"

    private fun token(): String {
        val e = System.currentTimeMillis() / 1000 + 120
        val body = """{"a":"call_answer","e":$e,"t":"$call","u":"11111111-2222-3333-4444-555555555555","v":0}"""
        val enc = Base64.getUrlEncoder().withoutPadding()
        return enc.encodeToString(body.toByteArray()) + "." + enc.encodeToString(ByteArray(32) { 1 })
    }

    /** Chrome's notification for a push: only title and text carry over. */
    private fun chrome(title: String, text: String): Notification =
        Notification.Builder(context, "chrome").setSmallIcon(android.R.drawable.sym_def_app_icon).setContentTitle(title).setContentText(text).build()

    /** The rings showing (the one-time "allow full screen" tip aside). */
    private fun ours(): List<Notification> = shadowOf(nm).allNotifications.filter { it.channelId != "call_tips" }

    @Before
    fun setUp() {
        // Nothing to answer on: a closed port fails fast for the background checks.
        context.getSharedPreferences("promptly", Context.MODE_PRIVATE).edit().putString("server", "http://127.0.0.1:9").commit()
        CallCenter.init(context)
    }

    @Test
    fun aRingRingsFullScreenAndStopsWhenAnsweredElsewhere() {
        val tag = "p#http://127.0.0.1:9#0call:$call|r|a|0|0|${token()}"
        assertTrue(CallCenter.onNotify(context, tag, chrome("ann", "Incoming call")))
        ShadowLooper.idleMainLooper()

        val ring = ours().single()
        assertEquals(RingNotes.CHANNEL_RING, ring.channelId)
        assertEquals(Notification.CATEGORY_CALL, ring.category)
        assertNotNull("rings over the lock screen", ring.fullScreenIntent)
        assertTrue("the ringtone loops", ring.flags and Notification.FLAG_INSISTENT != 0)
        assertEquals("ann", ring.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals(Notification.CallStyle::class.java.name, ring.extras.getString(Notification.EXTRA_TEMPLATE))
        assertTrue(CallCenter.state.value is CallState.Ringing)

        // "Answered on another device": nothing of Chrome's shows, the ring stops.
        assertTrue(CallCenter.onNotify(context, "p#http://127.0.0.1:9#0call:$call|s", chrome("Promptly", "Answered on another device")))
        ShadowLooper.idleMainLooper()
        assertTrue(ours().isEmpty())
        assertEquals(CallState.Idle, CallCenter.state.value)
    }

    @Test
    fun missedStopsTheRingAndChromeShowsMissedCall() {
        CallCenter.onNotify(context, "p#h#0call:$call|r|v|0|1|${token()}", chrome("The Lads", "ann is starting a video call"))
        ShadowLooper.idleMainLooper()
        assertEquals(1, ours().size)
        assertFalse(CallCenter.onNotify(context, "p#h#0call:$call|m", chrome("Missed video call", "ann called The Lads")))
        ShadowLooper.idleMainLooper()
        assertTrue(ours().isEmpty())
        assertEquals(CallState.Idle, CallCenter.state.value)
    }

    @Test
    fun theSiteClosingTheRingStopsIt() {
        val tag = "p#h#0call:$call|r|a|0|0|${token()}"
        CallCenter.onNotify(context, tag, chrome("ann", "Incoming call"))
        ShadowLooper.idleMainLooper()
        CallCenter.onCancel(context, tag)
        ShadowLooper.idleMainLooper()
        assertTrue(ours().isEmpty())
        assertEquals(CallState.Idle, CallCenter.state.value)
    }

    @Test
    fun declineFromTheRing() {
        CallCenter.onNotify(context, "p#h#0call:$call|r|a|0|0|${token()}", chrome("ann", "Incoming call"))
        ShadowLooper.idleMainLooper()
        CallCenter.decline(call)
        ShadowLooper.idleMainLooper()
        assertTrue(ours().isEmpty())
        assertEquals(CallState.Idle, CallCenter.state.value)
    }

    @Test
    fun otherNotificationsAndOldPagesAreLeftToChrome() {
        // No token (the page doesn't know this phone has the app), another app's tag, junk.
        assertFalse(CallCenter.onNotify(context, "p#h#0call:$call|r|a|0|0|", chrome("ann", "Incoming call")))
        assertFalse(CallCenter.onNotify(context, "p#h#0call:$call", chrome("ann", "Incoming call")))
        assertFalse(CallCenter.onNotify(context, "p#h#0room:42", chrome("Lounge", "hi")))
        ShadowLooper.idleMainLooper()
        assertTrue(ours().isEmpty())
        // Not set up with a server yet: Chrome's notification as before.
        context.getSharedPreferences("promptly", Context.MODE_PRIVATE).edit().remove("server").commit()
        assertFalse(CallCenter.onNotify(context, "p#h#0call:$call|r|a|0|0|${token()}", chrome("ann", "Incoming call")))
    }
}
