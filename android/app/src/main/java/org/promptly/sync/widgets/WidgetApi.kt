package org.promptly.sync.widgets

import okhttp3.Credentials
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.promptly.sync.Refused
import org.promptly.sync.Store
import org.promptly.sync.Unlinked
import java.io.IOException
import java.util.concurrent.TimeUnit

/** What the widgets need from the server — an interface so the sync logic can
 *  be tested without one. */
interface WidgetBackend {
    /** The snapshot; sections whose etag we sent come back `unchanged`. */
    fun snapshot(want: List<String>, days: Int, someday: Boolean, etags: Map<String, String>, noteIds: List<String>): JSONObject

    /** Send one outbox change; the server's answer. */
    fun send(op: Op): JSONObject
}

/**
 * `/api/widgets` with this phone's own app password (scope `widgets`), the way
 * the map signs in. 401 → [Unlinked] (the phone was removed); another 4xx →
 * [Refused]; 5xx and no signal → [IOException] (try again later).
 */
class WidgetApi(private val account: Store.Account) : WidgetBackend {
    private val json = "application/json".toMediaType()

    private fun Request.Builder.auth() = header("Authorization", Credentials.basic(account.username, account.password))

    private fun call(req: Request): JSONObject {
        http.newCall(req).execute().use { r ->
            val text = r.body.string()
            if (r.code == 401) throw Unlinked()
            if (r.code == 409) throw IOException("The server is still saving that change.")
            if (r.code in 400..499) {
                val detail = runCatching { JSONObject(text).optString("detail") }.getOrNull()?.takeIf { it.isNotBlank() }
                throw Refused(r.code, detail ?: "The server refused it (${r.code}).")
            }
            if (r.code >= 500) throw IOException("The server had a problem (${r.code}).")
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        }
    }

    override fun snapshot(want: List<String>, days: Int, someday: Boolean, etags: Map<String, String>, noteIds: List<String>): JSONObject {
        val url = "${account.server}/api/widgets/snapshot".toHttpUrl().newBuilder()
            .addQueryParameter("want", want.joinToString(","))
            .addQueryParameter("days", days.toString())
            .apply {
                if (someday) addQueryParameter("someday", "true")
                etags.forEach { (k, v) -> addQueryParameter("${k}_etag", v) }
                noteIds.forEach { addQueryParameter("note", it) }
            }
            .build()
        return call(Request.Builder().url(url).auth().get().build())
    }

    override fun send(op: Op): JSONObject {
        val (path, body) = when (op.type) {
            Op.COMPLETE -> "/api/widgets/tasks/complete" to JSONObject(op.body.toString()).put("client_id", op.id)
            Op.ADD_TASK -> "/api/widgets/tasks" to JSONObject(op.body.toString()).put("client_id", op.id)
            else -> throw Refused(400, "This phone doesn't know how to send that.")
        }
        return call(Request.Builder().url(account.server + path).auth().post(body.toString().toRequestBody(json)).build())
    }

    companion object {
        val http: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .callTimeout(45, TimeUnit.SECONDS)
            .build()
    }
}
