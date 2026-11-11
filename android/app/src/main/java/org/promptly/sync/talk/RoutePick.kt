package org.promptly.sync.talk

import android.media.AudioDeviceInfo

/** Which microphone and speaker a phone Talk conversation uses (Talk phase 2,
 *  WP-T13), as a plain function so it's tested without a phone.
 *
 *  * A headset (wired, USB, Bluetooth LE or hands-free) beats the phone: press the
 *    earbud (or start Talk) with the phone in your pocket and your voice comes
 *    through the earbuds.
 *  * **With Android Auto connected** the car's own hands-free (SCO) link is never
 *    picked for a phone conversation: the car path uses the car's microphone
 *    (`CarAudioRecord`). **In a Bluetooth-only car** (no Android Auto), the car's
 *    hands-free link is exactly right.
 *  * On **Android 10–11** a Bluetooth headset needs the old `startBluetoothSco()`
 *    ([Choice.legacySco]); Android 12+ uses `setCommunicationDevice`.
 *  * **Music-only earbuds** (A2DP, no hands-free profile) have no microphone:
 *    [Choice.musicOnly] makes Talk say once "Using your phone's microphone."
 *
 *  Re-run whenever devices come or go, so walking out of range moves the
 *  conversation to the phone without ending it. */
object RoutePick {
    data class Choice(
        /** The `AudioDeviceInfo` type to use, or null for the phone's own. */
        val type: Int?,
        val legacySco: Boolean = false,
        val musicOnly: Boolean = false,
    ) {
        val speaker: Boolean get() = type == null || type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    }

    private val HEADSETS = listOf(
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
    )

    /** [devices]: what can carry the call audio (Android 12+: the communication
     *  devices; before: the outputs). [outputs]: every output now connected.
     *  [carProjection]: Android Auto is connected. */
    fun pick(devices: List<Int>, outputs: List<Int>, carProjection: Boolean, sdk: Int): Choice {
        val usable = devices.filter { !(carProjection && it == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) }
        val headset = HEADSETS.firstOrNull { it in usable }
        val musicOnly = headset == null && AudioDeviceInfo.TYPE_BLUETOOTH_A2DP in outputs
        if (sdk >= 31) {
            val type = headset ?: AudioDeviceInfo.TYPE_BUILTIN_SPEAKER.takeIf { it in devices }
            return Choice(type, musicOnly = musicOnly)
        }
        return when (headset) {
            null -> Choice(null, musicOnly = musicOnly)
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> Choice(headset, legacySco = true)
            else -> Choice(headset)
        }
    }

    const val MUSIC_ONLY = "Using your phone's microphone."
}
