// The smaller surfaces: Chrome's autofill setting, the Quick Settings tile, SMS codes.
package org.promptly.sync.passwords

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import androidx.fragment.app.FragmentActivity
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import org.promptly.sync.passwords.credentials.PromptlyCredentialProviderService
import org.promptly.sync.passwords.ui.PasswordsActivity

/** VERIFY_NOTES item 14: the documented setting, intent and content provider. Nothing here
 *  ever touches Chrome's first-run or changes a setting; it only reads, and opens the screen. */
object ChromeSetup {
    private val CHANNELS = listOf("com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary")

    fun label(pkg: String) = when (pkg) {
        "com.android.chrome" -> "Chrome"
        "com.chrome.beta" -> "Chrome Beta"
        "com.chrome.dev" -> "Chrome Dev"
        "com.chrome.canary" -> "Chrome Canary"
        else -> pkg
    }

    fun installedChannels(context: Context): List<String> = CHANNELS.filter {
        runCatching { context.packageManager.getPackageInfo(it, 0) }.isSuccess
    }

    /** True or false from Chrome's provider; null when it doesn't answer (older Chrome). */
    fun state(context: Context, pkg: String): Boolean? = runCatching {
        val uri = Uri.Builder().scheme("content").authority("$pkg.AutofillThirdPartyModeContentProvider").path("autofill_third_party_mode").build()
        context.contentResolver.query(uri, arrayOf("autofill_third_party_state"), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getInt(c.getColumnIndexOrThrow("autofill_third_party_state")) == 1 else null
        }
    }.getOrNull()

    fun open(context: Context, pkg: String) {
        val i = Intent(Intent.ACTION_APPLICATION_PREFERENCES)
            .addCategory(Intent.CATEGORY_DEFAULT)
            .addCategory(Intent.CATEGORY_APP_BROWSER)
            .addCategory(Intent.CATEGORY_PREFERENCE)
            .setPackage(pkg)
        runCatching { context.startActivity(i) }
    }

    /** Is our provider on? Android answers this itself: the settings behind it aren't readable by
     *  an app, so reading them only ever said no. */
    fun credentialProviderEnabled(context: Context): Boolean? {
        if (Build.VERSION.SDK_INT < 34) return null
        return runCatching {
            context.getSystemService(android.credentials.CredentialManager::class.java)
                .isEnabledCredentialProviderService(ComponentName(context, PromptlyCredentialProviderService::class.java))
        }.getOrDefault(false)
    }

    fun openCredentialSettings(context: Context) {
        if (Build.VERSION.SDK_INT < 34) return
        val pending = runCatching { androidx.credentials.CredentialManager.create(context).createSettingsPendingIntent() }.getOrNull()
        val sent = pending != null && runCatching { pending.send() }.isSuccess
        if (!sent) runCatching { context.startActivity(Intent("android.settings.CREDENTIAL_PROVIDER")) }
    }
}

/** Site icons, once fetched, for as long as the vault's open: which sites you asked about says
 *  which accounts you have, so they don't outlast a lock, and they're never written down. */
object SiteIconCache {
    private const val BIGGEST = 4096
    private const val SHOWN = 96
    private val known = HashMap<String, android.graphics.Bitmap?>()

    @Synchronized
    fun has(domain: String) = known.containsKey(domain)

    @Synchronized
    fun peek(domain: String) = known[domain]

    /** Blocking. A site with no icon is remembered. A server that can't be reached isn't. */
    fun load(client: org.promptly.sync.passwords.core.VaultClient, domain: String): android.graphics.Bitmap? {
        val bytes = try {
            client.api.icon(domain)
        } catch (e: org.promptly.sync.passwords.core.OfflineError) {
            return null
        } catch (e: org.promptly.sync.passwords.core.ApiError) {
            null
        }
        val image = bytes?.let { decode(it) }
        synchronized(this) { known[domain] = image }
        return image
    }

    /** Whatever the bytes say they are, nothing bigger than this gets as far as memory. */
    fun decode(bytes: ByteArray): android.graphics.Bitmap? = runCatching {
        val size = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, size)
        if (size.outWidth <= 0 || size.outHeight <= 0 || size.outWidth > BIGGEST || size.outHeight > BIGGEST) return@runCatching null
        var sample = 1
        while (maxOf(size.outWidth, size.outHeight) / (sample * 2) >= SHOWN) sample *= 2
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample })
    }.getOrNull()

    @Synchronized
    fun forgetMemory() = known.clear()
}

/** Quick Settings tile: shows locked or unlocked. Tapping while unlocked locks; tapping
 *  while locked opens the app to unlock. */
class PasswordsTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        Pw.init(this)
        Pw.lockIfExpired()
        val tile = qsTile ?: return
        tile.label = "Passwords"
        tile.state = if (Pw.unlocked) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        if (Build.VERSION.SDK_INT >= 29) tile.subtitle = if (Pw.unlocked) "Unlocked" else "Locked"
        tile.updateTile()
    }

    override fun onClick() {
        super.onClick()
        Pw.init(this)
        if (Pw.unlocked) {
            Pw.lock("tile")
            qsTile?.let {
                it.state = Tile.STATE_INACTIVE
                if (Build.VERSION.SDK_INT >= 29) it.subtitle = "Locked"
                it.updateTile()
            }
            return
        }
        val intent = Intent(this, PasswordsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
            startActivityAndCollapse(intent)
        }
    }
}

/** SMS User Consent (VERIFY_NOTES item 16): no SMS permission. Android asks the person to
 *  share one message, for five minutes after this starts. Only the code is kept. */
object SmsCode {
    private val CODE = Regex("(?<![0-9])([0-9]{4,8})(?![0-9])")

    fun extract(message: String): String? = CODE.find(message)?.groupValues?.get(1)

    fun start(activity: FragmentActivity, onDone: (Result<String>) -> Unit) {
        val launcher = activity.activityResultRegistry.register(
            "pw-sms-consent-${System.nanoTime()}",
            androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult(),
        ) { result ->
            val text = if (result.resultCode == Activity.RESULT_OK) result.data?.getStringExtra(SmsRetriever.EXTRA_SMS_MESSAGE) else null
            val code = text?.let { extract(it) }
            if (code != null) onDone(Result.success(code)) else onDone(Result.failure(IllegalStateException("No code from that message.")))
        }
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
                runCatching { activity.unregisterReceiver(this) }
                val extras = intent.extras
                @Suppress("DEPRECATION")
                val status = extras?.get(SmsRetriever.EXTRA_STATUS) as? Status
                when (status?.statusCode) {
                    CommonStatusCodes.SUCCESS -> {
                        @Suppress("DEPRECATION")
                        val consent = extras.getParcelable<Intent>(SmsRetriever.EXTRA_CONSENT_INTENT)
                        if (consent != null) launcher.launch(consent) else onDone(Result.failure(IllegalStateException("No message came.")))
                    }
                    CommonStatusCodes.TIMEOUT -> onDone(Result.failure(IllegalStateException("No message came within five minutes.")))
                    else -> onDone(Result.failure(IllegalStateException("Couldn't read messages.")))
                }
            }
        }
        val filter = IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION)
        // Google Play services is the only sender it accepts, by this permission.
        androidx.core.content.ContextCompat.registerReceiver(activity, receiver, filter, SmsRetriever.SEND_PERMISSION, null, androidx.core.content.ContextCompat.RECEIVER_EXPORTED)
        SmsRetriever.getClient(activity).startSmsUserConsent(null)
            .addOnFailureListener { e ->
                runCatching { activity.unregisterReceiver(receiver) }
                onDone(Result.failure(e))
            }
    }
}
