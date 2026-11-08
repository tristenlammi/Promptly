package org.promptly.sync.maps

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.car.app.model.ListTemplate
import androidx.car.app.navigation.model.MapWithContentTemplate
import androidx.car.app.navigation.model.MessageInfo
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.car.app.validation.HostValidator
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import uniffi.ferrostar.DrivingSide
import uniffi.ferrostar.LaneInfo
import uniffi.ferrostar.ManeuverModifier
import uniffi.ferrostar.ManeuverType
import uniffi.ferrostar.VisualInstruction
import uniffi.ferrostar.VisualInstructionContent

/** WP-A1: the car's new screens (arrival, finding a new route, lanes, the newer route
 *  preview), "navigate to" links, and the host check. Every template is built, so the
 *  car library's own rules are checked as a car would. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CarReadyTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val home = Stop(-33.8, 151.2, "Home", "home")
    private fun route(seconds: Int = 1320) = CarRoute(seconds, 14.2, "M4", 0, listOf(151.2 to -33.8, 151.1 to -33.9), emptyList())

    // ---- Route preview on newer cars --------------------------------------------

    @Test
    fun newer_cars_get_the_map_with_a_list_and_go() {
        val plan = CarTripPlan(home, listOf(route(), route(1500)), selected = 1)
        val t = CarTemplates.preview(plan, 3, {}, {}, carApi = 7) as MapWithContentTemplate
        val list = t.contentTemplate as ListTemplate
        assertEquals("Home", list.header!!.title.toString())
        assertEquals(2, list.singleList!!.items.size)
        assertEquals(1, list.singleList!!.selectedIndex)
        assertEquals("Go", t.actionStrip!!.actions.single().title.toString())
    }

    @Test
    fun newer_cars_see_it_loading_while_looking() {
        val t = CarTemplates.preview(CarTripPlan(home), 3, {}, {}, carApi = 8) as MapWithContentTemplate
        assertTrue((t.contentTemplate as ListTemplate).isLoading)
    }

    @Test
    fun what_the_routes_avoid_is_said() {
        assertEquals("no tolls", CarTemplates.avoiding(TripOptions(tolls = true)))
        assertEquals("no tolls, no highways, no ferries", CarTemplates.avoiding(TripOptions(tolls = true, highways = true, ferries = true)))
        assertNull(CarTemplates.avoiding(TripOptions()))
        val plan = CarTripPlan(home, listOf(route()), options = TripOptions(tolls = true))
        val list = (CarTemplates.preview(plan, 3, {}, {}, carApi = 7) as MapWithContentTemplate).contentTemplate as ListTemplate
        val row = list.singleList!!.items.single() as androidx.car.app.model.Row
        assertTrue(row.texts.any { it.toString().contains("no tolls") })
    }

    // ---- Driving card ----------------------------------------------------------

    private fun instruction(lanes: List<LaneInfo>?, inPrimary: Boolean = false): VisualInstruction {
        val primary = VisualInstructionContent("Turn right onto George Street", ManeuverType.TURN, ManeuverModifier.RIGHT, null, if (inPrimary) lanes else null, emptyList())
        val sub = if (lanes != null && !inPrimary) VisualInstructionContent("", ManeuverType.TURN, ManeuverModifier.RIGHT, null, lanes, emptyList()) else null
        return VisualInstruction(primary, null, sub, 200.0)
    }

    private val lanes = listOf(
        LaneInfo(false, listOf("straight"), null),
        LaneInfo(true, listOf("straight", "right"), "right"),
        LaneInfo(true, listOf("right"), "right"),
    )

    @Test
    fun finding_a_new_route_shows_the_car_loading_card() {
        val info = CarTemplates.routingInfo(context, instruction(null), 150.0, DrivingSide.LEFT, null, rerouting = true)!!
        assertTrue(info.isLoading)
        NavigationTemplate.Builder().setNavigationInfo(info).setActionStrip(endOnly()).build()
    }

    @Test
    fun the_turn_card_carries_lanes_and_their_picture() {
        // The server's router puts lanes on the instruction under the turn.
        val info = CarTemplates.routingInfo(context, instruction(lanes), 150.0, DrivingSide.LEFT, null, rerouting = false)!!
        val step = info.currentStep!!
        assertEquals(3, step.lanes.size)
        assertNotNull(step.lanesImage)
        assertEquals("Turn right onto George Street", step.cue.toString())
        NavigationTemplate.Builder().setNavigationInfo(info).setActionStrip(endOnly()).build()
    }

    @Test
    fun lanes_on_the_turn_itself_work_too() {
        val info = CarTemplates.routingInfo(context, instruction(lanes, inPrimary = true), 150.0, DrivingSide.RIGHT, null, rerouting = false)!!
        assertEquals(3, info.currentStep!!.lanes.size)
        assertNotNull(info.currentStep!!.lanesImage)
    }

    @Test
    fun no_lanes_no_picture() {
        val info = CarTemplates.routingInfo(context, instruction(null), 150.0, DrivingSide.LEFT, null, rerouting = false)!!
        assertTrue(info.currentStep!!.lanes.isEmpty())
        assertNull(info.currentStep!!.lanesImage)
    }

    @Test
    fun nothing_to_show_before_the_first_instruction() {
        assertNull(CarTemplates.routingInfo(context, null, null, DrivingSide.LEFT, null, rerouting = false))
    }

    @Test
    fun lane_picture_is_one_cell_per_lane() {
        val picture = LaneImage.draw(lanes, DrivingSide.LEFT)
        assertEquals(picture.height * 3, picture.width)
        val uturn = LaneImage.draw(listOf(LaneInfo(true, listOf("uturn"), "uturn")), DrivingSide.RIGHT)
        assertEquals(uturn.height, uturn.width)
        assertEquals(0f, LaneImage.angleOf("straight"))
        assertEquals(90f, LaneImage.angleOf("right"))
        assertEquals(-40f, LaneImage.angleOf("slight left"))
        assertNull(LaneImage.angleOf("uturn"))
        assertEquals(0f, LaneImage.angleOf("something new"))
    }

    private fun endOnly() = androidx.car.app.model.ActionStrip.Builder()
        .addAction(androidx.car.app.model.Action.Builder().setTitle("End").setOnClickListener { }.build()).build()

    // ---- Arriving ------------------------------------------------------------

    @Test
    fun arriving_says_where_with_parking_and_done() {
        val t = CarTemplates.arrival(context, "Home", {}, {}) as NavigationTemplate
        val info = t.navigationInfo as MessageInfo
        assertEquals("You've arrived", info.title.toString())
        assertEquals("Home", info.text.toString())
        assertEquals(listOf("Save parking", "Done"), t.actionStrip!!.actions.map { it.title.toString() })
    }

    @Test
    fun arriving_somewhere_unnamed() {
        val t = CarTemplates.arrival(context, null, {}, {}) as NavigationTemplate
        assertNull((t.navigationInfo as MessageInfo).text)
    }

    // ---- "Navigate to" links -----------------------------------------------------

    private fun view(uri: String) = Intent(Intent.ACTION_VIEW, Uri.parse(uri))
    private val saved = TripOptions(tolls = true)

    @Test
    fun google_navigation_to_a_place() {
        val ask = MapLinks.read(view("google.navigation:q=-33.8568,151.2153"), saved) as MapLinks.Ask.Navigate
        assertEquals(-33.8568, ask.stop.lat, 1e-6)
        assertEquals(151.2153, ask.stop.lon, 1e-6)
        assertEquals(saved, ask.options)
        assertFalse(ask.addStop)
    }

    @Test
    fun google_navigation_by_name_with_its_own_avoids() {
        val ask = MapLinks.read(view("google.navigation:q=Sydney+Opera+House&avoid=hf"), saved) as MapLinks.Ask.NavigateTo
        assertEquals("Sydney Opera House", ask.query)
        assertEquals(TripOptions("drive", tolls = false, highways = true, ferries = true), ask.options)
    }

    @Test
    fun google_navigation_walking() {
        val ask = MapLinks.read(view("google.navigation:q=-33.8,151.2&mode=w"), saved) as MapLinks.Ask.Navigate
        assertEquals("walk", ask.options.mode)
    }

    @Test
    fun the_cars_own_navigate_action() {
        val intent = Intent(androidx.car.app.CarContext.ACTION_NAVIGATE, Uri.parse("geo:-33.8,151.2"))
        assertTrue(MapLinks.read(intent, saved) is MapLinks.Ask.Navigate)
    }

    @Test
    fun geo_links_show_a_place_or_search() {
        val pin = MapLinks.read(view("geo:0,0?q=-33.8,151.2(Mum's)"), saved) as MapLinks.Ask.Show
        assertEquals("Mum's", pin.stop.name)
        val spot = MapLinks.read(view("geo:-33.8,151.2"), saved) as MapLinks.Ask.Show
        assertEquals("Dropped pin", spot.stop.name)
        val search = MapLinks.read(view("geo:0,0?q=coffee"), saved) as MapLinks.Ask.Search
        assertEquals("coffee", search.query)
    }

    @Test
    fun links_that_arent_places() {
        assertNull(MapLinks.read(view("https://example.com/"), saved))
        assertNull(MapLinks.read(Intent(Intent.ACTION_VIEW), saved))
    }

    @Test
    fun phone_links_go_to_the_driving_screen_or_the_web_app() {
        val drive = MapLinks.driveLink(Stop(-33.8, 151.2, "Mum; Dad"), TripOptions(tolls = true))
        assertEquals("promptlymaps", drive.scheme)
        assertEquals("navigate", drive.authority)
        assertEquals("-33.800000,151.200000,Mum  Dad", drive.getQueryParameter("stops"))
        assertEquals("1", drive.getQueryParameter("tolls"))
        assertEquals("0", drive.getQueryParameter("ferries"))
        assertEquals("/maps?to=-33.800000%2C151.200000%2CHome", MapLinks.webPath(MapLinks.Ask.Show(home)))
        assertEquals("/maps?q=fish%20%26%20chips", MapLinks.webPath(MapLinks.Ask.Search("fish & chips")))
    }

    // ---- Hosts, routes ---------------------------------------------------------

    @Test
    fun only_googles_car_hosts_in_release() {
        assertSame(HostValidator.ALLOW_ALL_HOSTS_VALIDATOR, carHosts(context, debug = true))
        val release = carHosts(context, debug = false)
        assertNotSame(HostValidator.ALLOW_ALL_HOSTS_VALIDATOR, release)
        assertTrue(release.allowedHosts.containsKey("com.google.android.projection.gearhead"))
        assertFalse(release.allowedHosts.containsKey("com.example.fakehost"))
    }

    @Test
    fun route_requests_carry_the_trip_options() {
        val none = ServerRoutes.requestOptions(TripOptions())
        assertEquals(0, none.getJSONObject("costing_options").getJSONObject("auto").length())
        val car = ServerRoutes.requestOptions(TripOptions(tolls = true, highways = true, ferries = true)).getJSONObject("costing_options").getJSONObject("auto")
        assertEquals(0.0, car.getDouble("use_tolls"), 0.0)
        assertEquals(0.0, car.getDouble("use_highways"), 0.0)
        assertEquals(0.0, car.getDouble("use_ferry"), 0.0)
        // Highways only mean something when driving.
        val walk = ServerRoutes.requestOptions(TripOptions("walk", highways = true)).getJSONObject("costing_options")
        assertFalse(walk.getJSONObject("pedestrian").has("use_highways"))
        assertEquals("bicycle", ServerRoutes.profileOf(TripOptions("cycle")))
    }

    @Test
    fun saved_places_read_back_the_same() {
        val body = org.json.JSONObject(
            """{"places":[{"kind":"home","lat":-33.8,"lon":151.2,"name":"Home","address":null}],
               "parked":{"lat":-33.9,"lon":151.1},"recents":[{"lat":-33.7,"lon":151.0,"name":"Shops","address":"1 Main St"}]}""",
        )
        val got = Maps.placesFrom(body)
        assertEquals(listOf("Home", "Your car", "Shops"), got.map { it.name })
        assertNull(got[0].address)
        assertEquals("1 Main St", got[2].address)
    }
}
