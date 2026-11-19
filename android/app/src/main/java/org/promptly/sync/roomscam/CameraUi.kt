package org.promptly.sync.roomscam

import android.widget.VideoView
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import org.promptly.sync.R
import kotlin.math.roundToInt

private val Terracotta = Color(0xFFD97757)
private val Chip = Color(0x73000000)

@Composable
fun CameraScreen(a: RoomsCameraActivity) {
    Box(Modifier.fillMaxSize().background(Color.Black).testTag("rooms-camera")) {
        when (a.phase) {
            RoomsCameraActivity.Phase.ASKING -> Unit
            RoomsCameraActivity.Phase.REFUSED -> Message(
                "Promptly isn't allowed to use the camera.",
                "Allow Camera for Promptly in your phone's settings, then come back.",
                "Open settings", a::openSettings, "Choose from your photos", a::openGallery, a::close,
            )
            RoomsCameraActivity.Phase.PROBLEM -> Message(a.problem, "", "Try again", a::open, "Choose from your photos", a::openGallery, a::close)
            RoomsCameraActivity.Phase.REVIEW -> Review(a)
            else -> Live(a)
        }
    }
}

// ==================================================================== live

@Composable
private fun Live(a: RoomsCameraActivity) {
    val recording = a.phase == RoomsCameraActivity.Phase.RECORDING
    val busy = a.phase == RoomsCameraActivity.Phase.SAVING || a.phase == RoomsCameraActivity.Phase.STARTING
    val turn by animateFloatAsState(
        // The short way round: 270 is a quarter turn the other way.
        when (a.turned) { 90 -> 90f; 270 -> -90f; 180 -> 180f; else -> 0f }, label = "turn",
    )
    Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
        // ---- along the top
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            RoundButton(R.drawable.ic_map_close, "Close the camera", turn, onClick = a::close, tag = "cam-close")
            if (recording) {
                Row(
                    Modifier.clip(RoundedCornerShape(50)).background(Color(0xFFDC2626)).padding(horizontal = 12.dp, vertical = 5.dp).testTag("cam-clock"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(Color.White))
                    Spacer(Modifier.width(6.dp))
                    Text(CamPress.clock(a.elapsedMs), color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (a.nightOffered && !recording) {
                    RoundButton(R.drawable.ic_cam_night, if (a.night) "Turn Night off" else "Turn Night on", turn, lit = a.night, onClick = a::toggleNight, tag = "cam-night")
                }
                if (a.hasFlash && !recording) {
                    val (icon, what) = when (a.flash) {
                        RoomsCameraActivity.Flash.OFF -> R.drawable.ic_cam_flash_off to "Flash is off"
                        RoomsCameraActivity.Flash.AUTO -> R.drawable.ic_cam_flash_auto to "Flash is automatic"
                        RoomsCameraActivity.Flash.ON -> R.drawable.ic_cam_flash_on to "Flash is on"
                    }
                    RoundButton(icon, "$what. Tap to change", turn, lit = a.flash != RoomsCameraActivity.Flash.OFF, onClick = a::nextFlash, tag = "cam-flash")
                } else {
                    Spacer(Modifier.size(44.dp))
                }
            }
        }

        // ---- the picture: 4:3, the whole of what a photo keeps
        BoxWithConstraints(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
            Box(Modifier.fillMaxWidth().aspectRatio(3f / 4f, matchHeightConstraintsFirst = maxHeight < maxWidth * 4f / 3f)) {
                AndroidView(factory = { a.previewView.also { v -> (v.parent as? android.view.ViewGroup)?.removeView(v) } }, modifier = Modifier.fillMaxSize().testTag("cam-preview"))
                // A video is 16:9, cut from the middle: show what it will keep.
                if (recording) {
                    val cut = CamVideo.cropEachSide()
                    Box(Modifier.align(Alignment.CenterStart).fillMaxHeight().fillMaxWidth(cut).background(Color(0x99000000)))
                    Box(Modifier.align(Alignment.CenterEnd).fillMaxHeight().fillMaxWidth(cut).background(Color(0x99000000)))
                }
                a.focusAt?.let { (x, y) ->
                    val half = with(LocalDensity.current) { 34.dp.toPx() }
                    Box(
                        Modifier.offset { IntOffset((x - half).roundToInt(), (y - half).roundToInt()) }
                            .size(68.dp).border(1.5.dp, Terracotta, CircleShape).testTag("cam-focus"),
                    )
                }
                if (a.flashing) Box(Modifier.fillMaxSize().background(Color(0xCC000000)))
                if (busy) CircularProgressIndicator(Modifier.align(Alignment.Center).size(28.dp), color = Color(0xB3FFFFFF), strokeWidth = 2.5.dp)
                if (a.hint.isNotEmpty()) {
                    Text(
                        a.hint, color = Color.White, fontSize = 14.sp, textAlign = TextAlign.Center,
                        modifier = Modifier.align(Alignment.BottomCenter).padding(horizontal = 24.dp, vertical = 14.dp)
                            .clip(RoundedCornerShape(12.dp)).background(Color(0xA6000000)).padding(horizontal = 12.dp, vertical = 8.dp).testTag("cam-hint"),
                    )
                }
            }
        }

        // ---- zoom
        Row(Modifier.fillMaxWidth().height(44.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            val lit = CamZoom.active(a.presets, a.zoom)
            a.presets.forEach { p ->
                val on = p == lit
                Box(
                    Modifier.padding(horizontal = 4.dp).size(if (on) 40.dp else 34.dp).clip(CircleShape).background(Chip)
                        .clickable(role = Role.Button) { a.pickPreset(p) }
                        .semantics { contentDescription = "Zoom ${CamZoom.label(p)} times" }.testTag("cam-zoom-${CamZoom.label(p)}"),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        if (on) "${CamZoom.label(a.zoom)}×" else CamZoom.label(p),
                        color = if (on) Terracotta else Color.White, fontSize = if (on) 13.sp else 12.sp, fontWeight = FontWeight.Medium,
                        modifier = Modifier.rotate(turn),
                    )
                }
            }
        }

        // ---- along the bottom
        Row(Modifier.fillMaxWidth().padding(horizontal = 28.dp, vertical = 10.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            if (recording) Spacer(Modifier.size(48.dp))
            else RoundButton(R.drawable.wg_photo, "Choose from your photos", turn, size = 48, onClick = a::openGallery, tag = "cam-gallery")
            Shutter(a, recording)
            if (a.hasFront && !recording) RoundButton(R.drawable.ic_call_flip, if (a.front) "Use the back camera" else "Use the front camera", turn, size = 48, onClick = a::flip, tag = "cam-flip")
            else Spacer(Modifier.size(48.dp))
        }
        Text(
            when {
                recording -> "Let go to stop. Slide up to zoom."
                !a.canVideo -> "Tap for a photo."
                else -> "Tap for a photo, hold for a video."
            },
            color = Color(0xB3FFFFFF), fontSize = 12.sp, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp),
        )
    }
}

@Composable
private fun Shutter(a: RoomsCameraActivity, recording: Boolean) {
    val ring = CamPress.ring(a.elapsedMs)
    Box(
        Modifier.size(84.dp)
            .semantics {
                contentDescription = if (recording) "Recording. Let go to stop" else "Take a photo. Hold for a video"
                role = Role.Button
            }
            .testTag("cam-shutter")
            .pointerInput(Unit) {
                awaitEachGesture {
                    val first = awaitFirstDown(requireUnconsumed = false)
                    first.consume()
                    a.pressDown()
                    var up = 0f
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == first.id } ?: break
                        if (!change.pressed) {
                            change.consume()
                            a.pressUp()
                            return@awaitEachGesture
                        }
                        up -= change.positionChange().y
                        change.consume()
                        a.pressSlide(up)
                    }
                    a.pressCancel()
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val stroke = 4.dp.toPx()
            val inset = stroke / 2
            drawCircle(Color.White.copy(alpha = if (recording) 0.35f else 1f), radius = size.minDimension / 2 - inset, style = Stroke(stroke))
            if (recording) {
                drawArc(
                    Color(0xFFDC2626), startAngle = -90f, sweepAngle = 360f * ring, useCenter = false,
                    topLeft = Offset(inset, inset), size = Size(size.width - stroke, size.height - stroke),
                    style = Stroke(stroke, cap = StrokeCap.Round),
                )
            }
        }
        Box(
            Modifier.size(if (recording) 30.dp else 66.dp)
                .clip(if (recording) RoundedCornerShape(8.dp) else CircleShape)
                .background(if (recording) Color(0xFFDC2626) else Color.White),
        )
    }
}

@Composable
private fun RoundButton(icon: Int, what: String, turn: Float, size: Int = 44, lit: Boolean = false, tag: String, onClick: () -> Unit) {
    Box(
        Modifier.size(size.dp).clip(CircleShape).background(Chip)
            .clickable(role = Role.Button, onClickLabel = what, onClick = onClick)
            .semantics { contentDescription = what }.testTag(tag),
        contentAlignment = Alignment.Center,
    ) {
        Image(painterResource(icon), contentDescription = null, colorFilter = ColorFilter.tint(if (lit) Terracotta else Color.White), modifier = Modifier.size((size * 0.5f).dp).rotate(turn))
    }
}

// ==================================================================== what you took

@Composable
private fun Review(a: RoomsCameraActivity) {
    val shot = a.shot ?: return
    val send = a.send
    val sending = send is SendState.Sending
    Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            RoundButton(R.drawable.ic_map_close, "Close the camera", 0f, onClick = a::close, tag = "cam-close")
            Text(
                "To ${a.handoff?.title ?: "this conversation"}", color = Color(0xCCFFFFFF), fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 12.dp).weight(1f).testTag("cam-to"),
            )
        }
        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
            if (shot.video) {
                AndroidView(factory = { ctx -> VideoView(ctx).also { reviewVideo(it, shot.file) } }, modifier = Modifier.fillMaxSize().testTag("cam-review-video"))
            } else if (shot.preview != null) {
                Image(shot.preview.asImageBitmap(), contentDescription = "The photo you took", contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize().testTag("cam-review-photo"))
            } else {
                Text("Your photo is ready to send.", color = Color.White, fontSize = 15.sp)
            }
            if (send is SendState.Failed) {
                Text(
                    send.why, color = Color.White, fontSize = 14.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp).clip(RoundedCornerShape(12.dp)).background(Color(0xE6B91C1C)).padding(horizontal = 14.dp, vertical = 10.dp).testTag("cam-send-error"),
                )
            }
        }
        Box(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp).clip(RoundedCornerShape(20.dp)).background(Color(0xFF262626)).padding(horizontal = 14.dp, vertical = 10.dp)) {
            if (a.caption.isEmpty()) Text("Add a few words", color = Color(0x80FFFFFF), fontSize = 15.sp)
            BasicTextField(
                value = a.caption,
                onValueChange = { if (!sending) a.caption = it.take(4000) },
                enabled = !sending,
                textStyle = TextStyle(color = Color.White, fontSize = 15.sp),
                cursorBrush = SolidColor(Terracotta),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                maxLines = 4,
                modifier = Modifier.fillMaxWidth().heightIn(min = 20.dp).testTag("cam-caption"),
            )
        }
        Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, bottom = 12.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Retake", color = if (sending) Color(0x66FFFFFF) else Color.White, fontSize = 15.sp, fontWeight = FontWeight.Medium,
                modifier = Modifier.clip(RoundedCornerShape(50)).clickable(enabled = !sending, role = Role.Button, onClick = a::retake).padding(horizontal = 14.dp, vertical = 12.dp).testTag("cam-retake"),
            )
            val again = send is SendState.Failed && send.again
            val dead = send is SendState.Failed && !send.again
            Row(
                Modifier.clip(RoundedCornerShape(50)).background(if (dead) Color(0xFF404040) else Terracotta)
                    .clickable(enabled = !sending && !dead, role = Role.Button, onClick = a::sendShot)
                    .padding(horizontal = 20.dp, vertical = 12.dp).testTag("cam-send"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (sending) {
                    val f = (send as SendState.Sending).fraction
                    if (f > 0f) CircularProgressIndicator(progress = { f }, modifier = Modifier.size(18.dp), color = Color.White, trackColor = Color(0x55FFFFFF), strokeWidth = 2.dp)
                    else CircularProgressIndicator(Modifier.size(18.dp), color = Color.White, strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text("Sending ${(f * 100).roundToInt()}%", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                } else {
                    Image(painterResource(R.drawable.ic_cam_send), contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(if (again) "Try again" else "Send", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                }
            }
        }
    }
}

// ==================================================================== when there's no camera to show

@Composable
private fun Message(title: String, more: String, first: String, onFirst: () -> Unit, second: String, onSecond: () -> Unit, onClose: () -> Unit) {
    Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
        Box(Modifier.padding(12.dp)) { RoundButton(R.drawable.ic_map_close, "Close the camera", 0f, onClick = onClose, tag = "cam-close") }
        Column(Modifier.align(Alignment.Center).padding(horizontal = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(title, color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center, modifier = Modifier.testTag("cam-message"))
            if (more.isNotEmpty()) Text(more, color = Color(0xB3FFFFFF), fontSize = 14.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
            Spacer(Modifier.height(20.dp))
            Text(
                first, color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Medium,
                modifier = Modifier.clip(RoundedCornerShape(50)).background(Terracotta).clickable(role = Role.Button, onClick = onFirst).padding(horizontal = 20.dp, vertical = 12.dp),
            )
            Spacer(Modifier.height(10.dp))
            Text(
                second, color = Color.White, fontSize = 15.sp,
                modifier = Modifier.clip(RoundedCornerShape(50)).clickable(role = Role.Button, onClick = onSecond).padding(horizontal = 20.dp, vertical = 12.dp),
            )
        }
    }
}
