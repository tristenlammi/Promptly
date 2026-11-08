// The Google Play build is updated by Play, so it has no updater of its own and doesn't ask
// Android for permission to install apps. MainActivity never offers an update in this build
// (BuildConfig.SELF_UPDATE is false); this only keeps the shared code compiling.
package org.promptly.sync

import android.content.Context
import java.io.IOException

object Updater {
    fun installerPackage(@Suppress("UNUSED_PARAMETER") context: Context): String? = null

    fun downloadAndInstall(@Suppress("UNUSED_PARAMETER") context: Context, @Suppress("UNUSED_PARAMETER") update: Api.Update, @Suppress("UNUSED_PARAMETER") progress: (Long) -> Unit = {}): Nothing =
        throw IOException("Updates come from Google Play.")
}
