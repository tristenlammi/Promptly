// Updating the app. This app holds passwords now, so an update is downloaded here, its
// SHA-256 checked against the server's Promptly.json, and its signing key checked against
// this app's before Android's installer ever sees it. A mismatch is deleted and reported.
package org.promptly.sync

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.FileProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest

class UpdateHashMismatch : IOException("The download didn't match its checksum, so it wasn't installed.")

/** No Android in here, so the JVM tests run the real thing against a local HTTP server. */
object UpdateVerifier {
    private val SHA256 = Regex("^[0-9a-f]{64}$")

    /** A manifest with no usable hash means no update at all: fail closed. */
    fun validHash(raw: String?): String? = raw?.trim()?.lowercase()?.takeIf { SHA256.matches(it) }

    /** Streams to [dest] and hashes as it goes. On any mismatch [dest] is gone. */
    fun download(http: OkHttpClient, url: String, expectedSha256: String, dest: File, progress: (Long) -> Unit = {}) {
        val want = validHash(expectedSha256) ?: throw UpdateHashMismatch()
        dest.parentFile?.mkdirs()
        val part = File(dest.parentFile, dest.name + ".part")
        val md = MessageDigest.getInstance("SHA-256")
        try {
            http.newCall(Request.Builder().url(url).header("Cache-Control", "no-cache").build()).execute().use { r ->
                if (!r.isSuccessful) throw IOException("The download failed (${r.code}).")
                r.body.byteStream().use { input ->
                    part.outputStream().use { out ->
                        val buf = ByteArray(1 shl 16)
                        var total = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            md.update(buf, 0, n)
                            out.write(buf, 0, n)
                            total += n
                            progress(total)
                        }
                    }
                }
            }
            val got = md.digest().joinToString("") { "%02x".format(it) }
            // Not secret, but no reason to compare any other way.
            if (!MessageDigest.isEqual(got.toByteArray(), want.toByteArray())) throw UpdateHashMismatch()
            dest.delete()
            if (!part.renameTo(dest)) throw IOException("Couldn't save the download.")
        } finally {
            part.delete()
        }
    }
}

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
