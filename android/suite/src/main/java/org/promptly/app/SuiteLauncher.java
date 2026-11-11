package org.promptly.app;

import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;

import java.io.File;

import com.google.androidbrowserhelper.trusted.LauncherActivity;

import java.lang.reflect.Field;

/**
 * One home-screen icon: opens the saved server at this launcher's path
 * (its {@code org.promptly.app.PATH} meta-data) as a Trusted Web Activity —
 * Promptly full screen in Chrome. Before a server is set up, it goes to
 * {@link SetupActivity} first and comes back here after.
 *
 * <p>A launcher with a native screen for no signal ({@link #offlineActivity()}, P Maps'
 * offline map) opens that instead when the phone has no working connection and
 * something to show offline, rather than a web page that can't load.
 *
 * <p>A launcher whose app starts on a native screen ({@link #nativeFirst()}, P Maps'
 * Drive map) opens that when its icon is tapped. Anything that asks for a page
 * (a place another app sent, a widget, "more" on the native screen) still gets the page.
 *
 * <p>A widget opens a page of the app instead ({@link #EXTRA_URL_PATH}: an
 * event, a task), in the app's own task. Only a path on the saved server is
 * taken ({@link #safePath}), never another site.
 */
public class SuiteLauncher extends LauncherActivity {
    /** Open the web app even if the phone says there's no connection (the offline
     *  screen's own "Open P Maps on the web"). */
    static final String EXTRA_ONLINE = "org.promptly.app.ONLINE";

    /** Notes widgets: a path on the saved server to open instead of the launcher's own ("/calendar?event=…"). */
    public static final String EXTRA_URL_PATH = "org.promptly.app.URL_PATH";
    /** Told to the widgets (org.promptly.sync.widgets.WidgetEvents): refresh in a little while. */
    static final String ACTION_LAUNCHED = "org.promptly.app.action.LAUNCHED";
    private static final String WIDGET_EVENTS = "org.promptly.sync.widgets.WidgetEvents";

    /** Told to the native screen: it was opened by a tap on the icon. */
    static final String EXTRA_FROM_ICON = "org.promptly.app.FROM_ICON";

    private boolean offlineInstead;
    private boolean nativeInstead;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        offlineInstead = Server.get(this) != null && offlineActivity() != null
                && (getIntent() == null || !getIntent().getBooleanExtra(EXTRA_ONLINE, false))
                && !online() && hasOfflineData();
        nativeInstead = !offlineInstead && Server.get(this) != null && nativeFirst()
                && offlineActivity() != null && iconTap(getIntent());
        super.onCreate(savedInstanceState);
        if (Server.get(this) == null) {
            startActivity(new Intent(this, SetupActivity.class)
                    .putExtra(SetupActivity.EXTRA_THEN, getComponentName().getClassName()));
            finish();
            return;
        } else if (offlineInstead) {
            Intent offline = new Intent(Intent.ACTION_VIEW).setClassName(getPackageName(), offlineActivity());
            String asked = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_PATH);
            if (asked != null) offline.putExtra(EXTRA_PATH, asked);
            startActivity(offline);
            finish();
        } else if (nativeInstead) {
            startActivity(new Intent(Intent.ACTION_VIEW).setClassName(getPackageName(), offlineActivity())
                    .putExtra(EXTRA_FROM_ICON, true));
            finish();
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
        return Server.get(this) != null && !offlineInstead && !nativeInstead;
    }

    /** Whether a tap on this launcher's icon opens its native screen
     *  ({@link #offlineActivity()}) rather than the web page. */
    protected boolean nativeFirst() {
        return false;
    }

    /** A plain tap on the icon: nobody asked for a page, a place or a share. */
    private static boolean iconTap(Intent intent) {
        return intent != null && Intent.ACTION_MAIN.equals(intent.getAction()) && intent.getData() == null
                && !intent.hasExtra(EXTRA_PATH) && !intent.hasExtra(EXTRA_URL_PATH)
                && !intent.getBooleanExtra(EXTRA_ONLINE, false);
    }

    /** The native screen (a class in the app module, named as a string: this module can't
     *  see it) to open with no connection, or null for none. */
    protected String offlineActivity() {
        return null;
    }

    /** Whether the phone has a connection Android has checked reaches the internet. */
    private boolean online() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (cm == null) return true;
        Network network = cm.getActiveNetwork();
        NetworkCapabilities caps = network == null ? null : cm.getNetworkCapabilities(network);
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }

    /** P Maps' offline data, laid out by the app module's OfflineStore and TripCache:
     *  a downloaded square's map, or this week's trip maps. */
    private boolean hasOfflineData() {
        File root = new File(getFilesDir(), "maps-offline");
        File[] cells = new File(root, "cells").listFiles();
        if (cells != null) {
            for (File cell : cells) {
                if (new File(cell, "map.pmtiles").isFile()) return true;
            }
        }
        String[] trips = new File(root, "trips").list();
        return trips != null && trips.length > 0;
    }

    /** A path on your server to open instead of this launcher's own, e.g. P Maps
     *  showing a place another app sent ("/maps?to=…"). Only ever a path: the
     *  server is always the one you set up. */
    static final String EXTRA_PATH = "org.promptly.app.OPEN_PATH";

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
        // A page a widget opens (Notes widgets: an event, a task, a note).
        String widgetPath = intent == null ? null : safePath(intent.getStringExtra(EXTRA_URL_PATH));
        // A path asked for by another app (P Maps' map links) or by the app itself
        // (the voice notification opens its channel). Paths on our own server only.
        String asked = intent == null ? null : intent.getStringExtra(EXTRA_PATH);
        if (widgetPath != null) {
            path = widgetPath;
        } else if (asked != null && asked.startsWith("/") && !asked.startsWith("//") && !asked.contains("\\")) {
            path = asked;
        }
        String sep = path.contains("?") ? "&" : "?";
        // caps=voice: this app can hold a voice channel in the background
        // (the page hands Join over to it, frontend/src/rtc/voice/androidApp.ts).
        // calls: this app rings DM calls itself, full screen (Calls WP-D3), so the
        // page gives its rings the answer token and leaves the ringing to it.
        // callout: Call / Video call on the page hands the call to this app too
        // (promptly://call/start, Calls WP-D5), with the phone's own camera.
        return Uri.parse(Server.get(this) + path + sep + "source=android&caps=voice,calls,callout");
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
