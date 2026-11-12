package org.promptly.sync.maps

import android.content.Context
import android.util.Log
import androidx.car.app.navigation.model.Maneuver
import com.stadiamaps.ferrostar.car.app.template.models.toCarManeuver
import com.stadiamaps.ferrostar.core.NavigationUiState
import com.stadiamaps.ferrostar.core.NavigationViewModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import uniffi.ferrostar.DrivingSide
import uniffi.ferrostar.ManeuverType
import uniffi.ferrostar.RouteStep
import uniffi.ferrostar.VisualInstruction
import uniffi.ferrostar.VisualInstructionContent

/** Turns the car can always draw.
 *
 *  The car library refuses a "go round the roundabout and take exit N" turn without the N,
 *  and the router doesn't always send one. That refusal, inside the navigation library's
 *  link to the car, stopped the whole app about ten minutes into a drive (Android 1.8.0,
 *  a roundabout on the route): the car's screen went blank with no way back. A roundabout
 *  with no exit number is drawn as "exit the roundabout" instead, which the car accepts;
 *  the spoken direction is unchanged. */
object CarManeuvers {
    private const val TAG = "PromptlyCarMap"
    private val roundabouts = setOf(ManeuverType.ROUNDABOUT, ManeuverType.ROTARY, ManeuverType.ROUNDABOUT_TURN)

    /** [content] as a turn the car accepts with this [exit] (null: the router gave none). */
    fun safeContent(context: Context, content: VisualInstructionContent, side: DrivingSide, exit: Int?): VisualInstructionContent {
        if (exit != null || content.maneuverType !in roundabouts) return content
        val fine = runCatching { content.toCarManeuver(context, side, null) }.isSuccess
        return if (fine) content else content.copy(maneuverType = ManeuverType.EXIT_ROUNDABOUT)
    }

    /** The car's picture of a turn. Never throws: at worst a turn with no picture. */
    fun maneuver(context: Context, content: VisualInstructionContent, side: DrivingSide, exit: Int?): Maneuver =
        runCatching { safeContent(context, content, side, exit).toCarManeuver(context, side, exit) }
            .getOrElse {
                Log.w(TAG, "The car couldn't draw a ${content.maneuverType} turn", it)
                Maneuver.Builder(Maneuver.TYPE_UNKNOWN).build()
            }

    private fun safeInstruction(context: Context, v: VisualInstruction, side: DrivingSide, exit: Int?): VisualInstruction =
        v.copy(
            primaryContent = safeContent(context, v.primaryContent, side, exit),
            secondaryContent = v.secondaryContent?.let { safeContent(context, it, side, exit) },
            subContent = v.subContent?.let { safeContent(context, it, side, exit) },
        )

    /** A step whose turns the car can draw. */
    fun safeStep(context: Context, step: RouteStep): RouteStep {
        val exit = step.roundaboutExitNumber?.toInt()
        if (exit != null) return step
        val side = step.drivingSide ?: DrivingSide.RIGHT
        val fixed = step.visualInstructions.map { safeInstruction(context, it, side, null) }
        return if (fixed == step.visualInstructions) step else step.copy(visualInstructions = fixed)
    }

    fun safeState(context: Context, state: NavigationUiState): NavigationUiState {
        val steps = state.remainingSteps ?: return state
        val fixed = steps.map { safeStep(context, it) }
        return if (fixed == steps) state else state.copy(remainingSteps = fixed)
    }

    /** The trip as the car's link sees it: the same, with every turn one the car can draw. */
    class CarSafeModel(
        private val context: Context,
        private val inner: NavigationViewModel,
        scope: CoroutineScope,
    ) : NavigationViewModel by inner {
        override val navigationUiState: StateFlow<NavigationUiState> =
            inner.navigationUiState.map { safeState(context, it) }
                .stateIn(scope, SharingStarted.Eagerly, safeState(context, inner.navigationUiState.value))
    }
}
