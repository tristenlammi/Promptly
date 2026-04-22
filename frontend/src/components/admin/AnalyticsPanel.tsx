import { useMemo, useState } from "react";
import {
  Activity,
  CircleDollarSign,
  Coins,
  Loader2,
  MessageSquare,
  Users as UsersIcon,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  useAnalyticsByModel,
  useAnalyticsSummary,
  useAnalyticsTimeseries,
  useAnalyticsUsers,
  useAnalyticsUserTimeseries,
} from "@/hooks/useAdminUsers";
import { Modal } from "@/components/shared/Modal";
import { cn } from "@/utils/cn";
import { USD_TO_AUD, formatAud } from "@/utils/currency";
import type {
  AnalyticsTimeseriesPoint,
  AnalyticsUserRow,
} from "@/api/types";

// Window selector — keeps UI consistent across all sub-views.
const RANGE_OPTIONS = [7, 14, 30, 60, 90] as const;
type RangeDays = (typeof RANGE_OPTIONS)[number];

type Metric = "cost" | "tokens" | "messages";

const METRIC_LABELS: Record<Metric, string> = {
  cost: "Cost (AUD)",
  tokens: "Tokens",
  messages: "Messages",
};

export function AnalyticsPanel() {
  const [days, setDays] = useState<RangeDays>(30);
  // Tokens is the default because it's the most universally-useful
  // view — cost swings with provider pricing, messages undercounts
  // heavy turns, and tokens are what actually bill against quota
  // downstream.
  const [metric, setMetric] = useState<Metric>("tokens");
  const [chartUserId, setChartUserId] = useState<string | null>(null);
  const [drillUserId, setDrillUserId] = useState<string | null>(null);

  const summary = useAnalyticsSummary(days);
  const allUsersSeries = useAnalyticsTimeseries(days);
  // The per-user endpoint is only fetched when a specific user is
  // picked; ``enabled`` on the underlying ``useQuery`` guards it.
  const perUserSeries = useAnalyticsUserTimeseries(chartUserId, days);
  const users = useAnalyticsUsers(days);
  const byModel = useAnalyticsByModel(days);

  const activeSeries = chartUserId ? perUserSeries : allUsersSeries;

  const filledSeries = useMemo(
    () => fillMissingDays(activeSeries.data ?? [], days),
    [activeSeries.data, days]
  );

  const selectedUsername = useMemo(() => {
    if (!chartUserId) return null;
    return (
      users.data?.find((u) => u.user_id === chartUserId)?.username ?? null
    );
  }, [chartUserId, users.data]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-[var(--text-muted)]">
          Showing the last <strong>{days}</strong> days. Costs shown in
          <span className="font-mono"> AUD</span> (converted from provider USD
          at ~A${USD_TO_AUD.toFixed(2)}/USD).
        </div>
        <RangePicker value={days} onChange={setDays} />
      </div>

      {summary.isError && (
        <ErrorBanner message="Failed to load analytics summary." />
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Active users"
          icon={<UsersIcon className="h-4 w-4" />}
          loading={summary.isLoading}
          value={summary.data ? `${summary.data.active_users_window}` : "—"}
          hint={
            summary.data
              ? `of ${summary.data.total_users} total`
              : undefined
          }
          sparklineSeries={filledSeries}
          sparklineKey="messages"
          sparklineColor="var(--accent)"
        />
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
          value={summary.data ? formatInt(summary.data.total_tokens_window) : "—"}
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
          value={
            summary.data ? formatAud(summary.data.cost_usd_window) : "—"
          }
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

      <Card>
        <CardHeader
          title={`Daily ${METRIC_LABELS[metric].toLowerCase()}`}
          subtitle={
            chartUserId
              ? `Filtered to ${selectedUsername ?? "the selected user"}.`
              : "Summed across every user."
          }
          right={
            <div className="flex flex-wrap items-center gap-2">
              <UserFilter
                value={chartUserId}
                onChange={setChartUserId}
                users={users.data ?? []}
                loading={users.isLoading}
              />
              <MetricToggle value={metric} onChange={setMetric} />
            </div>
          }
        />
        <div className="h-72 w-full px-2 pb-3">
          {activeSeries.isLoading ? (
            <ChartLoading />
          ) : filledSeries.length === 0 ? (
            <EmptyState message="No usage recorded in this window yet." />
          ) : metric === "tokens" ? (
            // Stacked bars (prompt + completion) + total line on top.
            // Much more useful than a single line: you can see input vs
            // output ratio at a glance and still trace the overall trend.
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={filledSeries}
                margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border)"
                  opacity={0.4}
                />
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
                  formatter={(value, name) => [
                    formatInt(Number(value ?? 0)),
                    String(name),
                  ]}
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
          ) : metric === "messages" ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={filledSeries}
                margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border)"
                  opacity={0.4}
                />
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
                  formatter={(value) => [
                    formatInt(Number(value ?? 0)),
                    "Messages",
                  ]}
                />
                <Bar
                  dataKey="messages"
                  fill="var(--accent)"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={filledSeries}
                margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border)"
                  opacity={0.4}
                />
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
                  formatter={(value) => [
                    formatAud(Number(value ?? 0)),
                    "Cost",
                  ]}
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
          )}
        </div>
        <ChartSummaryRow series={filledSeries} metric={metric} />
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Cost by user"
            subtitle="Top 10 spenders in the window. Click a row for the per-user trend."
          />
          <div className="h-72 w-full px-2 pb-3">
            {users.isLoading ? (
              <ChartLoading />
            ) : (users.data ?? []).length === 0 ? (
              <EmptyState message="No spend recorded yet." />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={(users.data ?? []).slice(0, 10)}
                  margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--border)"
                    opacity={0.4}
                  />
                  <XAxis
                    dataKey="username"
                    tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                    stroke="var(--border)"
                    interval={0}
                    angle={-25}
                    textAnchor="end"
                    height={50}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                    stroke="var(--border)"
                    tickFormatter={(v: number) => formatAud(v)}
                    width={60}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(value) => [formatAud(Number(value ?? 0)), "Cost"]}
                  />
                  <Bar dataKey="cost_usd_window" radius={[4, 4, 0, 0]}>
                    {(users.data ?? []).slice(0, 10).map((row, i) => (
                      <Cell
                        key={row.user_id}
                        fill={USER_COLORS[i % USER_COLORS.length]}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="By model"
            subtitle="Spend split per model."
          />
          <div className="max-h-72 overflow-y-auto px-1 pb-2">
            {byModel.isLoading ? (
              <ChartLoading />
            ) : (byModel.data ?? []).length === 0 ? (
              <EmptyState message="No assistant turns recorded." />
            ) : (
              <table className="w-full text-xs">
                <thead className="text-left uppercase tracking-wider text-[10px] text-[var(--text-muted)]">
                  <tr>
                    <th className="px-2 py-1.5 font-semibold">Model</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Msgs</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Tokens</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {(byModel.data ?? []).map((row) => (
                    <tr
                      key={row.model_id}
                      className="border-t border-[var(--border)] first:border-t-0"
                    >
                      <td
                        className="px-2 py-1.5 font-mono text-[11px] text-[var(--text)]"
                        title={row.model_id}
                      >
                        <span className="block max-w-[20ch] truncate">
                          {row.model_id}
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
      </div>

      <Card>
        <CardHeader
          title="Per user"
          subtitle="Sorted by cost. Click a row for the per-user trend."
        />
        <div className="overflow-x-auto">
          {users.isLoading ? (
            <div className="px-4 py-8">
              <ChartLoading />
            </div>
          ) : (users.data ?? []).length === 0 ? (
            <EmptyState message="No usage recorded yet." />
          ) : (
            <UserTable
              rows={users.data ?? []}
              onPick={(id) => setDrillUserId(id)}
            />
          )}
        </div>
      </Card>

      <UserDrillDialog
        userId={drillUserId}
        days={days}
        username={
          users.data?.find((u) => u.user_id === drillUserId)?.username
        }
        onClose={() => setDrillUserId(null)}
      />
    </div>
  );
}

// --------------------------------------------------------------------
// User drill-down dialog
// --------------------------------------------------------------------
function UserDrillDialog({
  userId,
  days,
  username,
  onClose,
}: {
  userId: string | null;
  days: RangeDays;
  username?: string;
  onClose: () => void;
}) {
  const series = useAnalyticsUserTimeseries(userId, days);
  const filled = useMemo(
    () => fillMissingDays(series.data ?? [], days),
    [series.data, days]
  );

  return (
    <Modal
      open={userId !== null}
      onClose={onClose}
      title={username ? `Usage — ${username}` : "Usage"}
      widthClass="max-w-3xl"
    >
      <div className="space-y-3">
        <div className="text-xs text-[var(--text-muted)]">
          Last {days} days of activity for this user.
        </div>
        <div className="h-72 w-full">
          {series.isLoading ? (
            <ChartLoading />
          ) : filled.length === 0 ? (
            <EmptyState message="No usage recorded yet." />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={filled}
                margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border)"
                  opacity={0.4}
                />
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
                  formatter={(value, name) => {
                    const n = Number(value ?? 0);
                    if (name === "Cost") return [formatAud(n), "Cost"];
                    return [formatInt(n), String(name)];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line
                  type="monotone"
                  dataKey="cost_usd"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={false}
                  name="Cost"
                />
                <Line
                  type="monotone"
                  dataKey="messages"
                  stroke="var(--accent)"
                  strokeWidth={1.5}
                  dot={false}
                  name="Messages"
                  yAxisId={0}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------------
// User table
// --------------------------------------------------------------------
function UserTable({
  rows,
  onPick,
}: {
  rows: AnalyticsUserRow[];
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<keyof AnalyticsUserRow>(
    "cost_usd_window"
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? rows.filter(
          (r) =>
            r.username.toLowerCase().includes(q) ||
            r.email.toLowerCase().includes(q)
        )
      : rows;
    const sorted = [...list].sort((a, b) => {
      const av = a[sortKey] as number | string | null;
      const bv = b[sortKey] as number | string | null;
      const an = typeof av === "number" ? av : av === null ? -Infinity : 0;
      const bn = typeof bv === "number" ? bv : bv === null ? -Infinity : 0;
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc"
          ? av.localeCompare(bv)
          : bv.localeCompare(av);
      }
      return sortDir === "asc" ? an - bn : bn - an;
    });
    return sorted;
  }, [rows, query, sortKey, sortDir]);

  const flipSort = (key: keyof AnalyticsUserRow) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <input
          type="text"
          placeholder="Search users…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={cn(
            "h-8 w-full max-w-xs rounded-input border bg-[var(--surface)] px-2 text-xs",
            "border-[var(--border)] text-[var(--text)]",
            "focus:border-[var(--accent)] focus:outline-none"
          )}
        />
        <div className="text-[11px] text-[var(--text-muted)]">
          {filtered.length} {filtered.length === 1 ? "user" : "users"}
        </div>
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-[var(--border)] bg-black/[0.02] text-left text-[10px] uppercase tracking-wider text-[var(--text-muted)] dark:bg-white/[0.03]">
            <SortableHeader
              label="User"
              col="username"
              currentKey={sortKey}
              currentDir={sortDir}
              onClick={flipSort}
            />
            <SortableHeader
              label="Messages"
              col="messages_window"
              currentKey={sortKey}
              currentDir={sortDir}
              onClick={flipSort}
              align="right"
            />
            <SortableHeader
              label="Tokens"
              col="completion_tokens_window"
              currentKey={sortKey}
              currentDir={sortDir}
              onClick={flipSort}
              align="right"
            />
            <SortableHeader
              label="Cost"
              col="cost_usd_window"
              currentKey={sortKey}
              currentDir={sortDir}
              onClick={flipSort}
              align="right"
            />
            <SortableHeader
              label="Last active"
              col="last_active_at"
              currentKey={sortKey}
              currentDir={sortDir}
              onClick={flipSort}
            />
          </tr>
        </thead>
        <tbody>
          {filtered.map((r) => (
            <tr
              key={r.user_id}
              className="cursor-pointer border-t border-[var(--border)] first:border-t-0 hover:bg-[var(--surface-hover)]"
              onClick={() => onPick(r.user_id)}
            >
              <td className="px-3 py-2">
                <div className="text-xs font-medium text-[var(--text)]">
                  {r.username}
                </div>
                <div className="text-[10px] text-[var(--text-muted)]">
                  {r.email}
                </div>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatInt(r.messages_window)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatInt(
                  r.prompt_tokens_window + r.completion_tokens_window
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums font-medium">
                {formatAud(r.cost_usd_window)}
              </td>
              <td className="px-3 py-2 text-[var(--text-muted)]">
                {r.last_active_at
                  ? new Date(r.last_active_at).toLocaleDateString()
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortableHeader({
  label,
  col,
  currentKey,
  currentDir,
  onClick,
  align,
}: {
  label: string;
  col: keyof AnalyticsUserRow;
  currentKey: keyof AnalyticsUserRow;
  currentDir: "asc" | "desc";
  onClick: (col: keyof AnalyticsUserRow) => void;
  align?: "right";
}) {
  const isActive = currentKey === col;
  return (
    <th
      className={cn(
        "px-3 py-2 font-semibold cursor-pointer select-none",
        align === "right" && "text-right"
      )}
      onClick={() => onClick(col)}
    >
      <span className={cn(isActive && "text-[var(--text)]")}>
        {label}
        {isActive && (currentDir === "asc" ? " ↑" : " ↓")}
      </span>
    </th>
  );
}

// --------------------------------------------------------------------
// Stat card
// --------------------------------------------------------------------
function StatCard({
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
  sparklineSeries: AnalyticsTimeseriesPoint[];
  sparklineKey: keyof AnalyticsTimeseriesPoint;
  sparklineColor: string;
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
      {sparklineSeries.length > 1 && (
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
// Tiny presentational helpers
// --------------------------------------------------------------------
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
      {children}
    </div>
  );
}

function CardHeader({
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

function RangePicker({
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

/**
 * Dropdown that scopes the main trend chart to a single user. The
 * options are sourced from ``useAnalyticsUsers`` (already loaded for
 * the top-10 bar chart and the user table), so opening this picker
 * doesn't trigger a new fetch.
 */
function UserFilter({
  value,
  onChange,
  users,
  loading,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  users: AnalyticsUserRow[];
  loading: boolean;
}) {
  // Sort by cost desc (same ordering as the backend's ``analytics/users``
  // endpoint returns) so the heaviest users float to the top of the
  // dropdown. Preserves alphabetical as a tiebreaker for zero-spend
  // accounts.
  const sorted = useMemo(() => {
    return [...users].sort((a, b) => {
      if (b.cost_usd_window !== a.cost_usd_window) {
        return b.cost_usd_window - a.cost_usd_window;
      }
      return a.username.localeCompare(b.username);
    });
  }, [users]);

  return (
    <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
      <UsersIcon className="h-3 w-3" />
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={loading}
        className={cn(
          "h-7 max-w-[14rem] truncate rounded-input border bg-[var(--surface)] px-2 text-[11px]",
          "border-[var(--border)] text-[var(--text)]",
          "focus:border-[var(--accent)] focus:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-60"
        )}
      >
        <option value="">All users</option>
        {sorted.map((u) => (
          <option key={u.user_id} value={u.user_id}>
            {u.username}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Tiny stats bar under the main chart. Gives the admin quick totals
 * for the currently-filtered window without having to hover across
 * every bar — useful when a user filter is applied and the stat
 * cards up top still show the fleet-wide numbers.
 */
function ChartSummaryRow({
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
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--text-muted)]"
      )}
    >
      {metric === "tokens" ? (
        <>
          <SummaryStat
            label="Prompt"
            value={formatInt(stats.prompt)}
            dotColor="#a855f7"
          />
          <SummaryStat
            label="Completion"
            value={formatInt(stats.completion)}
            dotColor="#10b981"
          />
          <SummaryStat
            label="Total"
            value={formatInt(stats.prompt + stats.completion)}
          />
          <SummaryStat
            label="Peak day"
            value={formatInt(stats.peak)}
          />
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
          <SummaryStat
            label="Avg / day"
            value={formatAud(stats.cost / series.length)}
          />
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
      <span className="font-medium tabular-nums text-[var(--text)]">
        {value}
      </span>
    </div>
  );
}

function MetricToggle({
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

function ChartLoading() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-[var(--text-muted)]">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      Loading…
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 py-8 text-center text-xs text-[var(--text-muted)]">
      {message}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
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
const tooltipStyle: React.CSSProperties = {
  backgroundColor: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--text)",
};

const USER_COLORS = [
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

function formatInt(n: number): string {
  return Math.round(n).toLocaleString();
}

/** Compact number formatter for Y-axis ticks: 12,500 → "12.5k". */
function formatCompactInt(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs < 10_000 ? 1 : 0)}k`;
  return `${Math.round(n)}`;
}

function formatDayShort(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDayLong(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Backfill missing days with zero-rows so the X axis stays
 * continuous. Server only returns days with at least one row to
 * keep payload small; we fill client-side.
 */
function fillMissingDays(
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
