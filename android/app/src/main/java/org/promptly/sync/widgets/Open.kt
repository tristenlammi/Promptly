package org.promptly.sync.widgets

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import org.promptly.app.SuiteLauncher
import org.promptly.sync.MainActivity
import org.promptly.sync.Store

/**
 * Where a tap on a widget goes. Pages of the web app open in that app's own
 * P icon (CalendarLauncher, TasksLauncher…) at the page, so Back and the
 * recents list behave; if you've taken that icon off the home screen, the
 * page opens in the browser instead (as the assistant's "open" does).
 */
object Open {
    const val EXTRA_LAUNCHER = "launcher"
    const val EXTRA_PATH = "path"
    const val EXTRA_LINK = "link"

    const val CALENDAR = "org.promptly.app.CalendarLauncher"
    const val TASKS = "org.promptly.app.TasksLauncher"

    /** An intent for a widget: through [OpenActivity], which decides at tap time. */
    fun page(ctx: Context, launcher: String, path: String): Intent =
        Intent(ctx, OpenActivity::class.java)
            .putExtra(EXTRA_LAUNCHER, launcher)
            .putExtra(EXTRA_PATH, path)
            // Distinct data, so each row's tap is its own PendingIntent.
            .setData(Uri.parse("promptly-widget://open/${launcher.substringAfterLast('.')}$path"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** Link this phone (backup's pairing screen). */
    fun link(ctx: Context): Intent =
        Intent(ctx, OpenActivity::class.java).putExtra(EXTRA_LINK, true).setData(Uri.parse("promptly-widget://link"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    fun go(ctx: Context, launcher: String, path: String): Boolean {
        val safe = SuiteLauncher.safePath(path) ?: return false
        // CLEAR_TASK: with that app already open, its launcher would only bring the
        // open page forward (checked on the emulator); starting its task afresh
        // opens the page asked for.
        val app = Intent().setClassName(ctx.packageName, launcher)
            .putExtra(SuiteLauncher.EXTRA_URL_PATH, safe)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        if (start(ctx, app)) return true
        val server = Store(ctx).account?.server ?: return false
        val sep = if (safe.contains('?')) "&" else "?"
        return start(ctx, Intent(Intent.ACTION_VIEW, Uri.parse("$server$safe${sep}source=android")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun start(ctx: Context, intent: Intent): Boolean = try {
        // A launcher whose icon is turned off is a disabled component: say so up front.
        val target = intent.component
        if (target != null) {
            val state = ctx.packageManager.getComponentEnabledSetting(target)
            val on = when (state) {
                android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
                android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DEFAULT ->
                    runCatching { ctx.packageManager.getActivityInfo(target, 0).enabled }.getOrDefault(false)
                else -> false
            }
            if (!on) throw ActivityNotFoundException()
        }
        ctx.startActivity(intent)
        true
    } catch (e: ActivityNotFoundException) {
        false
    } catch (e: SecurityException) {
        false
    }
}

/** No screen of its own: opens what the widget asked for, then goes. */
class OpenActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val i = intent
        if (i.getBooleanExtra(Open.EXTRA_LINK, false)) {
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } else {
            val launcher = i.getStringExtra(Open.EXTRA_LAUNCHER)
            val path = i.getStringExtra(Open.EXTRA_PATH)
            if (launcher != null && path != null && launcher.startsWith("org.promptly.app.")) Open.go(this, launcher, path)
        }
        finish()
    }
}
