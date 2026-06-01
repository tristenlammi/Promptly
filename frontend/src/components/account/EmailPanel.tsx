import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Mail,
  RefreshCw,
  Unplug,
} from "lucide-react";

import { emailApi, type EmailAccount } from "@/api/email";
import { authApi } from "@/api/auth";
import { useAuthStore } from "@/store/authStore";
import { Button } from "@/components/shared/Button";
import { cn } from "@/utils/cn";

/**
 * Account → Email section (Phase 12 — E.2).
 *
 * Shows a "Connect Gmail" button when email is enabled org-wide,
 * lists connected accounts with sync status, and lets the user
 * configure their personal email mode (triage vs triage + RAG).
 */
export function EmailPanel() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const qc = useQueryClient();

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ["email", "feature-status"],
    queryFn: emailApi.featureStatus,
    staleTime: 60_000,
  });

  const { data: accounts = [], isLoading: accountsLoading } = useQuery({
    queryKey: ["email", "accounts"],
    queryFn: emailApi.listAccounts,
    enabled: !!status?.enabled,
    staleTime: 30_000,
  });

  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const disconnectMutation = useMutation({
    mutationFn: (id: string) => emailApi.disconnectAccount(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["email", "accounts"] });
    },
  });

  const syncMutation = useMutation({
    mutationFn: (id: string) => emailApi.syncNow(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["email", "accounts"] });
    },
  });

  const handleConnect = async () => {
    setConnectError(null);
    setConnecting(true);
    try {
      const { auth_url } = await emailApi.startGoogleOAuth();
      window.location.href = auth_url;
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "Failed to start OAuth.");
      setConnecting(false);
    }
  };

  const emailMode = user?.settings?.email_mode ?? "off";

  const updateMode = async (mode: "off" | "triage" | "triage_rag") => {
    const fresh = await authApi.updatePreferences({ email_mode: mode });
    setUser(fresh);
  };

  if (statusLoading) {
    return (
      <section className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
        <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Mail className="h-4 w-4 text-[var(--text-muted)]" />
          <h3 className="text-sm font-semibold">Email</h3>
        </header>
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
        <Mail className="h-4 w-4 text-[var(--text-muted)]" />
        <h3 className="text-sm font-semibold">Email</h3>
      </header>

      <div className="space-y-5 px-4 py-4">
        {/* Admin kill-switch guard */}
        {!status?.enabled && (
          <div className="flex items-start gap-2 rounded-input border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Email integration is not enabled on this instance. Ask your administrator to
            enable it under Admin → Email.
          </div>
        )}

        {/* Connected accounts */}
        {status?.enabled && (
          <>
            {accountsLoading ? (
              <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading accounts…
              </div>
            ) : accounts.length === 0 ? (
              <div>
                <p className="text-sm font-medium">No Gmail account connected</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Connect your Google account to enable AI-powered email triage,
                  RAG search over your inbox, and the Email panel in the sidebar.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {accounts.map((acct) => (
                  <AccountRow
                    key={acct.id}
                    account={acct}
                    onDisconnect={() => disconnectMutation.mutate(acct.id)}
                    onSync={() => syncMutation.mutate(acct.id)}
                    disconnecting={disconnectMutation.isPending && disconnectMutation.variables === acct.id}
                    syncing={syncMutation.isPending && syncMutation.variables === acct.id}
                  />
                ))}
              </div>
            )}

            {/* Connect button — shown even when accounts exist (multi-account future) */}
            {!status.oauth_configured ? (
              <div className="flex items-start gap-2 rounded-input border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Google OAuth credentials are not configured. Ask your administrator
                to add them under Admin → Email.
              </div>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void handleConnect()}
                disabled={connecting}
                className="inline-flex items-center gap-2"
              >
                {connecting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <GoogleIcon />
                )}
                {connecting ? "Redirecting…" : "Connect Gmail"}
              </Button>
            )}

            {connectError && (
              <p className="text-xs text-red-500">{connectError}</p>
            )}
          </>
        )}

        {/* Email mode selector — only when at least one account is connected */}
        {status?.enabled && accounts.length > 0 && (
          <>
            <div className="border-t border-[var(--border)]" />
            <div>
              <p className="text-sm font-semibold">Email mode</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Controls what Promptly does with your synced emails.
              </p>
              <div className="mt-3 space-y-2">
                {EMAIL_MODES.map(({ value, label, description }) => (
                  <label
                    key={value}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-input border px-3 py-2.5 transition",
                      emailMode === value
                        ? "border-[var(--accent)] bg-[var(--accent)]/5"
                        : "border-[var(--border)] hover:bg-[var(--hover)]"
                    )}
                  >
                    <input
                      type="radio"
                      name="email_mode"
                      value={value}
                      checked={emailMode === value}
                      onChange={() => void updateMode(value)}
                      className="mt-0.5 accent-[var(--accent)]"
                    />
                    <div className="min-w-0">
                      <p className="text-xs font-medium">{label}</p>
                      <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                        {description}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}

        <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
          Promptly never sends email on your behalf without an explicit Send action.
          OAuth tokens are stored encrypted and syncing can be paused or revoked at any time.
        </p>
      </div>
    </section>
  );
}

const EMAIL_MODES: { value: "off" | "triage" | "triage_rag"; label: string; description: string }[] = [
  {
    value: "off",
    label: "Off",
    description: "Hide the Email panel and pause all syncing.",
  },
  {
    value: "triage",
    label: "Triage",
    description: "Sync and AI-categorise emails. Read them in the Email panel.",
  },
  {
    value: "triage_rag",
    label: "Triage + RAG",
    description:
      "Triage plus full-text semantic indexing — use the search_emails tool in chat to query your inbox.",
  },
];

function AccountRow({
  account,
  onDisconnect,
  onSync,
  disconnecting,
  syncing,
}: {
  account: EmailAccount;
  onDisconnect: () => void;
  onSync: () => void;
  disconnecting: boolean;
  syncing: boolean;
}) {
  const lastSync = account.last_synced_at
    ? new Date(account.last_synced_at).toLocaleString()
    : "Never";

  return (
    <div className="flex items-start justify-between gap-3 rounded-input border border-[var(--border)] px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {account.last_sync_error ? (
            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
          )}
          <span className="truncate text-sm font-medium">{account.email_address}</span>
        </div>
        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
          {account.last_sync_error
            ? `Sync error: ${account.last_sync_error}`
            : `Last synced: ${lastSync}`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onSync}
          disabled={syncing}
          title="Sync now"
          className="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
        </button>
        <button
          type="button"
          onClick={onDisconnect}
          disabled={disconnecting}
          title="Disconnect"
          className="rounded p-1.5 text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
        >
          {disconnecting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Unplug className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}
