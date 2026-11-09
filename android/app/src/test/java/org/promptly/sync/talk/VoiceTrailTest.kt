package org.promptly.sync.talk

import android.content.Context
import android.provider.AlarmClock
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.assistant.Crashes
import org.promptly.sync.assistant.PhoneActions
import org.promptly.sync.assistant.VoiceTrail
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File

/** The voice breadcrumb in crash reports, and device actions through the phone's
 *  existing handlers. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VoiceTrailTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun a_line_round_trips_and_strips_anything_odd() {
        val m = VoiceTrail.Mark(1_700_000_000_000, "talk", "speaking", 1_699_999_700_000)
        assertEquals(m, VoiceTrail.parse(VoiceTrail.line(m)))
        assertEquals("talk", VoiceTrail.parse(VoiceTrail.line(m.copy(path = "ta|lk")))!!.path)
        assertNull(VoiceTrail.parse("garbage"))
    }

    @Test
    fun describes_what_voice_was_doing_at_the_time() {
        val start = 1_000_000L
        val marks = listOf(
            VoiceTrail.Mark(start, "talk", "listening", start),
            VoiceTrail.Mark(start + 30_000, "talk", "thinking", start),
            VoiceTrail.Mark(start + 31_000, "talk", "speaking", start),
        )
        val said = VoiceTrail.describe(marks, start + 312_000)!!
        assertEquals("Voice: Talk speaking, conversation 5m 12s old, last change 4m 41s before", said)
        // Before the conversation: nothing to say.
        assertNull(VoiceTrail.describe(marks, start - 1))
        // Long after the last change: not voice's doing.
        assertNull(VoiceTrail.describe(marks, start + 31_000 + 16 * 60_000))
        // After it ended: nothing going on.
        assertNull(VoiceTrail.describe(marks + VoiceTrail.Mark(start + 40_000, "talk", "ended", start), start + 41_000))
        assertEquals(
            "Voice: car assistant listening, last change 2s before",
            VoiceTrail.describe(listOf(VoiceTrail.Mark(start, "car", "listening", 0)), start + 2_000),
        )
    }

    @Test
    fun crash_reports_carry_the_breadcrumb() {
        val now = System.currentTimeMillis()
        File(context.filesDir, "voice_trail.txt").writeText(
            VoiceTrail.line(VoiceTrail.Mark(now - 60_000, "car", "listening", now - 300_000)) + "\n" +
                VoiceTrail.line(VoiceTrail.Mark(now - 5_000, "car", "speaking", now - 300_000)) + "\n",
        )
        val dir = File(context.filesDir, "crashes").apply { mkdirs() }
        File(dir, "$now.txt").writeText("main\njava.lang.IllegalStateException: boom\n\tat x.y(Z.kt:1)")
        val report = Crashes.reports(context).first { it.key == "kotlin-$now" }
        assertTrue(report.stack, report.stack.startsWith("java.lang.IllegalStateException: boom"))
        assertTrue(report.stack, report.stack.endsWith("Voice: car assistant speaking, conversation 5m 0s old, last change 5s before"))
        assertEquals("java.lang.IllegalStateException: boom", report.message)
    }

    @Test
    fun a_timer_goes_to_the_clock_app() {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        assertNull(PhoneActions.carry(app, JSONObject().put("type", "set_timer").put("seconds", 600).put("label", "Tea")))
        val sent = shadowOf(app).nextStartedActivity
        assertNotNull(sent)
        assertEquals(AlarmClock.ACTION_SET_TIMER, sent.action)
        assertEquals(600, sent.getIntExtra(AlarmClock.EXTRA_LENGTH, 0))
        assertEquals("Tea", sent.getStringExtra(AlarmClock.EXTRA_MESSAGE))
        assertTrue(sent.getBooleanExtra(AlarmClock.EXTRA_SKIP_UI, false))
    }

    @Test
    fun an_alarm_after_a_yes_goes_to_the_clock_app() {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        assertNull(PhoneActions.carry(app, JSONObject().put("type", "set_alarm").put("hour", 6).put("minute", 30)))
        val sent = shadowOf(app).nextStartedActivity
        assertEquals(AlarmClock.ACTION_SET_ALARM, sent.action)
        assertEquals(6, sent.getIntExtra(AlarmClock.EXTRA_HOUR, -1))
        assertEquals(30, sent.getIntExtra(AlarmClock.EXTRA_MINUTES, -1))
    }

    @Test
    fun bad_values_are_refused_on_the_phone_too() {
        assertEquals("I can't set that timer.", PhoneActions.carry(context, JSONObject().put("type", "set_timer").put("seconds", 0)))
        assertEquals("I can't set that alarm.", PhoneActions.carry(context, JSONObject().put("type", "set_alarm").put("hour", 25).put("minute", 0)))
        assertEquals("I can't open that.", PhoneActions.carry(context, JSONObject().put("type", "open_app").put("app", "settings")))
    }

    @Test
    fun the_dialler_opens_with_the_number_and_never_a_link() {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        assertNull(PhoneActions.carry(app, JSONObject().put("type", "dial").put("number", "+61 400 000 000")))
        val sent = shadowOf(app).nextStartedActivity
        assertEquals(android.content.Intent.ACTION_DIAL, sent.action)
        assertEquals("tel", sent.data!!.scheme)
        assertEquals("This phone can't do that.", PhoneActions.carry(app, JSONObject().put("type", "dial").put("number", "javascript:alert(1)")))
    }

    @Test
    fun with_the_screen_locked_screen_things_wait() {
        val unlock = "Unlock your phone for that."
        for (type in listOf("dial", "message", "open_app", "go")) {
            assertEquals(type, unlock, PhoneActions.carry(context, JSONObject().put("type", type).put("number", "123").put("app", "mail"), locked = true))
        }
        // A timer doesn't need the screen.
        assertNull(PhoneActions.carry(context, JSONObject().put("type", "set_timer").put("seconds", 60), locked = true))
    }
}
