import { useEffect } from "react";

import { authApi } from "@/api/auth";
import { isServerUnavailable } from "@/api/client";
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

      // While the server is unreachable (restarting for an update), keep
      // retrying instead of showing the login page — the session is
      // probably fine, and the login page made it look like it wasn't.
      for (let attempt = 0; ; attempt++) {
        try {
          const user = await authApi.me();
          if (cancelled) return;
          setUser(user);
          setStatus("authenticated");
          return;
        } catch (err) {
          if (cancelled) return;
          // Retry what's temporary — a restart, a rate limit, a server
          // error — rather than show the login page for it (R-142).
          const statusCode = (err as { response?: { status?: number } })?.response?.status;
          const temporary =
            isServerUnavailable(err) || statusCode === 429 || (statusCode ?? 0) >= 500;
          if (!temporary) {
            setStatus("unauthenticated");
            return;
          }
          setStatus("reconnecting");
          await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** attempt)));
          if (cancelled) return;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [setStatus, setUser]);
}
