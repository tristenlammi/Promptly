package org.promptly.sync

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import java.io.InputStream
import java.security.MessageDigest

/** A photo or video on the phone. */
data class Item(
    val id: Long,
    val uri: Uri,
    val name: String,
    val mime: String,
    val size: Long,
    /** Seconds. */
    val modified: Long,
    val bucket: String,
    /** When it was taken (ms), if the phone knows. */
    val taken: Long? = null,
) {
    /** Changes when the file does — an edited photo is sent again. */
    val sig: String get() = "$size:$modified"
}

data class Bucket(val id: String, val name: String, val count: Int)

object Media {
    private fun collections(): List<Uri> = if (Build.VERSION.SDK_INT >= 29) {
        listOf(
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL),
            MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL),
        )
    } else {
        listOf(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, MediaStore.Video.Media.EXTERNAL_CONTENT_URI)
    }

    /** Each folder with photos or videos in it, biggest first (Camera first). */
    fun buckets(context: Context): List<Bucket> {
        val seen = HashMap<String, Pair<String, Int>>()
        for (item in items(context, null)) {
            val (name, n) = seen[item.bucket] ?: Pair(names[item.bucket] ?: "Folder", 0)
            seen[item.bucket] = Pair(name, n + 1)
        }
        return seen.map { (id, v) -> Bucket(id, v.first, v.second) }
            .sortedWith(compareByDescending<Bucket> { it.name.equals("Camera", true) }.thenByDescending { it.count })
    }

    /** Bucket id → its name, as last seen by [items]. */
    private val names = HashMap<String, String>()

    /** Where MediaStore is now — `(version, generation)` — when this phone can
     *  say (Android 11+, photos on the phone itself, no SD card). */
    fun position(context: Context): Pair<String, Long>? {
        if (Build.VERSION.SDK_INT < 30) return null
        if (MediaStore.getExternalVolumeNames(context) != setOf(MediaStore.VOLUME_EXTERNAL_PRIMARY)) return null
        return Pair(
            MediaStore.getVersion(context, MediaStore.VOLUME_EXTERNAL_PRIMARY),
            MediaStore.getGeneration(context, MediaStore.VOLUME_EXTERNAL_PRIMARY),
        )
    }

    /** Everything in these folders (or all, for null), oldest first — or, with
     *  [since], only what was added or changed after that generation. */
    fun items(context: Context, buckets: Set<String>?, since: Long? = null): List<Item> {
        val out = ArrayList<Item>()
        val cols = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED,
            "bucket_id",
            "bucket_display_name",
            "datetaken",
        )
        val clauses = ArrayList<String>()
        val args = ArrayList<String>()
        if (Build.VERSION.SDK_INT >= 29) clauses += "${MediaStore.MediaColumns.IS_PENDING} = 0"
        if (since != null && Build.VERSION.SDK_INT >= 30) {
            clauses += "${MediaStore.MediaColumns.GENERATION_MODIFIED} > ?"
            args += since.toString()
        }
        val where = clauses.joinToString(" AND ").ifEmpty { null }
        for (collection in collections()) {
            context.contentResolver.query(collection, cols, where, args.toTypedArray().ifEmpty { null }, "${MediaStore.MediaColumns.DATE_ADDED} ASC")
                ?.use { c ->
                    while (c.moveToNext()) {
                        val bucket = c.getString(5) ?: continue
                        names[bucket] = c.getString(6) ?: "Folder"
                        if (buckets != null && bucket !in buckets) continue
                        val size = c.getLong(3)
                        if (size <= 0) continue
                        val id = c.getLong(0)
                        out += Item(
                            id = id,
                            uri = Uri.withAppendedPath(collection, id.toString()),
                            name = c.getString(1) ?: "$id",
                            mime = c.getString(2) ?: "application/octet-stream",
                            size = size,
                            modified = c.getLong(4),
                            bucket = bucket,
                            taken = if (c.isNull(7)) null else c.getLong(7).takeIf { it > 0 },
                        )
                    }
                }
        }
        return out
    }

    /** The file as it was taken — with where it was taken, when allowed. */
    fun open(context: Context, item: Item): InputStream {
        if (Build.VERSION.SDK_INT >= 29) {
            runCatching {
                return context.contentResolver.openInputStream(MediaStore.setRequireOriginal(item.uri))!!
            }
        }
        return context.contentResolver.openInputStream(item.uri) ?: error("Can't read ${item.name}")
    }

    fun sha256(context: Context, item: Item): String {
        val md = MessageDigest.getInstance("SHA-256")
        open(context, item).use { s ->
            val buf = ByteArray(1 shl 18) // fewer, bigger reads
            while (true) {
                val n = s.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}

/** What's been sent (or refused), and uploads under way. */
class Ledger(context: Context) : SQLiteOpenHelper(context.applicationContext, "ledger.db", null, 2) {
    override fun onCreate(db: SQLiteDatabase) {
        // state: 'done' (on the server), 'refused' (the server said no; not
        // retried until it changes) or 'deleted' (deleted in Promptly).
        db.execSQL("CREATE TABLE sent (media_id INTEGER PRIMARY KEY, sig TEXT NOT NULL, state TEXT NOT NULL, note TEXT, sha TEXT)")
        db.execSQL("CREATE TABLE pending (media_id INTEGER PRIMARY KEY, sig TEXT NOT NULL, sha TEXT, location TEXT)")
    }

    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) {
        if (old < 2) db.execSQL("ALTER TABLE sent ADD COLUMN sha TEXT")
    }

    /** media id → SHA-256 of what was sent, for those that are on the server. */
    fun doneHashes(): Map<Long, Pair<String, String?>> {
        val out = HashMap<Long, Pair<String, String?>>()
        readableDatabase.rawQuery("SELECT media_id, sig, sha FROM sent WHERE state = 'done'", null).use { c ->
            while (c.moveToNext()) out[c.getLong(0)] = Pair(c.getString(1), c.getString(2))
        }
        return out
    }

    fun saveHash(item: Item, sha: String) {
        writableDatabase.execSQL("UPDATE sent SET sha = ? WHERE media_id = ? AND sig = ?", arrayOf<Any>(sha, item.id, item.sig))
    }

    /** media id → sig, for everything settled. */
    fun settled(): Map<Long, String> {
        val out = HashMap<Long, String>()
        readableDatabase.rawQuery("SELECT media_id, sig FROM sent", null).use { c ->
            while (c.moveToNext()) out[c.getLong(0)] = c.getString(1)
        }
        return out
    }

    fun count(state: String, ids: Collection<Long>? = null): Int {
        if (ids == null) {
            readableDatabase.rawQuery("SELECT COUNT(*) FROM sent WHERE state = ?", arrayOf(state)).use { c ->
                return if (c.moveToFirst()) c.getInt(0) else 0
            }
        }
        val set = ids.toHashSet()
        var n = 0
        readableDatabase.rawQuery("SELECT media_id FROM sent WHERE state = ?", arrayOf(state)).use { c ->
            while (c.moveToNext()) if (c.getLong(0) in set) n++
        }
        return n
    }

    fun settle(item: Item, state: String, note: String? = null, sha: String? = null) {
        val db = writableDatabase
        db.insertWithOnConflict("sent", null, ContentValues().apply {
            put("media_id", item.id); put("sig", item.sig); put("state", state); put("note", note); put("sha", sha)
        }, SQLiteDatabase.CONFLICT_REPLACE)
        db.delete("pending", "media_id = ?", arrayOf(item.id.toString()))
    }

    data class Pending(val sha: String?, val location: String?)

    fun pending(item: Item): Pending? {
        readableDatabase.rawQuery(
            "SELECT sha, location FROM pending WHERE media_id = ? AND sig = ?", arrayOf(item.id.toString(), item.sig)
        ).use { c -> return if (c.moveToFirst()) Pending(c.getString(0), c.getString(1)) else null }
    }

    fun savePending(item: Item, sha: String?, location: String?) {
        writableDatabase.insertWithOnConflict("pending", null, ContentValues().apply {
            put("media_id", item.id); put("sig", item.sig); put("sha", sha); put("location", location)
        }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun reset() {
        writableDatabase.delete("sent", null, null)
        writableDatabase.delete("pending", null, null)
    }
}
