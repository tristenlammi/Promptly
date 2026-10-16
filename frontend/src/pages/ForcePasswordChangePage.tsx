import { KeyRound } from "lucide-react";

import { ChangePasswordPanel } from "@/components/account/ChangePasswordPanel";
import { useAuthStore } from "@/store/authStore";

/** First sign-in with a password an admin chose: pick your own before
 *  anything else (R-259). The backend refuses everything but the account
 *  endpoints until then; this is the only screen until it's done. */
export function ForcePasswordChangePage() {
  const user = useAuthStore((s) => s.user);
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 py-8 text-[var(--text)]">
      <div className="w-full max-w-md rounded-card border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-[var(--accent-text)]" aria-hidden />
          <h1 className="text-lg font-semibold">Choose your own password</h1>
        </div>
        <p className="mb-4 text-sm text-[var(--text-muted)]">
          {user?.username ? `Welcome, ${user.username}. ` : ""}Your account was set up with a
          password someone else chose. Pick a new one to continue.
        </p>
        <ChangePasswordPanel />
      </div>
    </div>
  );
}
