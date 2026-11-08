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
 *
 * <p>A widget opens a page of the app instead ({@link #EXTRA_URL_PATH}: an
 * event, a task), in the app's own task. Only a path on the saved server is
 * taken ({@link #safePath}), never another site.
 */
public class SuiteLauncher extends LauncherActivity {
    /** A path on the saved server to open instead of the launcher's own ("/calendar?event=…"). */
    public static final String EXTRA_URL_PATH = "org.promptly.app.URL_PATH";
    /** Told to the widgets (org.promptly.sync.widgets.WidgetEvents): refresh in a little while. */
    static final String ACTION_LAUNCHED = "org.promptly.app.action.LAUNCHED";
    private static final String WIDGET_EVENTS = "org.promptly.sync.widgets.WidgetEvents";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Server.get(this) == null) {
            startActivity(new Intent(this, SetupActivity.class)
                    .putExtra(SetupActivity.EXTRA_THEN, getComponentName().getClassName()));
            finish();
            return;
        }
        // The widgets refresh a couple of minutes after an app is opened (by then
        // you're likely back on the home screen). An explicit broadcast to our own
        // receiver; nothing happens when there are no widgets.
        try {
            sendBroadcast(new Intent(ACTION_LAUNCHED).setClassName(getPackageName(), WIDGET_EVENTS));
        } catch (RuntimeException ignored) {
            // The widgets aren't in this build: nothing to tell.
        }
    }

    @Override
    protected boolean shouldLaunchImmediately() {
        return Server.get(this) != null;
    }

    /**
     * {@code path} if it's a path on this server — starts with one "/", no
     * backslash (browsers read "/\evil" as "//evil"), no spaces or control
     * characters, not absurdly long — else null.
     */
    public static String safePath(String path) {
        if (path == null || path.isEmpty() || path.length() > 2000) return null;
        if (path.charAt(0) != '/' || path.startsWith("//")) return null;
        for (int i = 0; i < path.length(); i++) {
            char c = path.charAt(i);
            if (c == '\\' || c <= ' ' || c == 0x7f) return null;
        }
        return path;
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
        Intent intent = getIntent();
        String asked = intent == null ? null : safePath(intent.getStringExtra(EXTRA_URL_PATH));
        if (asked != null) path = asked;
        String sep = path.contains("?") ? "&" : "?";
        return Uri.parse(Server.get(this) + path + sep + "source=android");
    }
}
