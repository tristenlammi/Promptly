package org.promptly.sync.maps

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.json.JSONArray
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.maps.offline.OfflineApi
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import uniffi.ferrostar.DrivingSide
import java.util.Locale

/** A map opens where you are, else on the maps the server keeps, else on the world:
 *  never on a fixed country (it used to open on Australia, whatever the server had). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MapStartTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val newZealand = doubleArrayOf(165.5, -48.0, 179.0, -33.5)
    private val germany = doubleArrayOf(5.8, 47.2, 15.1, 55.1)

    @Test
    fun where_you_are_comes_first() {
        val view = MapStart.view(here = 52.52 to 13.40, bounds = newZealand, zoomHere = 15.0)
        assertEquals(MapStart.From.HERE, view.from)
        assertEquals(13.40, view.lon, 1e-9)
        assertEquals(52.52, view.lat, 1e-9)
        assertEquals(15.0, view.zoom, 1e-9)
    }

    @Test
    fun then_the_servers_maps() {
        val view = MapStart.view(here = null, bounds = newZealand, zoomHere = 15.0)
        assertEquals(MapStart.From.SERVER, view.from)
        assertEquals(172.25, view.lon, 1e-9)
        assertEquals(-40.75, view.lat, 1e-9)
        assertArrayEquals(newZealand, view.box, 0.0)
        // The whole country fits: further out than a city, closer than the world.
        assertTrue(view.zoom > 2.0 && view.zoom < 7.0)
        // A position that isn't one (0, 0, or off the globe) doesn't count as where you are.
        assertEquals(MapStart.From.SERVER, MapStart.view(0.0 to 0.0, germany, 15.0).from)
        assertEquals(MapStart.From.SERVER, MapStart.view(123.0 to 500.0, germany, 15.0).from)
    }

    @Test
    fun then_the_world_and_never_australia() {
        for (view in listOf(MapStart.view(null, null, 15.0), MapStart.view(null, doubleArrayOf(1.0, 2.0), 15.0), MapStart.view(null, doubleArrayOf(10.0, 5.0, 10.0, 5.0), 15.0))) {
            assertEquals(MapStart.From.WORLD, view.from)
            assertTrue(view.zoom < 1.5)
            assertFalse(view.lon in 112.0..154.0 && view.lat in -44.0..-10.0)
        }
    }

    @Test
    fun the_servers_answer_is_read_and_remembered() {
        assertArrayEquals(germany, MapStart.parseBounds(JSONArray(germany.toList())), 0.0)
        assertNull(MapStart.parseBounds(null as JSONArray?))
        assertNull(MapStart.parseBounds(JSONArray(listOf(1.0, 2.0, 3.0))))
        assertNull(MapStart.parseBounds(JSONArray(listOf("a", "b", "c", "d"))))
        assertNull(MapStart.parseBounds(JSONArray(listOf(15.1, 47.2, 5.8, 55.1)))) // east before west

        assertNull(MapStart.savedBounds(context))
        MapStart.saveBounds(context, JSONArray(germany.toList()))
        assertArrayEquals(germany, MapStart.savedBounds(context), 0.0)
        // A server that has no map any more says null, and the old box is forgotten.
        MapStart.saveBounds(context, null)
        assertNull(MapStart.savedBounds(context))
    }

    @Test
    fun without_the_location_permission_nothing_is_known_and_nothing_is_asked() {
        assertNull(MapStart.lastKnown(context))
    }

    @Test
    fun the_route_decides_the_driving_side() {
        // Whatever the place, what the route says wins.
        assertEquals(DrivingSide.RIGHT, DrivingSides.side(DrivingSide.RIGHT, at = -33.87 to 151.21))
        assertEquals(DrivingSide.LEFT, DrivingSides.side(DrivingSide.LEFT, at = 52.52 to 13.40))
    }

    @Test
    fun a_step_without_a_side_takes_it_from_the_place() {
        assertEquals(DrivingSide.LEFT, DrivingSides.side(null, at = -33.87 to 151.21)) // Sydney
        assertEquals(DrivingSide.LEFT, DrivingSides.side(null, at = -41.29 to 174.78)) // Wellington
        assertEquals(DrivingSide.LEFT, DrivingSides.side(null, at = 51.51 to -0.13)) // London
        assertEquals(DrivingSide.LEFT, DrivingSides.side(null, at = 35.68 to 139.69)) // Tokyo
        assertEquals(DrivingSide.LEFT, DrivingSides.side(null, at = 28.61 to 77.21)) // Delhi
        assertEquals(DrivingSide.LEFT, DrivingSides.side(null, at = -26.20 to 28.05)) // Johannesburg
        assertEquals(DrivingSide.RIGHT, DrivingSides.side(null, at = 52.52 to 13.40)) // Berlin
        assertEquals(DrivingSide.RIGHT, DrivingSides.side(null, at = 48.86 to 2.35)) // Paris
        assertEquals(DrivingSide.RIGHT, DrivingSides.side(null, at = 40.71 to -74.01)) // New York
        assertEquals(DrivingSide.RIGHT, DrivingSides.side(null, at = -23.55 to -46.63)) // Sao Paulo
        assertEquals(DrivingSide.RIGHT, DrivingSides.side(null, at = 39.90 to 116.40)) // Beijing
        // No position: where the server's maps are.
        assertEquals(DrivingSide.RIGHT, DrivingSides.side(null, at = null, bounds = germany))
        assertEquals(DrivingSide.LEFT, DrivingSides.side(null, at = null, bounds = newZealand))
        // Where you are beats where the maps are.
        assertEquals(DrivingSide.RIGHT, DrivingSides.side(null, at = 52.52 to 13.40, bounds = newZealand))
        // Nothing known at all: left, as before.
        assertEquals(DrivingSide.LEFT, DrivingSides.side(null))
    }

    @Test
    fun directions_are_read_in_the_phones_own_english() {
        assertEquals(Locale.forLanguageTag("en-NZ"), voiceLocale(Locale.forLanguageTag("en-NZ")))
        assertEquals(Locale.forLanguageTag("en-GB"), voiceLocale(Locale.forLanguageTag("en-GB")))
        assertEquals(Locale.forLanguageTag("en-AU"), voiceLocale(Locale.forLanguageTag("en-AU")))
        // They're written in English, so a German phone still gets an English voice.
        assertEquals(Locale.ENGLISH, voiceLocale(Locale.GERMANY))
    }

    @Test
    fun an_areas_name_is_the_town_in_any_country() {
        assertEquals("Dubbo", OfflineApi.town(" Dubbo New South Wales 2830"))
        assertEquals("Mudgee", OfflineApi.town("Mudgee NSW"))
        assertEquals("Taupō", OfflineApi.town(" Taupō 3330"))
        assertEquals("Berlin", OfflineApi.town(" 10115 Berlin"))
        assertEquals("Lyon", OfflineApi.town("69002 Lyon"))
        // A town that shares a state's name keeps it.
        assertEquals("Victoria", OfflineApi.town("Victoria 8000"))
        assertEquals("Melbourne", OfflineApi.town("Melbourne Victoria 3000"))
        // Only a state or a postcode: no town there.
        assertEquals("", OfflineApi.town("NSW 2042"))
        assertEquals("", OfflineApi.town(" 2042"))
    }
}
