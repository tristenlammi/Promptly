package org.promptly.sync.maps

import android.content.res.Configuration
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.max
import androidx.compose.ui.graphics.Color
import com.stadiamaps.ferrostar.maplibreui.routeline.BorderedPolyline
import uniffi.ferrostar.GeographicCoordinate
import com.stadiamaps.ferrostar.composeui.config.NavigationViewComponentBuilder
import com.stadiamaps.ferrostar.composeui.config.VisualNavigationViewConfig
import com.stadiamaps.ferrostar.composeui.models.CameraControlState
import com.stadiamaps.ferrostar.composeui.runtime.paddingForGridView
import com.stadiamaps.ferrostar.composeui.theme.NavigationUITheme
import com.stadiamaps.ferrostar.composeui.views.overlays.LandscapeNavigationOverlayView
import com.stadiamaps.ferrostar.composeui.views.overlays.PortraitNavigationOverlayView
import com.stadiamaps.ferrostar.core.NavigationUiState
import com.stadiamaps.ferrostar.core.NavigationViewModel
import com.stadiamaps.ferrostar.maplibreui.NavigationMapPuckStyle
import com.stadiamaps.ferrostar.maplibreui.NavigationMapView
import com.stadiamaps.ferrostar.maplibreui.routeline.RouteOverlayBuilder
import com.stadiamaps.ferrostar.maplibreui.runtime.NavigationMapState
import com.stadiamaps.ferrostar.maplibreui.runtime.navigationCameraOptions
import org.maplibre.compose.map.MapOptions
import org.maplibre.compose.map.OrnamentOptions
import org.maplibre.compose.style.BaseStyle
import org.maplibre.compose.util.MaplibreComposable

/** Your route from where you are on it: the part behind you isn't drawn. The same on
 *  the phone and the car. */
fun routeAheadOverlay(dark: Boolean) = RouteOverlayBuilder(navigationPath = { ui ->
    val ahead = rememberRouteAhead(ui)
    if (ahead.size >= 2) BorderedPolyline(points = ahead, color = DriveColours.route(dark), borderColor = DriveColours.routeEdge(dark))
})

/**
 * The line still ahead of you, ending under the arrow: cut where the arrow is shown
 * (it glides along the route), not at the latest GPS fix, which is up to a second ahead
 * of it. The line is gently rounded once per route ([RouteAhead.smooth]), and only
 * re-cut every few metres, so it isn't rebuilt every frame.
 */
@Composable
fun rememberRouteAhead(ui: NavigationUiState): List<GeographicCoordinate> {
    val shown = rememberTripShown(ui)
    val line = remember(ui.routeGeometry) {
        ui.routeGeometry?.takeIf { it.size >= 2 }?.let { g -> RouteRuler(RouteAhead.smooth(g.map { it.lat to it.lng })) }
    }
    val onRoute = ui.isNavigating() && ui.routeDeviation is uniffi.ferrostar.RouteDeviation.NoDeviation
    if (line == null || shown == null || !onRoute) return remember(ui.remainingSteps, ui.location) { ui.aheadLine() }
    val along = line.project(shown.lat, shown.lon)
    val step = (along / 4.0).toLong()
    return remember(line, step) { line.from(along).map { GeographicCoordinate(it.first, it.second) } }
}

/** The trip's line from you to the end, or the whole of it before the steps are known. */
internal fun NavigationUiState.aheadLine(): List<GeographicCoordinate> {
    val steps = remainingSteps.orEmpty().map { step -> step.geometry.map { it.lat to it.lng } }
    if (steps.isEmpty()) return routeGeometry.orEmpty()
    val here = location?.coordinates?.let { it.lat to it.lng }
    return RouteAhead.from(steps, here).map { GeographicCoordinate(it.first, it.second) }
}

/** The library's own position dot, drawn in nothing: [Puck] (the arrow from the map
 *  with no trip, big and turning with the car) is drawn instead, on the phone and the
 *  car alike. */
val HiddenLibraryPuck = NavigationMapPuckStyle(
    dotFillColorCurrentLocation = Color.Transparent,
    dotFillColorOldLocation = Color.Transparent,
    accuracyStrokeColor = Color.Transparent,
    accuracyFillColor = Color.Transparent,
    bearingColor = Color.Transparent,
)

/** You on a trip's map: the one arrow, where the trip says you are (on the road),
 *  pointing the way you're going. The library's own dot is never drawn. */
@Composable
@MaplibreComposable
fun YouOnTrip(state: NavigationUiState) {
    // Glided along the route with the camera, so it sits still on the screen.
    val at = rememberTripShown(state)
    Puck(at?.let { it.lat to it.lon }, at?.bearing?.toFloat() ?: 0f)
}

/** The trip's map with the turn card and arrival bar over it: the navigation library's
 *  own view (DynamicallyOrientingNavigationView, 0.59), put together here so its
 *  re-centre / whole-route button can be left out. That view always draws the button
 *  (ours is in the button column); given no room it still left its shadow on the map. */
@Composable
fun DriveNavigationView(
    modifier: Modifier,
    baseStyle: BaseStyle,
    navigationMapState: NavigationMapState,
    viewModel: NavigationViewModel,
    locationPuckStyle: NavigationMapPuckStyle,
    theme: NavigationUITheme,
    config: VisualNavigationViewConfig,
    views: NavigationViewComponentBuilder,
    routeOverlayBuilder: RouteOverlayBuilder?,
    onTapExit: (() -> Unit)?,
    mapContent: @Composable @MaplibreComposable ((NavigationUiState) -> Unit)?,
) {
    val configuration = LocalConfiguration.current
    val landscape = configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    val direction = LocalLayoutDirection.current
    val uiState by viewModel.navigationUiState.collectAsState()
    val navigating = uiState.isNavigating()
    var progressHeight by remember { mutableStateOf(0.dp) }
    val insets = remember { mutableStateOf(PaddingValues(0.dp)) }
    val grid = paddingForGridView()
    val bars = WindowInsets.systemBars.asPaddingValues()

    // The map's logo and credit, clear of the arrival bar.
    val barHeight = if (navigating && !landscape) progressHeight else 0.dp
    val mapOptions = remember(barHeight, bars, grid, direction) {
        MapOptions(
            ornamentOptions = OrnamentOptions(
                isCompassEnabled = false,
                isScaleBarEnabled = false,
                logoAlignment = Alignment.BottomStart,
                attributionAlignment = Alignment.BottomEnd,
                padding = PaddingValues(
                    start = bars.calculateStartPadding(direction),
                    end = bars.calculateEndPadding(direction) + grid.calculateEndPadding(direction) + 16.dp,
                    top = bars.calculateTopPadding() + 8.dp,
                    bottom = bars.calculateBottomPadding() + grid.calculateBottomPadding() + barHeight + 8.dp,
                ),
            ),
        )
    }
    // You, low on the screen but above the arrival bar.
    val base = navigationCameraOptions()
    val camera = if (!navigating) base else {
        val padding = base.navigationPadding
        val screen = configuration.screenHeightDp.dp
        val target = (screen + padding.calculateTopPadding() - padding.calculateBottomPadding()) / 2
        val lowest = screen - insets.value.calculateBottomPadding() - 24.dp
        val extra: Dp = max(0.dp, (target - lowest) * 2)
        base.copy(
            navigationPadding = PaddingValues(
                start = padding.calculateStartPadding(direction),
                top = padding.calculateTopPadding(),
                end = padding.calculateEndPadding(direction),
                bottom = padding.calculateBottomPadding() + extra,
            ),
        )
    }

    Box(modifier) {
        NavigationMapView(
            baseStyle = baseStyle,
            navigationMapState = navigationMapState,
            uiState = uiState,
            mapOptions = mapOptions,
            navigationCameraOptions = camera,
            routeOverlayBuilder = routeOverlayBuilder,
            locationPuckStyle = locationPuckStyle,
            // One arrow only: ours ([YouOnTrip]), never the library's dot as well.
            showDefaultPuck = false,
            content = mapContent,
        )
        if (navigating) {
            val overlay = Modifier.padding(bars).padding(grid)
            if (landscape) {
                LandscapeNavigationOverlayView(
                    modifier = overlay,
                    viewModel = viewModel,
                    cameraControlState = CameraControlState.Hidden,
                    theme = theme,
                    config = config,
                    views = views,
                    mapViewInsets = insets,
                    contentPadding = bars,
                    onTapExit = onTapExit,
                )
            } else {
                PortraitNavigationOverlayView(
                    modifier = overlay,
                    viewModel = viewModel,
                    cameraControlState = CameraControlState.Hidden,
                    theme = theme,
                    config = config,
                    views = views,
                    mapViewInsets = insets,
                    contentPadding = bars,
                    onProgressViewHeightChange = { progressHeight = it },
                    onTapExit = onTapExit,
                )
            }
        }
    }
}
