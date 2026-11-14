package org.promptly.sync.push

import android.content.Context
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.promptly.sync.Api
import org.promptly.sync.BuildConfig
import org.promptly.sync.Store
import org.promptly.sync.maps.Maps
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Notifications shown by this app itself: "Promptly", its icon, its own
 * channels. No browser in between, and nothing for the server's owner to set up.
 *
 * The server already sends standard Web Push (encrypted to each device, signed
 * with its own VAPID key). Google's push service takes exactly that for an
 * Android app too, so this phone registers with it using the server's public
 * key (the UnifiedPush library's embedded FCM distributor: no Firebase project,
 * no shared secret) and gives the server the address and keys it gets back,
 * the same three values a browser would. The library decrypts what arrives.
 *
 * Needs the phone to be linked (its app password, [Store.account]) and Google
 * Play services. Without either, nothing here runs and the browser's own
 * notifications carry on as before.
 */
object NativePush {
    const val TAG = "PromptlyPush"
    private const val PREFS = "push"
    private const val KEY_ENDPOINT = "endpoint"
    private const val KEY_SERVER = "server"
    private const val KEY_VAPID = "vapid"
    private const val KEY_AT = "registered_at"
    private const val KEY_SENT = "sent"
    private const val KEY_VERSION = "version"

    /** Ask Google's push service again this often, in case the address moved. */
    private val AGAIN_MS = TimeUnit.HOURS.toMillis(24)
    private val JSON = "application/json".toMediaType()
    private val io = Executors.newSingleThreadExecutor()

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** This phone shows Promptly's notifications itself (the server has its address). */
    fun active(context: Context): Boolean = prefs(context).getBoolean(KEY_SENT, false)

    /** Android lets this app show notifications at all (its permission, its master switch). */
    fun allowed(context: Context): Boolean =
        context.getSystemService(android.app.NotificationManager::class.java)?.areNotificationsEnabled() == true

    /** Register, if this phone is linked. Cheap to call often: it only talks to
     *  anything once a day, or when the server changed. */
    fun start(context: Context, force: Boolean = false) {
        val app = context.applicationContext
        if (!Store(app).hasAccount) return
        io.execute {
            try {
                register(app, force)
            } catch (e: Exception) {
                Log.w(TAG, "register: ${e.message}")
            }
        }
    }

    private fun register(app: Context, force: Boolean) {
        val account = Store(app).account ?: return
        val p = prefs(app)
        if (!allowed(app)) {
            // Android won't show anything from this app: don't take the phone's
            // notifications over from the browser (and hand them back if we had).
            Log.i(TAG, "notifications are off for the app: the browser's stay")
            if (p.getBoolean(KEY_SENT, false)) {
                UnifiedPush.unregister(app)
                gone(app)
            }
            return
        }
        // An updated app tells the server straight away: what it's sent
        // (a silent "clear", say) depends on the version it knows.
        val fresh = p.getString(KEY_SERVER, null) == account.server && p.getBoolean(KEY_SENT, false) &&
            p.getString(KEY_VERSION, null) == BuildConfig.VERSION_NAME &&
            System.currentTimeMillis() - p.getLong(KEY_AT, 0) < AGAIN_MS
        if (fresh && !force) return
        if (!playServices(app)) {
            Log.i(TAG, "no Google Play services: the browser's notifications stay")
            return
        }
        // The server's public key: what Google ties this registration to, so only
        // this server can send to it.
        val req = Request.Builder().url("${account.server}/api/notifications/public-key").build()
        val key = Api.http.newCall(req).execute().use { r ->
            if (!r.isSuccessful) throw IllegalStateException("public key: ${r.code}")
            JSONObject(r.body.string()).getString("public_key").trim().trimEnd('=')
        }
        if (p.getString(KEY_SERVER, null) != account.server || p.getString(KEY_VAPID, null) != key) {
            // Another server, or its key changed: the old registration is no use.
            p.edit().remove(KEY_SENT).putString(KEY_SERVER, account.server).putString(KEY_VAPID, key).apply()
        }
        // Always this app's own built-in distributor, never another app's
        // (a phone may have one installed for something else).
        UnifiedPush.saveDistributor(app, app.packageName)
        UnifiedPush.register(app, messageForDistributor = "Promptly", vapid = key)
        Log.i(TAG, "asked Google's push service for an address")
    }

    private fun playServices(context: Context): Boolean = try {
        context.packageManager.getPackageInfo("com.google.android.gms", 0)
        true
    } catch (e: Exception) {
        false
    }

    /** Google gave (or changed) this phone's address: tell the server. */
    internal fun endpoint(context: Context, endpoint: PushEndpoint) {
        val app = context.applicationContext
        val keys = endpoint.pubKeySet
        if (keys == null) {
            Log.w(TAG, "address without keys: ignored")
            return
        }
        val p = prefs(app)
        val before = p.getString(KEY_ENDPOINT, null)
        val body = JSONObject()
            .put("endpoint", endpoint.url)
            .put("keys", JSONObject().put("p256dh", keys.pubKey).put("auth", keys.auth))
            .put("device", Api.deviceName())
            .put("version", BuildConfig.VERSION_NAME)
            .put("install", install(app))
        if (before != null && before != endpoint.url) body.put("replaces", before)
        try {
            Maps.send(app, "POST", "/api/notifications/native", body, timeoutSeconds = 30)
            p.edit().putString(KEY_ENDPOINT, endpoint.url).putBoolean(KEY_SENT, true)
                .putString(KEY_VERSION, BuildConfig.VERSION_NAME)
                .putLong(KEY_AT, System.currentTimeMillis()).apply()
            Log.i(TAG, "the server has this phone's address")
        } catch (e: Exception) {
            // Tried again the next time the app starts.
            p.edit().remove(KEY_SENT).apply()
            Log.w(TAG, "couldn't tell the server: ${e.message}")
        }
    }

    /** Which phone this is, for the server to replace this phone's old row after a
     *  reinstall: 12 hex characters derived from Android's per-app device id
     *  (the same after reinstalling, different for every app and phone). */
    private fun install(app: Context): String = try {
        val id = android.provider.Settings.Secure.getString(app.contentResolver, android.provider.Settings.Secure.ANDROID_ID).orEmpty()
        java.security.MessageDigest.getInstance("SHA-256").digest("promptly-push:$id".toByteArray())
            .joinToString("") { "%02x".format(it) }.take(12)
    } catch (e: Exception) {
        ""
    }

    /** Google dropped the registration: the server needn't keep trying it. */
    internal fun gone(context: Context) {
        val app = context.applicationContext
        val p = prefs(app)
        val was = p.getString(KEY_ENDPOINT, null)
        p.edit().remove(KEY_SENT).remove(KEY_ENDPOINT).remove(KEY_AT).apply()
        if (was == null) return
        try {
            val server = Store(app).account?.server ?: return
            val req = Request.Builder().url("$server/api/notifications/native/gone")
                .post(JSONObject().put("endpoint", was).toString().toRequestBody(JSON)).build()
            Maps.client(app, 20).newCall(req).execute().close()
        } catch (e: Exception) {
            Log.w(TAG, "couldn't tell the server it's gone: ${e.message}")
        }
    }

    internal fun failed(context: Context) {
        prefs(context).edit().remove(KEY_AT).apply()
    }
}

/** Where the library hands what Google's push service sends this app. */
class PromptlyPushService : PushService() {
    private val io = Executors.newSingleThreadExecutor()

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val app = applicationContext
        io.execute { NativePush.endpoint(app, endpoint) }
    }

    override fun onMessage(message: PushMessage, instance: String) {
        if (!message.decrypted) {
            Log.w(NativePush.TAG, "a push that couldn't be decrypted: dropped")
            return
        }
        val app = applicationContext
        val text = String(message.content, Charsets.UTF_8)
        io.execute {
            try {
                PushNotes.show(app, PushPayload.parse(text))
            } catch (e: Exception) {
                Log.w(NativePush.TAG, "showing a push: ${e.message}")
            }
        }
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        Log.w(NativePush.TAG, "registration failed: $reason")
        NativePush.failed(applicationContext)
    }

    override fun onUnregistered(instance: String) {
        val app = applicationContext
        io.execute { NativePush.gone(app) }
    }
}
