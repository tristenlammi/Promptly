package org.promptly.sync.talk

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import org.promptly.sync.assistant.AssistantActivity

/** Quick Settings → "Talk to Promptly". It opens the sheet, so the conversation
 *  starts from something on screen (Android's rule for the microphone), and asks
 *  you to unlock first if the phone is locked. While a conversation is on, the
 *  tile shows it, and a tap brings the sheet back. */
class TalkTile : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        val tile = qsTile ?: return
        val on = Talk.live
        tile.label = "Talk to Promptly"
        tile.state = if (on) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        if (Build.VERSION.SDK_INT >= 29) tile.subtitle = if (on) "On" else null
        tile.updateTile()
    }

    override fun onClick() {
        super.onClick()
        val open = {
            val intent = Intent(this, AssistantActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(AssistantActivity.EXTRA_FROM, "tile")
            if (Build.VERSION.SDK_INT >= 34) {
                startActivityAndCollapse(PendingIntent.getActivity(this, 3, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            } else {
                @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
                startActivityAndCollapse(intent)
            }
        }
        // Nothing is heard until you've unlocked.
        if (isLocked) unlockAndRun { open() } else open()
    }
}
