package org.promptly.sync.maps

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import androidx.car.app.connection.CarConnection
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Observer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import org.promptly.sync.R
import java.io.File
import java.time.Instant

/** Records your timeline: your phone's GPS, sent only to your server. While you
 *  stay put it looks every few minutes, to go easy on the battery. Positions
 *  wait in a small file when there's no signal. Also notices the car screen
 *  going away, which is where you parked. */
class TimelineService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var manager: LocationManager
    private var moving = true
    private var last: Location? = null
    private var stillSince = 0L
    private var lastLive = 0L
    private var sharing = true
    private var inCar = false
    private var carObserver: Observer<Int>? = null
    private var connection: CarConnection? = null
    private val listener = LocationListener { onFix(it) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        manager = getSystemService(LOCATION_SERVICE) as LocationManager
        val channel = NotificationChannel(CHANNEL, "Timeline", NotificationManager.IMPORTANCE_MIN)
        channel.description = "Shown while P Maps records your timeline"
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            stopSelf()
            return START_NOT_STICKY
        }
        val note = notification()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTE, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTE, note)
        }
        request()
        if (carObserver == null) watchCar()
        return START_STICKY
    }

    private fun watchCar() {
        val observer = Observer<Int> { type ->
            val connected = type == CarConnection.CONNECTION_TYPE_PROJECTION
            if (inCar && !connected) {
                last?.let { at -> scope.launch { runCatching { Maps.park(this@TimelineService, at.latitude, at.longitude, "auto") } } }
            }
            inCar = connected
        }
        carObserver = observer
        connection = CarConnection(applicationContext).also { it.type.observeForever(observer) }
    }

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, TimelineActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_map_status)
            .setContentTitle("Recording your timeline")
            .setContentText("Only your Promptly server gets this.")
            .setContentIntent(open)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
    }

    @SuppressLint("MissingPermission")
    private fun request() {
        manager.removeUpdates(listener)
        if (!manager.allProviders.contains(LocationManager.GPS_PROVIDER)) return
        val every = if (moving) MOVING_MS else STILL_MS
        manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, every, if (moving) 25f else 0f, listener, Looper.getMainLooper())
    }

    private fun onFix(at: Location) {
        val previous = last
        val now = System.currentTimeMillis()
        if (previous != null && at.distanceTo(previous) > 100f) {
            stillSince = now
            if (!moving) {
                moving = true
                request()
            }
        } else if (moving && stillSince != 0L && now - stillSince > 10 * 60_000) {
            moving = false
            request()
        } else if (stillSince == 0L) {
            stillSince = now
        }
        last = at
        keep(at)
        sendLive(at, now)
    }

    private fun sendLive(at: Location, now: Long) {
        val wait = if (sharing) 60_000L else 10 * 60_000L
        if (now - lastLive < wait) return
        lastLive = now
        scope.launch {
            val body = JSONObject().put("lat", at.latitude).put("lon", at.longitude)
            if (at.hasSpeed()) body.put("speed", at.speed.toDouble())
            runCatching { Maps.send(this@TimelineService, "POST", "/api/maps/live", body) }
                .onSuccess { sharing = it.optBoolean("sharing") }
        }
    }

    private fun queue() = File(filesDir, "timeline-queue.jsonl")

    @Synchronized
    private fun keep(at: Location) {
        val row = JSONObject()
            .put("at", Instant.ofEpochMilli(at.time).toString())
            .put("lat", at.latitude)
            .put("lon", at.longitude)
        if (at.hasAccuracy()) row.put("accuracy", at.accuracy.toDouble())
        if (at.hasSpeed()) row.put("speed", at.speed.toDouble())
        queue().appendText(row.toString() + "\n")
        val now = System.currentTimeMillis()
        if (now - lastFlush > FLUSH_MS) {
            lastFlush = now
            scope.launch { flush() }
        }
    }

    private var lastFlush = 0L

    /** Send what's waiting, oldest first. If the server says the timeline is
     *  paused, stop and forget what's waiting. */
    private fun flush() {
        val rows: List<String>
        synchronized(this) {
            val file = queue()
            if (!file.exists()) return
            rows = file.readLines().filter { it.isNotBlank() }
        }
        var sent = 0
        for (batch in rows.chunked(1000)) {
            val points = JSONArray()
            batch.forEach { points.put(JSONObject(it)) }
            val answer = runCatching { Maps.send(this, "POST", "/api/maps/timeline/points", JSONObject().put("points", points)) }.getOrNull() ?: break
            sent += batch.size
            if (!answer.optBoolean("timeline_on", true)) {
                synchronized(this) { queue().delete() }
                stopSelf()
                return
            }
        }
        if (sent > 0) {
            synchronized(this) {
                val file = queue()
                val now = file.readLines().filter { it.isNotBlank() }
                file.writeText(now.drop(sent).joinToString("") { it + "\n" })
            }
        }
    }

    override fun onDestroy() {
        manager.removeUpdates(listener)
        carObserver?.let { connection?.type?.removeObserver(it) }
        scope.launch { flush() }.invokeOnCompletion { scope.cancel() }
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "timeline"
        private const val NOTE = 7301
        private const val MOVING_MS = 30_000L
        private const val STILL_MS = 5 * 60_000L
        private const val FLUSH_MS = 5 * 60_000L

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, TimelineService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, TimelineService::class.java))
        }

        private fun prefs(context: Context) = context.getSharedPreferences("maps", MODE_PRIVATE)

        fun wanted(context: Context) = prefs(context).getBoolean("timeline", false)

        fun setWanted(context: Context, on: Boolean) {
            prefs(context).edit().putBoolean("timeline", on).apply()
        }
    }
}

/** Carries on after the phone restarts, if it was on. */
class TimelineBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val background = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (TimelineService.wanted(context) && background) TimelineService.start(context)
    }
}
