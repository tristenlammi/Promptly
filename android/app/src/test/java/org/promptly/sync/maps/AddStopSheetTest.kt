package org.promptly.sync.maps

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Back on the driving screen's Add stop sheet closes the sheet, not the screen
 *  (it used to close the whole driving screen mid-trip). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AddStopSheetTest {
    @Test
    fun back_closes_the_add_stop_sheet_and_leaves_the_driving_screen() {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        // Stands in for the driving screen's own Back (which would close it).
        var screenBack = 0
        activity.onBackPressedDispatcher.addCallback(object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                screenBack++
            }
        })
        var open by mutableStateOf(true)
        activity.setContent { if (open) AddStopSheet { open = false } }
        idle()

        activity.onBackPressedDispatcher.onBackPressed()
        idle()
        assertFalse("Back should close the sheet", open)
        assertEquals("Back went past the sheet to the driving screen", 0, screenBack)
        assertFalse(activity.isFinishing)

        // With the sheet gone, Back is the screen's again.
        activity.onBackPressedDispatcher.onBackPressed()
        idle()
        assertEquals(1, screenBack)
        assertTrue(activity.onBackPressedDispatcher.hasEnabledCallbacks())
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()
}
