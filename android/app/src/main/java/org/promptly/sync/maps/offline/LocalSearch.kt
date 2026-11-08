package org.promptly.sync.maps.offline

import android.database.sqlite.SQLiteDatabase
import android.util.Log
import org.promptly.sync.maps.Maps
import org.promptly.sync.maps.Stop
import java.io.File
import java.util.Locale
import kotlin.math.abs
import kotlin.math.cos

import kotlin.math.sqrt

/**
 * Search with no server: the downloaded squares' places, streets and house numbers in
 * `search.db` ([SearchDb]). "Caltex Mudgee" is an FTS4 match over names, streets and
 * localities, ranked by how well it matches, then how near you it is, then how
 * well-known the place is. "12 Smith St Newtown" is a house number on a street: the
 * street by name (with "St" read as "Street"), the locality if you gave one, then the
 * number from that street's house numbers. "Fuel" and "the nearest servo" are a kind of
 * place, nearest first. Everything it returns is marked [Stop.offline].
 *
 * Reads only. With no file, or a square half-written by a download, it finds nothing
 * rather than failing.
 */
class LocalSearch(private val file: File) {

    /** Places, streets and addresses for [query], best first. [near]: (lat, lon). */
    fun find(query: String, near: Pair<Double, Double>?, limit: Int = 10): List<Stop> {
        val words = SearchText.words(query)
        if (words.isEmpty() || words.joinToString("").length < 2) return emptyList()
        Categories.of(query)?.let { kind -> return if (near == null) emptyList() else around(kind, near, limit) }
        val address = AddressQuery.parse(query)
        return read { db ->
            val out = mutableListOf<Scored>()
            address?.let { out += addresses(db, it, near) }
            // "12 Smith St": the number isn't in a place's name, so the words after it are what's matched.
            out += places(db, address?.words ?: words, near)
            out.sortedByDescending { it.score }
                .map { it.stop }
                .distinctBy { "${it.name.lowercase(Locale.ROOT)}|%.3f,%.3f".format(Locale.ROOT, it.lat, it.lon) }
                .take(limit)
        } ?: emptyList()
    }

    /** Whether any downloaded square has house numbers (for "house numbers aren't saved here"). */
    fun hasAddresses(): Boolean = read { db ->
        db.rawQuery("SELECT 1 FROM squares WHERE addresses > 0 LIMIT 1", null).use { it.moveToFirst() }
    } ?: false

    /** Places of a [Categories] kind around [near], nearest first. */
    fun around(category: String, near: Pair<Double, Double>, limit: Int = 8, radiusKm: Double = 8.0): List<Stop> {
        val kinds = Categories.kinds(category) ?: return emptyList()
        val box = Geo.box(listOf(near), radiusKm)
        return read { db ->
            kindsIn(db, kinds, box)
                .map { it to Geo.km(near.first, near.second, it.lat, it.lon) }
                .filter { it.second <= radiusKm }
                .sortedBy { it.second }
                .map { (row, _) -> row.stop(Categories.label(category)) }
                .distinctBy { "%.3f,%.3f".format(Locale.ROOT, it.lat, it.lon) }
                .take(limit)
        } ?: emptyList()
    }

    /**
     * Places of a [Categories] kind along the road ahead: [line] is the rest of the route
     * as (lat, lon), starting where you are. Within [offRouteKm] of it and the next
     * [aheadKm], ordered by how far ahead they are (no detour times: that needs the
     * engine, which phase 2 adds).
     */
    fun along(category: String, line: List<Pair<Double, Double>>, aheadKm: Double = 60.0, offRouteKm: Double = 1.0, limit: Int = 8): List<Maps.Nearby> {
        val kinds = Categories.kinds(category) ?: return emptyList()
        val ahead = Geo.firstKm(line, aheadKm)
        if (ahead.size < 2) return emptyList()
        val box = Geo.box(ahead, offRouteKm)
        return read { db ->
            kindsIn(db, kinds, box).mapNotNull { row ->
                val (off, along) = Geo.toLine(ahead, row.lat, row.lon)
                if (off > offRouteKm) null else Maps.Nearby(row.stop(Categories.label(category)), null, along)
            }
                .sortedBy { it.aheadKm }
                .distinctBy { "%.3f,%.3f".format(Locale.ROOT, it.stop.lat, it.stop.lon) }
                .take(limit)
        } ?: emptyList()
    }

    // ---- The parts -------------------------------------------------------------------

    private class Scored(val stop: Stop, val score: Double)

    /** A row of `places`, coordinates in degrees. */
    internal data class Place(
        val type: String, val name: String, val alt: String?, val kind: String?, val number: String?, val street: String?,
        val locality: String?, val state: String?, val postcode: String?, val lat: Double, val lon: Double, val rank: Int,
    ) {
        fun stop(fallback: String? = null): Stop {
            val road = listOfNotNull(number, street).joinToString(" ").takeIf { it.isNotBlank() && it != name }
            val area = listOfNotNull(locality, state, postcode).joinToString(" ").takeIf { it.isNotBlank() && it != name }
            val address = listOfNotNull(road, area).joinToString(", ").ifEmpty { null }
            return Stop(lat, lon, name.ifBlank { fallback ?: "Place" }, if (type == "place") "place" else type, address, offline = true)
        }
    }

    private fun places(db: SQLiteDatabase, words: List<String>, near: Pair<Double, Double>?): List<Scored> {
        val match = SearchText.match(words) ?: return emptyList()
        val order = if (near != null) "abs(p.lat - ?) + abs(p.lon - ?)" else "p.rank DESC"
        val args = mutableListOf(match)
        if (near != null) {
            args += Math.round(near.first * 1e6).toString()
            args += Math.round(near.second * 1e6).toString()
        }
        val rows = db.rawQuery(
            "SELECT p.type, p.name, p.alt, p.kind, p.number, p.street, p.locality, p.state, p.postcode, p.lat, p.lon, p.rank " +
                "FROM places p WHERE p.id IN (SELECT docid FROM places_fts WHERE places_fts MATCH ?) ORDER BY $order LIMIT $CANDIDATES",
            args.toTypedArray(),
        ).use { c ->
            buildList {
                while (c.moveToNext()) {
                    add(
                        Place(
                            c.getString(0), c.getString(1), c.getString(2), c.getString(3), c.getString(4), c.getString(5), c.getString(6),
                            c.getString(7), c.getString(8), c.getLong(9) / 1e6, c.getLong(10) / 1e6, c.getInt(11),
                        ),
                    )
                }
            }
        }
        return rows.map { Scored(it.stop(), Ranking.score(words, it, near)) }
    }

    private fun kindsIn(db: SQLiteDatabase, kinds: List<String>, box: Geo.Box): List<Place> {
        val marks = kinds.joinToString(",") { "?" }
        val args = kinds + listOf(box.south, box.north, box.west, box.east).map { Math.round(it * 1e6).toString() }
        return db.rawQuery(
            "SELECT type, name, alt, kind, number, street, locality, state, postcode, lat, lon, rank FROM places " +
                "WHERE kind IS NOT NULL AND kind IN ($marks) AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 2000",
            args.toTypedArray(),
        ).use { c ->
            buildList {
                while (c.moveToNext()) {
                    add(
                        Place(
                            c.getString(0), c.getString(1), c.getString(2), c.getString(3), c.getString(4), c.getString(5), c.getString(6),
                            c.getString(7), c.getString(8), c.getLong(9) / 1e6, c.getLong(10) / 1e6, c.getInt(11),
                        ),
                    )
                }
            }
        }
    }

    private data class Street(val id: Long, val name: String, val locality: String?, val state: String?, val postcode: String?, val exact: Boolean)

    /** "12 Macquarie Street Dubbo": the street (and locality), then the house number on it. */
    private fun addresses(db: SQLiteDatabase, ask: AddressQuery, near: Pair<Double, Double>?): List<Scored> {
        val streets = LinkedHashMap<Long, Street>()
        // Where the street's name ends and the locality starts isn't known: try each split.
        for (k in ask.words.size downTo 1) {
            val streetWords = ask.words.take(k)
            val placeWords = ask.words.drop(k)
            for (s in streetsNamed(db, streetWords)) {
                if (placeWords.isNotEmpty() && !SearchText.allIn(placeWords, listOfNotNull(s.locality, s.state, s.postcode))) continue
                val had = streets[s.id]
                if (had == null || (!had.exact && s.exact)) streets[s.id] = s
            }
            if (streets.size >= 40) break
        }
        if (streets.isEmpty()) return emptyList()
        val out = mutableListOf<Scored>()
        for (s in streets.values) {
            val numbers = db.rawQuery("SELECT number, lat, lon FROM addresses WHERE street = ?", arrayOf(s.id.toString())).use { c ->
                buildList { while (c.moveToNext()) add(HouseNumbers.Row(c.getString(0), c.getLong(1) / 1e6, c.getLong(2) / 1e6)) }
            }
            val hit = HouseNumbers.best(numbers, ask.number) ?: continue
            val title = (ask.unit?.let { "$it/" } ?: "") + "${hit.row.number} ${s.name}"
            val area = listOfNotNull(s.locality, s.state, s.postcode).joinToString(" ").ifEmpty { null }
            val note = if (hit.exact) area else listOfNotNull(area, "closest to ${ask.number}").joinToString(" · ")
            val km = near?.let { Geo.km(it.first, it.second, hit.row.lat, hit.row.lon) }
            // An exact house number on the street you named beats a place that merely mentions it.
            val score = 10.0 + (if (s.exact) 2.0 else 0.0) + (if (hit.exact) 3.0 else 0.0) + Ranking.near(km)
            out += Scored(Stop(hit.row.lat, hit.row.lon, title, "address", note, offline = true), score)
        }
        return out
    }

    private fun streetsNamed(db: SQLiteDatabase, words: List<String>): List<Street> {
        val typed = words.joinToString(" ")
        val full = SearchText.expandStreet(words).joinToString(" ")
        val found = mutableListOf<Street>()
        fun rows(sql: String, vararg args: String, exact: Boolean) =
            db.rawQuery(sql, args).use { c ->
                while (c.moveToNext()) found += Street(c.getLong(0), c.getString(1), c.getString(2), c.getString(3), c.getString(4), exact)
            }
        val sql = "SELECT id, name, locality, state, postcode FROM streets WHERE name"
        rows("$sql = ? COLLATE NOCASE LIMIT 60", full, exact = true)
        // "12 Macquarie" (no type) and "12 Macquarie Str" (half typed): the streets that start so.
        rows("$sql LIKE ? ESCAPE '\\' LIMIT 60", SearchText.likePrefix(typed), exact = false)
        if (full != typed) rows("$sql LIKE ? ESCAPE '\\' LIMIT 60", SearchText.likePrefix(full), exact = false)
        return found.filter { it.exact || SearchText.startsWithWords(it.name, words) }
    }

    private inline fun <T> read(block: (SQLiteDatabase) -> T): T? {
        if (!file.isFile) return null
        return try {
            SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY or SQLiteDatabase.NO_LOCALIZED_COLLATORS).use(block)
        } catch (e: Exception) {
            // A download writing the file, or no tables yet: nothing found this time.
            Log.w(TAG, "Offline search: ${e.message}")
            null
        }
    }

    companion object {
        private const val TAG = "PromptlyOffline"
        /** How many FTS matches, nearest first, are ranked properly. */
        private const val CANDIDATES = 400
    }
}

/** What people type, as words: lower case, accents kept as FTS4's unicode61 folds them. */
internal object SearchText {
    private val SPLIT = Regex("[^\\p{L}\\p{N}]+")

    fun words(text: String): List<String> = text.lowercase(Locale.ROOT).split(SPLIT).filter { it.isNotEmpty() }

    /** Australia Post's street types, as people shorten them, to the names G-NAF and OSM use. */
    val TYPES: Map<String, String> = mapOf(
        "st" to "street", "str" to "street", "rd" to "road", "ave" to "avenue", "av" to "avenue", "dr" to "drive", "drv" to "drive",
        "ct" to "court", "crt" to "court", "pl" to "place", "cres" to "crescent", "cr" to "crescent", "cresc" to "crescent",
        "hwy" to "highway", "pde" to "parade", "tce" to "terrace", "terr" to "terrace", "cl" to "close", "cct" to "circuit",
        "bvd" to "boulevard", "bvde" to "boulevard", "blvd" to "boulevard", "esp" to "esplanade", "gr" to "grove", "gve" to "grove",
        "ln" to "lane", "sq" to "square", "wy" to "way", "cir" to "circle", "pkwy" to "parkway", "pky" to "parkway",
        "prom" to "promenade", "mwy" to "motorway", "fwy" to "freeway", "gdns" to "gardens", "hts" to "heights", "lp" to "loop",
        "wk" to "walk", "trl" to "trail", "tr" to "track", "trk" to "track", "rdwy" to "roadway", "app" to "approach",
        "bwy" to "broadway", "ch" to "chase", "gln" to "glen", "vw" to "view", "ri" to "rise", "rte" to "route",
    )

    /** "macquarie st" → "macquarie street": only the last word is a street type. */
    fun expandStreet(words: List<String>): List<String> =
        if (words.isEmpty()) words else words.dropLast(1) + (TYPES[words.last()] ?: words.last())

    /** An FTS4 query matching every word as a prefix ("rd" also as "road"). Null if nothing to match. */
    fun match(words: List<String>): String? {
        val terms = words.filter { it.isNotEmpty() }.map { w ->
            // Quotes keep the word one term, whatever it looks like (FTS operators, say).
            val own = "\"$w*\""
            TYPES[w]?.let { "$own OR \"$it*\"" } ?: own
        }
        return terms.takeIf { it.isNotEmpty() }?.joinToString(" ")
    }

    fun likePrefix(text: String): String = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"

    /** Every word starts one of the words of [fields]. */
    fun allIn(words: List<String>, fields: List<String>): Boolean {
        val have = fields.flatMap { words(it) }
        return words.all { w -> have.any { it.startsWith(w) || (SearchText.TYPES[w]?.let(it::startsWith) ?: false) } }
    }

    /** [name]'s first words are [words] (the last one may be half typed or shortened). */
    fun startsWithWords(name: String, words: List<String>): Boolean {
        val have = words(name)
        if (have.size < words.size) return false
        for (i in words.indices) {
            val w = words[i]
            val h = have[i]
            val last = i == words.lastIndex
            val ok = h == w || TYPES[w] == h || (last && (h.startsWith(w) || (TYPES[w]?.let(h::startsWith) ?: false)))
            if (!ok) return false
        }
        return true
    }
}

/** "3/12 Smith St, Newtown NSW 2042": the house number, the unit, and the words after. */
internal data class AddressQuery(val number: String, val unit: String?, val words: List<String>) {
    companion object {
        private val NUMBER = Regex("^\\d{1,6}[a-z]?(?:-\\d{1,6}[a-z]?)?$")
        private val UNIT_WORDS = setOf("unit", "u", "apt", "apartment", "flat", "shop", "suite", "lot", "villa", "townhouse", "level", "lvl")

        fun parse(text: String): AddressQuery? {
            var rest = text.trim().lowercase(Locale.ROOT).replace(',', ' ')
            var unit: String? = null
            // "unit 3, 12 smith st" / "u3 12 smith st"
            Regex("^(?:${UNIT_WORDS.joinToString("|")})\\s*(\\w{1,6})\\s+").find(rest)?.let {
                unit = it.groupValues[1]
                rest = rest.substring(it.range.last + 1)
            }
            // "3/12 smith st"
            Regex("^(\\w{1,6})\\s*/\\s*(\\d)").find(rest)?.let {
                unit = it.groupValues[1]
                rest = rest.substring(it.groups[2]!!.range.first)
            }
            val first = rest.trim().split(Regex("\\s+")).firstOrNull() ?: return null
            if (!NUMBER.matches(first)) return null
            val words = SearchText.words(rest.trim().substring(first.length))
            // A number and nothing else, or only a postcode after it, isn't an address.
            if (words.isEmpty() || words.all { it.all(Char::isDigit) }) return null
            return AddressQuery(first, unit?.uppercase(Locale.ROOT), words)
        }
    }
}

/** Picking the house number on a street. */
internal object HouseNumbers {
    data class Row(val number: String, val lat: Double, val lon: Double)
    data class Hit(val row: Row, val exact: Boolean)

    private fun first(number: String): Int? = Regex("^(\\d+)").find(number)?.groupValues?.get(1)?.toIntOrNull()

    private fun range(number: String): IntRange? {
        val m = Regex("^(\\d+)[a-z]?-(\\d+)[a-z]?$", RegexOption.IGNORE_CASE).find(number) ?: return null
        val a = m.groupValues[1].toInt()
        val b = m.groupValues[2].toInt()
        return if (a <= b) a..b else null
    }

    /** The number asked for; else a range or lettered number that includes it ("10-14", "12A");
     *  else the nearest number on the same side of the street. Null on a street with none. */
    fun best(rows: List<Row>, asked: String): Hit? {
        if (rows.isEmpty()) return null
        rows.firstOrNull { it.number.equals(asked, ignoreCase = true) }?.let { return Hit(it, true) }
        val n = first(asked) ?: return null
        rows.firstOrNull { r -> range(r.number)?.let { n in it } == true }?.let { return Hit(it, true) }
        rows.filter { first(it.number) == n }.minByOrNull { it.number.length }?.let { return Hit(it, true) }
        val numbered = rows.mapNotNull { r -> first(r.number)?.let { r to it } }
        val sameSide = numbered.filter { it.second % 2 == n % 2 }.ifEmpty { numbered }
        return sameSide.minByOrNull { abs(it.second - n) }?.let { Hit(it.first, false) }
    }
}

/** How well a place matches what you typed, how near you it is, and how well known. */
internal object Ranking {
    fun near(km: Double?): Double = if (km == null) 0.0 else 3.0 / (1.0 + km / 5.0)

    fun score(words: List<String>, place: LocalSearch.Place, near: Pair<Double, Double>?): Double {
        val name = SearchText.words(place.name)
        val alt = place.alt?.let { SearchText.words(it) }.orEmpty()
        fun has(w: String, of: List<String>) = of.any { it.startsWith(w) || (SearchText.TYPES[w]?.let(it::startsWith) ?: false) }
        // Words in the name count most; "Mudgee" in "Caltex Mudgee" matching the locality, less.
        val matched = words.count { has(it, name) || has(it, alt) }
        var score = 4.0 * matched / words.size + 1.5 * (words.size - matched) / words.size
        val asked = words.joinToString(" ")
        val called = name.joinToString(" ")
        if (called == asked) score += 2.0
        else if (called.startsWith(asked)) score += 1.5
        else if (alt.joinToString(" ") == asked) score += 2.0
        // A town or suburb by its own name is usually what's meant.
        if (place.type == "locality" && matched == words.size) score += 0.5
        val km = near?.let { Geo.km(it.first, it.second, place.lat, place.lon) }
        score += near(km)
        score += 1.5 * place.rank.coerceIn(0, 100_000) / 100_000.0
        return score
    }
}

/** Fuel, food and the rest, as the server's `maps/nearby.py` names them. */
internal object Categories {
    private class Category(val label: String, val tags: List<String>, val words: Set<String>)

    private val ALL = linkedMapOf(
        "fuel" to Category("Fuel", listOf("amenity:fuel"), setOf("fuel", "petrol", "petrol station", "gas", "gas station", "servo", "service station", "diesel")),
        "food" to Category("Food", listOf("amenity:restaurant", "amenity:fast_food"), setOf("food", "restaurant", "restaurants", "fast food", "takeaway", "something to eat", "lunch", "dinner")),
        "coffee" to Category("Coffee", listOf("amenity:cafe"), setOf("coffee", "cafe", "cafes", "café")),
        "groceries" to Category("Groceries", listOf("shop:supermarket", "shop:convenience"), setOf("groceries", "grocery", "supermarket", "supermarkets", "convenience store")),
        "chemist" to Category("Chemist", listOf("amenity:pharmacy"), setOf("chemist", "pharmacy", "chemists")),
        "toilets" to Category("Toilets", listOf("amenity:toilets"), setOf("toilet", "toilets", "bathroom", "restroom", "public toilets")),
        "parking" to Category("Parking", listOf("amenity:parking"), setOf("parking", "car park", "carpark")),
        "atm" to Category("ATM", listOf("amenity:atm"), setOf("atm", "cash machine")),
        "hotel" to Category("Places to stay", listOf("tourism:hotel", "tourism:motel"), setOf("hotel", "hotels", "motel", "motels", "accommodation", "somewhere to stay")),
    )
    private val FILLER = Regex("\\b(near me|nearby|near here|around here|closest|nearest|find|a|an|the|me|some)\\b")

    /** "fuel near me", "the nearest servo": a category, not a place's name. */
    fun of(query: String): String? {
        var q = query.lowercase(Locale.ROOT).replace(Regex("[^\\p{L}\\p{N}\\s]"), " ")
        q = FILLER.replace(q, " ").split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        return ALL.entries.firstOrNull { q in it.value.words }?.key
    }

    fun kinds(category: String): List<String>? = ALL[category]?.tags

    fun label(category: String): String = ALL[category]?.label ?: category
}

/** Small distances on the ground, near enough for "1.2 km" and "within a kilometre". */
internal object Geo {
    data class Box(val west: Double, val south: Double, val east: Double, val north: Double)

    fun km(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val x = (lon2 - lon1) * cos(Math.toRadians((lat1 + lat2) / 2)) * 111.32
        val y = (lat2 - lat1) * 110.574
        return sqrt(x * x + y * y)
    }

    fun box(points: List<Pair<Double, Double>>, marginKm: Double): Box {
        val lat = points.map { it.first }
        val lon = points.map { it.second }
        val dLat = marginKm / 110.574
        val dLon = marginKm / (111.32 * cos(Math.toRadians(lat.average())).coerceAtLeast(0.1))
        return Box(lon.min() - dLon, lat.min() - dLat, lon.max() + dLon, lat.max() + dLat)
    }

    /** The start of [line] (lat, lon) up to [km] along it. */
    fun firstKm(line: List<Pair<Double, Double>>, km: Double): List<Pair<Double, Double>> {
        if (line.size < 2) return line
        val out = mutableListOf(line.first())
        var total = 0.0
        for (i in 1 until line.size) {
            total += km(line[i - 1].first, line[i - 1].second, line[i].first, line[i].second)
            out += line[i]
            if (total >= km) break
        }
        return out
    }

    /** How far a point is from [line], and how far along the line its nearest spot is (km). */
    fun toLine(line: List<Pair<Double, Double>>, lat: Double, lon: Double): Pair<Double, Double> {
        var best = Double.MAX_VALUE
        var bestAlong = 0.0
        var along = 0.0
        val scale = cos(Math.toRadians(lat)) * 111.32
        for (i in 1 until line.size) {
            val (aLat, aLon) = line[i - 1]
            val (bLat, bLon) = line[i]
            val ax = (aLon - lon) * scale
            val ay = (aLat - lat) * 110.574
            val bx = (bLon - lon) * scale
            val by = (bLat - lat) * 110.574
            val dx = bx - ax
            val dy = by - ay
            val len2 = dx * dx + dy * dy
            val t = if (len2 == 0.0) 0.0 else (-(ax * dx + ay * dy) / len2).coerceIn(0.0, 1.0)
            val px = ax + t * dx
            val py = ay + t * dy
            val d = sqrt(px * px + py * py)
            val segment = sqrt(len2)
            if (d < best) {
                best = d
                bestAlong = along + t * segment
            }
            along += segment
        }
        return best to bestAlong
    }
}
