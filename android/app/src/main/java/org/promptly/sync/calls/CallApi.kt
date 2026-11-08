package org.promptly.sync.calls

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The phone's DM-call requests (`backend/app/calls/dm_router.py`). No bearer
 * and no app password: a ring is answered, declined and checked with the
 * push's own answer token (one person, one call, two minutes); once
 * answered, the call session from the answer is the key (one person, one
 * call, this device, 12 hours).
 */
class CallApi(private val server: String) {
    /** 404 / 409: the call isn't there for you any more (ended, not ringing you). */
    class Over(val code: Int) : IOException("call over ($code)")

    suspend fun answer(token: String): CallJoin =
        CallProtocol.parseJoin(post("/api/calls/answer", CallProtocol.answerBody(token)))

    suspend fun decline(token: String) {
        post("/api/calls/answer/decline", CallProtocol.tokenBody(token))
    }

    suspend fun ringState(token: String): RingState =
        CallProtocol.parseRingState(post("/api/calls/answer/state", CallProtocol.tokenBody(token)))

    suspend fun refresh(session: String): CallRefresh = try {
        CallRefresh.Ok(CallProtocol.parseJoin(post("/api/calls/session/refresh", CallProtocol.sessionBody(session))))
    } catch (_: Over) {
        CallRefresh.Gone
    } catch (e: IOException) {
        CallRefresh.Failed(e.message ?: "network")
    } catch (e: IllegalArgumentException) {
        CallRefresh.Failed(e.message ?: "bad answer")
    }

    suspend fun leave(session: String) {
        post("/api/calls/session/leave", CallProtocol.sessionBody(session))
    }

    private suspend fun post(path: String, body: String): String = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(server.trimEnd('/') + path)
            .post(body.toRequestBody(JSON))
            .header("Accept", "application/json")
            .build()
        http.newCall(req).execute().use { res ->
            when {
                res.code == 404 || res.code == 409 -> throw Over(res.code)
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
