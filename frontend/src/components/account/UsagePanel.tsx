import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CircleDollarSign,
  MessageSquare,
  TrendingUp,
} from "lucide-react";

import {
  useMyUsageByModel,
  useMyUsageSummary,
  useMyUsageTimeseries,
} from "@/hooks/useUsage";
import { useAvailableModels } from "@/hooks/useProviders";
import {
  Card,
  CardHeader,
  ChartLoading,
  ChartSummaryRow,
  EmptyState,
  ErrorBanner,
  type Metric,
  MetricToggle,
  type RangeDays,
  RangePicker,
  StatCard,
  UsageTrendChart,
  fillMissingDays,
  formatInt,
} from "@/components/usage/shared";
import { cn } from "@/utils/cn";
import { USD_TO_AUD, formatAud } from "@/utils/currency";
import type { MyUsageSummary } from "@/api/types";

/**
 * End-user usage & cost dashboard (Phase 8). The self-scoped twin of the
 * admin ``AnalyticsPanel`` — same window picker, metric toggle, trend
 * chart, and by-model table, but showing only the signed-in user's own
 * numbers and surfacing their personal spend limits up top. Every figure
 * comes from the ``/api/usage/me/*`` endpoints, which are keyed off the
 * session so a user can never read anyone else's usage.
 */
export function UsagePanel() {
  const [days, setDays] = useState<RangeDays>(30);
  // Tokens first for the same reason the admin view defaults to it: the
  // most stable, quota-relevant signal.
  const [metric, setMetric] = useState<Metric>("tokens");

  const summary = useMyUsageSummary(days);
  const series = useMyUsageTimeseries(days);
  const byModel = useMyUsageByModel(days);

  const filledSeries = useMemo(
    () => fillMissingDays(series.data ?? [], days),
    [series.data, days]
  );

  // Raw model ids ("deepseek/deepseek-v4-flash") are for machines — show
  // the picker's display names, falling back to the id for models that
  // are no longer offered.
  const { data: availableModels } = useAvailableModels();
  const modelNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of availableModels ?? []) {
      if (!map.has(m.model_id)) map.set(m.model_id, m.display_name);
    }
    return map;
  }, [availableModels]);

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-muted)]">
            <BarChart3 className="h-4 w-4" />
          </span>
          <h3 className="text-sm font-semibold">Usage &amp; cost</h3>
        </div>
        <RangePicker value={days} onChange={setDays} />
      </header>

      <p className="text-xs text-[var(--text-muted)]">
        Your activity over the last <strong>{days}</strong> days. Costs are
        shown in <span className="font-mono">AUD</span> (converted from provider
        USD at ~A${USD_TO_AUD.toFixed(2)}/USD) and are an estimate, not a bill.
      </p>

      {summary.isError && (
        <ErrorBanner message="Failed to load your usage summary." />
      )}

      {summary.data && <VerdictBanner summary={summary.data} />}

      {/* Quota strip — always visible so quotas exist as a concept even for
          uncapped users ("no limit set" beats a section that appears out of
          nowhere the day an admin adds a cap). */}
      {summary.data && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <QuotaMeter
            label="Today"
            used={summary.data.daily_used}
            cap={summary.data.daily_cap}
          />
          <QuotaMeter
            label="This month"
            used={summary.data.monthly_used}
            cap={summary.data.monthly_cap}
          />
        </div>
      )}

      {/* Headline cards. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label={`Messages (${days}d)`}
          icon={<MessageSquare className="h-4 w-4" />}
          loading={summary.isLoading}
          value={summary.data ? formatInt(summary.data.messages_window) : "—"}
          hint={
            summary.data
              ? `${formatInt(summary.data.messages_today)} today`
              : undefined
          }
          sparklineSeries={filledSeries}
          sparklineKey="messages"
          sparklineColor="#0ea5e9"
        />
        <StatCard
          label={`Tokens (${days}d)`}
          icon={<Activity className="h-4 w-4" />}
          loading={summary.isLoading}
          value={
            summary.data ? formatInt(summary.data.total_tokens_window) : "—"
          }
          hint={
            summary.data
              ? `${formatInt(summary.data.prompt_tokens_window)} prompt · ${formatInt(
                  summary.data.completion_tokens_window
                )} completion`
              : undefined
          }
          sparklineSeries={filledSeries}
          sparklineKey="prompt_tokens"
          sparklineColor="#a855f7"
        />
        <StatCard
          label={`Cost (${days}d)`}
          icon={<CircleDollarSign className="h-4 w-4" />}
          loading={summary.isLoading}
          value={summary.data ? formatAud(summary.data.cost_usd_window) : "—"}
          hint={
            summary.data
              ? `${formatAud(summary.data.cost_usd_today)} today`
              : undefined
          }
          sparklineSeries={filledSeries}
          sparklineKey="cost_usd"
          sparklineColor="#10b981"
        />
      </div>

      {/* Trend chart. */}
      <Card>
        <CardHeader
          title="Daily trend"
          subtitle="Your messages, tokens, and cost by day."
          right={<MetricToggle value={metric} onChange={setMetric} />}
        />
        <div className="h-72 w-full px-2 pb-3">
          {series.isLoading ? (
            <ChartLoading />
          ) : filledSeries.length === 0 ? (
            <EmptyState message="No usage recorded in this window yet." />
          ) : (
            <UsageTrendChart series={filledSeries} metric={metric} />
          )}
        </div>
        <ChartSummaryRow series={filledSeries} metric={metric} />
      </Card>

      {/* By model. */}
      <Card>
        <CardHeader title="By model" subtitle="Where your spend goes." />
        <div className="max-h-72 overflow-y-auto px-1 pb-2">
          {byModel.isLoading ? (
            <ChartLoading />
          ) : (byModel.data ?? []).length === 0 ? (
            <EmptyState message="No assistant turns recorded yet." />
          ) : (
            <table className="w-full text-xs">
              <thead className="text-left uppercase tracking-wider text-[10px] text-[var(--text-muted)]">
                <tr>
                  <th className="px-2 py-1.5 font-semibold">Model</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Msgs</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Tokens</th>
                  <th
                    className="px-2 py-1.5 font-semibold text-right"
                    title="Estimated from provider list pricing — rounding, discounts, and caching mean your provider's dashboard is the source of truth."
                  >
                    Cost*
                  </th>
                </tr>
              </thead>
              <tbody>
                {(byModel.data ?? []).map((row) => (
                  <tr
                    key={row.model_id}
                    className="border-t border-[var(--border)] first:border-t-0"
                  >
                    <td
                      className={cn(
                        "px-2 py-1.5 text-[11px] text-[var(--text)]",
                        !modelNames.has(row.model_id) && "font-mono"
                      )}
                      title={row.model_id}
                    >
                      <span className="block max-w-[24ch] truncate">
                        {modelNames.get(row.model_id) ?? row.model_id}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-[var(--text-muted)]">
                      {formatInt(row.messages_window)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-[var(--text-muted)]">
                      {formatInt(
                        row.prompt_tokens_window + row.completion_tokens_window
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-medium text-[var(--text)]">
                      {formatAud(row.cost_usd_window)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </section>
  );
}

// --------------------------------------------------------------------
// Quota meter — one spend-limit bar (mirrors the admin UserUsageModal).
// --------------------------------------------------------------------
function QuotaMeter({
  label,
  used,
  cap,
}: {
  label: string;
  used: number;
  cap: number | null;
}) {
  const pct = cap && cap > 0 ? (used / cap) * 100 : null;
  const tone =
    pct === null ? "neutral" : pct >= 100 ? "danger" : pct >= 80 ? "warn" : "ok";

  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
          <TrendingUp className="h-3.5 w-3.5" />
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
        {formatInt(used)}
        <span className="ml-1 text-xs font-normal text-[var(--text-muted)]">
          {cap === null
            ? "tokens · no limit set"
            : `/ ${formatInt(cap)} tokens`}
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
// Verdict banner — surfaced only when near or over a cap.
// --------------------------------------------------------------------
function VerdictBanner({ summary }: { summary: MyUsageSummary }) {
  if (summary.verdict === "ok") return null;

  const window = summary.blocking_window === "daily" ? "daily" : "monthly";
  const blocked = summary.verdict === "blocked";

  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-card border px-3 py-2.5 text-xs",
        blocked
          ? "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      )}
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        {blocked
          ? `You've reached your ${window} token limit — new messages are paused until it resets.`
          : `You're approaching your ${window} token limit.`}
      </span>
    </div>
  );
}
