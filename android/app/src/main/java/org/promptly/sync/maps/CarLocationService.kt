package org.promptly.sync.maps

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.promptly.sync.R

/** Keeps your position coming while P Maps is on the car's screen with no trip.
 *
 *  Android counts an app drawn on the car's screen as in the background, and an app in
 *  the background gets no location unless it's allowed "all the time". During a trip the
 *  navigation library runs its own location service, which is why trips worked and the
 *  map with nowhere set didn't follow you: it got one fix when it opened and nothing
 *  after. This is that same kind of service (a location foreground service, the way the
 *  car library's guide says to do it), with nothing in it: while it runs, the app may use
 *  the location it was given "while using the app". It stops when the car screen goes. */
class CarLocationService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val channel = NotificationChannel(CHANNEL, "P Maps in the car", NotificationManager.IMPORTANCE_MIN)
        channel.description = "Shown while P Maps is on your car's screen"
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            stopSelf()
            return START_NOT_STICKY
        }
        val note = notification()
        val started = runCatching {
            if (Build.VERSION.SDK_INT >= 34) startForeground(NOTE, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            else startForeground(NOTE, note)
        }
        if (started.isFailure) {
            Log.w(TAG, "Couldn't keep the car map's position coming", started.exceptionOrNull())
            stopSelf()
        }
        // Not restarted by the system: the car screen starts it again when it's back.
        return START_NOT_STICKY
    }

    private fun notification(): Notification =
        NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_map_status)
            .setContentTitle("P Maps is on your car's screen")
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .build()

    companion object {
        private const val TAG = "PromptlyCarMap"
        private const val CHANNEL = "promptly_car_map"
        private const val NOTE = 4711

        /** The car screen is up. Safe to call again; never throws. */
        fun start(context: Context) {
            runCatching { ContextCompat.startForegroundService(context, Intent(context, CarLocationService::class.java)) }
                .onFailure { Log.w(TAG, "Couldn't start the car map's location service", it) }
        }

        /** The car screen has gone. */
        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, CarLocationService::class.java)) }
        }
    }
}
