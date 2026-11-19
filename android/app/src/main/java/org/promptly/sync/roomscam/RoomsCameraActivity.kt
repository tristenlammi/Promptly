package org.promptly.sync.roomscam

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.media.MediaFormat
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.Log
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
    private var extMode: Int? = null
    private var ultraOn = false
    private var openedAt = 0L
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
        // Android bringing this back after stopping the app has nothing to show: the
        // shot wasn't kept, and a send that was under way finishes on its own.
        val h = if (savedInstanceState == null) read(intent) else null
        if (h == null) {
            if (savedInstanceState == null) refuse()
            finishAndRemoveTask()
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

    private fun read(intent: Intent?): CamHandoff? {
        val uri = intent?.data
        val params = uri?.queryParameterNames?.associateWith { uri.getQueryParameter(it) } ?: emptyMap()
        return if (uri?.host == "rooms" && uri.path == "/camera") CamHandoffs.parse(params, CallCenter.server(this), System.currentTimeMillis()) else null
    }

    private fun refuse() {
        Toast.makeText(
            this,
            if (CallCenter.server(this) == null) "Set up the Promptly app first: open P Rooms from your home screen." else "Open the camera from a conversation in Rooms.",
            Toast.LENGTH_LONG,
        ).show()
    }

    /** The camera button again, perhaps in another conversation, while this was still open. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val h = read(intent) ?: return refuse()
        setIntent(intent)
        // What was on screen belonged to the last conversation: it doesn't follow you to this one.
        if (recording != null) stopRecording()
        if (send !is SendState.Sending && pendingId == null) shot?.file?.delete()
        pendingId?.let { CamWatch.unwatch(it) }
        watchJob?.cancel()
        pendingId = null
        shot = null
        caption = ""
        send = SendState.Idle
        handoff = h
        if (has(Manifest.permission.CAMERA)) open() else phase = Phase.REFUSED
    }

    override fun onStart() {
        super.onStart()
        orientation?.enable()
        // Back from Settings with the camera allowed.
        if (phase == Phase.REFUSED && has(Manifest.permission.CAMERA)) open()
    }

    override fun onStop() {
        super.onStop()
        orientation?.disable()
        // Not in front: nothing is filmed, and a video in progress ends here.
        stopRecording()
        down = false
        holdJob?.cancel()
        // Left while a send was under way, or after one failed for want of a connection:
        // it carries on by itself to the end (WorkManager), and this screen is done. Coming
        // back to a stale "didn't send" for a picture that has since arrived helps nobody.
        val id = pendingId
        val s = send
        if (id != null && shot != null && !isFinishing && (s is SendState.Sending || (s is SendState.Failed && s.again))) {
            CamWatch.unwatch(id)
            watchJob?.cancel()
            if (s is SendState.Failed) backgroundSend()
            Toast.makeText(this, "Still sending. It will arrive in the conversation.", Toast.LENGTH_SHORT).show()
            finishAndRemoveTask()
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
        openedAt = System.currentTimeMillis()
        CamStart.configure()
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val p = runCatching { future.get() }.getOrNull()
            if (p == null) return@addListener trouble("This phone's camera wouldn't start.")
            provider = p
            hasFront = runCatching { p.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) }.getOrDefault(false)
            val hasBack = runCatching { p.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA) }.getOrDefault(false)
            if (!hasBack && !hasFront) return@addListener trouble("This phone has no camera Promptly can use.")
            if (!hasBack) front = true
            // The picture first. Finding out what photo processing the phone maker offers
            // takes a moment longer; if there is any, the camera switches to it then.
            bind()
            if (extensions != null) return@addListener
            val ext = ExtensionsManager.getInstanceAsync(this, p)
            ext.addListener({
                extensions = runCatching { ext.get() }.getOrNull()
                if (!isFinishing && !isDestroyed && (phase == Phase.LIVE || phase == Phase.STARTING) && recording == null && !down && extMode == null && photoMode() != null) bind()
            }, ContextCompat.getMainExecutor(this))
        }, ContextCompat.getMainExecutor(this))
    }

    private fun selector(): CameraSelector = if (front) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA

    /** The phone maker's own photo processing for this camera, if it has any ([CamExt.pick]). */
    private fun photoMode(): Int? {
        val ex = extensions ?: return null
        val sel = selector()
        fun offers(mode: Int) = runCatching { ex.isExtensionAvailable(sel, mode) }.getOrDefault(false)
        val auto = offers(ExtensionMode.AUTO)
        val nightOk = offers(ExtensionMode.NIGHT)
        nightOffered = CamExt.nightButton(auto, nightOk)
        if (!nightOffered) night = false
        return when (CamExt.pick(auto, offers(ExtensionMode.HDR), nightOk, night)) {
            CamExt.Mode.AUTO -> ExtensionMode.AUTO
            CamExt.Mode.HDR -> ExtensionMode.HDR
            CamExt.Mode.NIGHT -> ExtensionMode.NIGHT
            null -> null
        }
    }

    private class Attempt(val selector: CameraSelector, val still: ImageCapture, val video: VideoCapture<Recorder>?, val ext: Int?, val ultra: Boolean)

    /**
     * Start the camera with the best set of things this phone can run at once.
     * A phone that can't run a set says so when it's bound, and the next is tried.
     *
     * For photos the phone maker's processing is used where there is any (Auto,
     * else HDR). Most phones can't record video through it, so a hold then
     * comes back here with [forVideo] and records with the plain camera.
     */
    @SuppressLint("RestrictedApi")
    private fun bind(forVideo: Boolean = false) {
        val p = provider ?: return
        if (isFinishing || isDestroyed) return
        if (phase == Phase.REVIEW || phase == Phase.SAVING) return
        p.unbindAll()
        camera = null
        val mode = photoMode().takeIf { !forVideo }

        val fourByThree = ResolutionSelector.Builder().setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY).build()
        // The sensor's own picture, up to about 12 megapixels: sharp, and not a
        // 50-megapixel file on phones that offer one.
        val twelve = ResolutionSelector.Builder().setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
            .setResolutionStrategy(ResolutionStrategy(Size(STILL_LONG, STILL_SHORT), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER)).build()
        val preview = Preview.Builder().setResolutionSelector(fourByThree).build()
        fun still(ultra: Boolean) = ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
            .setResolutionSelector(twelve)
            .setJpegQuality(95)
            .setTargetRotation(rotation)
            .setFlashMode(flashMode())
            // Ultra HDR: an ordinary JPEG that also carries the bright detail an HDR screen can show.
            .apply { if (ultra) setOutputFormat(ImageCapture.OUTPUT_FORMAT_JPEG_ULTRA_HDR) }
            .build()

        val limit = handoff?.limit ?: CamHandoffs.DEFAULT_MAX_BYTES
        fun recorder(strict: Boolean) = Recorder.Builder()
            .setQualitySelector(QualitySelector.from(Quality.FHD, FallbackStrategy.lowerQualityOrHigherThan(Quality.FHD)))
            .setTargetVideoEncodingBitRate(CamVideo.bits(limit))
            // H.264 and AAC in an MP4: what every phone, computer and browser plays.
            // Left to itself a phone may pick a sound format a browser won't play.
            .apply {
                if (strict) {
                    setVideoMimeType(MediaFormat.MIMETYPE_VIDEO_AVC)
                    setAudioMimeType(MediaFormat.MIMETYPE_AUDIO_AAC)
                    setTargetAudioEncodingBitRate(CamVideo.AUDIO_BITS)
                }
            }
            .build()
        val steady = runCatching { Recorder.getVideoCapabilities(p.getCameraInfo(selector())).isStabilizationSupported }.getOrDefault(false)
        fun video(strict: Boolean, best: Boolean) = VideoCapture.Builder(recorder(strict))
            .setMirrorMode(MirrorMode.MIRROR_MODE_OFF)
            .setTargetRotation(rotation)
            .apply {
                if (best) setTargetFrameRate(Range(30, 30))
                if (best && steady) setVideoStabilizationEnabled(true)
            }
            .build()
        val ultraOk = runCatching {
            ImageCapture.getImageCaptureCapabilities(p.getCameraInfo(selector())).supportedOutputFormats.contains(ImageCapture.OUTPUT_FORMAT_JPEG_ULTRA_HDR)
        }.getOrDefault(false)

        val attempts = buildList {
            if (mode != null) {
                runCatching { extensions!!.getExtensionEnabledCameraSelector(selector(), mode) }.getOrNull()?.let { ext ->
                    // A few phones record through it too; most give photos only.
                    add(Attempt(ext, still(false), video(strict = true, best = false), mode, false))
                    add(Attempt(ext, still(false), null, mode, false))
                }
            }
            if (ultraOk) add(Attempt(selector(), still(true), video(strict = true, best = true), null, true))
            add(Attempt(selector(), still(false), video(strict = true, best = true), null, false))
            add(Attempt(selector(), still(false), video(strict = false, best = true), null, false))
            add(Attempt(selector(), still(false), video(strict = false, best = false), null, false))
            add(Attempt(selector(), still(false), null, null, false))
        }
        var bound: Camera? = null
        var used: Attempt? = null
        for (a in attempts) {
            val c = runCatching {
                p.unbindAll()
                p.bindToLifecycle(this, a.selector, *listOfNotNull(preview, a.still, a.video).toTypedArray())
            }.getOrNull()
            if (c != null) {
                bound = c
                used = a
                break
            }
        }
        if (bound == null || used == null) return trouble("This phone's camera wouldn't start. Something else may be using it.")
        extMode = used.ext
        ultraOn = used.ultra
        if (night && used.ext != ExtensionMode.NIGHT) night = false
        camera = bound
        imageCapture = used.still
        videoCapture = used.video
        // With the phone's photo processing on, a hold switches to the plain camera to record.
        canVideo = used.video != null || used.ext != null
        Log.i(TAG, "bound: extension=${used.ext} ultraHdr=${used.ultra} video=${used.video != null} steady=$steady forVideo=$forVideo")
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
                live()
            }
        }
        if (phase == Phase.STARTING && bound.cameraInfo.cameraState.value?.type == CameraState.Type.OPEN) live()
        if (forVideo) {
            // The hold that brought us here: still held, start recording; let go, it was nothing.
            phase = Phase.LIVE
            if (down && used.video != null) startVideo() else restorePhotoMode()
        }
    }

    private fun live() {
        phase = Phase.LIVE
        if (openedAt > 0) {
            Log.i(TAG, "viewfinder up ${System.currentTimeMillis() - openedAt} ms after opening")
            openedAt = 0
        }
    }

    /** After a video (or a hold that came to nothing): back to the photo processing, if this phone has any. */
    private fun restorePhotoMode() {
        if (extMode == null && phase == Phase.LIVE && recording == null && photoMode() != null) bind()
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
        if (night) say("Night: hold still while it takes the picture.")
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
        val pressed = System.currentTimeMillis()
        val options = ImageCapture.OutputFileOptions.Builder(file).build()
        capture.takePicture(options, ContextCompat.getMainExecutor(this), object : ImageCapture.OnImageSavedCallback {
            override fun onImageSaved(result: ImageCapture.OutputFileResults) {
                if (file.length() == 0L) {
                    file.delete()
                    return failedShot("That didn't take. Try again.")
                }
                Log.i(TAG, "photo saved ${System.currentTimeMillis() - pressed} ms after the tap (extension=$extMode ultraHdr=$ultraOn, ${file.length() / 1024} KB)")
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
        restorePhotoMode()
    }

    // ================================================================ a video

    @SuppressLint("MissingPermission")
    private fun startVideo() {
        val capture = videoCapture
        if (capture == null && extMode != null) {
            // The phone's photo processing can't record: the plain camera does, in a moment.
            if (!has(Manifest.permission.RECORD_AUDIO) && !micAsked) {
                micAsked = true
                down = false
                askMic.launch(Manifest.permission.RECORD_AUDIO)
                return
            }
            phase = Phase.STARTING
            bind(forVideo = true)
            return
        }
        if (capture == null) {
            say("This phone can't record video here. Tap for a photo.")
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
        val max = handoff?.limit ?: CamHandoffs.DEFAULT_MAX_BYTES
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
        val max = handoff?.limit ?: CamHandoffs.DEFAULT_MAX_BYTES
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

    /** Send, or Try again: the same send has the same id, so the server never posts it twice. */
    fun sendShot() {
        if (send is SendState.Sending) return
        tick()
        send = SendState.Sending(0f)
        val (id, work) = enqueue() ?: return
        CamWatch.watch(id)
        watch(work)
    }

    /** The same, with nobody watching: it keeps trying on its own. */
    private fun backgroundSend() {
        enqueue()
    }

    private fun enqueue(): Pair<String, UUID>? {
        val s = shot ?: return null
        val h = handoff ?: return null
        val id = pendingId ?: UUID.randomUUID().toString().also { pendingId = it }
        return id to CamSend.start(this, PendingShot(id, h.server, h.ticket, s.file.absolutePath, s.name, s.mime, caption.trim().take(4000), s.video, h.room, h.title, h.maxBytes, h.tus))
    }

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
        val id = pendingId
        if (id != null && shot != null && (s is SendState.Sending || (s is SendState.Failed && s.again))) {
            CamWatch.unwatch(id)
            watchJob?.cancel()
            if (s is SendState.Failed) backgroundSend()
            Toast.makeText(this, "Still sending. It will arrive in the conversation.", Toast.LENGTH_SHORT).show()
        } else if (id == null) {
            shot?.file?.delete()
        }
        finishAndRemoveTask()
    }

    /** Back: from what you took to the camera again (it isn't sent); otherwise out. */
    fun back() {
        if (phase == Phase.REVIEW && send !is SendState.Sending && send !is SendState.Sent) retake() else close()
    }

    companion object {
        const val STILL_LONG = 4032
        const val STILL_SHORT = 3024
        /** Past this a phone is only blowing up pixels. */
        const val MAX_ZOOM = 10f
        const val LOW_SPACE_BYTES = 200L * 1024 * 1024
        const val TAG = "RoomsCam"
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
