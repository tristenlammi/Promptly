package org.promptly.sync.maps

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.location.LocationRequest
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.car.app.connection.CarConnection
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Observer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.promptly.sync.R
import java.util.concurrent.Executor

/**
 * The phone's position in the background, for two things that are each only on if you
 * turned them on:
 *
 * - **Your timeline**: positions kept in a small file and sent to your server every few
 *   minutes (and whenever the service starts, a connection comes back, or it stops).
 * - **Live location**: while you're sharing with someone, where you are goes to your
 *   server every minute on the move, and every three minutes when you're staying put
 *   (the same place again, so the people watching can see the phone is still there).
 *
 * It runs while either is wanted and stops when neither is. Timeline positions are only
 * kept while the timeline is on. While you stay put it looks every few minutes, to go
 * easy on the battery. Also notices the car screen going away, which is where you parked.
 *
 * Android stops services; [LocationKeeper] starts this one again. The rules (how often,
 * what's kept, what happens when a send fails) are in Tracking.kt, where they're tested.
 */
class TimelineService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val main = Handler(Looper.getMainLooper())
    private lateinit var manager: LocationManager
    private lateinit var status: TrackStatus
    private lateinit var queue: TrackQueue
    private val motion = Motion(SystemClock.elapsedRealtime())
    private var started = false

    /** The newest position worth showing someone. */
    private var last: Location? = null

    /** The last one kept for the timeline. */
    private var kept: Location? = null
    private var lastFlush = 0L
    private var flushing = false
    private var lastLiveTry = 0L
    private var liveWorked = true
    private var liveBusy = false
    private var shown = ""
    private var inCar = false
    private var carObserver: Observer<Int>? = null
    private var connection: CarConnection? = null
    private var network: ConnectivityManager.NetworkCallback? = null

    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) = onFix(location)

        // Without these, a phone on an older Android crashes when GPS is turned off.
        override fun onProviderEnabled(provider: String) = Unit
        override fun onProviderDisabled(provider: String) = Unit

        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
    }
    private val onMain = Executor { job -> main.post(job) }
    private val ticker = object : Runnable {
        override fun run() {
            beat()
            main.postDelayed(this, TICK_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        manager = getSystemService(LOCATION_SERVICE) as LocationManager
        status = TrackStatus(this)
        queue = LocationKeeper.queue(this)
        val channel = NotificationChannel(CHANNEL, "Timeline and live location", NotificationManager.IMPORTANCE_MIN)
        channel.description = "Shown while P Maps records your timeline or shares where you are"
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            status.runProblem = Problem.PERMISSION
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            val note = notification()
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTE, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            } else {
                startForeground(NOTE, note)
            }
        } catch (e: Exception) {
            // Android brought the service back by itself after stopping the app, at a
            // moment it doesn't allow a location service to start. Written down, not a
            // crash; LocationKeeper starts it at the next moment that is allowed.
            Log.w(TAG, "not allowed to start now: ${e.javaClass.simpleName}")
            status.runProblem = if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED) Problem.BLOCKED else Problem.BACKGROUND
            stopSelf()
            return START_NOT_STICKY
        }
        if (!started) {
            started = true
            running = this
            status.runProblem = null
            request()
            watchCar()
            watchNetwork()
            // What was waiting when it last stopped goes now, not after the next drive.
            flush()
            main.postDelayed(ticker, 1_000L)
        }
        return START_STICKY
    }

    private fun watchCar() {
        val observer = Observer<Int> { type ->
            val connected = type == CarConnection.CONNECTION_TYPE_PROJECTION
            if (inCar && !connected) {
                last?.let { at -> scope.launch { runCatching { Parking.save(this@TimelineService, at.latitude, at.longitude, "auto") } } }
            }
            inCar = connected
        }
        carObserver = observer
        connection = runCatching { CarConnection(applicationContext).also { it.type.observeForever(observer) } }.getOrNull()
    }

    /** A connection coming back: send what's waiting, and where you are, straight away. */
    private fun watchNetwork() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(net: Network) {
                main.post {
                    if (running !== this@TimelineService) return@post
                    lastFlush = 0L
                    if (!liveWorked) lastLiveTry = 0L
                    beat()
                }
            }
        }
        network = callback
        runCatching { cm.registerDefaultNetworkCallback(callback) }
    }

    private fun words(): Pair<String, String> = when {
        status.timeline && status.sharing -> "Recording your timeline and sharing your location" to "Only your Promptly server gets this, and the people you chose."
        status.sharing -> "Sharing your location" to "With the people you chose, through your Promptly server."
        else -> "Recording your timeline" to "Only your Promptly server gets this."
    }

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, TimelineActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val (title, text) = words()
        shown = title
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_map_status)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
    }

    /** Ask the phone for positions, as often as [motion] says. Moving: GPS every half
     *  minute. Staying put: a GPS look every five minutes, and between those whatever the
     *  phone can tell cheaply (Wi-Fi and masts; indoors GPS often says nothing at all). */
    @SuppressLint("MissingPermission")
    private fun request() {
        runCatching { manager.removeUpdates(listener) }
        val providers = manager.allProviders
        val moving = motion.moving
        runCatching {
            if (LocationManager.GPS_PROVIDER in providers) {
                manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, if (moving) LiveBeat.fixEvery(true) else STILL_GPS_MS, 0f, listener, Looper.getMainLooper())
            }
        }
        if (moving) return
        runCatching {
            if (Build.VERSION.SDK_INT >= 31 && LocationManager.FUSED_PROVIDER in providers) {
                val every = LocationRequest.Builder(LiveBeat.fixEvery(false)).setQuality(LocationRequest.QUALITY_BALANCED_POWER_ACCURACY).build()
                manager.requestLocationUpdates(LocationManager.FUSED_PROVIDER, every, onMain, listener)
            } else if (LocationManager.NETWORK_PROVIDER in providers) {
                manager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, LiveBeat.fixEvery(false), 0f, listener, Looper.getMainLooper())
            }
        }
        // Free: whatever another app's asking for anyway. It's how a drive that starts
        // while this is in its slow mode gets noticed sooner.
        runCatching {
            if (LocationManager.PASSIVE_PROVIDER in providers) {
                manager.requestLocationUpdates(LocationManager.PASSIVE_PROVIDER, 30_000L, 50f, listener, Looper.getMainLooper())
            }
        }
    }

    private fun onFix(at: Location) {
        val now = SystemClock.elapsedRealtime()
        val age = LocationKeeper.ageMs(at)
        if (age > 5 * 60_000L) return // something the phone remembered, not where it is
        val gps = at.provider == LocationManager.GPS_PROVIDER
        val doubt = if (at.hasAccuracy()) at.accuracy else 1000f
        val before = last
        // GPS is believed over a guess from Wi-Fi, unless GPS has had nothing to say for a while.
        if (before == null || gps || before.provider != LocationManager.GPS_PROVIDER || LocationKeeper.ageMs(before) > 90_000L) last = at
        status.fixAt = System.currentTimeMillis() - age
        if (motion.fix(now, at.latitude, at.longitude, doubt)) request()
        if (status.timeline && doubt <= KEEP_WITHIN_METRES) keep(at, age)
        beat()
    }

    private fun keep(at: Location, age: Long) {
        val previous = kept
        if (previous != null && !TrackRows.worthKeeping(at.distanceTo(previous), (at.elapsedRealtimeNanos - previous.elapsedRealtimeNanos) / 1_000_000L)) return
        val line = TrackRows.row(
            TrackRows.fixTime(at.time, age, System.currentTimeMillis()), at.latitude, at.longitude,
            if (at.hasAccuracy()) at.accuracy else null, if (at.hasSpeed()) at.speed else null,
        ) ?: return
        kept = at
        runCatching { queue.add(line) }
    }

    /** Everything that happens on the clock rather than on a new position: the slow mode
     *  once you've stayed put, sending what's waiting, the heartbeat to the people you
     *  share with, and stopping when nothing's wanted any more. Called every half minute,
     *  on each position, when a connection comes back, and by the wake-up alarm. */
    fun beat() {
        if (running !== this) return
        val now = SystemClock.elapsedRealtime()
        if (motion.tick(now)) request()
        val timeline = status.timeline
        val sharing = status.sharing
        if (!Wanted.running(timeline, sharing)) {
            stopSelf()
            return
        }
        if (words().first != shown) runCatching { getSystemService(NotificationManager::class.java).notify(NOTE, notification()) }
        val off = if (manager.isLocationEnabled) null else Problem.LOCATION_OFF
        if (status.runProblem != off) status.runProblem = off
        if (timeline && now - lastFlush >= FLUSH_MS) flush()
        live(now, sharing)
    }

    /** Send the timeline positions that are waiting. */
    private fun flush() {
        if (flushing) return
        flushing = true
        lastFlush = SystemClock.elapsedRealtime()
        scope.launch {
            try {
                LocationKeeper.awake(this@TimelineService, 90_000L) { LocationKeeper.upload(this@TimelineService) }
            } catch (e: Exception) {
                Log.w(TAG, "upload: ${e.javaClass.simpleName}")
            } finally {
                flushing = false
            }
        }
    }

    private fun live(now: Long, sharing: Boolean) {
        // A trip you're being guided on sends its own, with where it's going and when.
        if (liveBusy || (sharing && Nav.onTrip())) return
        if (!LiveBeat.due(now, lastLiveTry, sharing, motion.moving, liveWorked)) return
        lastLiveTry = now
        val at = (listOfNotNull(last, LocationKeeper.lastKnown(this)).maxByOrNull { it.elapsedRealtimeNanos })
            ?.takeIf { sharing && LiveBeat.sendable(motion.moving, LocationKeeper.ageMs(it)) }
        liveBusy = true
        scope.launch {
            try {
                liveWorked = LocationKeeper.awake(this@TimelineService, 30_000L) {
                    if (at != null) {
                        LocationKeeper.sendLive(this@TimelineService, at.latitude, at.longitude, if (at.hasSpeed() && motion.moving) at.speed else null)
                    } else {
                        // Nobody to send to, or nowhere current to send: still say we're
                        // here, and hear whether someone's been added or it's ended.
                        LocationKeeper.checkIn(this@TimelineService, force = true) && !sharing
                    }
                }
            } catch (e: Exception) {
                liveWorked = false
            } finally {
                liveBusy = false
            }
        }
    }

    override fun onDestroy() {
        main.removeCallbacks(ticker)
        runCatching { manager.removeUpdates(listener) }
        carObserver?.let { connection?.type?.removeObserver(it) }
        network?.let { cb -> runCatching { (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(cb) } }
        if (running === this) running = null
        // What's waiting goes now if it can; if it can't, it's in the file for next time.
        val app = applicationContext
        if (started && TrackStatus(app).timeline) LocationKeeper.background { LocationKeeper.upload(app) }
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "PromptlyTimeline"
        private const val CHANNEL = "timeline"
        private const val NOTE = 7301
        private const val TICK_MS = 30_000L
        private const val STILL_GPS_MS = 5 * 60_000L
        private const val FLUSH_MS = 5 * 60_000L

        /** A position vaguer than this isn't put in the timeline (it still counts as "here" for a heartbeat). */
        const val KEEP_WITHIN_METRES = 100f

        /** The service, while it's really running in this process. */
        @Volatile
        var running: TimelineService? = null
            private set

        /** Start it now if it's wanted (and Android allows). */
        fun start(context: Context) {
            LocationKeeper.ensure(context)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, TimelineService::class.java))
        }

        fun wanted(context: Context) = TrackStatus(context).timeline

        fun setWanted(context: Context, on: Boolean) {
            TrackStatus(context).timeline = on
        }
    }
}
