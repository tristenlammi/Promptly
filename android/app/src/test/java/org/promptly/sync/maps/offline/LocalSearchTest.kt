package org.promptly.sync.maps.offline

import android.database.sqlite.SQLiteDatabase
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.nio.file.Files

/** WP-M6: offline search over the merged `search.db`. FTS4 with ranking near you,
 *  street abbreviations, house numbers ("12 Macquarie St"), kinds of place ("fuel"),
 *  places along the road ahead, and nothing breaking when there's nothing downloaded. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LocalSearchTest {
    private lateinit var work: File
    private lateinit var db: SearchDb
    private lateinit var search: LocalSearch

    private val dubbo = -32.2480 to 148.6040
    private val canberra = -35.2800 to 149.1300

    @Before
    fun setUp() {
        work = Files.createTempDirectory("local-search").toFile()
        db = SearchDb(File(work, "search.db"))
        // Dubbo's square: a servo, a hospital, a street with house numbers, the town.
        db.putPlaces("148_-33", places("148_-33",
            "('place','Caltex Dubbo',NULL,'amenity:fuel','123','Cobra Street','Dubbo','NSW','2830',-32255000,148615000,600)",
            "('place','Ampol Dubbo',NULL,'amenity:fuel',NULL,'Erskine Street','Dubbo','NSW','2830',-32260000,148590000,500)",
            "('place','Dubbo Base Hospital',NULL,'amenity:hospital',NULL,'Myall Street','Dubbo','NSW','2830',-32257000,148609000,800)",
            "('street','Macquarie Street',NULL,'highway:primary',NULL,NULL,'Dubbo','NSW','2830',-32249000,148603000,400)",
            "('street','Wheelers Lane',NULL,'highway:secondary',NULL,NULL,'Dubbo','NSW','2830',-32270000,148630000,300)",
            "('locality','Dubbo',NULL,'place:town',NULL,NULL,NULL,'NSW','2830',-32246000,148603000,2000)",
            "('place','Mudgee Caltex',NULL,'amenity:fuel',NULL,'Church Street','Mudgee','NSW','2850',-32590000,148590000,300)",
            "('place','Gilgandra Caltex',NULL,'amenity:fuel',NULL,'Miller Street','Gilgandra','NSW','2827',-32800000,148650000,300)",
        ), "p1")
        db.putAddresses("148_-33", addresses(
            listOf("Macquarie Street" to "Dubbo", "Macquarie Street" to "Wellington", "Wheelers Lane" to "Dubbo"),
            listOf(
                Triple(1, "10", -32249300), Triple(1, "12", -32249360), Triple(1, "14-16", -32249420), Triple(1, "20A", -32249600),
                Triple(1, "11", -32249330), Triple(2, "12", -32550000), Triple(3, "5", -32270050),
            ),
        ), "a1")
        // Canberra's square: another servo, so "Caltex" has a far one too.
        db.putPlaces("149_-36", places("149_-36",
            "('place','Caltex Civic',NULL,'amenity:fuel',NULL,'Northbourne Avenue','Canberra','ACT','2601',-35274000,149131000,600)",
            "('street','Northbourne Avenue',NULL,'highway:primary',NULL,NULL,'Canberra','ACT','2601',-35270000,149130000,500)",
            "('street','Canberra Avenue',NULL,'highway:primary',NULL,NULL,'Griffith','ACT','2603',-35320000,149140000,450)",
            "('locality','Canberra',NULL,'place:city',NULL,NULL,NULL,'ACT','2600',-35281000,149128000,5000)",
            "('street','Hindmarsh Drive',NULL,'highway:primary',NULL,NULL,'Canberra','ACT','2606',-35340000,149110000,300)",
            "('street','Commonwealth Road',NULL,'highway:secondary',NULL,NULL,'Yarralumla','ACT','2600',-35300000,149100000,300)",
        ), "p2")
        search = LocalSearch(db.file)
    }

    @After
    fun tearDown() {
        work.deleteRecursively()
    }

    @Test
    fun aNameIsFoundNearYouFirst() {
        val nearDubbo = search.find("caltex", dubbo)
        assertEquals("Caltex Dubbo", nearDubbo.first().name)
        assertTrue(nearDubbo.all { it.offline })
        assertTrue(nearDubbo.any { it.name == "Caltex Civic" })
        val nearCanberra = search.find("Caltex", canberra)
        assertEquals("Caltex Civic", nearCanberra.first().name)
        // The address line is the place's street and area.
        assertEquals("123 Cobra Street, Dubbo NSW 2830", nearDubbo.first().address)
    }

    @Test
    fun theWholeNameBeatsAPlaceThatStartsWithIt() {
        val found = search.find("dubbo", canberra)
        assertEquals("Dubbo", found.first().name)
        assertTrue(found.any { it.name == "Dubbo Base Hospital" })
    }

    @Test
    fun wordsCanBeInTheNameAndTheLocality() {
        // "Caltex Mudgee": the brand in the name, the town in the locality, or both in the name.
        val found = search.find("caltex mudgee", dubbo)
        assertEquals("Mudgee Caltex", found.first().name)
        assertFalse(found.any { it.name == "Caltex Dubbo" })
    }

    @Test
    fun streetTypesAreReadInFull() {
        assertEquals("Northbourne Avenue", search.find("northbourne ave", canberra).first().name)
        assertEquals("Commonwealth Road", search.find("commonwealth rd", canberra).first().name)
        assertEquals("Hindmarsh Drive", search.find("Hindmarsh Dr", canberra).first().name)
        // Half typed.
        assertEquals("Northbourne Avenue", search.find("northb", canberra).first().name)
    }

    @Test
    fun aHouseNumberOnAStreet() {
        val found = search.find("12 Macquarie St", dubbo)
        val first = found.first()
        assertEquals("12 Macquarie Street", first.name)
        assertEquals("address", first.kind)
        assertEquals(-32.249360, first.lat, 1e-6)
        assertEquals("Dubbo NSW 2830", first.address)
        assertTrue(first.offline)
        // The street itself is found too, under the house number.
        assertTrue(found.any { it.name == "Macquarie Street" })
    }

    @Test
    fun theLocalityPicksTheStreet() {
        // Two Macquarie Streets: the one in Wellington, when you say so.
        val wellington = search.find("12 Macquarie Street Wellington", dubbo).first()
        assertEquals("12 Macquarie Street", wellington.name)
        assertEquals(-32.55, wellington.lat, 1e-6)
        // Without a locality, the nearer one.
        assertEquals(-32.249360, search.find("12 macquarie street", dubbo).first().lat, 1e-6)
        // A locality with no such street: no house number made up.
        assertFalse(search.find("12 Macquarie Street Canberra", dubbo).any { it.kind == "address" })
    }

    @Test
    fun unitsRangesLettersAndTheNearestNumber() {
        assertEquals("3/12 Macquarie Street", search.find("3/12 Macquarie St", dubbo).first().name)
        assertEquals("3/12 Macquarie Street", search.find("Unit 3, 12 Macquarie St Dubbo", dubbo).first().name)
        // 15 is inside "14-16".
        assertEquals("14-16 Macquarie Street", search.find("15 Macquarie St", dubbo).first().name)
        // "20" is "20A" on the ground.
        assertEquals("20A Macquarie Street", search.find("20 macquarie st", dubbo).first().name)
        // 13 isn't there: the nearest on the same side of the street, said plainly.
        val near = search.find("13 Macquarie St", dubbo).first()
        assertEquals("11 Macquarie Street", near.name)
        assertTrue(near.address!!.contains("closest to 13"))
        // No type typed at all.
        assertEquals("5 Wheelers Lane", search.find("5 wheelers", dubbo).first().name)
    }

    @Test
    fun withoutHouseNumbersTheStreetIsStillFound() {
        db.remove("148_-33", onlyAddresses = true)
        assertFalse(search.hasAddresses())
        val found = search.find("12 Macquarie St", dubbo)
        assertFalse(found.any { it.kind == "address" })
        assertEquals("Macquarie Street", found.first().name)
    }

    @Test
    fun aKindOfPlaceIsNearestFirst() {
        val fuel = search.find("the nearest servo", dubbo)
        assertEquals(listOf("Caltex Dubbo", "Ampol Dubbo"), fuel.map { it.name })
        assertTrue(search.find("fuel near me", null).isEmpty())
        // Within 8 km only: Mudgee and Gilgandra are further.
        assertFalse(search.around("fuel", dubbo).any { it.name == "Mudgee Caltex" })
    }

    @Test
    fun placesAlongTheRoadAheadSayHowFarAhead() {
        // Heading south from Dubbo towards Mudgee, past Ampol (on the road) and Mudgee's Caltex.
        val road = listOf(-32.25 to 148.59, -32.40 to 148.59, -32.59 to 148.59)
        val found = search.along("fuel", road)
        assertEquals(listOf("Ampol Dubbo", "Mudgee Caltex"), found.map { it.stop.name })
        assertEquals(1.1, found[0].aheadKm!!, 0.3)
        assertEquals(37.6, found[1].aheadKm!!, 1.0)
        assertNull(found[0].addsMinutes)
        assertTrue(found.all { it.stop.offline })
        // Off the road by more than a kilometre: not on the way.
        assertFalse(found.any { it.stop.name == "Caltex Dubbo" })
    }

    @Test
    fun nothingDownloadedFindsNothing() {
        val none = LocalSearch(File(work, "missing.db"))
        assertTrue(none.find("caltex", dubbo).isEmpty())
        assertTrue(none.along("fuel", listOf(dubbo, canberra)).isEmpty())
        assertFalse(none.hasAddresses())
        // Odd input isn't an error.
        assertTrue(search.find("\"*) OR (", dubbo).isEmpty())
        assertTrue(search.find("a", dubbo).isEmpty())
        // Removing a square takes its places out of search.
        db.remove("149_-36")
        assertFalse(search.find("caltex", canberra).any { it.name == "Caltex Civic" })
    }

    @Test
    fun aSearchIsQuick() {
        // A city's worth of rows (Sydney's squares hold about 60,000 places): well under a second.
        val rows = (1..20_000).map { i ->
            "('place','Shop $i',NULL,'shop:convenience',NULL,'Street ${i % 500}','Suburb ${i % 90}','NSW','2000',${-33870000 - i * 5},${151200000 + i * 5},${i % 1000})"
        }
        db.putPlaces("151_-34", places("151_-34", *rows.toTypedArray()), "big")
        val started = System.nanoTime()
        val found = search.find("shop 1234", -33.87 to 151.2)
        val ms = (System.nanoTime() - started) / 1_000_000
        assertNotNull(found.firstOrNull { it.name == "Shop 1234" })
        assertTrue("took $ms ms", ms < 1500)
    }

    // ---- Fixtures: the server's per-square files, as `search_index.py slice` writes them ----

    private var made = 0

    private fun places(cell: String, vararg rows: String): File {
        val f = File(work, "places-${made++}.sqlite")
        SQLiteDatabase.openOrCreateDatabase(f, null).use { d ->
            d.execSQL("CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT)")
            d.execSQL(
                "CREATE TABLE places(id INTEGER PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, alt TEXT, kind TEXT, number TEXT, street TEXT, " +
                    "locality TEXT, state TEXT, postcode TEXT, lat INTEGER NOT NULL, lon INTEGER NOT NULL, rank INTEGER NOT NULL)",
            )
            d.execSQL("INSERT INTO meta VALUES('format','1'),('cell',?)", arrayOf(cell))
            d.beginTransaction()
            rows.forEach { d.execSQL("INSERT INTO places(type, name, alt, kind, number, street, locality, state, postcode, lat, lon, rank) VALUES $it") }
            d.setTransactionSuccessful()
            d.endTransaction()
        }
        return f
    }

    /** Streets (name, locality) and house numbers (street index from 1, number, lat). */
    private fun addresses(streets: List<Pair<String, String>>, numbers: List<Triple<Int, String, Int>>): File {
        val f = File(work, "addresses-${made++}.sqlite")
        SQLiteDatabase.openOrCreateDatabase(f, null).use { d ->
            d.execSQL("CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT)")
            d.execSQL("CREATE TABLE streets(id INTEGER PRIMARY KEY, name TEXT NOT NULL, locality TEXT, state TEXT, postcode TEXT)")
            d.execSQL("CREATE TABLE addresses(street INTEGER NOT NULL, number TEXT NOT NULL, lat INTEGER NOT NULL, lon INTEGER NOT NULL, PRIMARY KEY(street, number)) WITHOUT ROWID")
            d.execSQL("INSERT INTO meta VALUES('format','1')")
            streets.forEachIndexed { i, (name, locality) ->
                val postcode = if (locality == "Wellington") "2820" else "2830"
                d.execSQL("INSERT INTO streets VALUES(?,?,?,'NSW',?)", arrayOf<Any>(i + 1, name, locality, postcode))
            }
            numbers.forEach { (street, number, lat) ->
                d.execSQL("INSERT INTO addresses VALUES(?,?,?,148603000)", arrayOf<Any>(street, number, lat))
            }
        }
        return f
    }
}
