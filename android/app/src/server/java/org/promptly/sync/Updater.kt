// Updating the app (server build only: the Play build is updated by Play). This app holds
// passwords now, so an update is downloaded here, its SHA-256 checked against the server's
// Promptly.json (UpdateVerifier), and its signing key checked against this app's before
// Android's installer ever sees it. A mismatch is deleted and reported.
package org.promptly.sync

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException
import java.security.MessageDigest

object Updater {
    private fun signers(pm: PackageManager, archive: File?, pkg: String): Set<String>? = runCatching {
        val flags = PackageManager.GET_SIGNING_CERTIFICATES
        val info = if (archive != null) pm.getPackageArchiveInfo(archive.path, flags) else pm.getPackageInfo(pkg, flags)
        val s = info?.signingInfo ?: return null
        val list = if (s.hasMultipleSigners()) s.apkContentsSigners else s.signingCertificateHistory
        list.map { sig -> MessageDigest.getInstance("SHA-256").digest(sig.toByteArray()).joinToString("") { "%02x".format(it) } }.toSet()
    }.getOrNull()

    private const val APK_TYPE = "application/vnd.android.package-archive"

    /** The system's package installer, by package name. */
    fun installerPackage(context: Context): String? {
        val probe = Intent(Intent.ACTION_VIEW).setDataAndType(android.net.Uri.parse("content://${context.packageName}.updates/update.apk"), APK_TYPE)
        return context.packageManager.queryIntentActivities(probe, android.content.pm.PackageManager.MATCH_SYSTEM_ONLY).firstOrNull()?.activityInfo?.packageName
    }

    /** Blocking. Downloads, checks the hash and the signer, and starts Android's installer. */
    fun downloadAndInstall(context: Context, update: Api.Update, progress: (Long) -> Unit = {}) {
        val dest = File(context.cacheDir, "updates/Promptly-${update.code}.apk")
        UpdateVerifier.download(Api.http, update.url, update.sha256, dest, progress)
        val mine = signers(context.packageManager, null, context.packageName)
        val theirs = signers(context.packageManager, dest, context.packageName)
        if (mine == null || theirs == null || mine.intersect(theirs).isEmpty()) {
            dest.delete()
            throw IOException("That download isn't signed by the same key as this app, so it wasn't installed.")
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", dest)
        // Only the phone's own installer gets the file, not whatever else claims this type.
        val installer = installerPackage(context) ?: throw IOException("This phone has no system installer to hand that to.")
        val install = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, APK_TYPE)
            .setPackage(installer)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls()) {
            // Android sends the person through "allow from this source" when it opens.
        }
        context.startActivity(install)
    }
}
