package org.promptly.sync.assistant

import android.app.KeyguardManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.provider.AlarmClock
import android.util.Log
import org.json.JSONObject
import org.promptly.sync.maps.Maps
import org.promptly.sync.maps.Nav
import org.promptly.sync.maps.Voice
import java.net.URLEncoder

/** What your server can ask this phone to do, all of it right here. There is no
 *  way to name an intent or a link: anything else is ignored, and every value is
 *  checked again even though the server already has. */
object PhoneActions {
    private const val TAG = "PromptlyVoice"
    private val NUMBER = Regex("""\+?[0-9][0-9 ()\-]{2,24}""")

    // Promptly's apps: launcher (which may be switched off in Choose apps), and path.
    private val APPS = mapOf(
        "promptly" to ("PromptlyLauncher" to "/"),
        "photos" to ("PhotosLauncher" to "/photos"),
        "rooms" to ("RoomsLauncher" to "/rooms/"),
        "calendar" to ("CalendarLauncher" to "/calendar"),
        "maps" to ("MapsLauncher" to "/maps"),
        "contacts" to ("ContactsLauncher" to "/app/open/contacts"),
        "budget" to ("BudgetLauncher" to "/app/open/budget"),
        "habits" to ("HabitsLauncher" to "/app/open/habits"),
        "journal" to ("JournalLauncher" to "/app/open/journal"),
        "workout" to ("WorkoutLauncher" to "/app/open/workout"),
        "flashcards" to ("FlashcardsLauncher" to "/app/open/flashcards"),
        "boardgames" to ("BoardgamesLauncher" to "/app/open/boardgames"),
        "health" to ("HealthLauncher" to "/app/open/health"),
        "mealplan" to ("MealplanLauncher" to "/app/open/mealplan"),
        "meals" to ("MealsLauncher" to "/app/open/meals"),
        "trip" to ("TripLauncher" to "/app/open/trip"),
        "tasks" to ("TasksLauncher" to "/app/open/tasks"),
    )

    /** Carry out what the assistant decided. Returns what to say instead, if it
     *  couldn't be done. Anything that isn't for the phone itself goes to the map. */
    fun carry(context: Context, action: JSONObject): String? {
        val type = action.optString("type")
        // You can't press anything on the phone from the car's screen.
        if (Voice.inCar && type in setOf("dial", "message", "open_app")) return "That needs your phone's screen."
        return when (type) {
            "set_timer" -> timer(context, action)
            "set_alarm" -> alarm(context, action)
            "dial", "message" -> reach(context, action)
            "open_app" -> openApp(context, action.optString("app"))
            "go" -> go(context, action)
            else -> {
                Nav.act(action)
                null
            }
        }
    }

    private fun start(context: Context, intent: Intent): Boolean = try {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (e: ActivityNotFoundException) {
        Log.w(TAG, "Nothing on this phone can do that", e)
        false
    } catch (e: SecurityException) {
        Log.w(TAG, "Not allowed to do that", e)
        false
    }

    private fun label(action: JSONObject): String? =
        action.optString("label").take(60).takeIf { it.isNotBlank() }

    private fun timer(context: Context, action: JSONObject): String? {
        val seconds = action.optInt("seconds")
        if (seconds !in 1..86400) return "I can't set that timer."
        val intent = Intent(AlarmClock.ACTION_SET_TIMER)
            .putExtra(AlarmClock.EXTRA_LENGTH, seconds)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        label(action)?.let { intent.putExtra(AlarmClock.EXTRA_MESSAGE, it) }
        return if (start(context, intent)) null else "There's no clock app on this phone that can set a timer."
    }

    private fun alarm(context: Context, action: JSONObject): String? {
        val hour = action.optInt("hour", -1)
        val minute = action.optInt("minute", -1)
        if (hour !in 0..23 || minute !in 0..59) return "I can't set that alarm."
        val intent = Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, hour)
            .putExtra(AlarmClock.EXTRA_MINUTES, minute)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        label(action)?.let { intent.putExtra(AlarmClock.EXTRA_MESSAGE, it) }
        return if (start(context, intent)) null else "There's no clock app on this phone that can set an alarm."
    }

    /** The dialler or a draft, with you to press call or send. With no number,
     *  you pick who from your contacts: no permission to read them is needed. */
    private fun reach(context: Context, action: JSONObject): String? {
        val number = action.optString("number")
        if (number.isEmpty()) {
            val sheet = AssistantActivity.current ?: return "I don't have a number for them."
            sheet.pickContact(action)
            return null
        }
        if (!open(context, action, number)) return "This phone can't do that."
        AssistantActivity.leave()
        return null
    }

    /** With the number known: only digits, so no dialling codes or other links. */
    internal fun open(context: Context, action: JSONObject, number: String): Boolean {
        if (!NUMBER.matches(number)) return false
        val intent = if (action.optString("type") == "dial") {
            Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null))
        } else {
            Intent(Intent.ACTION_SENDTO, Uri.fromParts("smsto", number, null)).apply {
                action.optString("text").take(1000).takeIf { it.isNotBlank() }?.let { putExtra("sms_body", it) }
            }
        }
        return start(context, intent)
    }

    private fun openApp(context: Context, key: String): String? {
        val (launcher, path) = APPS[key] ?: return "I can't open that."
        val app = Intent().setClassName(context.packageName, "org.promptly.app.$launcher")
        var opened = start(context, app)
        // You've taken its icon off the home screen, but it's still your app.
        if (!opened) {
            val server = Maps.server(context) ?: return "This phone isn't linked to your Promptly yet."
            opened = start(context, Intent(Intent.ACTION_VIEW, Uri.parse(server + path)))
        }
        if (!opened) return "I couldn't open that."
        AssistantActivity.leave()
        return null
    }

    private fun go(context: Context, action: JSONObject): String? {
        if (Nav.onTrip() || Voice.inCar) {
            Nav.act(action)
            return null
        }
        val stop = action.optJSONObject("stop") ?: return "I can't find that."
        val name = URLEncoder.encode(stop.optString("name", "Destination").replace(";", " "), "UTF-8")
        val link = "promptlymaps://navigate?stops=${stop.getDouble("lat")},${stop.getDouble("lon")},$name"
        if (!start(context, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(context.packageName))) return "I couldn't start directions."
        AssistantActivity.leave()
        return null
    }

    /** Is the lock screen up right now? */
    fun locked(context: Context): Boolean =
        context.getSystemService(KeyguardManager::class.java)?.isKeyguardLocked == true

    /** Where the phone last knew it was, for "fuel near me". Goes to your server,
     *  never to the model. */
    fun lastPosition(context: Context): Location? {
        val manager = context.getSystemService(LocationManager::class.java) ?: return null
        return runCatching {
            manager.getProviders(true).mapNotNull { manager.getLastKnownLocation(it) }.maxByOrNull { it.time }
        }.getOrNull()
    }
}
