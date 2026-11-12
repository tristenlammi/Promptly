package org.promptly.sync.maps

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context

/**
 * P Maps doesn't notify you on the phone while you drive: the map is on the car's screen
 * or in front of you. What has to stay is made silent and tucked away:
 *
 * - a trip's own "navigating" notification (Android needs one while a trip uses the
 *   location in the background): the lowest importance, no sound, no pop-up and no icon
 *   in the status bar, just a line at the bottom of the shade;
 * - the next-turn alert, which only goes out while another app is in front on the car's
 *   screen, so the car can show the turn over it: still shown on the car (the car decides
 *   that from the alert itself), but low and silent on the phone.
 *
 * Channel importance can only be lowered from the app, never raised, and not once you've
 * changed the channel yourself in Android's settings; lowering an existing one is fine.
 */
object QuietNotes {
    /** The next-turn alert's channel (it replaces "promptly_turns", which popped up). */
    const val TURNS = "promptly_car_turns"

    /** The navigation library's own channel for a trip's notification. */
    private const val TRIP = "ferrostar_navigation"
    private const val OLD_TURNS = "promptly_turns"

    fun set(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        runCatching {
            nm.createNotificationChannel(
                NotificationChannel(TRIP, "Trip in progress", NotificationManager.IMPORTANCE_MIN).apply {
                    description = "Shown silently while a trip is running"
                    setSound(null, null)
                    enableVibration(false)
                    setShowBadge(false)
                },
            )
            nm.createNotificationChannel(
                NotificationChannel(TURNS, "Next turn (car)", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "The next turn on the car's screen while another app is in front; silent on the phone"
                    setSound(null, null)
                    enableVibration(false)
                    setShowBadge(false)
                },
            )
            nm.deleteNotificationChannel(OLD_TURNS)
        }
    }
}
