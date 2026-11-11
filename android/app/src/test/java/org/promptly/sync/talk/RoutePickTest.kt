package org.promptly.sync.talk

import android.content.Intent
import android.media.AudioDeviceInfo.TYPE_BLE_HEADSET
import android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
import android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO
import android.media.AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
import android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
import android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Headsets and Bluetooth (WP-T13): which device a phone conversation uses, and the
 *  Bluetooth voice button reaching the assistant sheet. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RoutePickTest {
    private val phone = listOf(TYPE_BUILTIN_EARPIECE, TYPE_BUILTIN_SPEAKER)

    @Test
    fun earbuds_beat_the_phone() {
        val c = RoutePick.pick(phone + TYPE_BLUETOOTH_SCO, phone + TYPE_BLUETOOTH_SCO, carProjection = false, sdk = 34)
        assertEquals(TYPE_BLUETOOTH_SCO, c.type)
        assertFalse(c.legacySco)
        assertEquals(TYPE_WIRED_HEADSET, RoutePick.pick(phone + TYPE_BLUETOOTH_SCO + TYPE_WIRED_HEADSET, phone, false, 34).type)
        assertEquals(TYPE_BLE_HEADSET, RoutePick.pick(phone + TYPE_BLE_HEADSET, phone, false, 34).type)
    }

    @Test
    fun with_android_auto_never_the_cars_hands_free_link() {
        val c = RoutePick.pick(phone + TYPE_BLUETOOTH_SCO, phone + TYPE_BLUETOOTH_SCO, carProjection = true, sdk = 34)
        assertEquals(TYPE_BUILTIN_SPEAKER, c.type)
        assertTrue(c.speaker)
        // Android 10-11 too: no SCO started, the phone's own.
        val old = RoutePick.pick(phone + TYPE_BLUETOOTH_SCO, phone + TYPE_BLUETOOTH_SCO, carProjection = true, sdk = 29)
        assertNull(old.type)
        assertFalse(old.legacySco)
    }

    @Test
    fun a_bluetooth_only_car_is_the_hands_free_link() {
        val c = RoutePick.pick(phone + TYPE_BLUETOOTH_SCO, phone + TYPE_BLUETOOTH_SCO, carProjection = false, sdk = 34)
        assertEquals(TYPE_BLUETOOTH_SCO, c.type)
    }

    @Test
    fun android_10_and_11_use_the_old_sco_path() {
        val c = RoutePick.pick(phone + TYPE_BLUETOOTH_SCO, phone + TYPE_BLUETOOTH_SCO, carProjection = false, sdk = 29)
        assertEquals(TYPE_BLUETOOTH_SCO, c.type)
        assertTrue(c.legacySco)
        // A wired headset needs nothing started.
        assertFalse(RoutePick.pick(phone + TYPE_WIRED_HEADSET, phone + TYPE_WIRED_HEADSET, false, 30).legacySco)
    }

    @Test
    fun earbuds_gone_mid_conversation_means_the_phone() {
        val before = RoutePick.pick(phone + TYPE_BLUETOOTH_SCO, phone + TYPE_BLUETOOTH_SCO, false, 34)
        val after = RoutePick.pick(phone, phone, false, 34)
        assertEquals(TYPE_BLUETOOTH_SCO, before.type)
        assertEquals(TYPE_BUILTIN_SPEAKER, after.type)
        assertFalse(after.musicOnly)
    }

    @Test
    fun music_only_earbuds_say_so() {
        val c = RoutePick.pick(phone, phone + TYPE_BLUETOOTH_A2DP, carProjection = false, sdk = 34)
        assertTrue(c.musicOnly)
        assertEquals(TYPE_BUILTIN_SPEAKER, c.type)
        assertTrue(RoutePick.pick(phone, phone + TYPE_BLUETOOTH_A2DP, false, 29).musicOnly)
        assertFalse(RoutePick.pick(phone + TYPE_BLUETOOTH_SCO, phone + TYPE_BLUETOOTH_A2DP, false, 34).musicOnly)
    }

    @Test
    fun the_bluetooth_voice_button_opens_the_assistant_sheet() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val found = context.packageManager.queryIntentActivities(Intent(Intent.ACTION_VOICE_COMMAND).setPackage(context.packageName), 0)
        assertTrue(found.any { it.activityInfo.name.endsWith(".assistant.AssistantActivity") })
    }

    @Test
    fun the_hello_says_tap_and_locked_only_when_so() {
        val plain = TalkProtocol.hello(TalkProtocol.PHONE_CAPS, null, null)
        assertFalse(plain.has("turn_mode") || plain.has("locked"))
        val set = TalkProtocol.hello(TalkProtocol.PHONE_CAPS, null, null, turnMode = "tap", locked = true)
        assertEquals("tap", set.getString("turn_mode"))
        assertTrue(set.getBoolean("locked"))
    }
}
