@file:Suppress("DEPRECATION")

package org.promptly.sync.maps

import android.content.Context
import androidx.car.app.model.Action
import androidx.car.app.model.MessageTemplate
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.car.app.navigation.model.RoutePreviewNavigationTemplate
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The car library checks its rules when a template is built, and breaking one stops
 *  the app on the car's screen. These build each screen the way the app does. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CarTemplatesTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val home = Stop(-33.8, 151.2, "Home", "home", "1 Test St")
    private val work = Stop(-33.9, 151.1, "Work", "work")
    private fun route(seconds: Int = 1320, adds: Int = 0, via: String? = "M4") =
        CarRoute(seconds, 14.2, via, adds, listOf(151.2 to -33.8, 151.1 to -33.9), emptyList())

    @Test
    fun landing_with_and_without_home_and_work() {
        val full = CarTemplates.landing(context, home, work, {}, {}, {}) as NavigationTemplate
        assertEquals(3, full.actionStrip!!.actions.size)
        val bare = CarTemplates.landing(context, null, null, {}, {}, {}) as NavigationTemplate
        assertEquals(1, bare.actionStrip!!.actions.size)
        assertEquals(1, bare.mapActionStrip!!.actions.size)
    }

    @Test
    fun landing_offers_carry_on_first_when_a_trip_stopped() {
        // Four is the most a navigation template's strip takes: carry on, where to, home, work.
        val t = CarTemplates.landing(context, home, work, {}, {}, {}, onCarryOn = {}) as NavigationTemplate
        val actions = t.actionStrip!!.actions
        assertEquals(4, actions.size)
        assertEquals("Carry on", actions[0].title.toString())
        assertTrue(actions[0].flags and Action.FLAG_PRIMARY != 0)
        assertTrue(actions[1].flags and Action.FLAG_PRIMARY == 0)
    }

    @Test
    fun preview_while_looking_is_loading() {
        val t = CarTemplates.preview(CarTripPlan(home), 3, {}, {}, carApi = 6) as RoutePreviewNavigationTemplate
        assertTrue(t.isLoading)
    }

    @Test
    fun preview_lists_the_ways_there_with_go() {
        val plan = CarTripPlan(home, listOf(route(), route(1500, adds = 4, via = null), route(1800)), selected = 1)
        val t = CarTemplates.preview(plan, 3, {}, {}, carApi = 6) as RoutePreviewNavigationTemplate
        assertEquals(3, t.itemList!!.items.size)
        assertEquals(1, t.itemList!!.selectedIndex)
        assertEquals("Go", t.navigateAction!!.title.toString())
    }

    @Test
    fun preview_keeps_to_what_the_car_allows() {
        val plan = CarTripPlan(home, List(5) { route(1000 + it * 100) }, selected = 4)
        val t = CarTemplates.preview(plan, 2, {}, {}, carApi = 6) as RoutePreviewNavigationTemplate
        assertEquals(2, t.itemList!!.items.size)
        assertEquals(1, t.itemList!!.selectedIndex)
    }

    @Test
    fun a_row_for_every_kind_of_place() {
        val kinds = listOf("home", "work", "favourite", "list", "recent", "parked", "place", null)
        val stops = kinds.map { Stop(-33.0, 151.0, "Somewhere", it, "An address") }
        val list = CarTemplates.places(context, stops, 20, "None", { 1234f }) {}
        assertEquals(kinds.size, list.items.size)
        CarTemplates.places(context, emptyList(), 6, "None", { null }) {}
    }

    @Test
    fun an_offline_result_says_so() {
        // WP-M6: results from the phone's offline areas, and usual routes, in the car's list.
        val offline = CarTemplates.placeRow(context, Stop(-33.0, 151.0, "12 Macquarie Street", "address", "Dubbo NSW 2830", offline = true), 1234f) {}
        assertEquals("Offline · 1.2 km · Dubbo NSW 2830", offline.texts.single().toString())
        val online = CarTemplates.placeRow(context, Stop(-33.0, 151.0, "Caltex", "place", "Dubbo"), 800f) {}
        assertEquals("800 m · Dubbo", online.texts.single().toString())
        val list = CarTemplates.places(context, listOf(Stop(-33.0, 151.0, "School", "usual", "Usual route")), 6, "Nothing found offline.", { null }) {}
        assertEquals(1, list.items.size)
    }

    @Test
    fun ending_a_trip_asks() {
        val t = CarTemplates.confirmStop({}, {}) as MessageTemplate
        assertEquals(2, t.actions.size)
        assertNotNull(t.header)
        assertEquals(Action.TYPE_BACK, t.header!!.startHeaderAction!!.type)
    }

    @Test
    fun routes_from_the_server() {
        // (-33.8, 151.2), (-33.9, 151.1) at six decimals.
        val shape = Maps.encodeShape(listOf(-33.8 to 151.2, -33.9 to 151.1))
        val body = JSONObject(
            """{"routes":[
              {"km":14.2,"seconds":1200,"via_name":"M4","legs":[{"shape":"$shape"}],"through":[{"lat":1.0,"lon":2.0,"heading":90},{"lat":3.0,"lon":4.0}],
               "traffic":{"seconds":1500,"adds_seconds":300}},
              {"km":9.0,"seconds":1000,"via_name":null,"legs":[],"through":[],"traffic":null}
            ]}""",
        )
        val got = CarPreview.parseRoutes(body)
        assertEquals(1500, got[0].seconds)
        assertEquals(5, got[0].addsMinutes)
        assertEquals("M4", got[0].via)
        assertEquals(151.2, got[0].line[0].first, 1e-6)
        assertEquals(-33.9, got[0].line[1].second, 1e-6)
        assertEquals(ThroughPoint(1.0, 2.0, 90), got[0].through[0])
        assertEquals(ThroughPoint(3.0, 4.0, null), got[0].through[1])
        assertEquals(1000, got[1].seconds)
        assertEquals(0, got[1].addsMinutes)
        assertNull(got[1].via)
    }

    @Test
    fun nothing_from_the_server_is_no_routes() {
        assertTrue(CarPreview.parseRoutes(JSONObject("{}")).isEmpty())
    }
}
