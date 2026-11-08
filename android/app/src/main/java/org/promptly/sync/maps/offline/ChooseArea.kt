package org.promptly.sync.maps.offline

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.maplibre.compose.camera.CameraPosition
import org.maplibre.compose.camera.rememberCameraState
import org.maplibre.compose.map.GestureOptions
import org.maplibre.compose.map.MapOptions
import org.maplibre.compose.map.MaplibreMap
import org.maplibre.compose.map.OrnamentOptions
import org.maplibre.compose.style.BaseStyle
import org.maplibre.spatialk.geojson.Position

/** Choose an area: move the map so the place is inside the frame, see its size, and
 *  download. The squares the frame touches are shaded, because whole squares are what
 *  the phone keeps. */
@OptIn(FlowPreview::class, ExperimentalLayoutApi::class)
@Composable
fun ChooseArea(
    style: String,
    start: Pair<Double, Double>?,
    onBack: () -> Unit,
    onSaved: (OfflineApi.Area) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val accent = MaterialTheme.colorScheme.primary
    val camera = rememberCameraState(
        CameraPosition(target = Position(start?.second ?: 151.21, start?.first ?: -33.87), zoom = if (start != null) 8.5 else 7.0),
    )
    var mapSize by remember { mutableStateOf(IntSize.Zero) }
    // The frame's size without the keyboard: typing a name doesn't change the area.
    var frameSize by remember { mutableStateOf(IntSize.Zero) }
    val typing = WindowInsets.isImeVisible
    LaunchedEffect(mapSize, typing) { if (!typing && mapSize != IntSize.Zero) frameSize = mapSize }
    var estimate by remember { mutableStateOf<OfflineApi.Estimate?>(null) }
    var box by remember { mutableStateOf<OfflineApi.Box?>(null) }
    var checking by remember { mutableStateOf(true) }
    var name by remember { mutableStateOf("") }
    var named by remember { mutableStateOf(false) }
    var addresses by remember { mutableStateOf(true) }
    var saving by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val frameTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding() + 76.dp
    val frameSide = 28.dp

    // Each time the map settles: the frame's box, its squares and size, and a name.
    LaunchedEffect(frameSize, addresses) {
        if (frameSize == IntSize.Zero) return@LaunchedEffect
        camera.awaitProjection()
        snapshotFlow { camera.isCameraMoving to camera.position }
            .filter { !it.first }
            .debounce(350)
            .distinctUntilChanged()
            .collect {
                val projection = camera.projection ?: return@collect
                val w = with(density) { frameSize.width.toDp() }
                val h = with(density) { frameSize.height.toDp() }
                val nw = projection.positionFromScreenLocation(DpOffset(frameSide, frameTop))
                val se = projection.positionFromScreenLocation(DpOffset(w - frameSide, h - frameSide))
                val b = OfflineApi.Box(
                    minOf(nw.longitude, se.longitude), minOf(nw.latitude, se.latitude),
                    maxOf(nw.longitude, se.longitude), maxOf(nw.latitude, se.latitude),
                )
                box = b
                checking = true
                problem = null
                val api = Offline.api(context)
                if (api == null) {
                    problem = SignedOut().message
                    checking = false
                    return@collect
                }
                runCatching { withContext(Dispatchers.IO) { api.estimate(b, addresses) } }
                    .onSuccess { estimate = it }
                    .onFailure { problem = it.message ?: "Couldn't work out the size. Check your connection." }
                checking = false
                if (!named) {
                    val centre = camera.position.target
                    withContext(Dispatchers.IO) { runCatching { api.placeName(centre.latitude, centre.longitude) }.getOrNull() }
                        ?.takeIf { !named }?.let { name = it }
                }
            }
    }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).imePadding()) {
        Box(Modifier.weight(1f).fillMaxWidth().onSizeChanged { mapSize = it }) {
            MaplibreMap(
                modifier = Modifier.fillMaxSize(),
                baseStyle = BaseStyle.Uri(style),
                cameraState = camera,
                options = MapOptions(gestureOptions = GestureOptions.RotationLocked, ornamentOptions = OrnamentOptions.OnlyLogo),
            ) {
                AreaLayers(estimate?.cells.orEmpty(), null, accent)
            }
            // The frame: what's inside is what you're choosing.
            Canvas(Modifier.fillMaxSize().semantics { contentDescription = "The frame. Move and zoom the map to choose what's inside it." }) {
                val top = frameTop.toPx()
                val side = frameSide.toPx()
                val shade = Color.Black.copy(alpha = 0.28f)
                val frame = Size(size.width - 2 * side, size.height - top - side)
                drawRect(shade, Offset.Zero, Size(size.width, top))
                drawRect(shade, Offset(0f, size.height - side), Size(size.width, side))
                drawRect(shade, Offset(0f, top), Size(side, frame.height))
                drawRect(shade, Offset(size.width - side, top), Size(side, frame.height))
                drawRoundRect(Color.White, Offset(side, top), frame, CornerRadius(6.dp.toPx()), style = Stroke(3.dp.toPx()))
                drawRoundRect(accent, Offset(side, top), frame, CornerRadius(6.dp.toPx()), style = Stroke(1.5.dp.toPx()))
            }
            Row(
                Modifier.statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp).fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Surface(shape = CircleShape, shadowElevation = 3.dp) {
                    TextButton(onClick = onBack) { Text("Back") }
                }
                Surface(
                    Modifier.padding(start = 10.dp),
                    shape = RoundedCornerShape(50),
                    shadowElevation = 3.dp,
                ) {
                    Text(
                        "Move the map so your area is in the frame",
                        Modifier.padding(horizontal = 14.dp, vertical = 9.dp),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val e = estimate
            val text = when {
                problem != null -> problem!!
                e == null -> "Working out the size…"
                !e.ready -> StillBuilding().message!!
                e.cells.isEmpty() -> "There's no map here. Move the map over land."
                e.tooBig -> "That's too big for one download (${e.cells.size} squares). Zoom in, or save it as two areas."
                (box?.let { it.east - it.west } ?: 0.0) > 6.0 && e.bytes != null ->
                    "That's a big area: ${Sizes.text(e.bytes)}. Zoom in, or download it on Wi-Fi."
                e.bytes != null -> "About ${Sizes.text(e.bytes)}" + (name.takeIf { it.isNotBlank() }?.let { " · $it" } ?: "")
                else -> "Working out the size…"
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text,
                    Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite },
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = if (problem != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                )
                if (checking) CircularProgressIndicator(Modifier.padding(start = 8.dp).size(22.dp), strokeWidth = 2.dp)
            }
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.take(80); named = true },
                label = { Text("Name") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("House numbers", style = MaterialTheme.typography.bodyLarge)
                    Text(
                        "Find addresses like \"12 Smith St\" with no signal" +
                            (e?.addressesBytes?.takeIf { it >= 1_000_000 }?.let { " (+${Sizes.text(it)})" } ?: ""),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(checked = addresses, onCheckedChange = { addresses = it })
            }
            val ok = e != null && e.ready && e.cells.isNotEmpty() && !e.tooBig && problem == null && name.isNotBlank() && !saving && !checking
            Button(
                onClick = {
                    val b = box ?: return@Button
                    saving = true
                    scope.launch {
                        val api = Offline.api(context)
                        runCatching { withContext(Dispatchers.IO) { api!!.createView(name.trim(), b, addresses) } }
                            .onSuccess { area ->
                                withContext(Dispatchers.IO) {
                                    runCatching { Offline.refresh(context) }
                                    runCatching {
                                        api!!.report(area.id, Offline.deviceId(context), Offline.deviceName(context), "waiting", null, 0)
                                    }
                                }
                                Offline.download(context)
                                onSaved(area)
                            }
                            .onFailure { problem = it.message ?: "Couldn't save the area." }
                        saving = false
                    }
                },
                enabled = ok,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (saving) "Saving…" else "Download") }
            if (name.isBlank() && e != null && e.cells.isNotEmpty()) {
                Text("Give the area a name.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
