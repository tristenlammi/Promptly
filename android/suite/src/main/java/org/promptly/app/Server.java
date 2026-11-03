package org.promptly.app;

import android.content.Context;
import android.net.Uri;

/** The Promptly server this phone uses — asked for once, kept in the app's prefs. */
final class Server {
    private static final String PREFS = "promptly";
    private static final String KEY = "server";

    private Server() {}

    /** The saved server's origin ("https://promptly.example.com"), or null before setup. */
    static String get(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null);
    }

    static void set(Context c, String origin) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, origin).apply();
    }

    /** "promptly.example.com/x" → "https://promptly.example.com"; null if it isn't an address. */
    static String normalise(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty()) return null;
        if (!s.contains("://")) s = "https://" + s;
        Uri u = Uri.parse(s);
        String scheme = u.getScheme();
        if (u.getHost() == null || u.getHost().isEmpty()) return null;
        if (!"https".equals(scheme) && !"http".equals(scheme)) return null;
        return scheme + "://" + u.getAuthority();
    }
}
