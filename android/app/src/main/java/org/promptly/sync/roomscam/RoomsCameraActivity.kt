package org.promptly.sync.roomscam

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.Range
import android.util.Size
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.OrientationEventListener
import android.view.ScaleGestureDetector
import android.view.Surface
import android.view.WindowManager
import android.webkit.MimeTypeMap
import android.widget.Toast
import android.widget.VideoView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.MirrorMode
import androidx.camera.core.Preview
import androidx.camera.core.UseCase
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.extensions.ExtensionMode
import androidx.camera.extensions.ExtensionsManager
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.work.WorkInfo
import androidx.work.WorkManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.promptly.sync.calls.CallCenter
import java.io.File
import java.util.Date
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * The camera, in Rooms, on a phone with this app:
 * `promptly://rooms/camera?server=…&ticket=…&room=…&title=…`, opened by the
 * camera button in a conversation (frontend `rooms/nativeCamera.ts`). A web
 * page's camera gets the sensor's picture as it is, soft and squeezed; this
 * is the phone's real camera (CameraX): the full still pipeline, focus where
 * you tap, the wide and zoom lenses, steady video at a proper bit rate.
 *
 * **Tap** the round button for a photo, **hold** it for a video for as long
 * as you hold (a minute at most; slide up to zoom). Then you see what you
 * took, with room for a few words, Retake and Send. Send goes to the one
 * conversation the page opened this for, with the ticket the page was given
 * for it ([CamSend]; the app never has your sign-in), and comes back to the
 * conversation.
 *
 * The camera and microphone are on only while this is in front. The
 * microphone is asked for the first time you hold for a video; said no, a
 * video is recorded without sound.
 */
class RoomsCameraActivity : ComponentActivity() {
    enum class Phase { ASKING, REFUSED, STARTING, LIVE, RECORDING, SAVING, REVIEW, PROBLEM }
    enum class Flash { OFF, AUTO, ON }

    class Shot(val file: File, val video: Boolean, val name: String, val mime: String, val preview: Bitmap?)

    // ---- what the screen draws
    var phase by mutableStateOf(Phase.STARTING); private set
    var handoff: CamHandoff? = null; private set
    var front by mutableStateOf(false); private set
    var hasFront by mutableStateOf(false); private set
    var hasFlash by mutableStateOf(false); private set
    var flash by mutableStateOf(Flash.OFF); private set
    var nightOffered by mutableStateOf(false); private set
    var night by mutableStateOf(false); private set
    var canVideo by mutableStateOf(true); private set
    var zoom by mutableFloatStateOf(1f); private set
    var zoomMin by mutableFloatStateOf(1f); private set
    var zoomMax by mutableFloatStateOf(1f); private set
    var presets by mutableStateOf(emptyList<Float>()); private set
    var elapsedMs by mutableLongStateOf(0L); private set
    var hint by mutableStateOf(""); private set
    var problem by mutableStateOf(""); private set
    var shot by mutableStateOf<Shot?>(null); private set
    var caption by mutableStateOf("")
    var send by mutableStateOf<SendState>(SendState.Idle); private set
    /** How far the phone is turned (0, 90, 180, 270): the buttons turn to stay upright. */
    var turned by mutableIntStateOf(0); private set
    var focusAt by mutableStateOf<Pair<Float, Float>?>(null); private set
    var flashing by mutableStateOf(false); private set

    // ---- the camera
    lateinit var previewView: PreviewView; private set
    private var provider: ProcessCameraProvider? = null
    private var extensions: ExtensionsManager? = null
    private var camera: Camera? = null
    private var imageCapture: ImageCapture? = null
    private var videoCapture: VideoCapture<Recorder>? = null
    private var recording: Recording? = null
    private var recordingFile: File? = null
    private var recordingStartedAt = 0L
    private var ticker: Job? = null
    private var hintJob: Job? = null
    private var rotation = Surface.ROTATION_0
    private var orientation: OrientationEventListener? = null

    // ---- the button
    private var pressedAt = 0L
    private var down = false
    private var holdJob: Job? = null
    private var micAsked = false
    private var zoomAtPress = 1f

    // ---- the send
    private var pendingId: String? = null
    private var watchJob: Job? = null

    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) open() else phase = Phase.REFUSED
    }
    private val askMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        say(if (ok) "Hold the button to record a video." else "Videos will have no sound: Promptly isn't allowed to use the microphone.")
    }
    private val pickMedia = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) fromGallery(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val uri = intent?.data
        val params = uri?.queryParameterNames?.associateWith { uri.getQueryParameter(it) } ?: emptyMap()
        val saved = CallCenter.server(this)
        val h = if (uri?.host == "rooms" && uri.path == "/camera") CamHandoffs.parse(params, saved, System.currentTimeMillis()) else null
        if (h == null) {
            Toast.makeText(
                this,
                if (saved == null) "Set up the Promptly app first: open P Rooms from your home screen." else "Open the camera from a conversation in Rooms.",
                Toast.LENGTH_LONG,
            ).show()
            finish()
            return
        }
        handoff = h
        lifecycleScope.launch(Dispatchers.IO) { CamStore.sweep(applicationContext) }
        previewView = PreviewView(this).apply {
            scaleType = PreviewView.ScaleType.FIT_CENTER
            implementationMode = PreviewView.ImplementationMode.PERFORMANCE
        }
        wireGestures()
        orientation = object : OrientationEventListener(this) {
            override fun onOrientationChanged(deg: Int) {
                if (deg == ORIENTATION_UNKNOWN) return
                val r = when (deg) {
                    in 45 until 135 -> Surface.ROTATION_270
                    in 135 until 225 -> Surface.ROTATION_180
                    in 225 until 315 -> Surface.ROTATION_90
                    else -> Surface.ROTATION_0
                }
                if (r == rotation) return
                rotation = r
                turned = when (r) { Surface.ROTATION_90 -> 90; Surface.ROTATION_180 -> 180; Surface.ROTATION_270 -> 270; else -> 0 }
                imageCapture?.targetRotation = r
                // A video keeps the way up it started with.
                if (recording == null) videoCapture?.targetRotation = r
            }
        }
        setContent { CameraScreen(this) }
        if (has(Manifest.permission.CAMERA)) open() else {
            phase = Phase.ASKING
            askCamera.launch(Manifest.permission.CAMERA)
        }
    }

    override fun onStart() {
        super.onStart()
        orientation?.enable()
        // Back from Settings with the camera allowed.
        if (phase == Phase.REFUSED && has(Manifest.permission.CAMERA)) open()
        pendingId?.let { CamWatch.watch(it) }
    }

    override fun onStop() {
        super.onStop()
        orientation?.disable()
        // Not in front: nothing is filmed, and a video in progress ends here.
        stopRecording()
        down = false
        holdJob?.cancel()
        // A send the screen was watching carries on, on its own, to the end.
        pendingId?.let { id ->
            CamWatch.unwatch(id)
            val s = send
            val keep = shot
            if (s is SendState.Failed && s.again && keep != null) resend()
        }
    }

    private fun has(permission: String) = ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    fun openSettings() {
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
    }

    // ================================================================ the camera

    fun open() {
        phase = Phase.STARTING
        problem = ""
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val p = runCatching { future.get() }.getOrNull()
            if (p == null) return@addListener trouble("This phone's camera wouldn't start.")
            provider = p
            hasFront = runCatching { p.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) }.getOrDefault(false)
            val hasBack = runCatching { p.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA) }.getOrDefault(false)
            if (!hasBack && !hasFront) return@addListener trouble("This phone has no camera Promptly can use.")
            if (!hasBack) front = true
            val ext = ExtensionsManager.getInstanceAsync(this, p)
            ext.addListener({
                extensions = runCatching { ext.get() }.getOrNull()
                bind()
            }, ContextCompat.getMainExecutor(this))
        }, ContextCompat.getMainExecutor(this))
    }

    private fun selector(): CameraSelector = if (front) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA

    private fun nightAvailable(): Boolean =
        runCatching { extensions?.isExtensionAvailable(selector(), ExtensionMode.NIGHT) == true }.getOrDefault(false)

    @SuppressLint("RestrictedApi")
    private fun bind() {
        val p = provider ?: return
        if (isFinishing || isDestroyed) return
        if (phase == Phase.REVIEW || phase == Phase.SAVING) return
        p.unbindAll()
        camera = null
        nightOffered = nightAvailable()
        if (!nightOffered) night = false

        val fourByThree = ResolutionSelector.Builder()
            .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
        val preview = Preview.Builder().setResolutionSelector(fourByThree.build()).build()
        val still = ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
            .setResolutionSelector(
                // The sensor's own picture, up to about 12 megapixels: sharp, and not a
                // 50-megapixel file on phones that offer one.
                fourByThree.setResolutionStrategy(ResolutionStrategy(Size(STILL_LONG, STILL_SHORT), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER)).build(),
            )
            .setJpegQuality(95)
            .setTargetRotation(rotation)
            .setFlashMode(flashMode())
            .build()

        val max = handoff?.maxBytes ?: CamHandoffs.DEFAULT_MAX_BYTES
        val recorder = Recorder.Builder()
            .setQualitySelector(QualitySelector.from(Quality.FHD, FallbackStrategy.lowerQualityOrHigherThan(Quality.FHD)))
            .setTargetVideoEncodingBitRate(CamVideo.bits(max))
            .build()
        val steady = runCatching { Recorder.getVideoCapabilities(p.getCameraInfo(selector())).isStabilizationSupported }.getOrDefault(false)
        val video = VideoCapture.Builder(recorder)
            .setTargetFrameRate(Range(30, 30))
            .setMirrorMode(MirrorMode.MIRROR_MODE_OFF)
            .setTargetRotation(rotation)
            .apply { if (steady) setVideoStabilizationEnabled(true) }
            .build()
        val plainVideo = VideoCapture.Builder(recorder).setMirrorMode(MirrorMode.MIRROR_MODE_OFF).setTargetRotation(rotation).build()

        // Best first. A phone that can't run a set says so when it's bound, and the next is tried.
        val attempts: List<Triple<CameraSelector, List<UseCase>, VideoCapture<Recorder>?>> = buildList {
            if (night && nightOffered) {
                runCatching { extensions!!.getExtensionEnabledCameraSelector(selector(), ExtensionMode.NIGHT) }.getOrNull()
                    ?.let { add(Triple(it, listOf(preview, still), null)) }
            }
            add(Triple(selector(), listOf(preview, still, video), video))
            add(Triple(selector(), listOf(preview, still, plainVideo), plainVideo))
            add(Triple(selector(), listOf(preview, still), null))
        }
        var bound: Camera? = null
        var boundVideo: VideoCapture<Recorder>? = null
        var nightBound = false
        for ((i, a) in attempts.withIndex()) {
            val c = runCatching {
                p.unbindAll()
                p.bindToLifecycle(this, a.first, *a.second.toTypedArray())
            }.getOrNull()
            if (c != null) {
                bound = c
                boundVideo = a.third
                nightBound = night && nightOffered && i == 0 && a.third == null
                break
            }
        }
        if (bound == null) return trouble("This phone's camera wouldn't start. Something else may be using it.")
        if (night && !nightBound) night = false
        camera = bound
        imageCapture = still
        videoCapture = boundVideo
        canVideo = boundVideo != null
        preview.surfaceProvider = previewView.surfaceProvider
        hasFlash = bound.cameraInfo.hasFlashUnit()
        bound.cameraInfo.zoomState.removeObservers(this)
        bound.cameraInfo.zoomState.observe(this) { z ->
            zoom = z.zoomRatio
            if (z.minZoomRatio != zoomMin || z.maxZoomRatio != zoomMax) {
                zoomMin = z.minZoomRatio
                zoomMax = z.maxZoomRatio
                presets = CamZoom.presets(zoomMin, minOf(zoomMax, MAX_ZOOM))
            }
        }
        bound.cameraInfo.cameraState.removeObservers(this)
        bound.cameraInfo.cameraState.observe(this) { s ->
            val e = s.error
            if (e != null && (phase == Phase.LIVE || phase == Phase.STARTING)) {
                trouble(
                    when (e.code) {
                        CameraState.ERROR_CAMERA_IN_USE, CameraState.ERROR_MAX_CAMERAS_IN_USE -> "Another app is using the camera. Close it and try again."
                        CameraState.ERROR_CAMERA_DISABLED -> "The camera is turned off on this phone (a work or privacy setting)."
                        CameraState.ERROR_DO_NOT_DISTURB_MODE_ENABLED -> "Do Not Disturb is stopping the camera. Turn it off and try again."
                        else -> "The camera stopped. Try again."
                    },
                )
            } else if (s.type == CameraState.Type.OPEN && phase == Phase.STARTING) {
                phase = Phase.LIVE
            }
        }
        if (phase == Phase.STARTING && bound.cameraInfo.cameraState.value?.type == CameraState.Type.OPEN) phase = Phase.LIVE
    }

    private fun trouble(what: String) {
        runCatching { provider?.unbindAll() }
        camera = null
        problem = what
        phase = Phase.PROBLEM
    }

    private fun flashMode() = when (flash) {
        Flash.ON -> ImageCapture.FLASH_MODE_ON
        Flash.AUTO -> ImageCapture.FLASH_MODE_AUTO
        Flash.OFF -> ImageCapture.FLASH_MODE_OFF
    }

    fun nextFlash() {
        flash = when (flash) { Flash.OFF -> Flash.AUTO; Flash.AUTO -> Flash.ON; Flash.ON -> Flash.OFF }
        imageCapture?.flashMode = flashMode()
        tick()
    }

    fun flip() {
        if (!hasFront || phase != Phase.LIVE) return
        front = !front
        tick()
        phase = Phase.STARTING
        bind()
    }

    fun toggleNight() {
        if (!nightOffered || phase != Phase.LIVE) return
        night = !night
        tick()
        phase = Phase.STARTING
        bind()
        if (night) say("Night is for photos: hold still. Turn it off to record a video.")
    }

    fun zoomTo(ratio: Float) {
        val c = camera ?: return
        c.cameraControl.setZoomRatio(CamZoom.clamp(ratio, zoomMin, minOf(zoomMax, MAX_ZOOM)))
    }

    fun pickPreset(ratio: Float) {
        tick()
        zoomTo(ratio)
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun wireGestures() {
        val pinch = ScaleGestureDetector(this, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(d: ScaleGestureDetector): Boolean {
                zoomTo(CamZoom.pinch(zoom, d.scaleFactor, zoomMin, minOf(zoomMax, MAX_ZOOM)))
                return true
            }
        })
        var moved = false
        previewView.setOnTouchListener { v, e ->
            pinch.onTouchEvent(e)
            when (e.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> moved = false
                android.view.MotionEvent.ACTION_POINTER_DOWN -> moved = true
                android.view.MotionEvent.ACTION_UP -> if (!moved && !pinch.isInProgress) {
                    focus(e.x, e.y)
                    v.performClick()
                }
            }
            true
        }
    }

    private fun focus(x: Float, y: Float) {
        val c = camera ?: return
        if (phase != Phase.LIVE && phase != Phase.RECORDING) return
        val point = previewView.meteringPointFactory.createPoint(x, y)
        val action = FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE or FocusMeteringAction.FLAG_AWB)
            .setAutoCancelDuration(4, TimeUnit.SECONDS)
            .build()
        if (!c.cameraInfo.isFocusMeteringSupported(action)) return
        runCatching { c.cameraControl.startFocusAndMetering(action) }
        focusAt = x to y
        tick()
        lifecycleScope.launch {
            delay(1200)
            if (focusAt == x to y) focusAt = null
        }
    }

    // ================================================================ the button

    /** A finger (or a volume key) went down on the round button. */
    fun pressDown() {
        if (phase != Phase.LIVE || down) return
        down = true
        pressedAt = System.currentTimeMillis()
        zoomAtPress = zoom
        holdJob?.cancel()
        holdJob = lifecycleScope.launch {
            delay(HOLD_MS)
            if (down && phase == Phase.LIVE) startVideo()
        }
    }

    /** While held: [upPx] is how far the finger has slid up from where it went down. */
    fun pressSlide(upPx: Float) {
        if (phase != Phase.RECORDING) return
        zoomTo(CamZoom.slide(zoomAtPress, upPx, resources.displayMetrics.density * 260f, minOf(zoomMax, MAX_ZOOM)))
    }

    fun pressUp() {
        if (!down) return
        down = false
        holdJob?.cancel()
        when (CamPress.released(System.currentTimeMillis() - pressedAt, recording != null)) {
            CamPress.Was.PHOTO -> takePhoto()
            CamPress.Was.VIDEO -> stopRecording()
            CamPress.Was.NOTHING -> Unit
        }
    }

    fun pressCancel() {
        if (!down) return
        down = false
        holdJob?.cancel()
        if (recording != null) stopRecording()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val volume = event.keyCode == KeyEvent.KEYCODE_VOLUME_UP || event.keyCode == KeyEvent.KEYCODE_VOLUME_DOWN
        if (volume && (phase == Phase.LIVE || phase == Phase.RECORDING)) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) pressDown()
            if (event.action == KeyEvent.ACTION_UP) pressUp()
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun tick() = window.decorView.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)

    private fun say(text: String) {
        hint = text
        hintJob?.cancel()
        hintJob = lifecycleScope.launch {
            delay(4500)
            if (hint == text) hint = ""
        }
    }

    private fun roomLeft(): Boolean = CamStore.dir(this).usableSpace > LOW_SPACE_BYTES

    // ================================================================ a photo

    private fun takePhoto() {
        val capture = imageCapture ?: return
        if (phase != Phase.LIVE) return
        if (!roomLeft()) return say("This phone is almost out of space. Free some up and try again.")
        tick()
        phase = Phase.SAVING
        flashing = true
        lifecycleScope.launch {
            delay(90)
            flashing = false
        }
        val file = CamStore.newFile(this, "jpg")
        val options = ImageCapture.OutputFileOptions.Builder(file).build()
        capture.takePicture(options, ContextCompat.getMainExecutor(this), object : ImageCapture.OnImageSavedCallback {
            override fun onImageSaved(result: ImageCapture.OutputFileResults) {
                if (file.length() == 0L) {
                    file.delete()
                    return failedShot("That didn't take. Try again.")
                }
                keep(file, video = false, ext = "jpg")
            }

            override fun onError(e: ImageCaptureException) {
                file.delete()
                failedShot("That didn't take. Try again.")
            }
        })
    }

    private fun failedShot(why: String) {
        if (isFinishing || isDestroyed) return
        phase = Phase.LIVE
        say(why)
    }

    // ================================================================ a video

    @SuppressLint("MissingPermission")
    private fun startVideo() {
        val capture = videoCapture
        if (capture == null) {
            say(if (night) "Night is for photos. Turn it off to record a video." else "This phone can't record video here. Tap for a photo.")
            return
        }
        if (!roomLeft()) return say("This phone is almost out of space. Free some up and try again.")
        val mic = has(Manifest.permission.RECORD_AUDIO)
        if (!mic && !micAsked) {
            // Asked the first time you hold; the question takes the finger off the button.
            micAsked = true
            down = false
            askMic.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        val max = handoff?.maxBytes ?: CamHandoffs.DEFAULT_MAX_BYTES
        val file = CamStore.newFile(this, "mp4")
        capture.targetRotation = rotation
        val pending = capture.output.prepareRecording(this, FileOutputOptions.Builder(file).setFileSizeLimit((max * 0.97).toLong()).build())
            .apply { if (mic) withAudioEnabled() }
        recordingFile = file
        recordingStartedAt = System.currentTimeMillis()
        elapsedMs = 0
        phase = Phase.RECORDING
        window.decorView.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        if (!mic) say("Recording without sound: Promptly isn't allowed to use the microphone.")
        if (flash == Flash.ON && hasFlash) runCatching { camera?.cameraControl?.enableTorch(true) }
        recording = pending.start(ContextCompat.getMainExecutor(this)) { event ->
            if (event is VideoRecordEvent.Finalize) finishedVideo(file, event)
        }
        ticker?.cancel()
        ticker = lifecycleScope.launch {
            while (recording != null) {
                elapsedMs = System.currentTimeMillis() - recordingStartedAt
                if (elapsedMs >= MAX_VIDEO_MS) {
                    stopRecording()
                    break
                }
                delay(50)
            }
        }
    }

    private fun stopRecording() {
        val r = recording ?: return
        recording = null
        ticker?.cancel()
        runCatching { camera?.cameraControl?.enableTorch(false) }
        if (phase == Phase.RECORDING) phase = Phase.SAVING
        runCatching { r.stop() }
    }

    private fun finishedVideo(file: File, event: VideoRecordEvent.Finalize) {
        recording = null
        ticker?.cancel()
        runCatching { camera?.cameraControl?.enableTorch(false) }
        zoomTo(zoomAtPress)
        val lengthMs = TimeUnit.NANOSECONDS.toMillis(event.recordingStats.recordedDurationNanos)
        // These still leave a whole, playable file behind.
        val fine = !event.hasError() || event.error == VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED ||
            event.error == VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED || event.error == VideoRecordEvent.Finalize.ERROR_SOURCE_INACTIVE
        if (isFinishing || isDestroyed) {
            file.delete()
            return
        }
        if (!fine || file.length() == 0L) {
            file.delete()
            return failedShot(if (event.error == VideoRecordEvent.Finalize.ERROR_INSUFFICIENT_STORAGE) "This phone ran out of space." else "That video didn't record. Try again.")
        }
        if (lengthMs < MIN_VIDEO_MS) {
            file.delete()
            return failedShot("That video was too short. Hold the button a little longer.")
        }
        tick()
        keep(file, video = true, ext = "mp4")
    }

    // ================================================================ what you took

    private fun keep(file: File, video: Boolean, ext: String, name: String? = null) {
        phase = Phase.SAVING
        lifecycleScope.launch {
            val picture = if (video) null else withContext(Dispatchers.IO) { thumbnail(file) }
            if (isFinishing || isDestroyed) return@launch
            caption = ""
            send = SendState.Idle
            shot = Shot(file, video, name ?: CamNames.file(video, Date(), ext), CamNames.mime(ext), picture)
            phase = Phase.REVIEW
            // Nothing more to film until Retake: the camera goes off.
            runCatching { provider?.unbindAll() }
            camera = null
        }
    }

    /** The photo at about screen size, the right way up. */
    private fun thumbnail(file: File): Bitmap? = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        val want = maxOf(resources.displayMetrics.heightPixels, 1600)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= want) sample *= 2
        val raw = BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        val turn = when (ExifInterface(file.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> 0f
        }
        if (turn == 0f) raw else Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, Matrix().apply { postRotate(turn) }, true)
    }.getOrNull()

    fun openGallery() {
        if (phase == Phase.RECORDING || phase == Phase.SAVING) return
        pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
    }

    private fun fromGallery(uri: Uri) {
        val max = handoff?.maxBytes ?: CamHandoffs.DEFAULT_MAX_BYTES
        val before = phase
        phase = Phase.SAVING
        lifecycleScope.launch {
            val type = contentResolver.getType(uri) ?: ""
            val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(type) ?: if (type.startsWith("video/")) "mp4" else "jpg"
            val video = type.startsWith("video/")
            val file = withContext(Dispatchers.IO) {
                runCatching {
                    val f = CamStore.newFile(applicationContext, ext)
                    contentResolver.openInputStream(uri)?.use { input -> f.outputStream().use { input.copyTo(it) } }
                    f
                }.getOrNull()
            }
            when {
                file == null || file.length() == 0L || !(type.startsWith("image/") || video) -> {
                    file?.delete()
                    phase = before
                    say("Promptly couldn't open that one.")
                    if (before != Phase.LIVE) open()
                }
                file.length() > max -> {
                    file.delete()
                    phase = before
                    say("That one is too big to send from here. Send it from the conversation's + button.")
                    if (before != Phase.LIVE) open()
                }
                else -> keep(file, video, ext, name = queryName(uri) ?: CamNames.file(video, Date(), ext))
            }
        }
    }

    private fun queryName(uri: Uri): String? = runCatching {
        contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }.getOrNull()?.takeIf { it.isNotBlank() }?.take(120)

    fun retake() {
        val s = shot ?: return
        pendingId?.let {
            CamSend.cancel(this, it)
            CamWatch.unwatch(it)
            CamStore.load(this, it)?.let { p -> java.io.File(filesDir, "roomscam/${p.id}.json").delete() }
        }
        pendingId = null
        watchJob?.cancel()
        s.file.delete()
        shot = null
        send = SendState.Idle
        if (has(Manifest.permission.CAMERA)) open() else phase = Phase.REFUSED
    }

    // ================================================================ sending

    fun sendShot() {
        val s = shot ?: return
        val h = handoff ?: return
        if (send is SendState.Sending) return
        val id = pendingId ?: UUID.randomUUID().toString().also { pendingId = it }
        tick()
        send = SendState.Sending(0f)
        CamWatch.watch(id)
        val work = CamSend.start(this, PendingShot(id, h.server, h.ticket, s.file.absolutePath, s.name, s.mime, caption.trim().take(4000), s.video))
        watch(work)
    }

    /** The same send once more (its id is the same, so the server never posts it twice). */
    fun resend() = sendShot()

    private fun watch(work: UUID) {
        watchJob?.cancel()
        watchJob = lifecycleScope.launch {
            WorkManager.getInstance(applicationContext).getWorkInfoByIdFlow(work).collect { info ->
                when (info?.state) {
                    WorkInfo.State.RUNNING -> send = SendState.Sending(info.progress.getFloat(CamSend.KEY_FRACTION, 0f))
                    WorkInfo.State.SUCCEEDED -> {
                        send = SendState.Sent
                        pendingId?.let { CamWatch.unwatch(it) }
                        done()
                    }
                    WorkInfo.State.FAILED -> {
                        val again = info.outputData.getBoolean(CamSend.KEY_AGAIN, false)
                        send = SendState.Failed(info.outputData.getString(CamSend.KEY_WHY) ?: "That didn't send.", again)
                    }
                    else -> Unit // waiting for a connection: still "sending"
                }
            }
        }
    }

    private fun done() {
        window.decorView.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
        finishAndRemoveTask()
    }

    /** The X, or Back. A send in progress carries on by itself. */
    fun close() {
        val s = send
        if (s is SendState.Sending) Toast.makeText(this, "Still sending. It will arrive in the conversation.", Toast.LENGTH_SHORT).show()
        else if (!(s is SendState.Failed && s.again)) shot?.let { if (pendingId == null) it.file.delete() }
        finishAndRemoveTask()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (phase == Phase.REVIEW && send !is SendState.Sending) retake() else close()
    }

    companion object {
        const val STILL_LONG = 4032
        const val STILL_SHORT = 3024
        /** Past this a phone is only blowing up pixels. */
        const val MAX_ZOOM = 10f
        const val LOW_SPACE_BYTES = 150L * 1024 * 1024
    }
}

/** Where the looping review video is drawn. */
internal fun reviewVideo(view: VideoView, file: File) {
    view.setVideoPath(file.absolutePath)
    view.setOnPreparedListener { mp ->
        mp.isLooping = true
        view.start()
    }
}
