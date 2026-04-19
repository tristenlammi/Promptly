import { useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import { useAdminUsers, useAuthEvents } from "@/hooks/useAdminUsers";
import { cn } from "@/utils/cn";
import type { AdminUser, AuthEvent } from "@/api/types";

const PAGE_SIZE = 50;

/**
 * Friendly labels for the canonical event_type strings emitted by
 * ``app/auth/events.py``. Adding a new event server-side without
 * updating this map is harmless — we fall back to the raw key.
 */
const EVENT_LABELS: Record<string, string> = {
  login_success: "Login",
  login_fail: "Login failed",
  logout: "Logout",
  lockout: "Lockout",
  unlock: "Unlocked",
  disable: "Disabled",
  enable: "Enabled",
  password_change: "Password changed",
  password_reset_by_admin: "Password reset (admin)",
  force_logout_all: "Forced logout (all sessions)",
  token_refresh: "Token refresh",
  refresh_rejected: "Refresh rejected",
  mfa_enrolled: "MFA enrolled",
  mfa_verified: "MFA verified",
  mfa_fail: "MFA failed",
  mfa_reset: "MFA reset",
  mfa_backup_used: "MFA backup code used",
  mfa_device_trusted: "Device trusted",
  mfa_device_revoked: "Device revoked",
  app_settings_changed: "App settings changed",
};

/** Filter dropdown options. Order matters — top items are most-used. */
const EVENT_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All events" },
  { value: "login_success", label: EVENT_LABELS.login_success },
  { value: "login_fail", label: EVENT_LABELS.login_fail },
  { value: "lockout", label: EVENT_LABELS.lockout },
  { value: "unlock", label: EVENT_LABELS.unlock },
  { value: "disable", label: EVENT_LABELS.disable },
  { value: "enable", label: EVENT_LABELS.enable },
  { value: "logout", label: EVENT_LABELS.logout },
  { value: "force_logout_all", label: EVENT_LABELS.force_logout_all },
  { value: "password_change", label: EVENT_LABELS.password_change },
  { value: "password_reset_by_admin", label: EVENT_LABELS.password_reset_by_admin },
  { value: "refresh_rejected", label: EVENT_LABELS.refresh_rejected },
  { value: "mfa_enrolled", label: EVENT_LABELS.mfa_enrolled },
  { value: "mfa_verified", label: EVENT_LABELS.mfa_verified },
  { value: "mfa_fail", label: EVENT_LABELS.mfa_fail },
  { value: "mfa_backup_used", label: EVENT_LABELS.mfa_backup_used },
  { value: "mfa_device_trusted", label: EVENT_LABELS.mfa_device_trusted },
  { value: "app_settings_changed", label: EVENT_LABELS.app_settings_changed },
];

export function AuditLogPanel() {
  const [eventType, setEventType] = useState<string>("");
  const [userId, setUserId] = useState<string>("");
  const [page, setPage] = useState(0);

  const { data: users } = useAdminUsers();
  const { data: events, isLoading, isFetching, isError, error, refetch } =
    useAuthEvents({
      event_type: eventType || undefined,
      user_id: userId || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    });

  const usersById = useMemo(() => {
    const map = new Map<string, AdminUser>();
    for (const u of users ?? []) map.set(u.id, u);
    return map;
  }, [users]);

  const onFilterChange = (next: string) => {
    setEventType(next);
    setPage(0);
  };
  const onUserChange = (next: string) => {
    setUserId(next);
    setPage(0);
  };

  // We fetch PAGE_SIZE+0 — if the server returns exactly PAGE_SIZE rows
  // there *might* be a next page. Cheap heuristic that avoids a
  // separate count query.
  const hasNextPage = (events?.length ?? 0) === PAGE_SIZE;

  return (
    <div className="space-y-4">
      <FilterBar
        eventType={eventType}
        userId={userId}
        users={users ?? []}
        onEventChange={onFilterChange}
        onUserChange={onUserChange}
        onRefresh={() => refetch()}
        refreshing={isFetching && !isLoading}
      />

      {isError && (
        <div
          role="alert"
          className="rounded-card border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400"
        >
          Failed to load audit log:{" "}
          {error instanceof Error ? error.message : "Unknown error"}
        </div>
      )}

      <div className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-12 text-sm text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading audit log…
          </div>
        ) : events && events.length > 0 ? (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-black/[0.02] text-left text-[11px] uppercase tracking-wider text-[var(--text-muted)] dark:bg-white/[0.03]">
                <th className="px-4 py-2.5 font-semibold">When</th>
                <th className="px-4 py-2.5 font-semibold">Event</th>
                <th className="px-4 py-2.5 font-semibold">User</th>
                <th className="px-4 py-2.5 font-semibold">IP</th>
                <th className="px-4 py-2.5 font-semibold">Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <EventRow
                  key={ev.id}
                  event={ev}
                  user={ev.user_id ? usersById.get(ev.user_id) : undefined}
                />
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-4 py-12 text-center text-sm text-[var(--text-muted)]">
            No events match the current filters.
          </div>
        )}
      </div>

      <Pagination
        page={page}
        hasNext={hasNextPage}
        onPrev={() => setPage((p) => Math.max(0, p - 1))}
        onNext={() => setPage((p) => p + 1)}
      />
    </div>
  );
}

// --------------------------------------------------------------------
// Filter bar
// --------------------------------------------------------------------
function FilterBar({
  eventType,
  userId,
  users,
  onEventChange,
  onUserChange,
  onRefresh,
  refreshing,
}: {
  eventType: string;
  userId: string;
  users: AdminUser[];
  onEventChange: (v: string) => void;
  onUserChange: (v: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={eventType} onChange={onEventChange} ariaLabel="Filter by event type">
        {EVENT_FILTERS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </Select>
      <Select value={userId} onChange={onUserChange} ariaLabel="Filter by user">
        <option value="">All users</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.username} · {u.email}
          </option>
        ))}
      </Select>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
        }
        onClick={onRefresh}
        disabled={refreshing}
      >
        Refresh
      </Button>
    </div>
  );
}

function Select({
  value,
  onChange,
  children,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  ariaLabel: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      className={cn(
        "h-8 rounded-input border bg-[var(--surface)] px-2 text-xs",
        "border-[var(--border)] text-[var(--text)]",
        "focus:border-[var(--accent)] focus:outline-none"
      )}
    >
      {children}
    </select>
  );
}

// --------------------------------------------------------------------
// Row + helpers
// --------------------------------------------------------------------
type Severity = "info" | "warn" | "danger" | "success";

const SEVERITY: Record<string, Severity> = {
  login_success: "success",
  login_fail: "warn",
  lockout: "danger",
  unlock: "info",
  disable: "danger",
  enable: "info",
  refresh_rejected: "warn",
  password_reset_by_admin: "warn",
  force_logout_all: "warn",
  mfa_fail: "warn",
  mfa_enrolled: "success",
  mfa_verified: "success",
  app_settings_changed: "warn",
};

function EventRow({ event, user }: { event: AuthEvent; user?: AdminUser }) {
  const label = EVENT_LABELS[event.event_type] ?? event.event_type;
  const severity = SEVERITY[event.event_type] ?? "info";
  const when = new Date(event.created_at);

  return (
    <tr className="border-t border-[var(--border)] first:border-t-0 align-top">
      <td className="px-4 py-2.5">
        <div className="text-xs font-medium text-[var(--text)]">
          {when.toLocaleString()}
        </div>
        <div className="text-[11px] text-[var(--text-muted)]" title={event.created_at}>
          {relativeTime(when)}
        </div>
      </td>
      <td className="px-4 py-2.5">
        <SeverityBadge severity={severity} label={label} />
      </td>
      <td className="px-4 py-2.5">
        {user ? (
          <div>
            <div className="text-xs font-medium text-[var(--text)]">
              {user.username}
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">{user.email}</div>
          </div>
        ) : event.identifier ? (
          <div className="text-xs italic text-[var(--text-muted)]" title="No matching user account">
            {event.identifier}
          </div>
        ) : (
          <span className="text-xs text-[var(--text-muted)]">—</span>
        )}
      </td>
      <td className="px-4 py-2.5">
        <span
          className="inline-block max-w-[14ch] truncate font-mono text-[11px] text-[var(--text-muted)]"
          title={event.ip || undefined}
        >
          {event.ip || "—"}
        </span>
      </td>
      <td className="px-4 py-2.5">
        {event.detail ? (
          <span
            className="block max-w-[42ch] truncate text-[11px] text-[var(--text-muted)]"
            title={event.detail}
          >
            {event.detail}
          </span>
        ) : (
          <span className="text-[11px] text-[var(--text-muted)]">—</span>
        )}
      </td>
    </tr>
  );
}

function SeverityBadge({ severity, label }: { severity: Severity; label: string }) {
  const styles: Record<Severity, string> = {
    success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    info: "bg-[var(--accent)]/10 text-[var(--accent)]",
    warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    danger: "bg-red-500/10 text-red-600 dark:text-red-400",
  };
  const Icon =
    severity === "success"
      ? ShieldCheck
      : severity === "danger"
        ? ShieldX
        : ShieldAlert;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        styles[severity]
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

function Pagination({
  page,
  hasNext,
  onPrev,
  onNext,
}: {
  page: number;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (page === 0 && !hasNext) return null;
  const start = page * PAGE_SIZE + 1;
  const end = start + PAGE_SIZE - 1;
  return (
    <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
      <span>
        Showing {start}–{end}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<ChevronLeft className="h-3.5 w-3.5" />}
          onClick={onPrev}
          disabled={page === 0}
        >
          Previous
        </Button>
        <Button
          variant="ghost"
          size="sm"
          rightIcon={<ChevronRight className="h-3.5 w-3.5" />}
          onClick={onNext}
          disabled={!hasNext}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------
function relativeTime(when: Date): string {
  const diffSec = Math.round((Date.now() - when.getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86_400)}d ago`;
}
