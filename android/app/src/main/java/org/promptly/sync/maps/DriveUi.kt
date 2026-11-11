package org.promptly.sync.maps

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.stadiamaps.ferrostar.composeui.views.components.maneuver.ManeuverImage
import com.stadiamaps.ferrostar.ui.formatters.DistanceMeasurementSystem
import com.stadiamaps.ferrostar.ui.formatters.LocalizedDistanceFormatter
import uniffi.ferrostar.DrivingSide
import uniffi.ferrostar.LaneInfo
import uniffi.ferrostar.VisualInstruction
import uniffi.ferrostar.VisualInstructionContent

// What's drawn over the map while you drive, here once so the map with no trip and the
// trip itself look like one app: big enough to read at a glance and to hit without
// looking, the same colours by day and by night, and nothing that isn't needed.

/** Day and night colours: warm neutrals, with Promptly's terracotta for the things to press. */
object DriveColours {
    val Danger = Color(0xFFC62828)
    val Warning = Color(0xFFB45309)

    /** The turn card: dark by day too, so white on it reads in full sun. */
    val Banner = Color(0xFF26211E)
    val BannerNight = Color(0xFF2E2825)
    val BannerStrip = Color(0x1FFFFFFF)

    fun route(dark: Boolean) = if (dark) Color(0xFF5B9DF0) else Color(0xFF2F78D6)

    fun scheme(dark: Boolean): ColorScheme = if (dark) {
        darkColorScheme(
            primary = Color(0xFFE08B6D),
            onPrimary = Color(0xFF3A1A0E),
            background = Color(0xFF1A1715),
            onBackground = Color(0xFFF3ECE6),
            surface = Color(0xFF3A3430),
            onSurface = Color(0xFFF3ECE6),
            surfaceVariant = Color(0xFF48413C),
            onSurfaceVariant = Color(0xFFC2B7AE),
            surfaceTint = Color(0xFF3A3430),
            surfaceContainerLowest = Color(0xFF1A1715),
            surfaceContainerLow = Color(0xFF3A3430),
            surfaceContainer = Color(0xFF3F3834),
            surfaceContainerHigh = Color(0xFF453E3A),
            surfaceContainerHighest = Color(0xFF4C4540),
            outline = Color(0xFF8C8178),
            outlineVariant = Color(0xFF5E554F),
            error = Color(0xFFF2867A),
            onError = Color(0xFF3B0A06),
        )
    } else {
        lightColorScheme(
            primary = Color(0xFFD97757),
            onPrimary = Color.White,
            background = Color(0xFFFAF7F4),
            onBackground = Color(0xFF211C19),
            surface = Color(0xFFFFFCFA),
            onSurface = Color(0xFF211C19),
            surfaceVariant = Color(0xFFF0EAE4),
            onSurfaceVariant = Color(0xFF5C534C),
            surfaceTint = Color(0xFFFFFCFA),
            surfaceContainerLowest = Color.White,
            surfaceContainerLow = Color(0xFFFFFCFA),
            surfaceContainer = Color(0xFFF8F4F0),
            surfaceContainerHigh = Color(0xFFF3EEE9),
            surfaceContainerHighest = Color(0xFFEEE8E2),
            outline = Color(0xFF8A7F77),
            outlineVariant = Color(0xFFDDD4CC),
            error = Color(0xFFB3261E),
            onError = Color.White,
        )
    }
}

/** Is the driving screen wearing its night colours? */
val LocalDriveDark = staticCompositionLocalOf { false }

/** The driving screen's colours follow its map (the sun, or what you chose), not the
 *  phone's own dark mode: a dark map under light buttons would be the worst of both. */
@Composable
fun DriveTheme(content: @Composable () -> Unit) {
    val mapDark by Nav.dark.collectAsState()
    val dark = mapDark ?: isSystemInDarkTheme()
    CompositionLocalProvider(LocalDriveDark provides dark) {
        MaterialTheme(colorScheme = remember(dark) { DriveColours.scheme(dark) }, content = content)
    }
}

internal val KILOMETRES = LocalizedDistanceFormatter(distanceMeasurementSystemOverride = DistanceMeasurementSystem.SI)

/** A round button to hit without looking: 56 dp, one picture, said aloud by its name. */
@Composable
fun RoundButton(icon: Int, label: String, modifier: Modifier = Modifier, filled: Boolean = false, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        shape = CircleShape,
        color = if (filled) scheme.primary else scheme.surface,
        contentColor = if (filled) scheme.onPrimary else scheme.onSurface,
        shadowElevation = 4.dp,
        modifier = modifier.size(56.dp).semantics {
            contentDescription = label
            role = Role.Button
        },
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(26.dp))
        }
    }
}

/** A button with words, for the one thing to do next ("Re-centre"). */
@Composable
fun WordButton(text: String, icon: Int?, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(50),
        color = scheme.primary,
        contentColor = scheme.onPrimary,
        shadowElevation = 4.dp,
        modifier = modifier.defaultMinSize(minHeight = 56.dp),
    ) {
        Row(Modifier.padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            icon?.let { Icon(painterResource(it), contentDescription = null, modifier = Modifier.size(22.dp)) }
            Text(text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** How fast you're going, and the road's limit beside it when the map knows one. Over
 *  the limit (by more than a needle's width), the speed turns red. */
@Composable
fun SpeedBadge(kmh: Int, limit: Int?, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val over = limit != null && kmh > limit + 2
    Row(
        modifier.clearAndSetSemantics {
            contentDescription = "$kmh kilometres an hour" + (limit?.let { ", limit $it" } ?: "")
        },
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Surface(shape = CircleShape, color = if (over) DriveColours.Danger else scheme.surface, contentColor = if (over) Color.White else scheme.onSurface, shadowElevation = 4.dp, modifier = Modifier.size(76.dp)) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Text("$kmh", fontSize = 28.sp, lineHeight = 30.sp, fontWeight = FontWeight.Bold)
                Text("km/h", fontSize = 12.sp, lineHeight = 13.sp)
            }
        }
        if (limit != null) {
            // The sign as it looks on the road: a red ring on white, day or night.
            Box(
                Modifier.size(52.dp).clip(CircleShape).background(Color.White).border(5.dp, Color(0xFFD32F2F), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text("$limit", color = Color(0xFF1B1B1B), fontSize = if (limit >= 100) 17.sp else 20.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

/** The road you're on. */
@Composable
fun RoadName(name: String, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    Surface(shape = RoundedCornerShape(50), color = scheme.surface, contentColor = scheme.onSurface, shadowElevation = 3.dp, modifier = modifier) {
        Text(name, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
    }
}

/** Something ahead that matters now: a hazard, a camera. */
@Composable
fun Alert(text: String, modifier: Modifier = Modifier, colour: Color = DriveColours.Danger) {
    Text(
        text,
        color = Color.White,
        fontWeight = FontWeight.Bold,
        fontSize = 17.sp,
        modifier = modifier.clip(RoundedCornerShape(50)).background(colour).padding(horizontal = 16.dp, vertical = 10.dp).semantics { liveRegion = LiveRegionMode.Polite },
    )
}

/** What the screen is doing, or can't do, said quietly. */
@Composable
fun Notice(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        color = Color.White,
        fontSize = 14.sp,
        fontWeight = FontWeight.Medium,
        modifier = modifier.clip(RoundedCornerShape(50)).background(Color(0xE63A3532)).padding(horizontal = 12.dp, vertical = 6.dp).semantics { liveRegion = LiveRegionMode.Polite },
    )
}

/** The next turn: how far, which way, onto what. Then the lanes to be in, and the turn
 *  straight after when it follows closely. */
@Composable
fun TurnBanner(
    instruction: VisualInstruction,
    metres: Double?,
    then: VisualInstructionContent?,
    side: DrivingSide,
    modifier: Modifier = Modifier,
) {
    val primary = instruction.primaryContent
    val lanes: List<LaneInfo>? = instruction.subContent?.laneInfo?.takeIf { it.isNotEmpty() } ?: primary.laneInfo?.takeIf { it.isNotEmpty() }
    Surface(
        shape = RoundedCornerShape(24.dp),
        color = if (LocalDriveDark.current) DriveColours.BannerNight else DriveColours.Banner,
        contentColor = Color.White,
        shadowElevation = 8.dp,
        modifier = modifier.fillMaxWidth(),
    ) {
        Column {
            Row(Modifier.padding(start = 14.dp, end = 18.dp, top = 14.dp, bottom = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(80.dp), contentAlignment = Alignment.Center) {
                    Box(Modifier.requiredSize(64.dp).scale(1.2f)) { ManeuverImage(primary, tint = Color.White) }
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    if (metres != null) {
                        Text(KILOMETRES.format(metres), fontSize = 40.sp, lineHeight = 44.sp, fontWeight = FontWeight.Bold)
                    }
                    Text(primary.text, fontSize = 24.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    instruction.secondaryContent?.text?.takeIf { it.isNotBlank() }?.let {
                        Text(it, fontSize = 17.sp, lineHeight = 21.sp, color = Color.White.copy(alpha = 0.8f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            if (lanes != null) {
                val picture = remember(lanes, side) { LaneImage.draw(lanes, side).asImageBitmap() }
                Box(Modifier.fillMaxWidth().background(DriveColours.BannerStrip).padding(vertical = 6.dp), contentAlignment = Alignment.Center) {
                    Image(picture, contentDescription = "Lanes to be in", modifier = Modifier.height(44.dp))
                }
            }
            if (then != null) {
                Row(
                    Modifier.fillMaxWidth().background(DriveColours.BannerStrip).padding(horizontal = 18.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text("Then", fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    Box(Modifier.size(30.dp), contentAlignment = Alignment.Center) {
                        Box(Modifier.requiredSize(64.dp).scale(0.47f)) { ManeuverImage(then, tint = Color.White) }
                    }
                    Text(then.text, fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Color.White.copy(alpha = 0.9f))
                }
            }
        }
    }
}

/** The bottom of a trip: when you'll get there, how long and how far that is, and End. */
@Composable
fun EtaBar(arrive: String, left: String, distance: String, trafficAddsMinutes: Int?, onEnd: () -> Unit, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    Surface(shape = RoundedCornerShape(24.dp), color = scheme.surface, contentColor = scheme.onSurface, shadowElevation = 8.dp, modifier = modifier.fillMaxWidth()) {
        Row(Modifier.padding(start = 22.dp, end = 12.dp, top = 12.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).clearAndSetSemantics { contentDescription = "Arriving $arrive, $left, $distance" }) {
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(arrive, fontSize = 30.sp, lineHeight = 34.sp, fontWeight = FontWeight.Bold)
                    Text("arrival", fontSize = 15.sp, lineHeight = 26.sp, color = scheme.onSurfaceVariant)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("$left · $distance", fontSize = 18.sp, fontWeight = FontWeight.Medium, color = scheme.onSurfaceVariant)
                    if (trafficAddsMinutes != null && trafficAddsMinutes >= 1) {
                        Text(
                            "· +$trafficAddsMinutes min traffic",
                            fontSize = 18.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = if (LocalDriveDark.current) Color(0xFFF2A65A) else DriveColours.Warning,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            Surface(
                onClick = onEnd,
                shape = RoundedCornerShape(50),
                color = DriveColours.Danger,
                contentColor = Color.White,
                modifier = Modifier.defaultMinSize(minWidth = 84.dp, minHeight = 56.dp).semantics { contentDescription = "End trip" },
            ) {
                Box(contentAlignment = Alignment.Center) { Text("End", fontSize = 19.sp, fontWeight = FontWeight.Bold) }
            }
        }
    }
}

/** The picture for what a trip says aloud. */
fun Sound.icon(): Int = when (this) {
    Sound.ALL -> org.promptly.sync.R.drawable.ic_map_sound_on
    Sound.ALERTS -> org.promptly.sync.R.drawable.ic_map_sound_alerts
    Sound.MUTE -> org.promptly.sync.R.drawable.ic_map_sound_off
}
