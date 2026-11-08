package org.promptly.sync.voice

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The voice service's calls to the server (`backend/app/calls/voice_router.py`).
 * No bearer and no app password: the voice session from the page's Join is
 * the key, scoped to one person, one channel, 12 hours, and dead once you
 * leave.
 */
class VoiceApi(private val server: String) {
    /** 404 from a session route: the session is over. */
    class Gone : IOException("voice session ended")

    /** 429: too many speaking edges; wait a little. */
    class Slow : IOException("slow down")

    suspend fun refresh(session: String): Refresh = try {
        Refresh.Ok(VoiceProtocol.parseJoin(post("/api/rooms/voice/refresh", VoiceProtocol.refreshBody(session))))
    } catch (_: Gone) {
        Refresh.Gone
    } catch (e: IOException) {
        Refresh.Failed(e.message ?: "network")
    } catch (e: IllegalArgumentException) {
        Refresh.Failed(e.message ?: "bad answer")
    }

    suspend fun state(session: String, mic: MicState) {
        post("/api/rooms/voice/session/state", VoiceProtocol.stateBody(session, mic))
    }

    suspend fun speaking(session: String, on: Boolean) {
        post("/api/rooms/voice/session/speaking", VoiceProtocol.speakingBody(session, on))
    }

    suspend fun stillHere(session: String) {
        post("/api/rooms/voice/session/still-here", VoiceProtocol.sessionBody(session))
    }

    suspend fun leave(session: String) {
        post("/api/rooms/voice/session/leave", VoiceProtocol.sessionBody(session))
    }

    private suspend fun post(path: String, body: String): String = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(server.trimEnd('/') + path)
            .post(body.toRequestBody(JSON))
            .header("Accept", "application/json")
            .build()
        http.newCall(req).execute().use { res ->
            when {
                res.code == 404 -> throw Gone()
                res.code == 429 -> throw Slow()
                !res.isSuccessful -> throw IOException("HTTP ${res.code}")
                else -> res.body.string()
            }
        }
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        private val http = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .build()
    }
}
