import { useEffect } from "react";

import { authApi } from "@/api/auth";
import { useAuthStore } from "@/store/authStore";

/**
 * Runs once on app mount and decides which top-level screen to show:
 *
 *   1. Hit the public /auth/setup-status probe. If the DB has zero admins we
 *      flip to "needs_setup" and the router renders the setup wizard.
 *   2. Otherwise try /auth/me. Axios' 401 interceptor will first attempt a
 *      silent refresh using the HttpOnly refresh cookie before giving up.
 *   3. Anything else → "unauthenticated" and the router shows the login page.
 */
export function useAuthBootstrap() {
  const setUser = useAuthStore((s) => s.setUser);
  const setStatus = useAuthStore((s) => s.setStatus);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setStatus("loading");

      try {
        const { requires_setup } = await authApi.setupStatus();
        if (cancelled) return;
        if (requires_setup) {
          setStatus("needs_setup");
          return;
        }
      } catch {
        // If the probe itself errors out (network, 5xx) we fall through to
        // the /auth/me attempt below — treating it as "probably configured,
        // probably unauthenticated" is a safer default than locking the user
        // out of the setup wizard.
      }

      try {
        const user = await authApi.me();
        if (cancelled) return;
        setUser(user);
        setStatus("authenticated");
      } catch {
        if (cancelled) return;
        setStatus("unauthenticated");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [setStatus, setUser]);
}
