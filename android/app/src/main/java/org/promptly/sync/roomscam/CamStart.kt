package org.promptly.sync.roomscam

import android.util.Log
import androidx.camera.camera2.Camera2Config
import androidx.camera.core.CameraXConfig
import androidx.camera.core.RetryPolicy
import androidx.camera.lifecycle.ProcessCameraProvider

/**
 * How CameraX starts in this app. Left alone, when a phone says it has a
 * camera it doesn't (a front camera on some tablets and on the emulator),
 * CameraX waits and looks again for several seconds before showing anything.
 * Here it looks for under a second and carries on with the cameras it found.
 */
object CamStart {
    /** How long to look for a camera the phone claims but doesn't show. */
    const val LOOK_MS = 700L
    private var done = false

    @Synchronized
    fun configure() {
        if (done) return
        done = true
        runCatching {
            ProcessCameraProvider.configureInstance(
                CameraXConfig.Builder.fromConfig(Camera2Config.defaultConfig())
                    .setCameraProviderInitRetryPolicy(RetryPolicy.Builder(RetryPolicy.DEFAULT).setTimeoutInMillis(LOOK_MS).build())
                    .build(),
            )
        }.onFailure { Log.w("RoomsCam", "CameraX keeps its own start-up settings", it) }
    }
}
