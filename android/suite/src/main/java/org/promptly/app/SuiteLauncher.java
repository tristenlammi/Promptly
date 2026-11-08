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

    @Override
    protected Uri getLaunchingUrl() {
        String path = "/";
        try {
            ActivityInfo info = getPackageManager().getActivityInfo(getComponentName(), PackageManager.GET_META_DATA);
            if (info.metaData != null) path = info.metaData.getString("org.promptly.app.PATH", "/");
        } catch (PackageManager.NameNotFoundException ignored) {
            // Can't happen for our own activity; "/" is a fine fallback.
        }
        // A page inside this launcher's app, from the app itself (the voice
        // notification opens its channel). Paths on our own server only.
        String open = getIntent() != null ? getIntent().getStringExtra(EXTRA_OPEN_PATH) : null;
        if (open != null && open.startsWith("/") && !open.startsWith("//") && !open.contains("\\")) path = open;
        String sep = path.contains("?") ? "&" : "?";
        // caps=voice: this app can hold a voice channel in the background
        // (the page hands Join over to it, frontend/src/rtc/voice/androidApp.ts).
        // calls: this app rings DM calls itself, full screen (Calls WP-D3), so the
        // page gives its rings the answer token and leaves the ringing to it.
        // callout: Call / Video call on the page hands the call to this app too
        // (promptly://call/start, Calls WP-D5), with the phone's own camera.
        return Uri.parse(Server.get(this) + path + sep + "source=android&caps=voice,calls,callout");
    }

    /** A path to open instead of the launcher's own (see getLaunchingUrl). */
    public static final String EXTRA_OPEN_PATH = "org.promptly.app.OPEN_PATH";
}
