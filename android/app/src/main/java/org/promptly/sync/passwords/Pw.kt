// Holds the one vault client for this process, its offline copy, its Keystore-wrapped
// secrets and the auto-lock timer. Every surface (the app, autofill, Credential Manager,
// the tile) goes through here, so unlocking in one unlocks them all and locking locks all.
package org.promptly.sync.passwords

import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import com.lambdapioneer.argon2kt.Argon2Kt
import com.lambdapioneer.argon2kt.Argon2Mode
import com.lambdapioneer.argon2kt.Argon2Version
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.promptly.sync.passwords.autofill.AssetLinks
import org.promptly.sync.passwords.autofill.AutofillIndex
import org.promptly.sync.passwords.core.Argon2Engine
import org.promptly.sync.passwords.core.BouncyCastleArgon2
import org.promptly.sync.passwords.core.BouncyCastleArgon2d
import org.promptly.sync.passwords.core.CachedAccount
import org.promptly.sync.passwords.core.CachedItem
import org.promptly.sync.passwords.core.CachedVault
import org.promptly.sync.passwords.core.Generator
import org.promptly.sync.passwords.core.LocalStore
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.Primitives
import org.promptly.sync.passwords.core.SecretKeeper
import org.promptly.sync.passwords.core.VaultApi
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.Wordlist
import org.promptly.sync.passwords.core.WrongAccountError
import org.promptly.sync.passwords.core.b64u
import org.promptly.sync.passwords.core.fromB64u
import org.promptly.sync.passwords.core.sameAccount
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Only for the device token, read by the alert check while the phone is locked, which the
 *  other key refuses to do. The token alone can't open anything: the vault needs its session. */
object AlertSeal {
    private const val ALIAS = "promptly_pw_alerts"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    fun seal(plain: ByteArray): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val ct = c.doFinal(plain)
        return b64u(c.iv) + ":" + b64u(ct)
    }

    fun open(sealed: String): ByteArray? = runCatching {
        val (iv, ct) = sealed.split(":", limit = 2)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, fromB64u(iv)))
        c.doFinal(fromB64u(ct))
    }.getOrNull()
}

/** A key in the Android Keystore, for secrets that must be usable without a prompt (so
 *  the app can ask for the master password) but useless off this phone. */
object DeviceSeal {
    private const val ALIAS = "promptly_pw_device"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        fun spec(unlocked: Boolean) = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .apply { if (unlocked) setUnlockedDeviceRequired(true) }
            .build()
        // Only while the phone itself is unlocked, where the hardware can promise that.
        return runCatching {
            gen.init(spec(true))
            gen.generateKey()
        }.getOrElse {
            gen.init(spec(false))
            gen.generateKey()
        }
    }

    fun seal(plain: ByteArray): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val ct = c.doFinal(plain)
        return b64u(c.iv) + ":" + b64u(ct)
    }

    fun open(sealed: String): ByteArray? = runCatching {
        val (iv, ct) = sealed.split(":", limit = 2)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, fromB64u(iv)))
        c.doFinal(fromB64u(ct))
    }.getOrNull()

    fun forget() {
        runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS) }
    }
}

/** The offline copy: SQLite holding only what the server holds (ciphertext, wrapped
 *  keys, bookkeeping), in the app's private directory with backups excluded. */
class PasswordsDb(context: Context) : SQLiteOpenHelper(context.applicationContext, "promptly_vault.db", null, 1), LocalStore {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
        db.execSQL("CREATE TABLE vaults (id TEXT PRIMARY KEY, v TEXT NOT NULL)")
        db.execSQL("CREATE TABLE items (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, v TEXT NOT NULL)")
        db.execSQL("CREATE INDEX items_vault ON items (vault_id)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    private fun parse(s: String) = Json.parseToJsonElement(s) as JsonObject

    override fun getMeta(key: String): JsonElement? =
        readableDatabase.query("meta", arrayOf("v"), "k=?", arrayOf(key), null, null, null).use { c ->
            if (c.moveToFirst()) Json.parseToJsonElement(c.getString(0)) else null
        }

    override fun setMeta(key: String, value: JsonElement) {
        writableDatabase.insertWithOnConflict("meta", null, ContentValues().apply { put("k", key); put("v", value.toString()) }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    override fun deleteMeta(key: String) {
        writableDatabase.delete("meta", "k=?", arrayOf(key))
    }

    override fun getAccount(): CachedAccount? = (getMeta("account") as? JsonObject)?.let { CachedAccount.from(it) }
    override fun putAccount(a: CachedAccount) = setMeta("account", a.toJson())

    override fun getVaults(): List<CachedVault> =
        readableDatabase.query("vaults", arrayOf("v"), null, null, null, null, null).use { c ->
            buildList { while (c.moveToNext()) add(CachedVault.from(parse(c.getString(0)))) }
        }

    override fun putVault(v: CachedVault) {
        writableDatabase.insertWithOnConflict("vaults", null, ContentValues().apply { put("id", v.id); put("v", v.toJson().toString()) }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    override fun deleteVault(id: String) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete("vaults", "id=?", arrayOf(id))
            db.delete("items", "vault_id=?", arrayOf(id))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    override fun getItems(vaultId: String): List<CachedItem> =
        readableDatabase.query("items", arrayOf("v"), "vault_id=?", arrayOf(vaultId), null, null, null).use { c ->
            buildList { while (c.moveToNext()) add(CachedItem.from(parse(c.getString(0)))) }
        }

    override fun getItem(id: String): CachedItem? =
        readableDatabase.query("items", arrayOf("v"), "id=?", arrayOf(id), null, null, null).use { c ->
            if (c.moveToFirst()) CachedItem.from(parse(c.getString(0))) else null
        }

    override fun putItems(items: List<CachedItem>) {
        if (items.isEmpty()) return
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (i in items) {
                db.insertWithOnConflict("items", null, ContentValues().apply {
                    put("id", i.id)
                    put("vault_id", i.vaultId)
                    put("v", i.toJson().toString())
                }, SQLiteDatabase.CONFLICT_REPLACE)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    override fun deleteItem(id: String) {
        writableDatabase.delete("items", "id=?", arrayOf(id))
    }

    override fun clear() {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete("meta", null, null)
            db.delete("vaults", null, null)
            db.delete("items", null, null)
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }
}

/** Settings on this device. Nothing here is a secret, except what's sealed. */
class PwPrefs(context: Context) {
    val prefs: SharedPreferences = context.applicationContext.getSharedPreferences("pw_prefs", Context.MODE_PRIVATE)

    var server: String?
        get() = prefs.getString("server", null)
        set(v) = prefs.edit().putString("server", v).apply()

    var deviceId: String?
        get() = prefs.getString("device_id", null)
        set(v) = prefs.edit().putString("device_id", v).apply()

    var deviceToken: String?
        get() = prefs.getString("device_token", null)?.let { DeviceSeal.open(it) }?.let { String(it) }
        set(v) = prefs.edit().putString("device_token", v?.let { DeviceSeal.seal(it.toByteArray()) }).apply()

    var alertToken: String?
        get() = prefs.getString("alert_token", null)?.let { AlertSeal.open(it) }?.let { String(it) }
        set(v) = prefs.edit().putString("alert_token", v?.let { AlertSeal.seal(it.toByteArray()) }).apply()

    /** Minutes of no use before the vault locks. 0 is as soon as you leave the app. */
    var autoLockMinutes: Int
        get() = prefs.getInt("auto_lock", 15)
        set(v) = prefs.edit().putInt("auto_lock", v).apply()

    var lockOnScreenOff: Boolean
        get() = prefs.getBoolean("lock_screen_off", true)
        set(v) = prefs.edit().putBoolean("lock_screen_off", v).apply()

    var clipboardSeconds: Int
        get() = prefs.getInt("clipboard_seconds", 30)
        set(v) = prefs.edit().putInt("clipboard_seconds", v).apply()

    /** Autofill's dropdown can show which account it would fill while the vault is locked. */
    var namesWhileLocked: Boolean
        get() = prefs.getBoolean("names_locked", true)
        set(v) = prefs.edit().putBoolean("names_locked", v).apply()

    var copyTotpAfterFill: Boolean
        get() = prefs.getBoolean("copy_totp", true)
        set(v) = prefs.edit().putBoolean("copy_totp", v).apply()

    var biometricBlob: String?
        get() = prefs.getString("bio_blob", null)
        set(v) = prefs.edit().putString("bio_blob", v).apply()

    var biometricIv: String?
        get() = prefs.getString("bio_iv", null)
        set(v) = prefs.edit().putString("bio_iv", v).apply()

    /** Sites where the person said never to offer saving. */
    var neverSave: Set<String>
        get() = prefs.getStringSet("never_save", emptySet())!!.toSet()
        set(v) = prefs.edit().putStringSet("never_save", v).apply()

    var recents: Map<String, Long>
        get() = prefs.getStringSet("recents", emptySet())!!.mapNotNull { e ->
            val at = e.indexOf('|')
            if (at <= 0) null else e.substring(0, at) to (e.substring(at + 1).toLongOrNull() ?: 0L)
        }.toMap()
        set(v) = prefs.edit().putStringSet("recents", v.entries.sortedByDescending { it.value }.take(200).map { "${it.key}|${it.value}" }.toSet()).apply()

    /** Finished or skipped: it's about this phone's settings, so it outlasts forgetting a vault. */
    var setupGuideDone: Boolean
        get() = prefs.getBoolean("setup_guide_done", false)
        set(v) = prefs.edit().putBoolean("setup_guide_done", v).apply()

    /** When this phone first opened the vault. The export reminder counts from here. */
    var exportSince: Long
        get() = prefs.getLong("export_since", 0)
        set(v) = prefs.edit().putLong("export_since", v).apply()

    /** The last encrypted export from this phone. A plain file doesn't count. */
    var exportLast: Long
        get() = prefs.getLong("export_last", 0)
        set(v) = prefs.edit().putLong("export_last", v).apply()

    var exportSnoozedUntil: Long
        get() = prefs.getLong("export_snoozed", 0)
        set(v) = prefs.edit().putLong("export_snoozed", v).apply()

    var exportNotifiedAt: Long
        get() = prefs.getLong("export_notified", 0)
        set(v) = prefs.edit().putLong("export_notified", v).apply()

    /** Whether autofill offers codes and sign-in links from Mail. Off unless turned on. */
    var mailCodes: Boolean
        get() = prefs.getBoolean("mail_codes", false)
        set(v) = prefs.edit().putBoolean("mail_codes", v).apply()

    /** Whether a Security check here posts its counts to the Today card. Off unless turned on. */
    var healthOptIn: Boolean
        get() = prefs.getBoolean("health_opt_in", false)
        set(v) = prefs.edit().putBoolean("health_opt_in", v).apply()

    fun forgetDevice() {
        val keep = prefs.getString("server", null)
        val guide = setupGuideDone
        prefs.edit().clear().putString("server", keep).putBoolean("setup_guide_done", guide).apply()
    }
}

/** Where a change-password run has got to. In memory, and it outlasts the vault locking, since going
 *  to the site's page is enough to lock it with "Lock after: Leaving". Only item ids. */
object ChangeQueue {
    @Volatile
    var ids: List<String> = emptyList()
        private set

    @Volatile
    var at = 0

    val active: Boolean get() = ids.isNotEmpty()

    fun start(list: List<String>) {
        ids = list
        at = 0
    }

    fun clear() {
        ids = emptyList()
        at = 0
    }
}

object Pw {
    private const val TAG = "PromptlyPasswords"

    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var clientInstance: VaultClient? = null

    /** Bumped when anything changes, so screens re-read. */
    val version = MutableStateFlow(0)

    /** Whether the vault's unlocked, for the app's own screens. */
    val unlockedFlow = MutableStateFlow(false)

    private val main = Handler(Looper.getMainLooper())
    private val lockRunnable = Runnable { if (expired()) lock("timer") else scheduleLock() }

    @Volatile
    private var lastUse = 0L

    @Volatile
    private var screenWatch: BroadcastReceiver? = null

    lateinit var prefs: PwPrefs
        private set

    lateinit var db: PasswordsDb
        private set

    /** Safe to call from anywhere, many times. */
    @Synchronized
    fun init(context: Context) {
        if (appContext != null) return
        val ctx = context.applicationContext
        appContext = ctx
        prefs = PwPrefs(ctx)
        db = PasswordsDb(ctx)
        Primitives.argon2Engine = chooseArgon2()
        Primitives.argon2dEngine = chooseArgon2d()
        fun asset(name: String) = ctx.assets.open("passwords/$name").use { it.readBytes().decodeToString() }
        Wordlist.loader = { asset("eff_large_wordlist.json") }
        Generator.rulesLoader = { asset("password-rules.json") }
        org.promptly.sync.passwords.core.PasswordChange.urlsLoader = { asset("change-password-URLs.json") }
        runCatching { Match.loadSharedCredentials(asset("shared-credentials.json")) }
    }

    /** argon2kt if its library loads and agrees with BouncyCastle on a small known input;
     *  BouncyCastle otherwise. A 16 KB page device could refuse the older library. */
    private fun chooseArgon2(): Argon2Engine {
        val native = nativeArgon2() ?: return BouncyCastleArgon2.also { Log.i(TAG, "Argon2: BouncyCastle (no native library)") }
        val probe = runCatching {
            val a = native.hash(byteArrayOf(1, 2, 3), ByteArray(16) { 7 }, 64, 1, 1, 32)
            val b = BouncyCastleArgon2.hash(byteArrayOf(1, 2, 3), ByteArray(16) { 7 }, 64, 1, 1, 32)
            a.contentEquals(b)
        }.getOrDefault(false)
        return if (probe) native else BouncyCastleArgon2.also { Log.w(TAG, "Argon2: native library disagreed or failed; using BouncyCastle") }
    }

    /** The same library and the same check. Only ever used to open a KeePass file. */
    private fun chooseArgon2d(): Argon2Engine {
        val native = nativeArgon2d() ?: return BouncyCastleArgon2d
        val agrees = runCatching {
            native.hash(byteArrayOf(1, 2, 3), ByteArray(16) { 7 }, 64, 1, 1, 32).contentEquals(BouncyCastleArgon2d.hash(byteArrayOf(1, 2, 3), ByteArray(16) { 7 }, 64, 1, 1, 32))
        }.getOrDefault(false)
        return if (agrees) native else BouncyCastleArgon2d
    }

    fun nativeArgon2d(): Argon2Engine? = runCatching {
        val lib = Argon2Kt()
        Argon2Engine { password, salt, m, t, p, length ->
            lib.hash(Argon2Mode.ARGON2_D, password, salt, t, m, p, length, Argon2Version.V13).rawHashAsByteArray()
        }
    }.getOrNull()

    fun nativeArgon2(): Argon2Engine? = runCatching {
        val lib = Argon2Kt()
        Argon2Engine { password, salt, m, t, p, length ->
            lib.hash(Argon2Mode.ARGON2_ID, password, salt, t, m, p, length, Argon2Version.V13).rawHashAsByteArray()
        }
    }.getOrNull()

    val connected: Boolean get() = prefs.server != null && prefs.deviceId != null

    /** The client for the saved server and device token, whether locked or not. */
    @Synchronized
    fun client(): VaultClient? {
        clientInstance?.let { return it }
        val server = prefs.server ?: return null
        if (prefs.deviceId == null) return null
        return newClient(server).also { clientInstance = it }
    }

    private fun newClient(server: String): VaultClient {
        val keeper = object : SecretKeeper {
            override fun save(raw: ByteArray) = prefs.prefs.edit().putString("secret_key", DeviceSeal.seal(raw)).apply()
            override fun load(): ByteArray? = prefs.prefs.getString("secret_key", null)?.let { DeviceSeal.open(it) }
            override fun has() = prefs.prefs.contains("secret_key")
            override fun clear() = prefs.prefs.edit().remove("secret_key").apply()
        }
        val api = VaultApi(server, { prefs.deviceToken })
        val c = VaultClient(api, db, keeper)
        c.onChange = {
            val ctx = appContext
            if (ctx != null && c.unlocked) AutofillIndex.rebuild(ctx, c)
            if (!c.unlocked) {
                AutofillIndex.forgetMemory()
                AssetLinks.forgetMemory()
                SiteIconCache.forgetMemory()
            }
            unlockedFlow.value = c.unlocked
            version.value = version.value + 1
        }
        return c
    }

    /** Set the moment a lock is asked for: the lock itself runs off the main thread. */
    @Volatile
    private var locking = false

    val unlocked: Boolean get() = !locking && clientInstance?.unlocked == true

    /** Save a device token for a server, and start over with a clean client. */
    @Synchronized
    fun connect(server: String, token: String, deviceId: String) {
        clientInstance?.let { if (it.unlocked) it.lock() }
        clientInstance = null
        prefs.server = server.trimEnd('/')
        prefs.deviceToken = token
        prefs.alertToken = token
        prefs.deviceId = deviceId
        appContext?.let { runCatching { AlertsCheck.schedule(it) } }
        version.value = version.value + 1
    }

    /** A new device token in place of this one, with the vault left as it is: to add a scope, which
     *  can't be done to a token that exists. The old one goes last, and if that can't be done right
     *  now it stays on the Devices list, where it can be removed. Someone else's token, as a browser
     *  signed in to another account would approve, changes nothing here and doesn't stay around. */
    fun replaceDevice(token: String, deviceId: String, userId: String?) {
        val server = prefs.server ?: return
        // From the store and not the session, since this can finish with the vault locked.
        if (!sameAccount(db.getAccount()?.userId, userId)) {
            runCatching { VaultApi(server, { token }).revokeDevice(deviceId) }
            throw WrongAccountError()
        }
        val oldToken = prefs.deviceToken
        val oldId = prefs.deviceId
        synchronized(this) {
            prefs.deviceToken = token
            prefs.alertToken = token
            prefs.deviceId = deviceId
        }
        // A session belongs to the device it was made for, so this one's finished.
        clientInstance?.let { c -> if (c.unlocked) runCatching { c.reprove() } }
        if (oldToken != null && oldId != null && oldId != deviceId) runCatching { VaultApi(server, { oldToken }).revokeDevice(oldId) }
        version.value = version.value + 1
    }

    /** The device token stopped working: ask for a new one, keeping everything else. */
    @Synchronized
    fun disconnect() {
        clientInstance = null
        prefs.deviceId = null
        prefs.deviceToken = null
        prefs.alertToken = null
        appContext?.let { runCatching { AlertsCheck.cancel(it) } }
        version.value = version.value + 1
    }

    /** This device's Secret Key isn't the current one any more. The token still works, and
     *  the offline copy is ciphertext it can't open: join again through the usual ways. */
    @Synchronized
    fun forgetSecretKey() {
        clientInstance?.keeper?.clear()
        Biometrics.forget()
        version.value = version.value + 1
    }

    /** Record use, restart the idle timer, and watch for the screen going off. */
    fun touch() {
        if (!unlocked) return
        lastUse = SystemClock.elapsedRealtime()
        scheduleLock()
        watchScreen()
    }

    private fun expired(): Boolean {
        val mins = prefs.autoLockMinutes
        if (mins < 0) return false
        // Not the wall clock, which anyone can set back. This one counts deep sleep too.
        return SystemClock.elapsedRealtime() - lastUse >= mins * 60_000L
    }

    private fun scheduleLock() {
        main.removeCallbacks(lockRunnable)
        val mins = prefs.autoLockMinutes
        if (mins > 0) main.postDelayed(lockRunnable, mins * 60_000L + 500)
    }

    /** Anything about to use the keys asks this first. The timer alone isn't enough: it
     *  doesn't tick while the phone's asleep. Past the limit? Lock. */
    fun lockIfExpired() {
        if (unlocked && expired()) lock("expired")
    }

    /** The app, or a fill it opened for another app, left the foreground. With "immediately",
     *  that's the end of the session. `graceMs` leaves time for a next step that's on its way. */
    fun onBackgrounded(graceMs: Long = 0) {
        if (!unlocked || prefs.autoLockMinutes != 0) return
        if (graceMs <= 0) {
            lock("background")
        } else {
            main.removeCallbacks(lockRunnable)
            main.postDelayed(lockRunnable, graceMs)
        }
    }

    fun lock(why: String = "user") {
        val c = clientInstance ?: return
        Log.i(TAG, "lock: $why")
        locking = true
        Thread {
            runCatching { c.lock() }
            locking = false
        }.start()
        main.removeCallbacks(lockRunnable)
        unlockedFlow.value = false
    }

    private fun watchScreen() {
        val ctx = appContext ?: return
        if (screenWatch != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == Intent.ACTION_SCREEN_OFF && prefs.lockOnScreenOff) lock("screen off")
            }
        }
        screenWatch = r
        val filter = IntentFilter(Intent.ACTION_SCREEN_OFF)
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED) else ctx.registerReceiver(r, filter)
    }

    fun markUsed(itemId: String) {
        val now = System.currentTimeMillis()
        prefs.recents = prefs.recents + (itemId to now)
    }

    /** For tests and "forget this device". */
    @Synchronized
    fun forgetDevice() {
        val ctx = appContext
        ChangeQueue.clear()
        clientInstance?.forgetDevice()
        clientInstance = null
        prefs.forgetDevice()
        Biometrics.forget()
        if (ctx != null) {
            AutofillIndex.clear(ctx)
            runCatching { AlertsCheck.cancel(ctx) }
        }
        unlockedFlow.value = false
        version.value = version.value + 1
    }

    /** Test seam: a client for another server address with no saved device. */
    fun clientForTests(): VaultClient = newClient(prefs.server ?: error("no server")).also { clientInstance = it }
}
