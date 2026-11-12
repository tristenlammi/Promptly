package org.promptly.sync.maps

import android.content.Context
import androidx.car.app.navigation.model.Maneuver
import androidx.test.core.app.ApplicationProvider
import com.stadiamaps.ferrostar.car.app.template.models.toCarManeuver
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import uniffi.ferrostar.DrivingSide
import uniffi.ferrostar.ManeuverModifier
import uniffi.ferrostar.ManeuverType
import uniffi.ferrostar.VisualInstructionContent

/** A roundabout with no exit number stopped the whole app in the car (Android 1.8.0). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CarManeuversTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private fun roundabout() = VisualInstructionContent(
        text = "Bells Creek Arterial Road",
        maneuverType = ManeuverType.ROUNDABOUT,
        maneuverModifier = ManeuverModifier.RIGHT,
        roundaboutExitDegrees = null,
        laneInfo = null,
        exitNumbers = emptyList(),
    )

    @Test
    fun the_library_refuses_a_roundabout_without_its_exit() {
        // What happened in the car: if this ever stops throwing, the library fixed it.
        val refused = runCatching { roundabout().toCarManeuver(context, DrivingSide.LEFT, null) }
        assertTrue(refused.exceptionOrNull() is IllegalArgumentException)
    }

    @Test
    fun a_roundabout_without_its_exit_is_drawn_as_leaving_one() {
        val safe = CarManeuvers.safeContent(context, roundabout(), DrivingSide.LEFT, null)
        assertEquals(ManeuverType.EXIT_ROUNDABOUT, safe.maneuverType)
        // And the car takes it.
        CarManeuvers.maneuver(context, roundabout(), DrivingSide.LEFT, null)
        safe.toCarManeuver(context, DrivingSide.LEFT, null)
    }

    @Test
    fun a_roundabout_with_its_exit_is_left_alone() {
        val content = roundabout()
        assertEquals(content, CarManeuvers.safeContent(context, content, DrivingSide.LEFT, 2))
        val m = CarManeuvers.maneuver(context, content, DrivingSide.LEFT, 2)
        assertEquals(2, m.roundaboutExitNumber)
    }

    @Test
    fun the_car_card_never_throws() {
        val m = CarManeuvers.maneuver(context, roundabout(), DrivingSide.RIGHT, null)
        assertTrue(m.type != Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CCW && m.type != Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CW)
    }
}
