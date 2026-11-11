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
