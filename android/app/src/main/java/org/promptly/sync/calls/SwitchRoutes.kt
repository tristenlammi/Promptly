package org.promptly.sync.calls

import com.twilio.audioswitch.AudioDevice
import io.livekit.android.audio.AudioSwitchHandler

/**
 * The sound picker's list when the app routes the sound itself (LiveKit's
 * AudioSwitch): a voice channel, or a call Android's call system didn't take.
 */
object SwitchRoutes {
    fun id(d: AudioDevice): String = d.javaClass.simpleName + ":" + d.name

    fun kind(d: AudioDevice): Routing.Kind = when (d) {
        is AudioDevice.BluetoothHeadset -> Routing.Kind.BLUETOOTH
        is AudioDevice.WiredHeadset -> Routing.Kind.WIRED
        is AudioDevice.Earpiece -> Routing.Kind.EARPIECE
        is AudioDevice.Speakerphone -> Routing.Kind.SPEAKER
    }

    fun of(sw: AudioSwitchHandler): List<AudioRoute> {
        val now = sw.selectedAudioDevice?.let { id(it) }
        return Routing.options(sw.availableAudioDevices.map { d -> AudioRoute(id(d), kind(d), Routing.label(kind(d), d.name), current = id(d) == now) })
    }

    /** Sends the sound there. The device, or null when it has gone. */
    fun select(sw: AudioSwitchHandler, routeId: String): AudioDevice? {
        val pick = sw.availableAudioDevices.firstOrNull { id(it) == routeId } ?: return null
        sw.selectDevice(pick)
        return pick
    }
}
