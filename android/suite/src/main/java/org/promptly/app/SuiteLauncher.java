package org.promptly.app;

import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;

import com.google.androidbrowserhelper.trusted.LauncherActivity;

/**
 * One home-screen icon: opens the saved server at this launcher's path
 * (its {@code org.promptly.app.PATH} meta-data) as a Trusted Web Activity —
 * Promptly full screen in Chrome. Before a server is set up, it goes to
 * {@link SetupActivity} first and comes back here after.
 */
public class SuiteLauncher extends LauncherActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Server.get(this) == null) {
            startActivity(new Intent(this, SetupActivity.class)
                    .putExtra(SetupActivity.EXTRA_THEN, getComponentName().getClassName()));
            finish();
        }
    }

    @Override
    protected boolean shouldLaunchImmediately() {
        return Server.get(this) != null;
    }

    /** A path on your server to open instead of this launcher's own, e.g. P Maps
     *  showing a place another app sent ("/maps?to=…"). Only ever a path: the
     *  server is always the one you set up. */
    static final String EXTRA_PATH = "org.promptly.app.OPEN_PATH";

    @Override
    protected Uri getLaunchingUrl() {
        String path = "/";
        try {
            ActivityInfo info = getPackageManager().getActivityInfo(getComponentName(), PackageManager.GET_META_DATA);
            if (info.metaData != null) path = info.metaData.getString("org.promptly.app.PATH", "/");
        } catch (PackageManager.NameNotFoundException ignored) {
            // Can't happen for our own activity; "/" is a fine fallback.
        }
        String asked = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_PATH);
        if (asked != null && asked.startsWith("/") && !asked.startsWith("//") && !asked.contains("\\")) path = asked;
        String sep = path.contains("?") ? "&" : "?";
        return Uri.parse(Server.get(this) + path + sep + "source=android");
    }
}
