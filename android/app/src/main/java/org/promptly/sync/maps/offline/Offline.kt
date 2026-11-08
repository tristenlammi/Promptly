package org.promptly.sync.maps.offline

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.StatFs
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import org.promptly.sync.Api
import org.promptly.sync.maps.Maps
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Offline P Maps on this phone: settings, the download schedule, and what each
 *  area's state is. The work itself is [OfflineEngine], run by [OfflineDownloadWorker]. */
object Offline {
    private const val TAG = "PromptlyOffline"
    const val CHANNEL = "maps-offline"
    const val DOWNLOAD = "maps-offline-download"
    private const val DAILY = "maps-offline-daily"

    /** One lock for everything that changes the files: a download run, or a delete. */
    val lock = Mutex()

    private val _run = MutableStateFlow<OfflineEngine.Progress?>(null)
    /** The download running now, if any. */
    val run: StateFlow<OfflineEngine.Progress?> = _run

    /** Bumped whenever something the screen shows changes. */
    private val _changed = MutableStateFlow(0)
    val changed: StateFlow<Int> = _changed

    fun touched() {
        _changed.value = _changed.value + 1
    }

    internal fun progress(p: OfflineEngine.Progress?) {
        _run.value = p
    }

    @Volatile private var store: OfflineStore? = null

    fun store(context: Context): OfflineStore = store ?: synchronized(this) {
        store ?: OfflineStore(File(context.applicationContext.filesDir, "maps-offline")).also { store = it }
    }

    @Volatile private var router: LocalRouter? = null

    /** Offline directions from the downloaded squares (one engine for the app). */
    fun router(context: Context): LocalRouter = router ?: synchronized(this) {
        router ?: store(context).let { s -> LocalRouter(s, File(s.root, "valhalla.json")) }.also { router = it }
    }

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences("maps-offline", Context.MODE_PRIVATE)

    var Context.wifiOnly: Boolean
        get() = prefs(this).getBoolean("wifi_only", true)
        set(value) = prefs(this).edit().putBoolean("wifi_only", value).apply()

    var Context.autoUpdate: Boolean
        get() = prefs(this).getBoolean("auto_update", true)
        set(value) = prefs(this).edit().putBoolean("auto_update", value).apply()

    /** "Keep each trip's map for a week" (on): the map along each route started with
     *  signal is saved, so a dead spot never blanks the screen ([MapTiles.saveTrip]). */
    var Context.keepTripMaps: Boolean
        get() = prefs(this).getBoolean("keep_trip_maps", true)
        set(value) = prefs(this).edit().putBoolean("keep_trip_maps", value).apply()

    /** This phone, as the server's area list names it. Made once, kept. */
    fun deviceId(context: Context): String {
        val p = prefs(context)
        p.getString("device_id", null)?.let { return it }
        val id = "android-" + UUID.randomUUID().toString()
        p.edit().putString("device_id", id).apply()
        return id
    }

    /** The name this phone was paired under (what Files → Devices shows), for the web's area list. */
    fun deviceName(context: Context): String =
        org.promptly.sync.Store(context).account?.device?.takeIf { it.isNotBlank() } ?: Api.deviceName()

    fun api(context: Context): OfflineApi? {
        val server = Maps.server(context) ?: return null
        return OfflineApi(server, Maps.client(context, 30))
    }

    fun freeSpace(context: Context): Long = StatFs(context.applicationContext.filesDir.path).availableBytes

    // ---- What the server said last (so the screen works with no signal) -----------

    fun saved(context: Context): OfflineApi.Overview? {
        val file = File(store(context).root, "overview.json")
        val server = Maps.server(context) ?: return null
        val j = runCatching { JSONObject(file.readText()) }.getOrNull() ?: return null
        if (j.optString("server") != server) return null
        return runCatching { OfflineApi.parseOverview(j.getJSONObject("overview")) }.getOrNull()
    }

    private fun keep(context: Context, raw: JSONObject) {
        val root = store(context).root
        root.mkdirs()
        val tmp = File(root, "overview.json.new")
        tmp.writeText(JSONObject().put("server", Maps.server(context)).put("overview", raw).toString())
        tmp.renameTo(File(root, "overview.json"))
    }

    /** The server's list of your areas (and whether it has packs), saved for later.
     *  Areas deleted here while offline are deleted on the server first. */
    fun refresh(context: Context): OfflineApi.Overview {
        val api = api(context) ?: throw SignedOut()
        val store = store(context)
        val pending = store.state.deleted.toList()
        for (id in pending) {
            api.delete(id)
            store.state.deleted -= id
            store.save()
        }
        val raw = api.overviewJson()
        keep(context, raw)
        touched()
        return OfflineApi.parseOverview(raw)
    }

    /** What every area wants: square → with house numbers (if any area that has it wants them). */
    fun wanted(areas: List<OfflineApi.Area>, deleted: Set<String> = emptySet()): Map<String, Boolean> {
        val out = mutableMapOf<String, Boolean>()
        for (a in areas) {
            if (a.id in deleted) continue
            for (c in a.cells) out[c] = (out[c] ?: false) || a.withAddresses
        }
        return out
    }

    // ---- One download run ------------------------------------------------------

    /** Brings the phone up to date with your areas. Called by the workers, under [lock]. */
    suspend fun runSync(context: Context, stopped: () -> Boolean, onProgress: (OfflineEngine.Progress) -> Unit): OfflineApi.Overview = lock.withLock {
        val store = store(context)
        val api = api(context) ?: throw SignedOut()
        try {
            val overview = refresh(context)
            if (!overview.enabled) throw OffOnServer()
            if (!overview.ready) throw StillBuilding()
            val areas = overview.areas.filter { it.id !in store.state.deleted }
            val wanted = wanted(areas)
            val device = deviceId(context)
            val name = deviceName(context)
            // Tell the server (and the web's area list) what's starting.
            for (a in areas) {
                if (!store.has(a.cells, a.withAddresses) || store.state.syncedBuild != overview.build) {
                    runCatching { api.report(a.id, device, name, "downloading", store.state.syncedBuild, store.cellBytes(a.cells)) }
                }
            }
            if (wanted.isNotEmpty()) {
                runCatching { MapAssets.sync(api.server, store.assetsDir, Downloader.plain, stopped) }
                    .onFailure { if (it is Stopped) throw it else Log.w(TAG, "Map styles and fonts: ${it.message}") }
            }
            val engine = OfflineEngine(store, api, Downloader(), { freeSpace(context) }, stopped) { p ->
                progress(p)
                onProgress(p)
            }
            engine.sync(wanted)
            for (a in areas) {
                runCatching { api.report(a.id, device, name, "ready", store.state.syncedBuild, store.cellBytes(a.cells)) }
            }
            overview
        } catch (raised: Exception) {
            // The connection dropping because the run was stopped (Wi-Fi gone) is a stop, not a problem.
            val e = if (raised !is Stopped && raised is IOException && raised !is OfflineProblem && stopped()) Stopped() else raised
            val s = store.state
            when (e) {
                is Stopped -> Unit
                is NoSpace -> Unit
                is OfflineProblem -> s.problem = e.message
                is IOException -> s.problem = "Download stopped: no connection. It'll carry on by itself."
                else -> s.problem = "Something went wrong: ${e.message}. It'll try again later."
            }
            store.save()
            if (e !is Stopped) {
                val state = if (e is NoSpace) "no_space" else "failed"
                val areas = saved(context)?.areas.orEmpty()
                for (a in areas) {
                    if (!store.has(a.cells, a.withAddresses)) {
                        runCatching { api.report(a.id, deviceId(context), deviceName(context), state, store.state.syncedBuild, store.cellBytes(a.cells)) }
                    }
                }
            }
            throw e
        } finally {
            progress(null)
            touched()
        }
    }

    /** Deletes an area: on the server (or later, if it can't be reached now), and its
     *  squares that no other area keeps, right away. */
    suspend fun delete(context: Context, area: OfflineApi.Area) {
        WorkManager.getInstance(context).cancelUniqueWork(DOWNLOAD)
        lock.withLock {
            val store = store(context)
            store.state.deleted += area.id
            store.save()
            val others = saved(context)?.areas.orEmpty().filter { it.id != area.id && it.id !in store.state.deleted }
            store.prune(wanted(others))
            runCatching {
                api(context)?.delete(area.id)
                store.state.deleted -= area.id
                store.save()
                runCatching { refresh(context) }
            }
        }
        touched()
        if (saved(context)?.areas.orEmpty().any { !store(context).has(it.cells, it.withAddresses) }) download(context)
    }

    /** Removes, right away, what no area wants any more (an area deleted on the web,
     *  or house numbers left out there). True if anything went. */
    fun tidy(context: Context, overview: OfflineApi.Overview): Boolean {
        val store = store(context)
        val wanted = wanted(overview.areas, store.state.deleted)
        val s = store.state
        val stale = s.files.keys.any { key ->
            val (owner, kind) = key.split("/", limit = 2)
            owner != "base" && (owner !in wanted || (kind == "addresses" && wanted[owner] != true))
        } || s.routing.keys.any { it.substringBefore('/') != "l0" && it.substringBefore('/') !in wanted } ||
            (wanted.isEmpty() && (s.files.isNotEmpty() || s.routing.isNotEmpty()))
        if (!stale) return false
        // A download that's running tidies up when it next starts; don't wait for it here.
        if (!lock.tryLock()) return false
        try {
            store.prune(wanted)
        } finally {
            lock.unlock()
        }
        touched()
        return true
    }

    /** Leave house numbers out (or put them back) for an area. */
    suspend fun setAddresses(context: Context, area: OfflineApi.Area, with: Boolean) {
        val api = api(context) ?: throw SignedOut()
        api.edit(area.id, withAddresses = with)
        refresh(context)
        if (!with) {
            lock.withLock {
                val store = store(context)
                val areas = saved(context)?.areas.orEmpty().filter { it.id !in store.state.deleted }
                store.prune(wanted(areas))
            }
            touched()
        } else download(context)
    }

    // ---- Scheduling ------------------------------------------------------------

    fun channel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Offline maps", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shows while offline map areas download, and when they're ready"
            },
        )
    }

    /** Start (or carry on) downloading. [mobileData]: this once, even without Wi-Fi. */
    fun download(context: Context, mobileData: Boolean = false) {
        val network = if (mobileData || !context.wifiOnly) NetworkType.CONNECTED else NetworkType.UNMETERED
        val request = OneTimeWorkRequestBuilder<OfflineDownloadWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(network).setRequiresStorageNotLow(false).build())
            .setInputData(workDataOf("mobile" to mobileData))
            .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
            .addTag(DOWNLOAD)
            .build()
        // Asked for mobile data: replace a run that's waiting for Wi-Fi. Otherwise keep one that's going.
        WorkManager.getInstance(context).enqueueUniqueWork(DOWNLOAD, if (mobileData) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, request)
    }

    /** After a Wi-Fi setting change: the waiting run takes the new rule. */
    fun reschedule(context: Context) {
        val wm = WorkManager.getInstance(context)
        wm.cancelUniqueWork(DOWNLOAD)
        val any = saved(context)?.areas.orEmpty().isNotEmpty()
        if (any) download(context)
        daily(context)
    }

    /** Once a day on Wi-Fi (and charging, with Update automatically): areas made on the
     *  web and new map builds. */
    fun daily(context: Context) {
        val wm = WorkManager.getInstance(context)
        if (Maps.server(context) == null) return
        val c = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .setRequiresBatteryNotLow(true)
            .setRequiresCharging(context.autoUpdate)
            .build()
        wm.enqueueUniquePeriodicWork(
            DAILY, ExistingPeriodicWorkPolicy.UPDATE,
            PeriodicWorkRequestBuilder<OfflineSyncWorker>(1, TimeUnit.DAYS, 6, TimeUnit.HOURS).setConstraints(c).build(),
        )
    }

    /** Whether this phone is on a network that doesn't count against data (Wi-Fi). */
    fun onWifi(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    fun online(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}
