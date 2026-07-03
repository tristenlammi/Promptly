import { useEffect } from "react";
import { useAuth } from "@clerk/clerk-react";

import { authApi } from "@/api/auth";
import { setClerkSignOut, setClerkTokenGetter } from "@/api/client";
import { useAuthStore } from "@/store/authStore";

/**
 * Drives the app's auth state from Clerk when ``AUTH_PROVIDER=clerk``. Rendered
 * once, inside ``<ClerkProvider>``, only in Clerk mode. Renders nothing.
 *
 * Responsibilities:
 *  1. Register Clerk's ``getToken`` / ``signOut`` with the axios client so
 *     every existing API call carries a fresh Clerk session token and logout
 *     ends the Clerk session.
 *  2. Reflect Clerk's signed-in state into ``authStore`` (the store the rest of
 *     the app already reads): signed in → load /auth/me → "authenticated";
 *     signed out → "unauthenticated" (App renders the Clerk sign-in page).
 *
 * This replaces ``useAuthBootstrap`` in Clerk mode (that hook no-ops here).
 */
export function ClerkBridge() {
  const { isLoaded, isSignedIn, getToken, signOut } = useAuth();
  const setUser = useAuthStore((s) => s.setUser);
  const setStatus = useAuthStore((s) => s.setStatus);
  const setAccessToken = useAuthStore((s) => s.setAccessToken);

  // Wire the token source + sign-out into the API client.
  useEffect(() => {
    setClerkTokenGetter((opts) => getToken(opts).catch(() => null));
    setClerkSignOut(() => signOut());
    return () => {
      setClerkTokenGetter(null);
      setClerkSignOut(null);
    };
  }, [getToken, signOut]);

  // Mirror Clerk session state → authStore.
  useEffect(() => {
    if (!isLoaded) {
      setStatus("loading");
      return;
    }
    let cancelled = false;
    (async () => {
      if (!isSignedIn) {
        setUser(null);
        setAccessToken(null);
        setStatus("unauthenticated");
        return;
      }
      setStatus("loading");
      try {
        const token = await getToken();
        setAccessToken(token ?? null);
        const user = await authApi.me();
        if (cancelled) return;
        setUser(user);
        setStatus("authenticated");
      } catch {
        // Token verify / provisioning failed backend-side — treat as signed
        // out so the user isn't stuck on a spinner.
        if (!cancelled) setStatus("unauthenticated");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, getToken, setUser, setStatus, setAccessToken]);

  return null;
}
