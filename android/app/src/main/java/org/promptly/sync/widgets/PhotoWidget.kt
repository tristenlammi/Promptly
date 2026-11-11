package org.promptly.sync.widgets

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.ActionParameters
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.state.getAppWidgetState
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.height
import androidx.glance.layout.size
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.state.GlanceStateDefinition
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import org.json.JSONArray
import org.json.JSONObject
import org.promptly.sync.R
import org.promptly.sync.Refused
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

/*
 * The Photo widget: one photo from an album you choose, cut to a shape, and
 * another one every half hour.
 *
 *  - PhotoCache: a few of the album's photos kept small on the phone
 *    (files/widgets/photos/<album>/), so it works with no signal and never
 *    holds a big picture. Wiped with the rest of the widgets' copy.
 *  - PhotoSync: tops the cache up from /api/widgets/photos (part of WidgetSync).
 *  - PhotoRender: cuts a saved photo to the shape at the widget's size —
 *    cropped round the people and pets in it (the server says where; kept
 *    beside the saved photo), or shown whole if that's what you chose.
 *  - PhotoWidget: draws it; which photo is showing is the widget's own state,
 *    so several widgets each keep their own album, shape and photo.
 */

// ------------------------------------------------------------------ saved photos

object PhotoCache {
    /** How many photos of an album stay on the phone. */
    const val KEEP = 12

    /** A saved photo's long edge, in pixels: enough for a big widget, about 100–200 KB. */
    const val EDGE = 960

    const val OK = "ok"
    const val EMPTY = "empty"
    const val GONE = "gone"

    class Meta(val title: String, val state: String, val count: Int, val fetchedAt: Long)

    private fun root(ctx: Context) = File(ctx.applicationContext.filesDir, "widgets/photos")
    private fun dir(ctx: Context, album: String) = File(root(ctx), WidgetApi.seg(album))

    fun file(ctx: Context, album: String, id: String) = File(dir(ctx, album), WidgetApi.seg(id) + ".jpg")

    fun saved(ctx: Context, album: String): List<PhotoPick.Saved> =
        dir(ctx, album).listFiles { f -> f.isFile && f.name.endsWith(".jpg") }.orEmpty()
            .map { PhotoPick.Saved(it.name.removeSuffix(".jpg"), it.lastModified()) }.sortedBy { it.id }

    fun ids(ctx: Context, album: String): List<String> = saved(ctx, album).map { it.id }

    fun meta(ctx: Context, album: String): Meta? = runCatching {
        val j = JSONObject(File(dir(ctx, album), "album.json").readText())
        Meta(j.optString("title"), j.optString("state", OK), j.optInt("count"), j.optLong("fetched"))
    }.getOrNull()

    fun setMeta(ctx: Context, album: String, meta: Meta) {
        val d = dir(ctx, album).apply { mkdirs() }
        val tmp = File(d, "album.json.tmp")
        tmp.writeText(JSONObject().put("title", meta.title).put("state", meta.state).put("count", meta.count).put("fetched", meta.fetchedAt).toString())
        val f = File(d, "album.json")
        if (!tmp.renameTo(f)) {
            f.delete()
            tmp.renameTo(f)
        }
    }

    fun delete(ctx: Context, album: String, ids: Collection<String>) = ids.forEach {
        file(ctx, album, it).delete()
        focusFile(ctx, album, it).delete()
    }

    /** Where a saved photo's subject is, kept beside it (so the crop is right with no signal). */
    private fun focusFile(ctx: Context, album: String, id: String) = File(dir(ctx, album), WidgetApi.seg(id) + ".focus")

    fun focus(ctx: Context, album: String, id: String): PhotoShapes.Focus? = runCatching {
        val a = JSONArray(focusFile(ctx, album, id).readText())
        PhotoShapes.Focus.of(a.getDouble(0), a.getDouble(1), a.getDouble(2), a.getDouble(3))
    }.getOrNull()

    /** [box]: the server's `{x, y, w, h}` for the photo, or null when it knows of no one in it. */
    fun setFocus(ctx: Context, album: String, id: String, box: JSONObject?) {
        val f = focusFile(ctx, album, id)
        val ok = box != null && PhotoShapes.Focus.of(box.optDouble("x"), box.optDouble("y"), box.optDouble("w"), box.optDouble("h")) != null
        if (!ok) {
            f.delete()
            return
        }
        runCatching {
            f.parentFile?.mkdirs()
            f.writeText(JSONArray().put(box!!.optDouble("x")).put(box.optDouble("y")).put(box.optDouble("w")).put(box.optDouble("h")).toString())
        }
    }

    /** A saved photo's width and height, without reading the picture. */
    fun size(ctx: Context, album: String, id: String): Pair<Int, Int>? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file(ctx, album, id).path, bounds)
        return if (bounds.outWidth > 0 && bounds.outHeight > 0) bounds.outWidth to bounds.outHeight else null
    }

    /** Forget the album's photos (it's empty now, or gone). */
    fun clear(ctx: Context, album: String) = delete(ctx, album, ids(ctx, album))

    /** Drop albums no widget shows any more. */
    fun prune(ctx: Context, albums: Set<String>) {
        val keep = albums.map { WidgetApi.seg(it) }.toSet()
        root(ctx).listFiles()?.forEach { if (it.name !in keep) it.deleteRecursively() }
    }

    /**
     * Save a downloaded picture small: read at a fraction of its size, shrunk
     * to [EDGE], written as a JPEG. False when it isn't a picture we can read.
     */
    fun store(bytes: ByteArray, to: File): Boolean = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return false
        val opts = BitmapFactory.Options().apply { inSampleSize = PhotoShapes.sample(bounds.outWidth, bounds.outHeight, EDGE) }
        var bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return false
        val long = max(bmp.width, bmp.height)
        if (long > EDGE) {
            val k = EDGE.toFloat() / long
            val small = Bitmap.createScaledBitmap(bmp, max((bmp.width * k).roundToInt(), 1), max((bmp.height * k).roundToInt(), 1), true)
            if (small !== bmp) bmp.recycle()
            bmp = small
        }
        to.parentFile?.mkdirs()
        val tmp = File(to.parentFile, to.name + ".tmp")
        val ok = tmp.outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, 86, it) }
        bmp.recycle()
        if (!ok) {
            tmp.delete()
            return false
        }
        if (!tmp.renameTo(to)) {
            to.delete()
            tmp.renameTo(to)
        }
        to.isFile
    }.getOrDefault(false)
}

// ------------------------------------------------------------------ getting them

object PhotoSync {
    /** How many to fetch while the cache is filling, and at each change-over. */
    const val FILL = 6
    const val FRESH = 4

    /** Swap some saved photos for new ones this often (a big album comes round over days, without much data). */
    const val REFRESH_MS = 6 * 60 * 60 * 1000L

    /** Nothing bigger than this is read from the server (its previews are well under 1 MB). */
    const val MAX_BYTES = 6L * 1024 * 1024

    /**
     * Bring each album's saved photos up to date. Every run asks the server
     * (a small answer) so a deleted album, an emptied one, or photos taken
     * out are noticed; pictures are only downloaded while the cache is
     * filling or [REFRESH_MS] has passed. Throws what [WidgetBackend] throws
     * (no signal, removed phone) — the caller already handles those.
     */
    fun run(
        ctx: Context, api: WidgetBackend, albums: List<String>, now: Long,
        showing: Set<String> = emptySet(), save: (ByteArray, File) -> Boolean = PhotoCache::store,
    ) {
        PhotoCache.prune(ctx, albums.toSet())
        for (album in albums.distinct()) {
            val saved = PhotoCache.saved(ctx, album)
            val before = PhotoCache.meta(ctx, album)
            val filling = saved.size < PhotoCache.KEEP
            val refresh = before == null || now < before.fetchedAt || now - before.fetchedAt >= REFRESH_MS
            val answer = try {
                api.albumPhotos(album, if (filling) FILL else if (refresh) FRESH else 1, saved.map { it.id })
            } catch (e: Refused) {
                if (e.status != 404) throw e
                PhotoCache.clear(ctx, album)
                PhotoCache.setMeta(ctx, album, PhotoCache.Meta(before?.title.orEmpty(), PhotoCache.GONE, 0, now))
                continue
            }
            val info = answer.optJSONObject("album")
            val title = info?.optString("title").orEmpty().ifBlank { before?.title.orEmpty() }
            val count = info?.optInt("count") ?: 0
            if (count == 0) {
                PhotoCache.clear(ctx, album)
                PhotoCache.setMeta(ctx, album, PhotoCache.Meta(title, PhotoCache.EMPTY, 0, now))
                continue
            }
            // Taken out of the album, or put in the trash: off the phone too.
            answer.optJSONArray("gone")?.let { g -> PhotoCache.delete(ctx, album, (0 until g.length()).map { g.optString(it) }) }
            val have = PhotoCache.ids(ctx, album).toSet()
            if (filling || refresh) {
                val photos = answer.optJSONArray("photos")
                for (i in 0 until (photos?.length() ?: 0)) {
                    val p = photos?.optJSONObject(i) ?: continue
                    val id = p.optString("id")
                    val url = p.optString("url")
                    if (id.isBlank() || url.isBlank() || id in have) continue
                    try {
                        if (save(api.download(url, MAX_BYTES), PhotoCache.file(ctx, album, id))) PhotoCache.setFocus(ctx, album, id, p.optJSONObject("focus"))
                    } catch (e: Refused) {
                        // This one picture can't be had (too big, its link ran out): the rest still can.
                    }
                }
            }
            // Ones it holds already: where their subject is, as the server knows it now
            // (found since they were saved, or moved by an edit). An older server says nothing.
            answer.optJSONArray("held")?.let { held ->
                for (i in 0 until held.length()) {
                    val h = held.optJSONObject(i) ?: continue
                    val id = h.optString("id")
                    if (id in have && h.has("focus")) PhotoCache.setFocus(ctx, album, id, h.optJSONObject("focus"))
                }
            }
            PhotoCache.delete(ctx, album, PhotoPick.trim(PhotoCache.saved(ctx, album), PhotoCache.KEEP, showing))
            PhotoCache.setMeta(ctx, album, PhotoCache.Meta(title, PhotoCache.OK, count, if (filling || refresh) now else before?.fetchedAt ?: now))
        }
    }
}

// ------------------------------------------------------------------ drawing

object PhotoRender {
    /**
     * The most pixels a widget's picture has (about 600×600). It goes to the
     * home screen inside the widget's update, so it stays small: ~1.4 MB of
     * memory at most, however big the widget is.
     */
    const val MAX_PIXELS = 360_000

    fun path(shape: PhotoShape, w: Float, h: Float): Path {
        val pts = PhotoShapes.outline(shape, w, h)
        val path = Path()
        if (pts.size < 6) return path
        path.moveTo(pts[0], pts[1])
        for (i in 2 until pts.size step 2) path.lineTo(pts[i], pts[i + 1])
        path.close()
        return path
    }

    /** Read a saved photo no bigger than it needs to be for a [w]×[h] widget. */
    fun load(file: File, w: Int, h: Int): Bitmap? = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0) return null
        val (fw, fh) = PhotoShapes.fit(w, h, MAX_PIXELS)
        BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = PhotoShapes.sample(bounds.outWidth, bounds.outHeight, max(fw, fh)) })
    }.getOrNull()

    /**
     * [src] cut to the shape, see-through outside, for a widget of [w]×[h]
     * pixels. It fills the shape, cropped round [focus] (the people and pets
     * in it; the middle when there's none) — or, with [whole], all of it is
     * shown inside the shape with a soft, dimmed copy of itself behind.
     */
    fun cut(src: Bitmap, shape: PhotoShape, w: Int, h: Int, focus: PhotoShapes.Focus? = null, whole: Boolean = false): Bitmap {
        val (fw, fh) = PhotoShapes.fit(w, h, MAX_PIXELS)
        val out = Bitmap.createBitmap(fw, fh, Bitmap.Config.ARGB_8888)
        val box = PhotoShapes.box(shape, fw.toFloat(), fh.toFloat())
        val to = RectF(box.left, box.top, box.right, box.bottom)
        val bw = max(box.width.roundToInt(), 1)
        val bh = max(box.height.roundToInt(), 1)
        val fill = if (whole) wholeIn(src, shape, fw, fh, focus) else null
        val from = fill ?: src
        val shader = BitmapShader(from, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
        if (fill == null) {
            val crop = PhotoShapes.cover(src.width, src.height, bw, bh, focus)
            shader.setLocalMatrix(Matrix().apply {
                setRectToRect(RectF(crop[0].toFloat(), crop[1].toFloat(), crop[2].toFloat(), crop[3].toFloat()), to, Matrix.ScaleToFit.FILL)
            })
        }
        val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply { this.shader = shader }
        Canvas(out).drawPath(path(shape, fw.toFloat(), fh.toFloat()), paint)
        fill?.recycle()
        return out
    }

    /** A small, blurred copy of [src] (its own picture: [src] is left as it is). */
    private fun soft(src: Bitmap): Bitmap {
        val k = BLUR_EDGE.toFloat() / max(src.width, src.height)
        val w = max((src.width * k).roundToInt(), 2)
        val h = max((src.height * k).roundToInt(), 2)
        // Down by halves: one big step skips most of the photo's pixels.
        var step = src
        while (step.width / 2 >= w * 2 && step.height / 2 >= h * 2) {
            val half = Bitmap.createScaledBitmap(step, step.width / 2, step.height / 2, true)
            if (step !== src) step.recycle()
            step = half
        }
        val small = Bitmap.createScaledBitmap(step, w, h, true).copy(Bitmap.Config.ARGB_8888, true)
        if (step !== src) step.recycle()
        val px = IntArray(w * h)
        small.getPixels(px, 0, w, 0, 0, w, h)
        val tmp = IntArray(w * h)
        repeat(3) {
            smear(px, tmp, w, h, across = true)
            smear(tmp, px, w, h, across = false)
        }
        small.setPixels(px, 0, w, 0, 0, w, h)
        return small
    }

    /** One pass of the blur: each pixel becomes the average of its neighbours along a row (or down a column). */
    private fun smear(from: IntArray, to: IntArray, w: Int, h: Int, across: Boolean) {
        val lines = if (across) h else w
        val len = if (across) w else h
        for (line in 0 until lines) for (i in 0 until len) {
            var r = 0
            var g = 0
            var b = 0
            for (d in -BLUR_REACH..BLUR_REACH) {
                val j = (i + d).coerceIn(0, len - 1)
                val c = from[if (across) line * w + j else j * w + line]
                r += (c shr 16) and 0xFF
                g += (c shr 8) and 0xFF
                b += c and 0xFF
            }
            val n = 2 * BLUR_REACH + 1
            to[if (across) line * w + i else i * w + line] = (0xFF shl 24) or ((r / n) shl 16) or ((g / n) shl 8) or (b / n)
        }
    }

    /** The blurred copy's long edge: it's blurred this small, then stretched. */
    private const val BLUR_EDGE = 48

    /** How far each of the three passes of the blur reaches, in the small copy's pixels. */
    private const val BLUR_REACH = 2

    /** How much darker the copy behind is (0–255 of black over it). */
    private const val DIM = 0x66

    /**
     * The whole widget as a plain rectangle, before the shape is cut: the
     * photo, all of it, where it fits inside the shape; behind it the same
     * photo filling the shape's box, blurred and dimmed.
     */
    private fun wholeIn(src: Bitmap, shape: PhotoShape, fw: Int, fh: Int, focus: PhotoShapes.Focus?): Bitmap {
        val layer = Bitmap.createBitmap(fw, fh, Bitmap.Config.ARGB_8888)
        val c = Canvas(layer)
        val smooth = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        val box = PhotoShapes.box(shape, fw.toFloat(), fh.toFloat())
        val to = RectF(box.left, box.top, box.right, box.bottom)
        val at = PhotoShapes.inside(shape, fw.toFloat(), fh.toFloat(), src.width, src.height)
        val photo = RectF(at.left, at.top, at.right, at.bottom)
        // Nothing shows behind a photo that fills its box already.
        if (photo.width() < to.width() - 1f || photo.height() < to.height() - 1f || shape != PhotoShape.ROUNDED) {
            val soft = soft(src)
            val crop = PhotoShapes.cover(soft.width, soft.height, max(to.width().roundToInt(), 1), max(to.height().roundToInt(), 1), focus)
            c.drawBitmap(soft, Rect(crop[0], crop[1], crop[2], crop[3]), to, smooth)
            c.drawColor(DIM shl 24)
            soft.recycle()
        }
        c.drawBitmap(src, null, photo, smooth)
        return layer
    }

    /** A made-up picture (a sunset over hills) for the widget picker — never anyone's photo. */
    fun sample(w: Int, h: Int): Bitmap {
        val bmp = Bitmap.createBitmap(max(w, 1), max(h, 1), Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val fw = bmp.width.toFloat()
        val fh = bmp.height.toFloat()
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.shader = LinearGradient(0f, 0f, 0f, fh, intArrayOf(0xFF6FA8DC.toInt(), 0xFFF6C9A0.toInt(), 0xFFE9967A.toInt()), floatArrayOf(0f, 0.6f, 1f), Shader.TileMode.CLAMP)
        c.drawRect(0f, 0f, fw, fh, paint)
        paint.shader = null
        paint.color = 0xFFFFF1C9.toInt()
        c.drawCircle(fw * 0.66f, fh * 0.46f, minOf(fw, fh) * 0.13f, paint)
        paint.color = 0xFFB85A3C.toInt()
        c.drawOval(RectF(-fw * 0.3f, fh * 0.6f, fw * 0.75f, fh * 1.4f), paint)
        paint.color = 0xFF7A3B2A.toInt()
        c.drawOval(RectF(fw * 0.35f, fh * 0.7f, fw * 1.4f, fh * 1.5f), paint)
        return bmp
    }
}

// ------------------------------------------------------------------ the widget

/** What a Photo widget has to show. */
sealed interface PhotoView {
    /** No album chosen yet. */
    data object Pick : PhotoView
    class Gone(val title: String) : PhotoView
    class Empty(val title: String, val albumId: String) : PhotoView
    class Waiting(val title: String) : PhotoView
    class Showing(val picture: Bitmap, val title: String, val albumId: String, val tapNext: Boolean) : PhotoView
}

class PhotoWidget : GlanceAppWidget() {
    // The picture is drawn for the widget's own size, so it's sharp and the shape is right at any size.
    override val sizeMode = SizeMode.Exact
    override val stateDefinition: GlanceStateDefinition<*> = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        WidgetStore.load(context)
        val widgetId = runCatching { GlanceAppWidgetManager(context).getAppWidgetId(id) }.getOrDefault(AppWidgetManager.INVALID_APPWIDGET_ID)
        provideContent {
            // Redrawn with the others (after a sync, at the half hour): read so this recomposes then.
            WidgetStore.state.collectAsState().value
            val prefs = currentState<Preferences>()
            val ctx = LocalContext.current
            val link = Widgets.link(ctx)
            if (link != Link.LINKED) {
                LinkMessage(ctx, link)
            } else {
                val (w, h) = pixels(ctx)
                PhotoContent(view(ctx, prefs, w, h), widgetId)
            }
        }
    }

    override suspend fun providePreview(context: Context, widgetCategory: Int) {
        provideContent {
            val (w, h) = pixels(context)
            val side = minOf(w, h)
            PhotoContent(PhotoView.Showing(PhotoRender.cut(PhotoRender.sample(side, side), PhotoShape.HEART, side, side), "Biscuit", "", tapNext = false), AppWidgetManager.INVALID_APPWIDGET_ID)
        }
    }

    companion object {
        val ALBUM_ID = stringPreferencesKey("album_id")
        val ALBUM_TITLE = stringPreferencesKey("album_title")
        val SHAPE = stringPreferencesKey("shape")
        val FIT = stringPreferencesKey("fit")
        val TAP = stringPreferencesKey("tap")
        val CURRENT = stringPreferencesKey("photo_id")
        val RECENT = stringPreferencesKey("recent")
        val SHOWN_AT = longPreferencesKey("shown_at")

        /** Fill the shape (cropped round the subject), or show the whole photo inside it. */
        const val FIT_FILL = "fill"
        const val FIT_WHOLE = "whole"

        const val TAP_NEXT = "next"
        const val TAP_OPEN = "open"

        /** A new photo this often. */
        const val EVERY_MS = 30 * 60 * 1000L

        private const val PREFS = "widgets"
        private const val NEXT_AT = "photo_next"

        @Composable
        private fun pixels(ctx: Context): Pair<Int, Int> {
            val size = LocalSize.current
            val density = ctx.resources.displayMetrics.density
            return max((size.width.value * density).roundToInt(), 48) to max((size.height.value * density).roundToInt(), 48)
        }

        /** What this widget shows right now, from its settings and the saved photos (no network). */
        fun view(ctx: Context, prefs: Preferences, w: Int, h: Int): PhotoView {
            val album = prefs[ALBUM_ID]?.ifBlank { null } ?: return PhotoView.Pick
            val meta = PhotoCache.meta(ctx, album)
            val title = meta?.title?.ifBlank { null } ?: prefs[ALBUM_TITLE].orEmpty()
            if (meta?.state == PhotoCache.GONE) return PhotoView.Gone(title)
            if (meta?.state == PhotoCache.EMPTY) return PhotoView.Empty(title, album)
            val ids = PhotoCache.ids(ctx, album)
            // The one chosen for now; before the first choice (or if it was let go), any saved one.
            val id = prefs[CURRENT]?.takeIf { it in ids } ?: ids.firstOrNull() ?: return PhotoView.Waiting(title)
            val src = PhotoRender.load(PhotoCache.file(ctx, album, id), w, h) ?: return PhotoView.Waiting(title)
            val cut = PhotoRender.cut(src, PhotoShape.of(prefs[SHAPE]), w, h, PhotoCache.focus(ctx, album, id), whole = prefs[FIT] == FIT_WHOLE)
            src.recycle()
            return PhotoView.Showing(cut, title, album, tapNext = prefs[TAP] != TAP_OPEN)
        }

        private suspend fun each(ctx: Context): List<Pair<GlanceId, Preferences>> = runCatching {
            GlanceAppWidgetManager(ctx).getGlanceIds(PhotoWidget::class.java).map { it to getAppWidgetState(ctx, PreferencesGlanceStateDefinition, it) }
        }.getOrDefault(emptyList())

        /** The albums the Photo widgets on the home screen show. */
        suspend fun albums(ctx: Context): List<String> = each(ctx).mapNotNull { it.second[ALBUM_ID]?.ifBlank { null } }.distinct()

        /** The photos on the widgets right now (kept on the phone while they are). */
        suspend fun showing(ctx: Context): Set<String> = each(ctx).mapNotNull { it.second[CURRENT] }.toSet()

        /** Move one widget on to another saved photo; false when there's nothing else to show. */
        suspend fun advance(ctx: Context, id: GlanceId, prefs: Preferences, now: Long): Boolean {
            val album = prefs[ALBUM_ID]?.ifBlank { null } ?: return false
            val ids = PhotoCache.ids(ctx, album)
            if (ids.isEmpty()) return false
            val current = prefs[CURRENT]
            val recent = prefs[RECENT].orEmpty().split(',').filter { it.isNotBlank() }
            // Ones that suit this widget's shape, while there are enough of them.
            val pool = suited(ctx, album, ids, box(ctx, id, prefs))
            val next = PhotoPick.next(pool, current, recent) ?: return false
            updateAppWidgetState(ctx, PreferencesGlanceStateDefinition, id) { p ->
                p.toMutablePreferences().apply {
                    this[CURRENT] = next
                    this[SHOWN_AT] = now
                    this[RECENT] = PhotoPick.remember(recent, next, pool.size).joinToString(",")
                }
            }
            return next != current
        }

        /** The saved photos that suit a box of [box]'s proportions (all of them when it isn't known). */
        fun suited(ctx: Context, album: String, ids: List<String>, box: Pair<Int, Int>?): List<String> {
            val (bw, bh) = box ?: return ids
            return PhotoPick.suited(ids) { id ->
                val (pw, ph) = PhotoCache.size(ctx, album, id) ?: return@suited 1f
                PhotoShapes.suits(pw, ph, bw, bh, PhotoCache.focus(ctx, album, id))
            }
        }

        /**
         * The proportions of the box this widget crops photos to: a square
         * for the shapes that keep theirs, the widget's own size for the ones
         * that fill it. Null when nothing is cropped (whole photos) or the
         * home screen hasn't said how big the widget is.
         */
        private suspend fun box(ctx: Context, id: GlanceId, prefs: Preferences): Pair<Int, Int>? {
            if (prefs[FIT] == FIT_WHOLE) return null
            if (!PhotoShape.of(prefs[SHAPE]).fills) return 1 to 1
            val sizes = runCatching { GlanceAppWidgetManager(ctx).getAppWidgetSizes(id) }.getOrDefault(emptyList())
            // The home screen gives the size upright and on its side: the narrower is upright.
            val landscape = ctx.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
            val size = (if (landscape) sizes.maxByOrNull { it.width.value } else sizes.minByOrNull { it.width.value }) ?: return null
            val w = size.width.value.roundToInt()
            val h = size.height.value.roundToInt()
            return if (w > 0 && h > 0) w to h else null
        }

        /**
         * Give every widget whose half hour is up (or whose photo has gone) its
         * next photo, and note when the next change is due. No network; the
         * caller redraws.
         */
        suspend fun rotate(ctx: Context, now: Long) {
            var soonest = 0L
            for ((id, prefs) in each(ctx)) {
                val album = prefs[ALBUM_ID]?.ifBlank { null } ?: continue
                val ids = PhotoCache.ids(ctx, album)
                if (ids.isEmpty()) continue
                var shownAt = prefs[SHOWN_AT] ?: 0L
                if (prefs[CURRENT] !in ids || PhotoPick.due(shownAt, now, EVERY_MS)) {
                    advance(ctx, id, prefs, now)
                    shownAt = now
                }
                if (ids.size > 1) soonest = if (soonest == 0L) shownAt + EVERY_MS else minOf(soonest, shownAt + EVERY_MS)
            }
            ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(NEXT_AT, soonest).apply()
        }

        /** When the next photo change is due (0: none) — [Boundaries] wakes the widgets then. */
        fun nextAt(ctx: Context): Long = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(NEXT_AT, 0L)
    }
}

class PhotoWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = PhotoWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        Widgets.onEnabled(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        Widgets.onDisabled(context)
    }
}

/** A tap on the photo: another one, now. */
class NextPhoto : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val prefs = getAppWidgetState(context, PreferencesGlanceStateDefinition, glanceId)
        PhotoWidget.advance(context, glanceId, prefs, System.currentTimeMillis())
        PhotoWidget().update(context, glanceId)
        PhotoWidget.rotate(context, System.currentTimeMillis())
        Boundaries.schedule(context)
    }
}

/** The Photo widget's settings (album and shape), from a tap on the widget. */
fun pickAlbum(ctx: Context, widgetId: Int): Intent =
    Intent(ctx, PhotoConfigActivity::class.java)
        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
        .setData(Uri.parse("promptly-widget://pick-album/$widgetId"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

/** An album's page in P Photos. */
fun albumPath(id: String?): String =
    if (id.isNullOrBlank() || id.any { !(it.isLetterOrDigit() || it == '-') }) "/photos/albums" else "/photos/albums/$id"

@Composable
private fun PhotoMessage(title: String, hint: String, action: Action?) {
    Frame {
        Column(
            GlanceModifier.fillMaxSize().then(if (action != null) GlanceModifier.clickable(action) else GlanceModifier),
            verticalAlignment = Alignment.CenterVertically, horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Image(ImageProvider(R.drawable.wg_photo), contentDescription = null, modifier = GlanceModifier.size(26.dp), colorFilter = ColorFilter.tint(WColors.accent))
            Spacer(GlanceModifier.height(6.dp))
            Text(title, style = WText.style(14.sp, bold = true).copy(textAlign = TextAlign.Center), maxLines = 2)
            Spacer(GlanceModifier.height(2.dp))
            Text(hint, style = WText.style(12.sp, WColors.muted).copy(textAlign = TextAlign.Center), maxLines = 3)
        }
    }
}

@Composable
fun PhotoContent(view: PhotoView, widgetId: Int) {
    val ctx = LocalContext.current
    val pick = if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) actionStartActivity(pickAlbum(ctx, widgetId)) else null
    when (view) {
        PhotoView.Pick -> PhotoMessage("Pick an album", "Tap to choose the photos to show here.", pick)
        is PhotoView.Gone -> PhotoMessage("This album isn't available", "It was deleted, or isn't shared with you any more. Tap to pick another.", pick)
        is PhotoView.Empty -> PhotoMessage(
            if (view.title.isBlank()) "No photos yet" else "No photos in ${view.title} yet",
            "Add some in P Photos and they'll show here.",
            actionStartActivity(Open.page(ctx, Open.PHOTOS, albumPath(view.albumId))),
        )
        is PhotoView.Waiting -> PhotoMessage(view.title.ifBlank { "Getting your photos…" }, if (view.title.isBlank()) "They show once the phone has synced." else "Getting your photos…", actionRunCallback<RefreshNow>())
        is PhotoView.Showing -> {
            val tap = when {
                view.albumId.isBlank() -> GlanceModifier
                view.tapNext -> GlanceModifier.clickable(actionRunCallback<NextPhoto>())
                else -> GlanceModifier.clickable(actionStartActivity(Open.page(ctx, Open.PHOTOS, albumPath(view.albumId))))
            }
            val about = when {
                view.title.isBlank() -> "A photo"
                view.tapNext -> "A photo from ${view.title}. Tap for another."
                else -> "A photo from ${view.title}. Tap to open the album."
            }
            // No background: outside the shape, the wallpaper shows through.
            Box(GlanceModifier.fillMaxSize().then(tap).semantics { contentDescription = about }, contentAlignment = Alignment.Center) {
                Image(ImageProvider(view.picture), contentDescription = null, modifier = GlanceModifier.fillMaxSize(), contentScale = ContentScale.Fit)
            }
        }
    }
}
