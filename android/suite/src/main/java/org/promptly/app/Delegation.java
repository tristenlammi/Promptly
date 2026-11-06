package org.promptly.app;

import com.google.androidbrowserhelper.locationdelegation.LocationDelegationExtraCommandHandler;
import com.google.androidbrowserhelper.trusted.DelegationService;

/** What Chrome asks this app for on a page's behalf: notifications, and location.
 *  Chrome sends a page's location request here, so the app has to answer it. */
public class Delegation extends DelegationService {
    public Delegation() {
        registerExtraCommandHandler(new LocationDelegationExtraCommandHandler());
    }
}
