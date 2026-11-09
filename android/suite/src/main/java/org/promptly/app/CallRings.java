package org.promptly.app;

import android.app.Notification;
import android.content.Context;

/**
 * DM calls (Calls WP-D3): where {@link Delegation} hands a call push's
 * notification, before Chrome's own version is shown. The app module
 * ({@code org.promptly.sync.calls.CallCenter}) sets the handler when the app
 * starts; it turns a ring into a full-screen incoming call and stops it when
 * the call's answered elsewhere. Without a handler, Chrome's notification
 * shows as before.
 */
public final class CallRings {
    public interface Handler {
        /**
         * A notification from the site, by Chrome's tag for it. True when the
         * app has shown it its own way (or it needs no showing); false to show
         * Chrome's notification as usual.
         */
        boolean onNotify(Context context, String platformTag, Notification notification);

        /** The site closed a notification it showed. */
        void onCancel(Context context, String platformTag);
    }

    private static volatile Handler handler;

    private CallRings() {}

    public static void set(Handler h) {
        handler = h;
    }

    static Handler get() {
        return handler;
    }
}
