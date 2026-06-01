import { useMemo } from "react";
import { Coins, Loader2 } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { cn } from "@/utils/cn";
import { formatAud } from "@/utils/currency";
import type { AnalyticsTimeseriesPoint } from "@/api/types";

// ---------------------------------------------------------------------------
// Shared presentation for the usage views.
//
// Both the admin fleet dashboard (``admin/AnalyticsPanel.tsx``) and the
// end-user dashboard (``account/UsagePanel.tsx``) render the same window
// picker, metric toggle, stat cards, and daily-trend chart. Keeping that
// chrome here means the two views stay visually identical and the chart's
// axis/tooltip formatting can't drift between them.
// ---------------------------------------------------------------------------

export const RANGE_OPTIONS = [7, 14, 30, 60, 90] as const;
export type RangeDays = (typeof RANGE_OPTIONS)[number];

export type Metric = "cost" | "tokens" | "messages";

export const METRIC_LABELS: Record<Metric, string> = {
  cost: "Cost (AUD)",
  tokens: "Tokens",
  messages: "Messages",
};

// --------------------------------------------------------------------
// Layout primitives
// --------------------------------------------------------------------
export function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
      <div>
        <div className="text-sm font-semibold text-[var(--text)]">{title}</div>
        {subtitle && (
          <div className="text-[11px] text-[var(--text-muted)]">{subtitle}</div>
        )}
      </div>
      {right}
    </div>
  );
}

export function RangePicker({
  value,
  onChange,
}: {
  value: RangeDays;
  onChange: (v: RangeDays) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Range"
      className="inline-flex overflow-hidden rounded-input border border-[var(--border)]"
    >
      {RANGE_OPTIONS.map((d) => (
        <button
          key={d}
          role="tab"
          aria-selected={d === value}
          onClick={() => onChange(d)}
          className={cn(
            "px-2.5 py-1 text-[11px] font-medium transition",
            d === value
              ? "bg-[var(--accent)]/10 text-[var(--accent)]"
              : "text-[var(--text-muted)] hover:text-[var(--text)]"
          )}
        >
          {d}d
        </button>
      ))}
    </div>
  );
}

export function MetricToggle({
  value,
  onChange,
}: {
  value: Metric;
  onChange: (m: Metric) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-input border border-[var(--border)]">
      {(Object.keys(METRIC_LABELS) as Metric[]).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={cn(
            "px-2.5 py-1 text-[11px] font-medium transition flex items-center gap-1",
            m === value
              ? "bg-[var(--accent)]/10 text-[var(--accent)]"
              : "text-[var(--text-muted)] hover:text-[var(--text)]"
          )}
        >
          {m === "cost" && <Coins className="h-3 w-3" />}
          {METRIC_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

// --------------------------------------------------------------------
// Stat card (with optional sparkline)
// --------------------------------------------------------------------
export function StatCard({
  label,
  value,
  hint,
  icon,
  loading,
  sparklineSeries,
  sparklineKey,
  sparklineColor,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  loading: boolean;
  sparklineSeries?: AnalyticsTimeseriesPoint[];
  sparklineKey?: keyof AnalyticsTimeseriesPoint;
  sparklineColor?: string;
}) {
  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
        <span className="text-[var(--accent)]">{icon}</span>
        <span className="uppercase tracking-wider">{label}</span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <div className="text-2xl font-semibold text-[var(--text)]">
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : value}
        </div>
      </div>
      {hint && (
        <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">{hint}</div>
      )}
      {sparklineSeries &&
        sparklineKey &&
        sparklineColor &&
        sparklineSeries.length > 1 && (
          <div className="mt-2 h-10 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={sparklineSeries}
                margin={{ top: 2, right: 0, left: 0, bottom: 2 }}
              >
                <Line
                  type="monotone"
                  dataKey={sparklineKey as string}
                  stroke={sparklineColor}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
    </div>
  );
}

// --------------------------------------------------------------------
// Daily-trend chart — shape switches on the active metric.
// --------------------------------------------------------------------
export function UsageTrendChart({
  series,
  metric,
}: {
  series: AnalyticsTimeseriesPoint[];
  metric: Metric;
}) {
  if (metric === "tokens") {
    // Stacked bars (prompt + completion) so you can read the input vs
    // output ratio at a glance and still trace the overall trend.
    return (
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={series}
          margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.4} />
          <XAxis
            dataKey="day"
            tickFormatter={(v: string) => formatDayShort(v)}
            tick={{ fontSize: 11, fill: "var(--text-muted)" }}
            stroke="var(--border)"
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--text-muted)" }}
            stroke="var(--border)"
            tickFormatter={(v: number) => formatCompactInt(v)}
            width={60}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(label) => formatDayLong(label as string)}
            formatter={(value, name) => [formatInt(Number(value ?? 0)), String(name)]}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar
            dataKey="prompt_tokens"
            stackId="tokens"
            fill="#a855f7"
            name="Prompt"
            radius={[0, 0, 0, 0]}
          />
          <Bar
            dataKey="completion_tokens"
            stackId="tokens"
            fill="#10b981"
            name="Completion"
            radius={[4, 4, 0, 0]}
          />
        </ComposedChart>
      </ResponsiveContainer>
    );
  }

  if (metric === "messages") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={series}
          margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.4} />
          <XAxis
            dataKey="day"
            tickFormatter={(v: string) => formatDayShort(v)}
            tick={{ fontSize: 11, fill: "var(--text-muted)" }}
            stroke="var(--border)"
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--text-muted)" }}
            stroke="var(--border)"
            tickFormatter={(v: number) => formatCompactInt(v)}
            width={60}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(label) => formatDayLong(label as string)}
            formatter={(value) => [formatInt(Number(value ?? 0)), "Messages"]}
          />
          <Bar dataKey="messages" fill="var(--accent)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={series}
        margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.4} />
        <XAxis
          dataKey="day"
          tickFormatter={(v: string) => formatDayShort(v)}
          tick={{ fontSize: 11, fill: "var(--text-muted)" }}
          stroke="var(--border)"
        />
        <YAxis
          tick={{ fontSize: 11, fill: "var(--text-muted)" }}
          stroke="var(--border)"
          tickFormatter={(v: number) => formatAud(v)}
          width={60}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(label) => formatDayLong(label as string)}
          formatter={(value) => [formatAud(Number(value ?? 0)), "Cost"]}
        />
        <Line
          type="monotone"
          dataKey="cost_usd"
          stroke="var(--accent)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// --------------------------------------------------------------------
// Stats bar under the main chart (per-window totals).
// --------------------------------------------------------------------
export function ChartSummaryRow({
  series,
  metric,
}: {
  series: AnalyticsTimeseriesPoint[];
  metric: Metric;
}) {
  const stats = useMemo(() => {
    let messages = 0;
    let prompt = 0;
    let completion = 0;
    let cost = 0;
    let peak = 0;
    for (const p of series) {
      messages += p.messages;
      prompt += p.prompt_tokens;
      completion += p.completion_tokens;
      cost += p.cost_usd;
      const perDay =
        metric === "cost"
          ? p.cost_usd
          : metric === "messages"
            ? p.messages
            : p.prompt_tokens + p.completion_tokens;
      if (perDay > peak) peak = perDay;
    }
    return { messages, prompt, completion, cost, peak };
  }, [series, metric]);

  if (series.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--text-muted)]">
      {metric === "tokens" ? (
        <>
          <SummaryStat label="Prompt" value={formatInt(stats.prompt)} dotColor="#a855f7" />
          <SummaryStat
            label="Completion"
            value={formatInt(stats.completion)}
            dotColor="#10b981"
          />
          <SummaryStat label="Total" value={formatInt(stats.prompt + stats.completion)} />
          <SummaryStat label="Peak day" value={formatInt(stats.peak)} />
        </>
      ) : metric === "messages" ? (
        <>
          <SummaryStat label="Total" value={formatInt(stats.messages)} />
          <SummaryStat label="Peak day" value={formatInt(stats.peak)} />
          <SummaryStat
            label="Avg / day"
            value={formatInt(stats.messages / series.length)}
          />
        </>
      ) : (
        <>
          <SummaryStat label="Total" value={formatAud(stats.cost)} />
          <SummaryStat label="Peak day" value={formatAud(stats.peak)} />
          <SummaryStat label="Avg / day" value={formatAud(stats.cost / series.length)} />
        </>
      )}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  dotColor,
}: {
  label: string;
  value: string;
  dotColor?: string;
}) {
  return (
    <div className="inline-flex items-center gap-1.5">
      {dotColor && (
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: dotColor }}
        />
      )}
      <span className="uppercase tracking-wider">{label}</span>
      <span className="font-medium tabular-nums text-[var(--text)]">{value}</span>
    </div>
  );
}

// --------------------------------------------------------------------
// State placeholders
// --------------------------------------------------------------------
export function ChartLoading() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-[var(--text-muted)]">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      Loading…
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 py-8 text-center text-xs text-[var(--text-muted)]">
      {message}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-card border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400"
    >
      {message}
    </div>
  );
}

// --------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------
export const tooltipStyle: React.CSSProperties = {
  backgroundColor: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--text)",
};

export const USER_COLORS = [
  "#10b981",
  "#0ea5e9",
  "#a855f7",
  "#f59e0b",
  "#ec4899",
  "#84cc16",
  "#f43f5e",
  "#6366f1",
  "#14b8a6",
  "#eab308",
];

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString();
}

/** Compact number formatter for Y-axis ticks: 12,500 → "12.5k". */
export function formatCompactInt(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs < 10_000 ? 1 : 0)}k`;
  return `${Math.round(n)}`;
}

export function formatDayShort(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatDayLong(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Backfill missing days with zero-rows so the X axis stays continuous.
 * The server only returns days with at least one row to keep the
 * payload small; we fill client-side.
 */
export function fillMissingDays(
  series: AnalyticsTimeseriesPoint[],
  days: number
): AnalyticsTimeseriesPoint[] {
  const byDay = new Map<string, AnalyticsTimeseriesPoint>();
  for (const p of series) {
    byDay.set(p.day.slice(0, 10), p);
  }
  const out: AnalyticsTimeseriesPoint[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    const existing = byDay.get(key);
    out.push(
      existing ?? {
        day: d.toISOString(),
        messages: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        cost_usd: 0,
      }
    );
  }
  return out;
}
