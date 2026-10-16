/**
 * Signing out — and making sure the next person on this browser starts clean
 * (R-030).
 *
 * Logout used to clear the auth store and navigate, nothing more. The next
 * person to sign in on the same browser saw the previous user's chat
 * titles (cached queries and stores survive a client-side navigation),
 * their unsent drafts (persisted in localStorage), and the device kept
 * receiving the previous user's push notifications, message previews
 * included.
 */
import { authApi } from "@/api/auth";
import { useAuthStore } from "@/store/authStore";

/** localStorage keys that hold one person's data (not device preferences
 *  like theme or note width, which stay). */
const USER_SCOPED_KEYS = [
  "promptly.composer-drafts",
  "promptly.model-selection",
  "promptly.chat-folders-ui",
  "promptly.autoCompact",
  "promptly.ws.contextBannerDismissed",
];
const USER_SCOPED_PREFIXES = ["promptly.ws.recents."];
const LAST_USER_KEY = "promptly.last-user";

function purgeUserData(): void {
  try {
    for (const k of USER_SCOPED_KEYS) localStorage.removeItem(k);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && USER_SCOPED_PREFIXES.some((p) => k.startsWith(p))) {
        localStorage.removeItem(k);
      }
    }
    localStorage.removeItem(LAST_USER_KEY);
  } catch {
    // Storage blocked (private mode) — nothing persisted to purge.
  }
}

/** Drop everything this tab knows about the signed-in user and start over
 *  at /login with a fresh page (so no cached query or store survives). */
export function resetToLogin(reason?: "mfa_disabled" | "everywhere"): void {
  useAuthStore.getState().clear();
  purgeUserData();
  window.location.replace(reason ? `/login?signed_out=${reason}` : "/login");
}

/** The Sidebar's "Log out": stop this device's notifications, end the
 *  session server-side, then reset. */
export async function logout(): Promise<void> {
  let endpoint: string | undefined;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    endpoint = sub?.endpoint;
    await sub?.unsubscribe();
  } catch {
    // No service worker / push here — nothing to stop.
  }
  try {
    await authApi.logout(endpoint);
  } catch {
    // The local reset below is the part that matters.
  }
  resetToLogin();
}

/** Call whenever a user is established (login, session restore). If a
 *  *different* person used this browser last without signing out, their
 *  saved drafts and choices were already loaded — purge and reload once. */
export function noteSignedInUser(userId: string): void {
  let previous: string | null = null;
  try {
    previous = localStorage.getItem(LAST_USER_KEY);
    localStorage.setItem(LAST_USER_KEY, userId);
  } catch {
    return;
  }
  if (previous && previous !== userId) {
    purgeUserData();
    try {
      localStorage.setItem(LAST_USER_KEY, userId);
    } catch {
      /* ignore */
    }
    window.location.reload();
  }
}
