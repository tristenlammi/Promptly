import { create } from "zustand";

import type { MfaMethod, User, UserSettings } from "@/api/types";

export type AuthStatus =
  | "idle"
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "needs_setup"
  // The user has completed the password step but still owes us a
  // second factor. App-level routing redirects them to a verify page
  // until ``pendingMfa`` is resolved (verified or cleared on cancel).
  | "mfa_required"
  // The user has completed the password step but the global
  // ``mfa_required`` setting is on and they have no method enrolled
  // yet. They get walked through the enrollment wizard before being
  // granted real session tokens.
  | "mfa_enrollment_required";

/** State carried between the password step and the second-factor step.
 *
 * Held in memory only — the JWT inside is short-lived (10 minutes by
 * default) and we don't want it surviving a tab close. If the user
 * refreshes mid-flow they fall back to the login page, which is the
 * safest behaviour.
 */
export type PendingMfa =
  | {
      kind: "challenge";
      token: string;
      method: MfaMethod;
      emailHint: string | null;
      expiresAt: number;
    }
  | {
      kind: "enrollment";
      token: string;
      expiresAt: number;
    };

interface AuthState {
  user: User | null;
  accessToken: string | null;
  status: AuthStatus;
  pendingMfa: PendingMfa | null;
  setUser: (user: User | null) => void;
  setAccessToken: (token: string | null) => void;
  setStatus: (status: AuthStatus) => void;
  setPendingMfa: (mfa: PendingMfa | null) => void;
  /** Optimistically merge keys into the cached user's ``settings``.
   *
   * Used by the in-chat Tools / Web toggles and the preferences panel
   * so the UI updates instantly while the PATCH is in-flight. The
   * server's response (a fresh ``User``) overwrites this on success
   * via ``setUser``; if the request fails the caller is responsible
   * for rolling back.
   */
  patchSettings: (patch: Partial<UserSettings>) => void;
  /** Convenience: log in successfully — set user, token, status, clear MFA. */
  loginSuccess: (user: User, accessToken: string) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  status: "idle",
  pendingMfa: null,
  setUser: (user) => set({ user }),
  setAccessToken: (accessToken) => set({ accessToken }),
  setStatus: (status) => set({ status }),
  setPendingMfa: (pendingMfa) => set({ pendingMfa }),
  patchSettings: (patch) =>
    set((state) =>
      state.user
        ? {
            user: {
              ...state.user,
              settings: { ...state.user.settings, ...patch },
            },
          }
        : state
    ),
  loginSuccess: (user, accessToken) =>
    set({
      user,
      accessToken,
      status: "authenticated",
      pendingMfa: null,
    }),
  clear: () =>
    set({
      user: null,
      accessToken: null,
      status: "unauthenticated",
      pendingMfa: null,
    }),
}));
