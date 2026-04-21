import { ShieldCheck } from "lucide-react";

import { ChatPreferencesPanel } from "@/components/account/ChatPreferencesPanel";
import { NotificationsPanel } from "@/components/account/NotificationsPanel";
import { PersonalContextPanel } from "@/components/account/PersonalContextPanel";
import { MfaSettingsPanel } from "@/components/mfa/MfaSettingsPanel";
import { useAuthStore } from "@/store/authStore";

/** User-facing account settings. Lives at /account/security and is
 * accessible to every authenticated user (admin or otherwise). The
 * admin-only "App settings" panel for org-wide MFA enforcement and
 * SMTP config lives separately on the admin page.
 *
 * Hosts two stacked panels:
 *   1. Chat defaults — Tools / Web search per-account preferences.
 *   2. MFA settings — enrollment, backup codes, trusted devices.
 *
 * The page kept its security-focused name and route for backwards
 * compatibility, but it now houses the broader account-preferences
 * surface as well.
 */
export function AccountSecurityPage() {
  const user = useAuthStore((s) => s.user);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)]/15 text-[var(--accent)]">
          <ShieldCheck className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold tracking-tight">
            Account
          </h1>
          <p className="truncate text-xs text-[var(--text-muted)]">
            Chat defaults, two-step verification, backup codes, trusted
            devices.
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
          <PersonalContextPanel />
          <ChatPreferencesPanel />
          <NotificationsPanel />
          <MfaSettingsPanel defaultEmail={user?.email} />
        </div>
      </div>
    </div>
  );
}
