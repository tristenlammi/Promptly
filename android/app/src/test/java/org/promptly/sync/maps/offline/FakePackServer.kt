package org.promptly.sync.maps.offline

import android.database.sqlite.SQLiteDatabase
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

/** A stand-in for the server's offline API and its signed `/m/` links: real HTTP on
 *  localhost, Range requests, and switches to misbehave (cut a download short, send
 *  damaged bytes, let links run out, go live with a new build mid-download). */
class FakePackServer(private val work: File) : AutoCloseable {
    class Pack(val cell: String?, val kind: String, val tile: Int?, val bytes: ByteArray) {
        val sha: String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val key: String get() = when (kind) {
            "l0" -> "l0/$tile"
            "cameras", "chargers" -> "base/$kind"
            else -> "$cell/$kind"
        }
    }

    /** The live build and its files, by key. */
    @Volatile var build = "build-1"
    @Volatile var packs: Map<String, Pack> = emptyMap()
    @Volatile var builtAt = "2026-11-03T23:45:00Z"

    /** Cut this file's body after so many bytes (once each), as a dropped connection does. */
    val cutAfter = Collections.synchronizedMap(mutableMapOf<String, Long>())
    /** Send this file with one byte changed, so many times. */
    val damage = Collections.synchronizedMap(mutableMapOf<String, Int>())
    /** Links issued before this count are out of date (404), as an expired link is. */
    @Volatile var linksValidFrom = 0
    /** Called as a file's body starts (to switch builds mid-download, say). */
    @Volatile var onServe: ((String) -> Unit)? = null

    val listings = AtomicInteger()
    val served = Collections.synchronizedList(mutableListOf<String>())
    val ranges = Collections.synchronizedList(mutableListOf<Pair<String, String?>>())

    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    val url: String get() = "http://127.0.0.1:${server.address.port}"

    init {
        server.createContext("/api/maps/offline/files") { ex -> handle(ex) { listing(it) } }
        server.createContext("/m/") { ex -> handle(ex) { file(it) } }
        server.executor = java.util.concurrent.Executors.newCachedThreadPool()
        server.start()
    }

    override fun close() = server.stop(0)

    private fun handle(ex: HttpExchange, block: (HttpExchange) -> Unit) {
        try {
            block(ex)
        } catch (_: java.io.IOException) {
            // A cut connection, on purpose.
        } finally {
            runCatching { ex.close() }
        }
    }

    private fun listing(ex: HttpExchange) {
        val q = ex.requestURI.rawQuery.split("&").associate { it.substringBefore("=") to URLDecoder.decode(it.substringAfter("="), "UTF-8") }
        val cells = q["cells"].orEmpty().split(",").filter { it.isNotEmpty() }
        val addresses = q["addresses"] == "1"
        val issue = listings.incrementAndGet()
        val files = JSONArray()
        val missing = JSONArray()
        val now = packs
        val l0 = sortedSetOf<Int>()
        for (c in cells) {
            val mine = now.values.filter { it.cell == c && (addresses || it.kind != "addresses") }
            if (mine.isEmpty()) { missing.put(c); continue }
            mine.sortedBy { it.kind }.forEach { files.put(row(it, issue)) }
            l0 += Cells.level0(c)
        }
        for (t in l0) now["l0/$t"]?.let { files.put(row(it, issue)) }
        now.values.filter { it.cell == null && it.kind != "l0" }.forEach { files.put(row(it, issue)) }
        val body = JSONObject().put("build", build).put("built_at", builtAt).put("expires_at", "2026-11-10T00:00:00Z")
            .put("files", files).put("missing", missing).toString().toByteArray()
        ex.responseHeaders.add("Content-Type", "application/json")
        ex.sendResponseHeaders(200, body.size.toLong())
        ex.responseBody.write(body)
    }

    private fun row(p: Pack, issue: Int) = JSONObject().put("cell", p.cell ?: JSONObject.NULL).put("kind", p.kind)
        .apply { if (p.tile != null) put("tile", p.tile) }
        .put("bytes", p.bytes.size).put("sha256", p.sha).put("url", "/m/$build/$issue/${p.key}")

    private fun file(ex: HttpExchange) {
        // /m/<build>/<issue>/<key…>
        val parts = ex.requestURI.path.removePrefix("/m/").split("/", limit = 3)
        val (linkBuild, issue, key) = Triple(parts[0], parts[1].toInt(), parts[2])
        val p = packs[key]
        if (linkBuild != build || issue < linksValidFrom || p == null) {
            ex.sendResponseHeaders(404, -1)
            return
        }
        onServe?.invoke(key)
        served += key
        val range = ex.requestHeaders.getFirst("Range")
        ranges += key to range
        var bytes = p.bytes
        synchronized(damage) {
            val left = damage[key] ?: 0
            if (left > 0) {
                damage[key] = left - 1
                bytes = bytes.copyOf().also { it[it.size / 2] = (it[it.size / 2] + 1).toByte() }
            }
        }
        var start = 0
        if (range != null) {
            start = range.removePrefix("bytes=").substringBefore("-").toInt()
            if (start >= bytes.size) {
                ex.sendResponseHeaders(416, -1)
                return
            }
            ex.responseHeaders.add("Content-Range", "bytes $start-${bytes.size - 1}/${bytes.size}")
            ex.sendResponseHeaders(206, (bytes.size - start).toLong())
        } else {
            ex.sendResponseHeaders(200, bytes.size.toLong())
        }
        val cut = cutAfter.remove(key)
        val end = if (cut != null) minOf(bytes.size.toLong(), start + cut).toInt() else bytes.size
        ex.responseBody.write(bytes, start, end - start)
        ex.responseBody.flush()
        // A cut connection: the body stops short of what the headers promised.
        if (cut != null) throw java.io.IOException("cut")
    }

    // ---- Building fake packs ------------------------------------------------------

    /** One square's files: a map, a routing tar, search. [seed] varies the bytes (a new build). */
    fun square(cell: String, seed: Int, mapBytes: Int = 600_000): List<Pack> {
        val r = Random(cell.hashCode() * 31 + seed)
        val c = Cells.parse(cell)!!
        val tiles = (0 until 3).map { i -> "2/000/${700 + (c.west + 180) % 100}/${c.south + 90}$i.gph" to r.nextBytes(40_000 + i * 1000) } +
            listOf("1/0${c.south + 90}/${c.west + 180}.gph" to r.nextBytes(30_000))
        return listOf(
            Pack(cell, "map", null, r.nextBytes(mapBytes)),
            Pack(cell, "route", null, tar(tiles)),
            Pack(cell, "places", null, places(cell, seed)),
            Pack(cell, "addresses", null, addresses(cell, seed)),
        )
    }

    fun level0(tile: Int, seed: Int) = Pack(null, "l0", tile, tar(listOf("0/00${tile / 1000}/${"%03d".format(tile % 1000)}.gph" to Random(tile + seed).nextBytes(50_000))))

    fun base(seed: Int) = listOf(
        Pack(null, "cameras", null, """{"cameras":[{"lat":-32.2,"lon":148.6,"seed":$seed}]}""".toByteArray()),
        Pack(null, "chargers", null, """{"chargers":[],"seed":$seed}""".toByteArray()),
    )

    /** Everything for these squares, as one build. */
    fun publish(build: String, seed: Int, vararg cells: String, sameRouteAs: Int? = null) {
        val all = mutableListOf<Pack>()
        for (c in cells) {
            val sq = square(c, seed)
            all += if (sameRouteAs != null) sq.map { if (it.kind == "route") square(c, sameRouteAs).first { k -> k.kind == "route" } else it } else sq
        }
        cells.map { Cells.level0(it) }.toSet().forEach { all += level0(it, sameRouteAs ?: seed) }
        all += base(seed)
        this.packs = all.associateBy { it.key }
        this.build = build
    }

    private var made = 0

    private fun places(cell: String, seed: Int): ByteArray {
        val f = File(work, "places-${made++}.sqlite")
        f.delete()
        SQLiteDatabase.openOrCreateDatabase(f, null).use { db ->
            db.execSQL("CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT)")
            db.execSQL(
                "CREATE TABLE places(id INTEGER PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, alt TEXT, kind TEXT, number TEXT, street TEXT, " +
                    "locality TEXT, state TEXT, postcode TEXT, lat INTEGER NOT NULL, lon INTEGER NOT NULL, rank INTEGER NOT NULL)",
            )
            db.execSQL("INSERT INTO meta VALUES('format','1'),('cell',?)", arrayOf(cell))
            db.execSQL("INSERT INTO places VALUES(1,'place','Caltex $cell',NULL,'amenity:fuel',NULL,'Macquarie Street','Dubbo','NSW','2830',-32250000,148600000,500)")
            db.execSQL("INSERT INTO places VALUES(2,'street','Macquarie Street',NULL,NULL,NULL,NULL,'Dubbo','NSW','2830',-32251000,148601000,300)")
            db.execSQL("INSERT INTO places VALUES(3,'locality','Seed$seed',NULL,NULL,NULL,NULL,NULL,'NSW',NULL,-32240000,148610000,900)")
        }
        return f.readBytes().also { f.delete() }
    }

    private fun addresses(cell: String, seed: Int): ByteArray {
        val f = File(work, "addresses-${made++}.sqlite")
        f.delete()
        SQLiteDatabase.openOrCreateDatabase(f, null).use { db ->
            db.execSQL("CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT)")
            db.execSQL("CREATE TABLE streets(id INTEGER PRIMARY KEY, name TEXT NOT NULL, locality TEXT, state TEXT, postcode TEXT)")
            db.execSQL("CREATE TABLE addresses(street INTEGER NOT NULL, number TEXT NOT NULL, lat INTEGER NOT NULL, lon INTEGER NOT NULL, PRIMARY KEY(street, number)) WITHOUT ROWID")
            db.execSQL("INSERT INTO meta VALUES('format','1'),('cell',?)", arrayOf(cell))
            db.execSQL("INSERT INTO streets VALUES(1,'Macquarie Street','Dubbo','NSW','2830')")
            for (n in 1..(10 + seed)) db.execSQL("INSERT INTO addresses VALUES(1,'$n',${-32250000 + n},${148600000 + n})")
        }
        return f.readBytes().also { f.delete() }
    }

    companion object {
        /** A plain ustar archive. */
        fun tar(members: List<Pair<String, ByteArray>>): ByteArray {
            val out = ByteArrayOutputStream()
            for ((name, data) in members) {
                val h = ByteArray(512)
                fun put(at: Int, s: String) = s.toByteArray().copyInto(h, at)
                put(0, name)
                put(100, "0000644")
                put(108, "0000000")
                put(116, "0000000")
                put(124, "%011o".format(data.size))
                put(136, "%011o".format(0))
                for (i in 148 until 156) h[i] = ' '.code.toByte()
                h[156] = '0'.code.toByte()
                put(257, "ustar")
                h[262] = 0
                put(263, "00")
                val sum = h.sumOf { it.toInt() and 0xFF }
                put(148, "%06o".format(sum))
                h[154] = 0
                out.write(h)
                out.write(data)
                val pad = (512 - data.size % 512) % 512
                out.write(ByteArray(pad))
            }
            out.write(ByteArray(1024))
            return out.toByteArray()
        }
    }
}
