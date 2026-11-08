package org.promptly.sync.calls

import android.content.Context
import android.net.Uri
import android.telecom.DisconnectCause
import android.util.Log
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlResult
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallEndpointCompat
import androidx.core.telecom.CallsManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * DM calls as real calls to Android (Core-Telecom, `androidx.core:core-telecom`):
 * the lock screen, a Bluetooth headset's answer and hang-up buttons, the car's
 * call screen and steering-wheel buttons, and audio that Android routes and
 * focuses like a phone call (P Maps' directions and Talking duck under it).
 *
 * Each ringing or answered call is added to Telecom as a self-managed call.
 * What Telecom asks (answer, hang up) goes to [CallCenter] as the same events
 * the screen and the notification send; what the phone does is told to
 * Telecom ([CallMachine]'s Telecom effects). If Telecom isn't there or refuses
 * a call, the call carries on without it: [CallService] then routes audio
 * itself (LiveKit's AudioSwitch).
 */
class CallTelecom(context: Context, private val scope: CoroutineScope, private val events: Events) {
    interface Events {
        /** Telecom asks to answer (a headset, the car, a watch). */
        fun systemAnswer(callId: String)
        /** Telecom asks to hang up or decline. */
        fun systemDisconnect(callId: String)
    }

    /** Where the audio goes now, and where it could go (for the Speaker button). */
    data class Audio(val current: Routing.Kind? = null, val available: List<Routing.Kind> = emptyList(), val muted: Boolean = false)

    private class Held(val job: Job) {
        var control: CallControlScope? = null
        var endpoints: List<CallEndpointCompat> = emptyList()
        var current: Routing.Kind? = null
        /** A request that came before Telecom handed us the call's controls. */
        var pending: (suspend CallControlScope.() -> Unit)? = null
    }

    private val manager = CallsManager(context.applicationContext)
    private var registered: Boolean? = null
    private val calls = mutableMapOf<String, Held>()
    private val _audio = MutableStateFlow(Audio())
    val audio: StateFlow<Audio> = _audio

    private fun register(): Boolean {
        registered?.let { return it }
        val ok = try {
            manager.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE or CallsManager.CAPABILITY_SUPPORTS_VIDEO_CALLING)
            true
        } catch (e: Exception) {
            // No telephony feature (some tablets), or Telecom said no.
            Log.w(TAG, "Telecom unavailable", e)
            false
        }
        registered = ok
        return ok
    }

    /** Telecom holds this call (so it routes the audio). */
    fun holds(callId: String): Boolean = calls[callId]?.control != null

    /** A call ringing this phone. */
    fun incoming(ring: Ring) {
        if (calls.containsKey(ring.callId) || !register()) return
        val attrs = CallAttributesCompat(
            ring.title,
            Uri.fromParts("sip", "promptly-" + ring.callId.take(8), null),
            CallAttributesCompat.DIRECTION_INCOMING,
            if (ring.video) CallAttributesCompat.CALL_TYPE_VIDEO_CALL else CallAttributesCompat.CALL_TYPE_AUDIO_CALL,
            CallAttributesCompat.SUPPORTS_SET_INACTIVE,
            null,
        )
        val id = ring.callId
        lateinit var held: Held
        val job = scope.launch {
            try {
                manager.addCall(
                    attrs,
                    { _ -> events.systemAnswer(id) },
                    { _ -> events.systemDisconnect(id) },
                    { },
                    { },
                ) {
                    held.control = this
                    launch { availableEndpoints.collect { list -> held.endpoints = list; publish(id) } }
                    launch { currentCallEndpoint.collect { e -> held.current = kindOf(e); publish(id) } }
                    launch { isMuted.collect { m -> if (calls[id] === held) _audio.value = _audio.value.copy(muted = m) } }
                    held.pending?.let { p ->
                        held.pending = null
                        launch { p() }
                    }
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                Log.w(TAG, "Telecom didn't take the call", e)
            } finally {
                if (calls[id] === held) calls.remove(id)
            }
        }
        held = Held(job)
        calls[id] = held
    }

    fun answer(callId: String, video: Boolean) = run(callId) {
        result("answer", answer(if (video) CallAttributesCompat.CALL_TYPE_VIDEO_CALL else CallAttributesCompat.CALL_TYPE_AUDIO_CALL))
    }

    fun active(callId: String) = run(callId) { result("active", setActive()) }

    fun end(callId: String, cause: EndCause) {
        val h = calls[callId] ?: return
        val code = when (cause) {
            EndCause.LOCAL -> DisconnectCause.LOCAL
            EndCause.REMOTE -> DisconnectCause.REMOTE
            EndCause.REJECTED -> DisconnectCause.REJECTED
            EndCause.MISSED -> DisconnectCause.MISSED
        }
        val c = h.control
        calls.remove(callId)
        if (c == null) {
            h.job.cancel()
            return
        }
        scope.launch {
            runCatching { c.disconnect(DisconnectCause(code)) }.onFailure { Log.w(TAG, "disconnect", it) }
            h.job.cancel()
        }
        if (calls.isEmpty()) _audio.value = Audio()
    }

    /** The loudspeaker, or back to the headset / earpiece. False when Telecom doesn't hold the call. */
    fun setSpeaker(callId: String, on: Boolean): Boolean {
        val h = calls[callId] ?: return false
        val c = h.control ?: return false
        val want = Routing.pick(h.endpoints.map { kindOf(it) }.distinct(), on) ?: return true
        val target = h.endpoints.firstOrNull { kindOf(it) == want } ?: return true
        scope.launch { result("route", c.requestEndpointChange(target)) }
        return true
    }

    private fun publish(callId: String) {
        val h = calls[callId] ?: return
        _audio.value = _audio.value.copy(current = h.current, available = h.endpoints.map { kindOf(it) }.distinct())
    }

    private fun run(callId: String, step: suspend CallControlScope.() -> Unit) {
        val h = calls[callId] ?: return
        val c = h.control
        if (c == null) {
            h.pending = step
            return
        }
        scope.launch { runCatching { c.step() }.onFailure { Log.w(TAG, "telecom", it) } }
    }

    private fun result(what: String, r: CallControlResult) {
        if (r !is CallControlResult.Success) Log.w(TAG, "$what: $r")
    }

    companion object {
        private const val TAG = "PromptlyCallTelecom"

        fun kindOf(e: CallEndpointCompat): Routing.Kind = when (e.type) {
            CallEndpointCompat.TYPE_EARPIECE -> Routing.Kind.EARPIECE
            CallEndpointCompat.TYPE_SPEAKER -> Routing.Kind.SPEAKER
            CallEndpointCompat.TYPE_WIRED_HEADSET -> Routing.Kind.WIRED
            CallEndpointCompat.TYPE_BLUETOOTH -> Routing.Kind.BLUETOOTH
            else -> Routing.Kind.OTHER
        }
    }
}
