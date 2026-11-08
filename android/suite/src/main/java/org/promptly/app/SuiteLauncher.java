package org.promptly.app;

import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;

import com.google.androidbrowserhelper.trusted.LauncherActivity;

import java.lang.reflect.Field;

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
        String sep = path.contains("?") ? "&" : "?";
        return Uri.parse(Server.get(this) + path + sep + "source=android");
    }

    // ---- Share targets (Porch, WP-P1.7) ----------------------------------------
    // A launcher with METADATA_SHARE_TARGET (gen_suite.py SHARE_TARGETS) is in the
    // share sheet. The library hands Chrome the share target as written; Chrome
    // needs its action to be a full URL on the verified site, and the server is
    // only known here, at run time. So before launching, the action path gets
    // the saved server in front of it.

    @Override
    protected void launchTwa() {
        absoluteShareTarget();
        super.launchTwa();
    }

    private void absoluteShareTarget() {
        String server = Server.get(this);
        if (server == null) return;
        try {
            Field metaField = LauncherActivity.class.getDeclaredField("mMetadata");
            metaField.setAccessible(true);
            Object meta = metaField.get(this);
            if (meta == null) return;
            Field targetField = meta.getClass().getDeclaredField("shareTarget");
            targetField.setAccessible(true);
            String json = (String) targetField.get(meta);
            String fixed = withServer(json, server);
            if (fixed != null && !fixed.equals(json)) targetField.set(meta, fixed);
        } catch (ReflectiveOperationException | RuntimeException e) {
            // The page still opens; only the shared items don't come along.
            Log.w("SuiteLauncher", "Couldn't set the share target's server", e);
        }
    }

    /** The share target JSON with a relative {@code "action": "/path"} made absolute
     *  against {@code server} ("https://home.example"). Anything else is returned as is. */
    static String withServer(String json, String server) {
        if (json == null || server == null) return json;
        String base = server.endsWith("/") ? server.substring(0, server.length() - 1) : server;
        return json.replaceFirst("\"action\"\\s*:\\s*\"/(?!/)", "\"action\": \"" + java.util.regex.Matcher.quoteReplacement(base) + "/");
    }
}
