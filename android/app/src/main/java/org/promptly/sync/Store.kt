package org.promptly.sync

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Where this phone syncs to, and how. The app password is sealed with a
 *  key that never leaves the phone's keystore. */
class Store(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("sync", Context.MODE_PRIVATE)

    data class Account(val server: String, val username: String, val password: String, val device: String)

    var account: Account?
        get() {
            val server = prefs.getString("server", null) ?: return null
            val username = prefs.getString("username", null) ?: return null
            val sealed = prefs.getString("password", null) ?: return null
            val password = Vault.open(sealed) ?: return null
            return Account(server, username, password, prefs.getString("device", "") ?: "")
        }
        set(value) {
            prefs.edit().apply {
                if (value == null) {
                    remove("server"); remove("username"); remove("password"); remove("device")
                } else {
                    putString("server", value.server)
                    putString("username", value.username)
                    putString("password", Vault.seal(value.password))
                    putString("device", value.device)
                }
            }.apply()
        }

    /** MediaStore bucket ids to back up; null until they're first chosen. */
    var buckets: Set<String>?
        get() = if (prefs.contains("buckets")) prefs.getStringSet("buckets", emptySet())!!.toSet() else null
        set(value) {
            prefs.edit().apply {
                if (value == null) remove("buckets") else putStringSet("buckets", value)
                // Different folders: the next run looks at everything again.
                remove("scan_version"); remove("scan_generation")
            }.apply()
        }

    /** Where the last complete run left MediaStore (Android 11+): the next run
     *  only reads what changed since, instead of every photo on the phone. */
    var scanVersion: String?
        get() = prefs.getString("scan_version", null)
        set(value) = prefs.edit().putString("scan_version", value).apply()

    var scanGeneration: Long
        get() = prefs.getLong("scan_generation", -1)
        set(value) = prefs.edit().putLong("scan_generation", value).apply()

    /** Epoch ms of the last run that read every photo — done at least daily. */
    var lastFullScan: Long
        get() = prefs.getLong("last_full_scan", 0)
        set(value) = prefs.edit().putLong("last_full_scan", value).apply()

    var wifiOnly: Boolean
        get() = prefs.getBoolean("wifi_only", true)
        set(value) = prefs.edit().putBoolean("wifi_only", value).apply()

    var chargingOnly: Boolean
        get() = prefs.getBoolean("charging_only", false)
        set(value) = prefs.edit().putBoolean("charging_only", value).apply()

    /** Epoch ms of the last run that finished, and what went wrong, if anything. */
    var lastSync: Long
        get() = prefs.getLong("last_sync", 0)
        set(value) = prefs.edit().putLong("last_sync", value).apply()

    var lastError: String?
        get() = prefs.getString("last_error", null)
        set(value) = prefs.edit().putString("last_error", value).apply()

    /** The server said this phone's password is no longer good. */
    var unlinked: Boolean
        get() = prefs.getBoolean("unlinked", false)
        set(value) = prefs.edit().putBoolean("unlinked", value).apply()

    var scheduleVersion: Int
        get() = prefs.getInt("schedule_version", 0)
        set(value) = prefs.edit().putInt("schedule_version", value).apply()

    fun clear() = prefs.edit().clear().apply()
}

private object Vault {
    private const val ALIAS = "promptlysync"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    fun seal(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val ct = c.doFinal(plain.toByteArray())
        return b64(c.iv) + ":" + b64(ct)
    }

    fun open(sealed: String): String? = runCatching {
        val (iv, ct) = sealed.split(":", limit = 2)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, unb64(iv)))
        String(c.doFinal(unb64(ct)))
    }.getOrNull()

    private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)
    private fun unb64(s: String) = Base64.decode(s, Base64.NO_WRAP)
}
