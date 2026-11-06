// Biometric unlock (plan 3.5). The derived unlock and auth keys are sealed under a
// Keystore key that needs a strong biometric for every use and dies when a new biometric
// is enrolled. The master password never reaches the Keystore. Reprompt and passkey
// signing use `confirm`, which has to open what's sealed under that same key.
package org.promptly.sync.passwords

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import org.promptly.sync.passwords.core.b64u
import org.promptly.sync.passwords.core.fromB64u
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object Biometrics {
    private const val ALIAS = "promptly_pw_biometric"
    private const val STRONG = BiometricManager.Authenticators.BIOMETRIC_STRONG

    /** Can this phone do a strong biometric right now? */
    fun available(context: Context): Boolean =
        BiometricManager.from(context).canAuthenticate(STRONG) == BiometricManager.BIOMETRIC_SUCCESS

    val enrolled: Boolean get() = Pw.prefs.biometricBlob != null

    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun newKey(): SecretKey {
        store().deleteEntry(ALIAS)
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true)
                .apply {
                    if (Build.VERSION.SDK_INT >= 30) setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                    else @Suppress("DEPRECATION") setUserAuthenticationValidityDurationSeconds(-1)
                }
                .build(),
        )
        return gen.generateKey()
    }

    private fun prompt(activity: FragmentActivity, title: String, subtitle: String?, crypto: BiometricPrompt.CryptoObject?, onDone: (Result<BiometricPrompt.AuthenticationResult>) -> Unit) {
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .apply { if (subtitle != null) setSubtitle(subtitle) }
            .setNegativeButtonText("Use master password")
            .setAllowedAuthenticators(STRONG)
            .setConfirmationRequired(false)
            .build()
        val p = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onDone(Result.success(result))
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = onDone(Result.failure(Failed(errString.toString(), errorCode)))
        })
        if (crypto != null) p.authenticate(info, crypto) else p.authenticate(info)
    }

    class Failed(message: String, val code: Int) : Exception(message) {
        val cancelled: Boolean get() = code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_CANCELED
    }

    /** Biometrics changed since this was set up, so the key is gone: fall back and say so. */
    class Invalidated : Exception("Your fingerprints or face changed, so biometric unlock was turned off. Use your master password, then turn it on again.")

    /** After a master password unlock: wrap the derived keys behind a biometric. */
    fun enroll(activity: FragmentActivity, secret: ByteArray, onDone: (Result<Unit>) -> Unit) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        try {
            cipher.init(Cipher.ENCRYPT_MODE, newKey())
        } catch (e: Exception) {
            onDone(Result.failure(e))
            return
        }
        prompt(activity, "Turn on biometric unlock", "Confirm it's you", BiometricPrompt.CryptoObject(cipher)) { r ->
            onDone(r.mapCatching { res ->
                val c = res.cryptoObject?.cipher ?: error("No cipher")
                val blob = c.doFinal(secret)
                Pw.prefs.biometricIv = b64u(c.iv)
                Pw.prefs.biometricBlob = b64u(blob)
            })
        }
    }

    /** Hands the wrapped keys back to `onDone`. The caller passes them to the client. */
    fun unlock(activity: FragmentActivity, onDone: (Result<ByteArray>) -> Unit) = open(activity, "Unlock Passwords", null, onDone)

    private fun open(activity: FragmentActivity, title: String, subtitle: String?, onDone: (Result<ByteArray>) -> Unit) {
        val blob = Pw.prefs.biometricBlob
        val iv = Pw.prefs.biometricIv
        val key = runCatching { store().getKey(ALIAS, null) as? SecretKey }.getOrNull()
        if (blob == null || iv == null || key == null) {
            forget()
            onDone(Result.failure(Invalidated()))
            return
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        try {
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, fromB64u(iv)))
        } catch (e: KeyPermanentlyInvalidatedException) {
            forget()
            onDone(Result.failure(Invalidated()))
            return
        } catch (e: Exception) {
            onDone(Result.failure(e))
            return
        }
        prompt(activity, title, subtitle, BiometricPrompt.CryptoObject(cipher)) { r ->
            onDone(r.mapCatching { res -> (res.cryptoObject?.cipher ?: error("No cipher")).doFinal(fromB64u(blob)) })
        }
    }

    /** For "reprompt" items and before signing a passkey. Not just a callback: the answer has
     *  to open what's sealed under the key, which dies when a new fingerprint's enrolled. */
    fun confirm(activity: FragmentActivity, title: String, subtitle: String?, onDone: (Result<Unit>) -> Unit) {
        open(activity, title, subtitle) { r ->
            onDone(r.map { it.fill(0) })
        }
    }

    fun forget() {
        Pw.prefs.biometricBlob = null
        Pw.prefs.biometricIv = null
        runCatching { store().deleteEntry(ALIAS) }
    }
}
