package org.promptly.sync.maps

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.location.LocationRequest
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.stadiamaps.ferrostar.core.location.NavigationLocationProviding
import java.util.concurrent.Executor
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow

/** Where you are, as often as the phone can say, for turn-by-turn.
 *
 *  Ferrostar's own provider asks for "balanced" accuracy, which is the battery-saving
 *  mode: mostly Wi-Fi and cell towers, so in a moving car the position barely changes.
 *  This listens to the GPS itself. Other sources only fill in while GPS has nothing to
 *  say, such as when you've just set off or you're in a tunnel. */
class LiveLocation(context: Context) : NavigationLocationProviding {
    private val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager

    @SuppressLint("MissingPermission") // Asked for before any trip starts.
    override suspend fun lastLocation(): Location? = lastKnown()

    @SuppressLint("MissingPermission")
    private fun lastKnown(): Location? =
        manager.allProviders
            .mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }
            .maxByOrNull { it.elapsedRealtimeNanos }

    @SuppressLint("MissingPermission")
    override fun locationUpdates(intervalMillis: Long): Flow<Location> = callbackFlow {
        var lastGps = 0L
        var newest = 0L
        val listener = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                // Fixes can arrive out of order from two sources.
                if (location.elapsedRealtimeNanos <= newest) return
                val now = SystemClock.elapsedRealtime()
                if (location.provider == LocationManager.GPS_PROVIDER) {
                    lastGps = now
                } else if (now - lastGps < GPS_TRUSTED_FOR_MS) {
                    return
                }
                newest = location.elapsedRealtimeNanos
                Log.v(TAG, "fix from ${location.provider}") // Never where: just that it came.
                trySend(location)
            }

            // Without these, a phone on an older Android crashes when GPS is turned off.
            override fun onProviderEnabled(provider: String) = Unit
            override fun onProviderDisabled(provider: String) = Unit

            @Deprecated("Deprecated in Java")
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
        }
        lastKnown()?.let { trySend(it) }
        val interval = intervalMillis.coerceAtMost(FASTEST_MS)
        val available = manager.allProviders
        if (LocationManager.GPS_PROVIDER in available) {
            manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, interval, 0f, listener, Looper.getMainLooper())
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && LocationManager.FUSED_PROVIDER in available) {
            val request = LocationRequest.Builder(interval).setQuality(LocationRequest.QUALITY_HIGH_ACCURACY).build()
            manager.requestLocationUpdates(LocationManager.FUSED_PROVIDER, request, onMain, listener)
        } else if (LocationManager.NETWORK_PROVIDER in available) {
            manager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, interval, 0f, listener, Looper.getMainLooper())
        }
        awaitClose { manager.removeUpdates(listener) }
    }

    private val onMain = Executor { job -> Handler(Looper.getMainLooper()).post(job) }

    private companion object {
        const val TAG = "PromptlyLocation"
        const val FASTEST_MS = 1000L
        const val GPS_TRUSTED_FOR_MS = 5000L
    }
}
