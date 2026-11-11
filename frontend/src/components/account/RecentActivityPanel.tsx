import { useCallback, useEffect, useState } from "react";
import { History, ShieldAlert } from "lucide-react";

import { authApi, type SecurityEvent } from "@/api/auth";
import { Button } from "@/components/shared/Button";
import { apiErrorMessage } from "@/utils/apiError";

const PAGE = 30;

/** Plain words for each kind of account event. */
function label(e: SecurityEvent): string {
  switch (e.kind) {
    case "login_success":
      if (e.via === "awaiting_mfa") return "Signed in with single sign-on, then asked for a code";
      return e.via === "sso" ? "Signed in with single sign-on" : "Signed in";
    case "login_fail":
      return "Someone entered a wrong password";
    case "lockout":
      return "Account locked after too many wrong passwords";
    case "unlock":
      return "Account unlocked";
    case "disable":
      return "Account turned off";
    case "enable":
      return "Account turned back on";
    case "logout":
      return "Signed out";
    case "force_logout_all":
      return "Signed out on every device";
    case "password_change":
      return e.via === "reset_link" ? "Password changed with a reset link" : "Password changed";
    case "password_reset_by_admin":
      return e.via === "edit" ? "Password set to a temporary one" : "Password reset to a temporary one";
    case "password_reset_requested":
      return "Password reset link emailed";
    case "mfa_enrolled":
      return "Two-step verification turned on";
    case "mfa_fail":
      return "Someone entered a wrong sign-in code";
    case "mfa_reset":
      return "Two-step verification turned off";
    case "mfa_backup_used":
      return "A backup code was used to sign in";
    case "mfa_device_trusted":
      return "A device was remembered for sign-in";
    case "mfa_device_revoked":
      return "A remembered device was removed";
    case "app_password_created":
      return "App password created";
    case "app_password_revoked":
      return "App password removed";
    case "user_created":
      return "Account created";
    case "role_changed":
      return "Role changed";
    case "email_changed":
      return "Email address changed";
    case "sso_linked":
      return "Single sign-on linked to your account";
    default:
      return e.kind.replace(/_/g, " ");
  }
}

/** "Chrome on Windows" from a user agent, without a parser library. */
function device(ua: string): string {
  if (!ua) return "";
  if (/okhttp|Promptly-Android|Dalvik/i.test(ua)) return "Promptly for Android";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Version\/\S+.*Safari/.test(ua)
          ? "Safari"
          : "";
  const os = /Windows NT/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iPod/.test(ua)
        ? "iPhone or iPad"
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || "Another app";
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Account → Security → Recent activity (admin privacy AP5): sign-ins,
 *  password and two-step changes, and every change an administrator made
 *  to this account, which is marked as such. */
export function RecentActivityPanel() {
  const [rows, setRows] = useState<SecurityEvent[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (before?: string) => {
    setBusy(true);
    setError(null);
    try {
      const page = await authApi.securityEvents(before);
      setRows((prev) => (before && prev ? [...prev, ...page] : page));
      setMore(page.length >= PAGE);
    } catch (e) {
      setError(apiErrorMessage(e, "Couldn't load your recent activity."));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      id="recent-activity"
      className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4"
      aria-labelledby="recent-activity-title"
    >
      <h2
        id="recent-activity-title"
        className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text)]"
      >
        <History className="h-4 w-4" /> Recent activity
      </h2>
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        Sign-ins and changes to your account. Anything your administrator
        changed is marked.
      </p>

      {error && (
        <div
          role="alert"
          className="mb-3 flex items-center justify-between gap-3 rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
        >
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}

      {rows === null && !error && (
        <p className="text-xs text-[var(--text-muted)]">Loading…</p>
      )}

      {rows !== null && rows.length === 0 && (
        <p className="text-xs text-[var(--text-muted)]">Nothing yet.</p>
      )}

      {rows !== null && rows.length > 0 && (
        <ul className="divide-y divide-[var(--border)] rounded-card border border-[var(--border)]">
          {rows.map((e) => {
            const dev = device(e.user_agent);
            return (
              <li key={e.id} className="flex flex-col gap-0.5 px-3 py-2 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <div className="text-[var(--text)]">{label(e)}</div>
                  {e.by_admin && (
                    <div className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                      <ShieldAlert className="h-3 w-3" aria-hidden />
                      By your administrator{e.admin_name ? ` (${e.admin_name})` : ""}
                    </div>
                  )}
                  {!e.by_admin && (dev || e.ip) && (
                    <div className="truncate text-xs text-[var(--text-muted)]">
                      {[dev, e.ip].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
                <time
                  dateTime={e.at}
                  className="shrink-0 text-xs text-[var(--text-muted)] sm:pt-0.5"
                >
                  {when(e.at)}
                </time>
              </li>
            );
          })}
        </ul>
      )}

      {more && rows && rows.length > 0 && (
        <div className="mt-3">
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={() => void load(rows[rows.length - 1].at)}
          >
            Show older
          </Button>
        </div>
      )}
    </section>
  );
}
