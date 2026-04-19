import { useMemo } from "react";
import { BarChart3, HardDrive, Loader2, TrendingUp } from "lucide-react";

import { Modal } from "@/components/shared/Modal";
import { useAdminUserUsage } from "@/hooks/useAdminUsers";
import { cn } from "@/utils/cn";
import type { AdminUser, AdminUserUsageDay } from "@/api/types";

interface UserUsageModalProps {
  open: boolean;
  user: AdminUser | null;
  onClose: () => void;
}

/**
 * Read-only "where is this user spending?" panel for admins. Pulls the
 * `/admin/users/{id}/usage` snapshot which already resolves the
 * effective cap (per-user override → org default → uncapped) and the
 * current daily/monthly token spend, plus a 30-day history rollup.
 *
 * The bars cap at 100% width even when the user has blown past their
 * monthly budget — we render the percentage label separately so the
 * "147%" case is still visible without breaking the layout.
 */
export function UserUsageModal({ open, user, onClose }: UserUsageModalProps) {
  const { data, isLoading, isError, error } = useAdminUserUsage(
    open ? (user?.id ?? null) : null,
    30
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={user ? `Usage — ${user.username}` : "Usage"}
      description="Token spend and storage for this user, refreshed on every open."
      widthClass="max-w-2xl"
      footer={
        <button
          type="button"
          onClick={onClose}
          className={cn(
            "inline-flex items-center justify-center rounded-input border px-3.5 py-1.5 text-sm",
            "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
            "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
          )}
        >
          Close
        </button>
      }
    >
      {isLoading && (
        <div className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading usage…
        </div>
      )}

      {isError && (
        <div
          role="alert"
          className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
        >
          Failed to load usage:{" "}
          {error instanceof Error ? error.message : "Unknown error"}
        </div>
      )}

      {data && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <UsageMeter
              icon={<TrendingUp className="h-3.5 w-3.5" />}
              label="Today"
              used={data.daily_used}
              cap={data.daily_cap}
              unit="tokens"
            />
            <UsageMeter
              icon={<TrendingUp className="h-3.5 w-3.5" />}
              label="This month"
              used={data.monthly_used}
              cap={data.monthly_cap}
              unit="tokens"
            />
            <UsageMeter
              icon={<HardDrive className="h-3.5 w-3.5" />}
              label="Storage"
              used={data.storage_used_bytes}
              cap={data.storage_cap_bytes}
              unit="bytes"
            />
          </div>

          <HistoryTable history={data.history} />
        </div>
      )}
    </Modal>
  );
}

// --------------------------------------------------------------------
// Meter card — one quota bar
// --------------------------------------------------------------------
function UsageMeter({
  icon,
  label,
  used,
  cap,
  unit,
}: {
  icon: React.ReactNode;
  label: string;
  used: number;
  cap: number | null;
  unit: "tokens" | "bytes";
}) {
  const format = unit === "bytes" ? formatBytes : formatNumber;
  const pct = cap && cap > 0 ? (used / cap) * 100 : null;
  const tone =
    pct === null
      ? "neutral"
      : pct >= 100
        ? "danger"
        : pct >= 80
          ? "warn"
          : "ok";

  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
          {icon}
          {label}
        </span>
        {pct !== null && (
          <span
            className={cn(
              "text-[11px] font-semibold tabular-nums",
              tone === "danger" && "text-red-600 dark:text-red-400",
              tone === "warn" && "text-amber-600 dark:text-amber-400",
              tone === "ok" && "text-[var(--text-muted)]"
            )}
          >
            {pct.toFixed(0)}%
          </span>
        )}
      </div>
      <div className="mt-1.5 text-sm font-semibold text-[var(--text)]">
        {format(used)}
        <span className="ml-1 text-xs font-normal text-[var(--text-muted)]">
          / {cap === null ? "unlimited" : format(cap)}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/[0.05] dark:bg-white/[0.06]">
        {pct !== null && (
          <div
            className={cn(
              "h-full rounded-full transition-all",
              tone === "danger" && "bg-red-500",
              tone === "warn" && "bg-amber-500",
              tone === "ok" && "bg-emerald-500"
            )}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------
// History table — last 30 days of token spend
// --------------------------------------------------------------------
function HistoryTable({ history }: { history: AdminUserUsageDay[] }) {
  const totals = useMemo(() => {
    let prompt = 0;
    let completion = 0;
    let messages = 0;
    for (const row of history) {
      prompt += row.prompt_tokens;
      completion += row.completion_tokens;
      messages += row.messages_sent;
    }
    return { prompt, completion, messages };
  }, [history]);

  if (history.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-[var(--border)] bg-[var(--bg)] px-3 py-4 text-center text-xs text-[var(--text-muted)]">
        No recorded usage in the last 30 days.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-card border border-[var(--border)]">
      <header className="flex items-center justify-between gap-2 border-b border-[var(--border)] bg-black/[0.02] px-3 py-2 dark:bg-white/[0.03]">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          <BarChart3 className="h-3.5 w-3.5" />
          Last {history.length} days
        </span>
        <span className="text-[11px] tabular-nums text-[var(--text-muted)]">
          {formatNumber(totals.prompt + totals.completion)} tokens ·{" "}
          {formatNumber(totals.messages)} messages
        </span>
      </header>
      <div className="max-h-64 overflow-y-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              <th className="px-3 py-1.5 font-semibold">Day</th>
              <th className="px-3 py-1.5 text-right font-semibold">Prompt</th>
              <th className="px-3 py-1.5 text-right font-semibold">
                Completion
              </th>
              <th className="px-3 py-1.5 text-right font-semibold">Messages</th>
            </tr>
          </thead>
          <tbody>
            {history.map((row) => (
              <tr
                key={row.day}
                className="border-t border-[var(--border)] tabular-nums"
              >
                <td className="px-3 py-1.5 text-[var(--text)]">{row.day}</td>
                <td className="px-3 py-1.5 text-right text-[var(--text-muted)]">
                  {formatNumber(row.prompt_tokens)}
                </td>
                <td className="px-3 py-1.5 text-right text-[var(--text-muted)]">
                  {formatNumber(row.completion_tokens)}
                </td>
                <td className="px-3 py-1.5 text-right text-[var(--text-muted)]">
                  {formatNumber(row.messages_sent)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------
// Number formatting
// --------------------------------------------------------------------
function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
