package org.promptly.sync.widgets

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/*
 * The at-a-glance widgets' saved copy: what `/api/widgets/glance` last said
 * (`files/widgets/hub.json`), plus the newest Porch photo. Like the snapshot,
 * the widgets only ever draw from this, never from the network, so they show
 * the last numbers with no signal; [SyncLogic] fills it.
 */

/** The last answer, as it came. [fetchedAt]: when the phone last heard from the server. */
data class HubState(val json: JSONObject = JSONObject(), val fetchedAt: Long = 0, val porch: Bitmap? = null, val version: Int = 0) {
    fun section(key: String): JSONObject? = json.optJSONObject(key)
    fun list(key: String): List<JSONObject> = json.optJSONArray(key).objects()
}

fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { optString(it) }.filter { it.isNotBlank() }

/** A string field, or null when it's missing, null or blank. */
fun JSONObject.text(key: String): String? = if (isNull(key)) null else optString(key).ifBlank { null }

/** A number that may be null (a target nobody set). */
fun JSONObject.num(key: String): Double? = if (!has(key) || isNull(key)) null else optDouble(key).takeIf { !it.isNaN() }

object HubStore {
    private const val PORCH_MAX = 2L * 1024 * 1024

    private val lock = Mutex()
    private val _state = MutableStateFlow(HubState())
    val state: StateFlow<HubState> = _state
    private var loaded = false

    private fun dir(ctx: Context) = File(ctx.applicationContext.filesDir, "widgets").apply { mkdirs() }

    suspend fun load(ctx: Context): HubState = withContext(Dispatchers.IO) {
        lock.withLock {
            if (!loaded) {
                val d = dir(ctx)
                val raw = runCatching { JSONObject(File(d, "hub.json").readText()) }.getOrNull() ?: JSONObject()
                val porch = runCatching { BitmapFactory.decodeFile(File(d, "porch.jpg").path) }.getOrNull()
                _state.value = HubState(raw.optJSONObject("answer") ?: JSONObject(), raw.optLong("fetched_at"), porch, 1)
                loaded = true
            }
            _state.value
        }
    }

    /** A new answer from the server; the Porch picture only when it changed. */
    suspend fun save(ctx: Context, answer: JSONObject, now: Long, api: WidgetBackend?) = withContext(Dispatchers.IO) {
        load(ctx)
        val d = dir(ctx)
        val oldThumb = _state.value.json.optJSONObject("social")?.optJSONObject("porch")?.text("thumb")
        val newThumb = answer.optJSONObject("social")?.optJSONObject("porch")?.text("thumb")
        var porch = _state.value.porch
        if (newThumb == null) {
            File(d, "porch.jpg").delete()
            porch = null
        } else if (newThumb.substringBefore('?') != oldThumb?.substringBefore('?') || porch == null) {
            // Signed links change every time; the path before the signature doesn't.
            porch = runCatching {
                val bytes = api?.download(newThumb, PORCH_MAX) ?: return@runCatching porch
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = 1 })
                if (bmp != null) {
                    val small = scaleDown(bmp, 480)
                    File(d, "porch.jpg").outputStream().use { small.compress(Bitmap.CompressFormat.JPEG, 85, it) }
                    small
                } else porch
            }.getOrDefault(porch)
        }
        // Sections we didn't ask for this time stay as they were.
        val merged = JSONObject(_state.value.json.toString())
        answer.keys().forEach { k -> merged.put(k, answer.get(k)) }
        val file = File(d, "hub.json")
        val tmp = File(d, "hub.json.tmp")
        tmp.writeText(JSONObject().put("answer", merged).put("fetched_at", now).toString())
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
        lock.withLock { _state.value = HubState(merged, now, porch, _state.value.version + 1) }
    }

    suspend fun wipe(ctx: Context) = withContext(Dispatchers.IO) {
        lock.withLock {
            val d = dir(ctx)
            File(d, "hub.json").delete()
            File(d, "porch.jpg").delete()
            _state.value = HubState(version = _state.value.version + 1)
            loaded = true
        }
    }

    fun bump() {
        _state.value = _state.value.copy(version = _state.value.version + 1)
    }

    private fun scaleDown(b: Bitmap, edge: Int): Bitmap {
        val big = maxOf(b.width, b.height)
        if (big <= edge) return b
        val f = edge.toFloat() / big
        return Bitmap.createScaledBitmap(b, (b.width * f).toInt().coerceAtLeast(1), (b.height * f).toInt().coerceAtLeast(1), true)
    }
}
