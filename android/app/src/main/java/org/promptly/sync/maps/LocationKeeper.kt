package org.promptly.sync.maps

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlarmManager
import android.app.Application
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.promptly.sync.BuildConfig
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** How the timeline and live location are going on this phone: when it last got a
 *  position, last sent, and what's wrong. Times and a problem's name; never a place. */
class TrackStatus(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("maps", Context.MODE_PRIVATE)

    /** You asked this phone to record your timeline. */
    var timeline: Boolean
        get() = prefs.getBoolean("timeline", false)
        set(v) = prefs.edit().putBoolean("timeline", v).apply()

    /** The server last said someone is being shown where you are, [sharingUntil] (0: until you stop). */
    private val saidSharing: Boolean get() = prefs.getBoolean("tl_sharing", false)
    val sharingUntil: Long get() = prefs.getLong("tl_sharing_until", 0)
    val sharing: Boolean get() = Wanted.sharing(saidSharing, sharingUntil, System.currentTimeMillis())

    fun setSharing(on: Boolean, until: Long = 0) = prefs.edit().putBoolean("tl_sharing", on).putLong("tl_sharing_until", if (on) until else 0).apply()

    /** Wall-clock ms of: the last position, the last timeline upload that worked, the last
     *  live position that got through, the last word with the server. 0: never. */
    var fixAt: Long
        get() = prefs.getLong("tl_fix_at", 0)
        set(v) = prefs.edit().putLong("tl_fix_at", v).apply()
    var sentAt: Long
        get() = prefs.getLong("tl_sent_at", 0)
        set(v) = prefs.edit().putLong("tl_sent_at", v).apply()
    var liveAt: Long
        get() = prefs.getLong("tl_live_at", 0)
        set(v) = prefs.edit().putLong("tl_live_at", v).apply()
    var checkedAt: Long
        get() = prefs.getLong("tl_checked_at", 0)
        set(v) = prefs.edit().putLong("tl_checked_at", v).apply()

    /** What's wrong with sending, and with running at all. Null: nothing. */
    var sendProblem: Problem?
        get() = Problem.of(prefs.getString("tl_send_problem", null))
        set(v) = prefs.edit().putString("tl_send_problem", v?.code).apply()
    var runProblem: Problem?
        get() = Problem.of(prefs.getString("tl_run_problem", null))
        set(v) = prefs.edit().putString("tl_run_problem", v?.code).apply()

    val problem: Problem? get() = runProblem ?: sendProblem
}

/**
 * Keeps the background service going whenever it should be: you asked for the timeline,
 * or you're sharing where you are with someone. Android stops services (an app update,
 * low memory, a crash anywhere in the app) and before this nothing started this one again
 * until the phone restarted, while the screens went on saying "Recording".
 *
 * [ensure] is called whenever the app comes alive for any reason: any Promptly screen or
 * launcher opening, the phone starting, the app being updated, a notification arriving,
 * and a check every quarter of an hour. Android only lets a location service start from
 * the background at some of those moments (and only with "Allow all the time"); when it
 * won't, that's written down ([TrackStatus.runProblem]), told to the server so the web
 * app can say so, and the quarter-hourly check sends one position itself.
 */
object LocationKeeper {
    private const val TAG = "PromptlyKeeper"
    private const val WORK = "location-keeper"
    const val ACTION_BEAT = "org.promptly.sync.maps.BEAT"
    private val io = Executors.newSingleThreadExecutor()

    /** Promptly screens in front right now. */
    @Volatile private var visible = 0

    fun queue(context: Context) = TrackQueue(File(context.applicationContext.filesDir, "timeline-queue.jsonl"))

    private fun has(context: Context, permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    /** Once, when the app's process starts. */
    fun init(app: Application) {
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                visible++
                // In front: the one moment Android always lets the service start.
                wake(activity.applicationContext, ask = true)
            }
            override fun onActivityPaused(activity: Activity) { visible = (visible - 1).coerceAtLeast(0) }
            override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
            override fun onActivityStarted(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
        runCatching {
            WorkManager.getInstance(app).enqueueUniquePeriodicWork(
                WORK, ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<LocationWorker>(15, TimeUnit.MINUTES).build(),
            )
        }
        wake(app, ask = false)
    }

    /** Start the service if it should be running and isn't; with [ask], first find out
     *  from the server what's wanted (a share started on another device). Returns at once. */
    fun wake(context: Context, ask: Boolean, force: Boolean = false) {
        val app = context.applicationContext
        ensure(app)
        // (Whether it's linked, without unsealing the password on the main thread.)
        if (!ask || !org.promptly.sync.Store(app).hasAccount) return
        io.execute {
            runCatching { checkIn(app, force) }
            ensure(app)
        }
    }

    /** Off the main thread, one job at a time. */
    fun background(job: () -> Unit) = io.execute { runCatching(job) }

    /** The heartbeat with no service to do it (Android wouldn't start one): hear what's
     *  wanted, try the service again, and failing that send one position from here. */
    internal fun beatWithoutService(app: Context) {
        awake(app, 40_000L) {
            checkIn(app)
            if (wanted(app) && !ensure(app)) {
                oneFix(app, waitSeconds = 8)
                if (TrackStatus(app).timeline) upload(app)
            }
        }
    }

    /** Whether it should be running: the timeline is on, or someone's being shown where you are. */
    fun wanted(context: Context): Boolean = TrackStatus(context).let { Wanted.running(it.timeline, it.sharing) }

    /** Start it if it's wanted, not running, and Android will let us. Never throws. */
    fun ensure(context: Context): Boolean {
        val app = context.applicationContext
        val status = TrackStatus(app)
        if (!wanted(app)) {
            cancelBeat(app)
            if (status.runProblem != null) status.runProblem = null
            return false
        }
        scheduleBeat(app, status.sharing)
        if (TimelineService.running != null) return true
        val problem = cannotStart(app)
        if (problem != null) {
            status.runProblem = problem
            return false
        }
        return try {
            ContextCompat.startForegroundService(app, Intent(app, TimelineService::class.java))
            true
        } catch (e: Exception) {
            // Android 12+: not from the background, not right now.
            Log.w(TAG, "couldn't start: ${e.javaClass.simpleName}")
            status.runProblem = Problem.BLOCKED
            false
        }
    }

    /** Why the service can't be started this moment, or null if it can be tried. */
    private fun cannotStart(app: Context): Problem? = when {
        !has(app, Manifest.permission.ACCESS_FINE_LOCATION) -> Problem.PERMISSION
        // From the background a location service may only be created with "Allow all the time".
        visible == 0 && !has(app, Manifest.permission.ACCESS_BACKGROUND_LOCATION) -> Problem.BACKGROUND
        else -> null
    }

    /** Tell the server this phone is here and how it's going, and hear what's wanted.
     *  Blocking. At most once a minute unless [force]. Returns false if it didn't get through. */
    fun checkIn(context: Context, force: Boolean = false): Boolean {
        val app = context.applicationContext
        val status = TrackStatus(app)
        val now = System.currentTimeMillis()
        if (!force && now - status.checkedAt < 60_000L) return true
        if (Maps.server(app) == null) return false
        val running = TimelineService.running != null
        val body = JSONObject()
            .put("recording", running)
            .put("waiting", queue(app).size())
            .put("app", BuildConfig.VERSION_NAME)
        (if (running) status.sendProblem else status.problem)?.let { body.put("problem", it.code) }
        val (code, text) = try {
            Maps.post(app, "/api/maps/phone/checkin", body.toString(), timeoutSeconds = 20)
        } catch (e: Exception) {
            status.sendProblem = Problem.NO_SIGNAL
            return false
        }
        when (val sent = Sent.of(code)) {
            is Sent.Ok -> {
                val answer = runCatching { JSONObject(text) }.getOrNull() ?: return false
                status.checkedAt = now
                if (status.sendProblem == Problem.SIGNED_OUT || status.sendProblem == Problem.NO_SIGNAL || status.sendProblem == Problem.SERVER) status.sendProblem = null
                val until = answer.optString("until").takeIf { it.isNotBlank() && it != "null" }
                    ?.let { runCatching { java.time.OffsetDateTime.parse(it).toInstant().toEpochMilli() }.getOrNull() } ?: 0L
                status.setSharing(answer.optBoolean("sharing"), until)
                if (status.timeline && !answer.optBoolean("timeline_on", true)) {
                    // Paused from somewhere else: stop, and forget what was waiting.
                    status.timeline = false
                    queue(app).clear()
                }
            }
            Sent.SignedOut -> status.sendProblem = Problem.SIGNED_OUT
            is Sent.Later -> status.sendProblem = sent.problem
            // A server from before this existed: it learns of sharing the old way.
            Sent.Refused -> status.checkedAt = now
        }
        return code in 200..299
    }

    /** Send the timeline positions that are waiting. Blocking; safe from anywhere. */
    fun upload(context: Context): Flushed {
        val app = context.applicationContext
        val status = TrackStatus(app)
        val result = Uploader.flush(queue(app)) { rows ->
            if (Maps.server(app) == null) return@flush Sent.SignedOut
            val (code, text) = Maps.post(app, "/api/maps/timeline/points", TrackRows.body(rows), timeoutSeconds = 40)
            val sent = Sent.of(code)
            if (sent is Sent.Ok) Sent.Ok(timelineOn = runCatching { JSONObject(text).optBoolean("timeline_on", true) }.getOrDefault(true)) else sent
        }
        if (result.sent > 0) status.sentAt = System.currentTimeMillis()
        status.sendProblem = result.problem
        if (result.paused) status.timeline = false
        return result
    }

    /** Send one position to the people you share with. Blocking. Returns whether it got
     *  through; updates what's known about sharing from the answer. */
    fun sendLive(context: Context, lat: Double, lon: Double, speed: Float?): Boolean {
        val app = context.applicationContext
        val status = TrackStatus(app)
        if (Maps.server(app) == null) {
            status.sendProblem = Problem.SIGNED_OUT
            return false
        }
        val body = JSONObject().put("lat", lat).put("lon", lon)
        if (speed != null && speed.isFinite() && speed >= 0f) body.put("speed", speed.toDouble())
        val (code, text) = try {
            Maps.post(app, "/api/maps/live", body.toString(), timeoutSeconds = 20)
        } catch (e: Exception) {
            status.sendProblem = Problem.NO_SIGNAL
            return false
        }
        when (val sent = Sent.of(code)) {
            is Sent.Ok -> {
                val sharing = runCatching { JSONObject(text).optBoolean("sharing") }.getOrDefault(false)
                // Still sharing: until when is unchanged. Not: it ended.
                if (!sharing) status.setSharing(false) else if (!status.sharing) status.setSharing(true)
                if (sharing) status.liveAt = System.currentTimeMillis()
                if (status.sendProblem != null && queue(app).size() == 0) status.sendProblem = null
                return true
            }
            Sent.SignedOut -> status.sendProblem = Problem.SIGNED_OUT
            is Sent.Later -> status.sendProblem = sent.problem
            Sent.Refused -> Unit
        }
        return false
    }

    /** The newest position the phone already has, from any source. Costs nothing. */
    @SuppressLint("MissingPermission")
    fun lastKnown(context: Context): Location? {
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        return manager.allProviders
            .mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }
            .maxByOrNull { it.elapsedRealtimeNanos }
    }

    fun ageMs(at: Location): Long = ((SystemClock.elapsedRealtimeNanos() - at.elapsedRealtimeNanos) / 1_000_000L).coerceAtLeast(0)

    // ---- The beat: something that wakes the phone to send, even asleep ----------

    private fun beat(app: Context): PendingIntent = PendingIntent.getBroadcast(
        app, 7302, Intent(app, TimelineBootReceiver::class.java).setAction(ACTION_BEAT),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    /** The next wake-up: every three minutes while sharing (the heartbeat), five
     *  otherwise (is the service still there, is there anything to send?). Inexact, so it needs no permission;
     *  Android may hold it back a few minutes on a phone that's sound asleep. */
    fun scheduleBeat(app: Context, sharing: Boolean) {
        val alarms = app.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val wait = LiveBeat.wakeEvery(sharing)
        runCatching { alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + wait, beat(app)) }
    }

    private fun cancelBeat(app: Context) {
        runCatching { (app.getSystemService(Context.ALARM_SERVICE) as? AlarmManager)?.cancel(beat(app)) }
    }

    /** Whether Android has been told to leave this app alone in the background. With it,
     *  the service may be started again at any time, and the phone sends while asleep. */
    fun unrestricted(context: Context): Boolean =
        (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.isIgnoringBatteryOptimizations(context.packageName) == true

    /** Hold the phone awake for one short job (a send), however it ends. */
    fun <T> awake(context: Context, ms: Long, job: () -> T): T {
        val lock = runCatching {
            (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "promptly:location").apply { setReferenceCounted(false); acquire(ms) }
        }.getOrNull()
        try {
            return job()
        } finally {
            runCatching { lock?.takeIf { it.isHeld }?.release() }
        }
    }

    /** What the quarter-hourly check does when the service isn't running and can't be
     *  started: one position, sent to the people you share with and kept for the
     *  timeline. Far less than the service does, and far better than nothing. */
    @SuppressLint("MissingPermission")
    internal fun oneFix(app: Context, waitSeconds: Long = 25): Boolean {
        if (!has(app, Manifest.permission.ACCESS_FINE_LOCATION) || !has(app, Manifest.permission.ACCESS_BACKGROUND_LOCATION)) return false
        val status = TrackStatus(app)
        val at = lastKnown(app)?.takeIf { ageMs(it) <= 5 * 60_000L } ?: current(app, waitSeconds) ?: return false
        val now = System.currentTimeMillis()
        status.fixAt = now - ageMs(at)
        if (status.timeline && at.hasAccuracy() && at.accuracy <= TimelineService.KEEP_WITHIN_METRES) {
            TrackRows.row(TrackRows.fixTime(at.time, ageMs(at), now), at.latitude, at.longitude, at.accuracy, if (at.hasSpeed()) at.speed else null)?.let { queue(app).add(it) }
        }
        if (status.sharing && !Nav.onTrip()) sendLive(app, at.latitude, at.longitude, if (at.hasSpeed()) at.speed else null)
        return true
    }

    /** Ask the phone where it is now, and wait a little for an answer. */
    @SuppressLint("MissingPermission")
    internal fun current(app: Context, waitSeconds: Long): Location? {
        if (Build.VERSION.SDK_INT < 30) return null
        val manager = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val providers = manager.allProviders
        val provider = when {
            Build.VERSION.SDK_INT >= 31 && LocationManager.FUSED_PROVIDER in providers -> LocationManager.FUSED_PROVIDER
            LocationManager.GPS_PROVIDER in providers -> LocationManager.GPS_PROVIDER
            LocationManager.NETWORK_PROVIDER in providers -> LocationManager.NETWORK_PROVIDER
            else -> return null
        }
        val done = java.util.concurrent.CountDownLatch(1)
        var got: Location? = null
        val cancel = android.os.CancellationSignal()
        return try {
            manager.getCurrentLocation(provider, cancel, { it.run() }) { got = it; done.countDown() }
            done.await(waitSeconds, TimeUnit.SECONDS)
            got
        } catch (e: Exception) {
            null
        } finally {
            cancel.cancel()
        }
    }
}

/** How this build asks to run in the background: directly in the app from your own
 *  server, by way of Android's battery list in the Google Play one. */
fun backgroundAsk(): BackgroundAsk = BackgroundAsk.of(ownApk = BuildConfig.SELF_UPDATE)

/** Open it: the first of [BackgroundAsk.steps] that this phone will open. */
@SuppressLint("BatteryLife") // Only the own-server build has ASK, and only when the person taps.
fun BackgroundAsk.open(context: Context) = openBackgroundAsk(this, context)

/** The same, for callers outside this package. */
@SuppressLint("BatteryLife")
fun openBackgroundAsk(ask: BackgroundAsk, context: Context) {
    val pkg = android.net.Uri.parse("package:${context.packageName}")
    for (step in ask.steps()) {
        val intent = when (step) {
            BackgroundAsk.Step.ASK -> Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg)
            BackgroundAsk.Step.LIST -> Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            BackgroundAsk.Step.APP_SETTINGS -> Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
        }
        if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (runCatching { context.startActivity(intent) }.isSuccess) return
    }
}

/** Every quarter of an hour, and whenever Android gets round to it: is the service
 *  still there, is there anything waiting to send, has someone started a share? */
class LocationWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val app = applicationContext
        runCatching {
            if (Maps.server(app) == null) return@runCatching
            LocationKeeper.checkIn(app, force = true)
            if (!LocationKeeper.wanted(app)) return@runCatching
            val running = LocationKeeper.ensure(app)
            if (!running) LocationKeeper.oneFix(app)
            if (TrackStatus(app).timeline) LocationKeeper.upload(app)
            // So the server hears why, if it couldn't be started.
            if (!running) LocationKeeper.checkIn(app, force = true)
        }
        Result.success()
    }
}

/** The phone started, the app was updated, or it's time for a heartbeat: carry on. */
class TimelineBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> LocationKeeper.wake(app, ask = true)
            LocationKeeper.ACTION_BEAT -> {
                val service = TimelineService.running
                if (service != null) {
                    LocationKeeper.scheduleBeat(app, TrackStatus(app).sharing)
                    service.beat(woken = true)
                } else {
                    val pending = goAsync()
                    LocationKeeper.background {
                        try {
                            LocationKeeper.beatWithoutService(app)
                        } finally {
                            pending.finish()
                        }
                    }
                }
            }
        }
    }
}
