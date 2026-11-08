package org.promptly.sync.maps.offline

import android.database.sqlite.SQLiteDatabase
import java.io.File

/** Every downloaded square's search in one database, `search.db`, with one FTS4
 *  index (unicode61) over place names. Each square's rows keep their own id range
 *  ([Cells.idRange]: the square's number in the top 32 bits, the server's row id
 *  below), so a square is added, replaced or removed on its own.
 *
 *  Tables (lat, lon in microdegrees, as the server's files):
 *  - `places(id, cell, type street|locality|place, name, alt, kind, number, street, locality, state, postcode, lat, lon, rank)`
 *  - `places_fts` FTS4 over places(name, alt, street, locality), docid = places.id
 *  - `streets(id, cell, name, locality, state, postcode)` and
 *    `addresses(street, number, lat, lon)` (house numbers; street = streets.id)
 *  - `squares(cell, places_sha, addresses_sha, places, addresses)`: what's in. */
class SearchDb(val file: File) {

    private fun open(): SQLiteDatabase {
        file.parentFile?.mkdirs()
        val db = SQLiteDatabase.openOrCreateDatabase(file, null)
        if (db.version < VERSION) {
            // Before any table: space freed by a removed square goes back to the phone.
            db.rawQuery("PRAGMA auto_vacuum = INCREMENTAL", null).use { c -> while (c.moveToNext()) Unit }
            db.beginTransaction()
            try {
                SCHEMA.forEach(db::execSQL)
                db.version = VERSION
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
        }
        return db
    }

    private inline fun <T> use(block: (SQLiteDatabase) -> T): T {
        val db = open()
        try {
            return block(db)
        } finally {
            db.close()
        }
    }

    /** Replaces a square's places with those in [source] (the server's `places.sqlite`). */
    fun putPlaces(cell: String, source: File, sha: String) = use { db ->
        val range = Cells.idRange(cell)
        val base = range.first
        attach(db, source) {
            db.beginTransaction()
            try {
                dropPlaces(db, cell)
                db.execSQL(
                    "INSERT INTO places(id, cell, type, name, alt, kind, number, street, locality, state, postcode, lat, lon, rank) " +
                        "SELECT ? + id, ?, type, name, alt, kind, number, street, locality, state, postcode, lat, lon, rank FROM src.places",
                    arrayOf<Any>(base, cell),
                )
                db.execSQL(
                    "INSERT INTO places_fts(docid, name, alt, street, locality) " +
                        "SELECT id, name, alt, street, locality FROM places WHERE id BETWEEN ? AND ?",
                    arrayOf<Any>(range.first, range.last),
                )
                val count = count(db, "SELECT count(*) FROM places WHERE id BETWEEN ? AND ?", range)
                // No upsert: Android 10's SQLite (3.22) is older than it.
                db.execSQL("INSERT OR IGNORE INTO squares(cell) VALUES(?)", arrayOf<Any>(cell))
                db.execSQL("UPDATE squares SET places_sha = ?, places = ? WHERE cell = ?", arrayOf<Any>(sha, count, cell))
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
        }
    }

    /** Replaces a square's streets and house numbers with those in [source] (`addresses.sqlite`). */
    fun putAddresses(cell: String, source: File, sha: String) = use { db ->
        val range = Cells.idRange(cell)
        attach(db, source) {
            db.beginTransaction()
            try {
                dropAddresses(db, cell)
                db.execSQL(
                    "INSERT INTO streets(id, cell, name, locality, state, postcode) SELECT ? + id, ?, name, locality, state, postcode FROM src.streets",
                    arrayOf<Any>(range.first, cell),
                )
                db.execSQL(
                    "INSERT OR IGNORE INTO addresses(street, number, lat, lon) SELECT ? + street, number, lat, lon FROM src.addresses",
                    arrayOf<Any>(range.first),
                )
                val count = count(db, "SELECT count(*) FROM addresses WHERE street BETWEEN ? AND ?", range)
                db.execSQL("INSERT OR IGNORE INTO squares(cell) VALUES(?)", arrayOf<Any>(cell))
                db.execSQL("UPDATE squares SET addresses_sha = ?, addresses = ? WHERE cell = ?", arrayOf<Any>(sha, count, cell))
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
        }
    }

    /** Takes a square out (all of it, or only its house numbers). */
    fun remove(cell: String, onlyAddresses: Boolean = false) {
        if (!file.exists()) return
        use { db ->
            db.beginTransaction()
            try {
                dropAddresses(db, cell)
                if (onlyAddresses) {
                    db.execSQL("UPDATE squares SET addresses_sha = NULL, addresses = 0 WHERE cell = ?", arrayOf<Any>(cell))
                } else {
                    dropPlaces(db, cell)
                    db.execSQL("DELETE FROM squares WHERE cell = ?", arrayOf<Any>(cell))
                }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            // Hand the freed pages back to the phone.
            db.rawQuery("PRAGMA incremental_vacuum", null).use { c -> while (c.moveToNext()) Unit }
        }
    }

    data class Square(val cell: String, val placesSha: String?, val addressesSha: String?, val places: Long, val addresses: Long)

    fun squares(): Map<String, Square> {
        if (!file.exists()) return emptyMap()
        return use { db ->
            db.rawQuery("SELECT cell, places_sha, addresses_sha, places, addresses FROM squares", null).use { c ->
                buildMap {
                    while (c.moveToNext()) {
                        put(c.getString(0), Square(c.getString(0), c.getString(1), c.getString(2), c.getLong(3), c.getLong(4)))
                    }
                }
            }
        }
    }

    private fun dropPlaces(db: SQLiteDatabase, cell: String) {
        val r = Cells.idRange(cell)
        // The index first: an FTS4 table over external content reads the old row to remove it.
        db.execSQL("DELETE FROM places_fts WHERE docid BETWEEN ? AND ?", arrayOf<Any>(r.first, r.last))
        db.execSQL("DELETE FROM places WHERE id BETWEEN ? AND ?", arrayOf<Any>(r.first, r.last))
        db.execSQL("UPDATE squares SET places_sha = NULL, places = 0 WHERE cell = ?", arrayOf<Any>(cell))
    }

    private fun dropAddresses(db: SQLiteDatabase, cell: String) {
        val r = Cells.idRange(cell)
        db.execSQL("DELETE FROM addresses WHERE street BETWEEN ? AND ?", arrayOf<Any>(r.first, r.last))
        db.execSQL("DELETE FROM streets WHERE id BETWEEN ? AND ?", arrayOf<Any>(r.first, r.last))
    }

    private fun count(db: SQLiteDatabase, sql: String, range: LongRange): Long =
        db.rawQuery(sql, arrayOf(range.first.toString(), range.last.toString())).use { c -> if (c.moveToFirst()) c.getLong(0) else 0 }

    private inline fun attach(db: SQLiteDatabase, source: File, block: () -> Unit) {
        db.execSQL("ATTACH DATABASE ? AS src", arrayOf<Any>(source.absolutePath))
        try {
            val format = db.rawQuery("SELECT v FROM src.meta WHERE k = 'format'", null).use { c -> if (c.moveToFirst()) c.getString(0) else null }
            if (format != null && format != "1") throw java.io.IOException("This server's search files are newer than this app. Update Promptly.")
            block()
        } finally {
            db.execSQL("DETACH DATABASE src")
        }
    }

    companion object {
        private const val VERSION = 1
        private val SCHEMA = listOf(
            "CREATE TABLE IF NOT EXISTS places(id INTEGER PRIMARY KEY, cell TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, " +
                "alt TEXT, kind TEXT, number TEXT, street TEXT, locality TEXT, state TEXT, postcode TEXT, " +
                "lat INTEGER NOT NULL, lon INTEGER NOT NULL, rank INTEGER NOT NULL)",
            "CREATE INDEX IF NOT EXISTS places_kind ON places(kind) WHERE kind IS NOT NULL",
            "CREATE VIRTUAL TABLE IF NOT EXISTS places_fts USING fts4(content=\"places\", name, alt, street, locality, tokenize=unicode61)",
            "CREATE TABLE IF NOT EXISTS streets(id INTEGER PRIMARY KEY, cell TEXT NOT NULL, name TEXT NOT NULL, locality TEXT, state TEXT, postcode TEXT)",
            "CREATE INDEX IF NOT EXISTS streets_name ON streets(name COLLATE NOCASE, locality COLLATE NOCASE)",
            "CREATE TABLE IF NOT EXISTS addresses(street INTEGER NOT NULL, number TEXT NOT NULL, lat INTEGER NOT NULL, lon INTEGER NOT NULL, " +
                "PRIMARY KEY(street, number)) WITHOUT ROWID",
            "CREATE TABLE IF NOT EXISTS squares(cell TEXT PRIMARY KEY, places_sha TEXT, addresses_sha TEXT, places INTEGER NOT NULL DEFAULT 0, " +
                "addresses INTEGER NOT NULL DEFAULT 0)",
        )
    }
}
