package org.promptly.sync.maps

import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.stadiamaps.ferrostar.car.app.intent.CarAppMapIntent
import com.stadiamaps.ferrostar.car.app.intent.CarAppMapIntentParser
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale

/** "Navigate to…", "show this place" and "search for…" from other apps, the phone's
 *  assistant and the car's, read by Ferrostar's parser (geo:, google.navigation: and
 *  the car's ACTION_NAVIGATE). The phone and the car each decide what to do with it. */
internal object MapLinks {
    sealed interface Ask {
        /** Drive there. [addStop]: on the way, if a trip's already running. */
        data class Navigate(val stop: Stop, val options: TripOptions, val addStop: Boolean = false) : Ask
        /** Drive to a place by name: look it up first. */
        data class NavigateTo(val query: String, val options: TripOptions) : Ask
        /** Show this place. */
        data class Show(val stop: Stop) : Ask
        /** Search for this. */
        data class Search(val query: String) : Ask
    }

    /** [saved]: the avoid choices to use when the link doesn't say. */
    fun read(intent: Intent, saved: TripOptions): Ask? {
        val asked = runCatching { CarAppMapIntentParser.parse(intent) }.getOrNull() ?: return null
        return when (asked) {
            is CarAppMapIntent.Navigate -> {
                val mode = when (asked.mode) {
                    CarAppMapIntent.Navigate.TravelMode.WALKING -> "walk"
                    CarAppMapIntent.Navigate.TravelMode.BICYCLING -> "cycle"
                    else -> "drive"
                }
                val options = if (asked.avoid.isEmpty() && mode == "drive") saved else TripOptions(
                    mode,
                    CarAppMapIntent.Navigate.Avoid.TOLLS in asked.avoid,
                    CarAppMapIntent.Navigate.Avoid.HIGHWAYS in asked.avoid,
                    CarAppMapIntent.Navigate.Avoid.FERRIES in asked.avoid,
                )
                when (val to = asked.destination) {
                    is CarAppMapIntent.Navigate.Destination.Coordinate ->
                        Ask.Navigate(Stop(to.location.lat, to.location.lng, named(to.label, "Destination")), options, asked.action == CarAppMapIntent.Navigate.Action.ADD_STOP)
                    is CarAppMapIntent.Navigate.Destination.Query -> to.query.trim().takeIf { it.isNotEmpty() }?.let { Ask.NavigateTo(it, options) }
                    else -> null
                }
            }
            is CarAppMapIntent.Pin -> Ask.Show(Stop(asked.location.lat, asked.location.lng, named(asked.label, "Dropped pin")))
            is CarAppMapIntent.DisplayMap -> Ask.Show(Stop(asked.center.lat, asked.center.lng, "Dropped pin"))
            is CarAppMapIntent.Search -> asked.query.trim().takeIf { it.isNotEmpty() }?.let { Ask.Search(it) }
            else -> null
        }
    }

    private fun named(label: String?, fallback: String) = label?.trim()?.takeIf { it.isNotEmpty() } ?: fallback

    /** The driving screen's own link, signed in already on this phone. */
    fun driveLink(stop: Stop, options: TripOptions): Uri = Uri.Builder()
        .scheme("promptlymaps").authority("navigate")
        .appendQueryParameter("stops", String.format(Locale.ROOT, "%.6f,%.6f,%s", stop.lat, stop.lon, stop.name.replace(";", " ")))
        .appendQueryParameter("mode", options.mode)
        .appendQueryParameter("tolls", if (options.tolls) "1" else "0")
        .appendQueryParameter("highways", if (options.highways) "1" else "0")
        .appendQueryParameter("ferries", if (options.ferries) "1" else "0")
        .build()

    /** Where in the P Maps web app shows this: /maps?to=… or /maps?q=…. */
    fun webPath(ask: Ask): String = when (ask) {
        is Ask.Navigate -> "/maps?to=" + Uri.encode(String.format(Locale.ROOT, "%.6f,%.6f,%s", ask.stop.lat, ask.stop.lon, ask.stop.name))
        is Ask.Show -> "/maps?to=" + Uri.encode(String.format(Locale.ROOT, "%.6f,%.6f,%s", ask.stop.lat, ask.stop.lon, ask.stop.name))
        is Ask.NavigateTo -> "/maps?q=" + Uri.encode(ask.query)
        is Ask.Search -> "/maps?q=" + Uri.encode(ask.query)
    }
}

/** P Maps for links from other apps on the phone. "Navigate to" starts driving in the
 *  driving screen (by name: the nearest match first). "Show this place" and "search
 *  for" open P Maps with it. Without P Maps signed in on this phone, the web app. */
class MapLinkActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Nav.init(this)
        val ask = MapLinks.read(intent, Nav.driveOptions())
        if (ask == null) {
            Toast.makeText(this, "P Maps couldn't read that place.", Toast.LENGTH_LONG).show()
            finish()
            return
        }
        val signedIn = Maps.server(this) != null
        when {
            ask is MapLinks.Ask.Navigate && signedIn -> drive(ask.stop, ask.options)
            ask is MapLinks.Ask.NavigateTo && signedIn -> lookUpAndDrive(ask)
            else -> openWeb(MapLinks.webPath(ask))
        }
    }

    private fun drive(stop: Stop, options: TripOptions) {
        startActivity(Intent(Intent.ACTION_VIEW, MapLinks.driveLink(stop, options), this, NavigationActivity::class.java))
        finish()
    }

    private fun lookUpAndDrive(ask: MapLinks.Ask.NavigateTo) {
        Toast.makeText(this, "Finding ${ask.query}…", Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            val here = runCatching { withTimeoutOrNull(3_000) { Nav.locationProvider.lastLocation() } }.getOrNull()
            val found = runCatching { PlaceSearch.find(this@MapLinkActivity, ask.query, here?.let { it.latitude to it.longitude }) }
            val best = found.getOrNull()?.stops?.firstOrNull()
            when {
                best != null -> drive(best, ask.options)
                found.isFailure -> {
                    Toast.makeText(this@MapLinkActivity, "Couldn't reach your server.", Toast.LENGTH_LONG).show()
                    finish()
                }
                // No signal and nothing on the phone: the web app can't help either.
                found.getOrNull()?.offline == true -> {
                    Toast.makeText(this@MapLinkActivity, found.getOrNull()!!.empty, Toast.LENGTH_LONG).show()
                    finish()
                }
                // Nothing by that name nearby: P Maps' own search, to look further.
                else -> openWeb(MapLinks.webPath(ask))
            }
        }
    }

    /** The P Maps web app at [path], in its own launcher if you have it on your
     *  home screen, else in Promptly's. */
    private fun openWeb(path: String) {
        val maps = ComponentName(packageName, "org.promptly.app.MapsLauncher")
        val promptly = ComponentName(packageName, "org.promptly.app.PromptlyLauncher")
        val target = if (enabled(maps)) maps else promptly
        runCatching {
            startActivity(Intent().setComponent(target).putExtra(EXTRA_PATH, path).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure {
            Toast.makeText(this, "Open P Maps to see this place.", Toast.LENGTH_LONG).show()
        }
        finish()
    }

    private fun enabled(component: ComponentName): Boolean = when (packageManager.getComponentEnabledSetting(component)) {
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
        PackageManager.COMPONENT_ENABLED_STATE_DEFAULT ->
            runCatching { packageManager.getActivityInfo(component, 0).enabled }.getOrDefault(false)
        else -> false
    }

    companion object {
        /** Read by the launchers (SuiteLauncher): a path on your server to open instead. */
        const val EXTRA_PATH = "org.promptly.app.OPEN_PATH"
    }
}
