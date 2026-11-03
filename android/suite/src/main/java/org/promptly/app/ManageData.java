package org.promptly.app;

import android.net.Uri;

import com.google.androidbrowserhelper.trusted.ManageDataLauncherActivity;

/** Settings → Storage → "Manage space": the saved server's site data in Chrome. */
public class ManageData extends ManageDataLauncherActivity {
    @Override
    protected Uri getDefaultUrlForManagingSpace() {
        String server = Server.get(this);
        return server == null ? null : Uri.parse(server + "/");
    }
}
