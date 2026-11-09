import { KeyRound } from "lucide-react";

import { ChangePasswordPanel } from "@/components/account/ChangePasswordPanel";
import { PrivacyStatement } from "@/components/account/PrivacyStatementPanel";
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
        {user?.admin_notice_kind === "password_reset" && user.admin_notice_at ? (
          <p className="mb-4 text-sm text-[var(--text-muted)]">
            Your administrator reset your password on{" "}
            {new Date(user.admin_notice_at).toLocaleDateString(undefined, { dateStyle: "medium" })}.
            Pick a new one to continue. If you didn&apos;t ask for this, tell them.
          </p>
        ) : (
          <p className="mb-4 text-sm text-[var(--text-muted)]">
            {user?.username ? `Welcome, ${user.username}. ` : ""}Your account was set up with a
            password someone else chose. Pick a new one to continue.
          </p>
        )}
        <ChangePasswordPanel />
        {/* The app-wide promise, at first sign-in (admin privacy AP9). */}
        <details className="mt-4 rounded-card border border-[var(--border)] px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium text-[var(--text)]">
            What your server admin can and can&apos;t see
          </summary>
          <PrivacyStatement className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]" />
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            It&apos;s also under Account → Privacy &amp; activity.
          </p>
        </details>
      </div>
    </div>
  );
}
