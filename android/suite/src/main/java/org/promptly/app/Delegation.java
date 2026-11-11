package org.promptly.app;

import android.app.Notification;
import android.content.Intent;
import android.util.Log;

import com.google.androidbrowserhelper.locationdelegation.LocationDelegationExtraCommandHandler;
import com.google.androidbrowserhelper.trusted.DelegationService;

/** What Chrome asks this app for on a page's behalf: notifications, and location.
 *  Chrome sends a page's location request here, so the app has to answer it.
 *  A call's ring (its tag holds {@code call:}) goes to {@link CallRings} first,
 *  which shows it as a real incoming call. */
public class Delegation extends DelegationService {
    private static final String TAG = "PromptlyDelegation";
    /** Told to the widgets (org.promptly.sync.widgets.WidgetEvents, in :app): a
     *  notification came, so refresh in a few seconds. Nothing happens without widgets. */
    static final String ACTION_NOTIFIED = "org.promptly.app.action.NOTIFIED";
    private static final String WIDGET_EVENTS = "org.promptly.sync.widgets.WidgetEvents";

    public Delegation() {
        registerExtraCommandHandler(new LocationDelegationExtraCommandHandler());
    }

    @Override
    public boolean onNotifyNotificationWithChannel(String platformTag, int platformId, Notification notification, String channelName) {
        tellWidgets();
        CallRings.Handler calls = CallRings.get();
        if (calls != null && platformTag != null && platformTag.contains("call:")) {
            try {
                if (calls.onNotify(this, platformTag, notification)) return true;
            } catch (RuntimeException e) {
                // Never lose the ring: Chrome's own notification instead.
                Log.w(TAG, "call notification", e);
            }
        }
        return super.onNotifyNotificationWithChannel(platformTag, platformId, notification, channelName);
    }

    /** An explicit broadcast to our own receiver (this module can't see :app's classes). */
    private void tellWidgets() {
        try {
            sendBroadcast(new Intent(ACTION_NOTIFIED).setClassName(getPackageName(), WIDGET_EVENTS));
        } catch (RuntimeException e) {
            // The widgets aren't in this build: nothing to tell.
        }
    }

    @Override
    public void onCancelNotification(String platformTag, int platformId) {
        super.onCancelNotification(platformTag, platformId);
        CallRings.Handler calls = CallRings.get();
        if (calls != null && platformTag != null && platformTag.contains("call:")) {
            try {
                calls.onCancel(this, platformTag);
            } catch (RuntimeException e) {
                Log.w(TAG, "call notification closed", e);
            }
        }
    }
}
