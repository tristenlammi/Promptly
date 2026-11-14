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
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.promptly.sync.R
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom

/** When the GPS runs and when the service ends: nothing but arithmetic, so it can be tested.
 *
 *  The page asks the server about once a second while the map is in front; the server tells
 *  this app whether anyone is asking ([wanted]). GPS runs only while they are. Forty seconds with
 *  nobody asking and the whole thing stops (with the server's own 20, a minute after the map went); a tap on the page's location button starts it again. */
class PageLocationPolicy(private val startedAt: Long) {
    private var lastWanted = startedAt
    var gps = false
        private set

    /** What the server just said, at [now] (elapsed ms). Null: it couldn't be reached. */
    fun heard(wanted: Boolean?, now: Long) {
        if (wanted == true) {
            lastWanted = now
            gps = true
        } else if (wanted == false) {
            gps = false
        } else if (now - lastWanted > UNHEARD_GPS_MS) {
            gps = false // no signal for a while: don't burn the battery guessing
        }
    }

    fun finished(now: Long): Boolean = now - lastWanted > IDLE_STOP_MS

    /** How long until the next word with the server. */
    fun pause(): Long = if (gps) 1000L else 2000L

    companion object {
        const val IDLE_STOP_MS = 40_000L
        const val UNHEARD_GPS_MS = 15_000L
    }
}

/** Hands this phone's GPS to the P Maps page the app opened, and only to it.
 *
 *  A page in the app's launcher is Chrome. Chrome passes a page's location request to the app
 *  only once Google has verified the app against your server, and where that check can't be
 *  made the page never learns where you are. So while the map page is in front and asking,
 *  this posts the position to your own server, which shows it to that page alone (the page
 *  and the app share a key no one else has; see the server's maps/phone_location.py). Nothing
 *  is kept there, and nothing goes anywhere else.
 *
 *  It is started while the app is on screen (the launcher opening the page, or the page's
 *  location button bouncing through [PageLocateActivity]), which is what lets it use the
 *  "while using the app" permission afterwards. */
class PageLocationService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loop: Job? = null
    private var updates: Job? = null
    @Volatile private var latest: Location? = null
    private var sent: Location? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val channel = NotificationChannel(CHANNEL, "Your location on the P Maps page", NotificationManager.IMPORTANCE_LOW)
        channel.description = "Shown while the P Maps page is using this phone's location"
        channel.setShowBadge(false)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP || !allowed(this) || server(this) == null) {
            // Android wants a started foreground service shown before it may stop.
            runCatching { show() }
            stopSelf()
            return START_NOT_STICKY
        }
        if (runCatching { show() }.isFailure) {
            Log.w(TAG, "Couldn't start")
            stopSelf()
            return START_NOT_STICKY
        }
        if (loop?.isActive != true) loop = scope.launch { run() }
        return START_NOT_STICKY
    }

    private fun show() {
        val note = notification()
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTE, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        else startForeground(NOTE, note)
    }

    private suspend fun run() {
        val url = server(this)?.let { "$it/api/maps/phone-location/fix" } ?: return stopSelf()
        val key = key(this)
        val policy = PageLocationPolicy(SystemClock.elapsedRealtime())
        var everWanted = false
        while (scope.isActive) {
            val fix = latest.takeIf { policy.gps && it !== sent }
            val wanted = post(url, key, fix)
            if (wanted != null && fix != null) sent = fix
            val now = SystemClock.elapsedRealtime()
            policy.heard(wanted, now)
            if (wanted == true) {
                everWanted = true
                used(this, true)
            }
            if (policy.gps) gpsOn() else gpsOff()
            if (policy.finished(now)) break
            delay(policy.pause())
        }
        gpsOff()
        // No page asked at all: Chrome can tell this server's pages where you are after
        // all (or no map was open). Don't start unasked next time; the button still can.
        if (!everWanted) used(this, false)
        stopSelf()
    }

    @SuppressLint("MissingPermission") // Checked in onStartCommand.
    private fun gpsOn() {
        if (updates?.isActive == true) return
        Log.i(TAG, "gps on") // Never where: just that it's on.
        updates = scope.launch(Dispatchers.Main) {
            runCatching { LiveLocation(this@PageLocationService).locationUpdates(1000L).collect { latest = it } }
        }
    }

    private fun gpsOff() {
        if (updates?.isActive == true) Log.i(TAG, "gps off")
        updates?.cancel()
        updates = null
        latest = null
        sent = null
    }

    /** True or false as the server says a page wants the position; null if it couldn't be asked. */
    private fun post(url: String, key: String, fix: Location?): Boolean? = runCatching {
        val body = JSONObject().put("key", key)
        if (fix != null) {
            body.put("lat", fix.latitude).put("lon", fix.longitude)
            if (fix.hasAccuracy()) body.put("accuracy", fix.accuracy.toDouble())
            if (fix.hasBearing()) body.put("heading", fix.bearing.toDouble().coerceIn(0.0, 360.0))
            if (fix.hasSpeed()) body.put("speed", fix.speed.toDouble().coerceIn(0.0, 200.0))
        }
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 5000
            c.readTimeout = 5000
            c.requestMethod = "POST"
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray()) }
            if (c.responseCode != 200) return@runCatching null
            JSONObject(c.inputStream.bufferedReader().use { it.readText() }).optBoolean("wanted", false)
        } finally {
            c.disconnect()
        }
    }.getOrNull()

    private fun notification(): Notification {
        val stop = PendingIntent.getService(
            this, 0, Intent(this, PageLocationService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_map_status)
            .setContentTitle("P Maps can see where this phone is")
            .setContentText("Only while its map is open. It stops by itself.")
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(0, "Stop", stop)
            .build()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "PromptlyPageLocation"
        private const val CHANNEL = "promptly_page_location"
        private const val NOTE = 4712
        const val ACTION_STOP = "org.promptly.sync.maps.PAGE_LOCATION_STOP"

        // The launchers' own settings (the suite module's Server and SuiteLauncher read these too).
        private const val PREFS = "promptly"
        private const val KEY = "page_location_key"
        private const val USED = "page_location_used"

        fun server(context: Context): String? =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("server", null)?.trimEnd('/')

        /** The key this phone's pages are opened with: random, made once. */
        fun key(context: Context): String {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            prefs.getString(KEY, null)?.let { return it }
            val made = ByteArray(32).also { SecureRandom().nextBytes(it) }
                .let { Base64.encodeToString(it, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP) }
            prefs.edit().putString(KEY, made).apply()
            return made
        }

        /** Whether a page has ever needed this here: only then do the launchers start it unasked. */
        fun used(context: Context, yes: Boolean) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (prefs.getBoolean(USED, false) != yes) prefs.edit().putBoolean(USED, yes).apply()
        }

        fun allowed(context: Context): Boolean =
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

        /** Only from a screen of this app that's showing. Safe to call again; never throws. */
        fun start(context: Context) {
            if (!allowed(context) || server(context) == null) return
            runCatching { ContextCompat.startForegroundService(context, Intent(context, PageLocationService::class.java)) }
                .onFailure { Log.w(TAG, "Couldn't start", it) }
        }
    }
}
