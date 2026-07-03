import { useMemo, useState } from "react";
import {
  Building2,
  CircleDollarSign,
  MessageSquare,
  Users as UsersIcon,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
  useAnalyticsOrgByModel,
  useAnalyticsOrgTimeseries,
  useAnalyticsOrgs,
  useAnalyticsSummary,
  useAnalyticsTimeseries,
} from "@/hooks/useAdminUsers";
import { Modal } from "@/components/shared/Modal";
import {
  Card,
  CardHeader,
  ChartLoading,
  ChartSummaryRow,
  EmptyState,
  ErrorBanner,
  METRIC_LABELS,
  type Metric,
  MetricToggle,
  type RangeDays,
  RangePicker,
  StatCard,
  USER_COLORS,
  UsageTrendChart,
  fillMissingDays,
  formatDayLong,
  formatDayShort,
  formatInt,
  tooltipStyle,
} from "@/components/usage/shared";
import { cn } from "@/utils/cn";
import { USD_TO_AUD, formatAud } from "@/utils/currency";
import type { AnalyticsOrgRow } from "@/api/types";

/**
 * The platform operator's analytics view. The super admin sees the fleet
 * **per organization** — cost/usage of each tenant as a whole, never another
 * tenant's individual users. (Org admins get the per-user view in
 * {@link AnalyticsPanel}; this component is only rendered for the operator.)
 */
export function OrgAnalyticsPanel() {
  const [days, setDays] = useState<RangeDays>(30);
  const [metric, setMetric] = useState<Metric>("tokens");
  const [chartOrgId, setChartOrgId] = useState<string | null>(null);
  const [drillOrgId, setDrillOrgId] = useState<string | null>(null);

  const summary = useAnalyticsSummary(days);
  const orgs = useAnalyticsOrgs(days);
  const fleetSeries = useAnalyticsTimeseries(days);
  const perOrgSeries = useAnalyticsOrgTimeseries(chartOrgId, days);
  const byModel = useAnalyticsByModel(days);

  const activeSeries = chartOrgId ? perOrgSeries : fleetSeries;
  const filledSeries = useMemo(
    () => fillMissingDays(activeSeries.data ?? [], days),
    [activeSeries.data, days]
  );

  const orgRows = orgs.data ?? [];
  const activeOrgs = useMemo(
    () => orgRows.filter((o) => o.messages_window > 0).length,
    [orgRows]
  );
  const selectedOrgName = useMemo(() => {
    if (!chartOrgId) return null;
    return orgRows.find((o) => o.org_id === chartOrgId)?.org_name ?? null;
  }, [chartOrgId, orgRows]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-[var(--text-muted)]">
          Fleet-wide, grouped <strong>per organisation</strong>. Last{" "}
          <strong>{days}</strong> days. Costs in
          <span className="font-mono"> AUD</span> (≈ A${USD_TO_AUD.toFixed(2)}
          /USD).
        </div>
        <RangePicker value={days} onChange={setDays} />
      </div>

      {(summary.isError || orgs.isError) && (
        <ErrorBanner message="Failed to load fleet analytics." />
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Organisations"
          icon={<Building2 className="h-4 w-4" />}
          loading={orgs.isLoading}
          value={`${orgRows.length}`}
          hint={`${activeOrgs} active this window`}
          sparklineSeries={filledSeries}
          sparklineKey="messages"
          sparklineColor="var(--accent)"
        />
        <StatCard
          label="Members"
          icon={<UsersIcon className="h-4 w-4" />}
          loading={summary.isLoading}
          value={summary.data ? formatInt(summary.data.total_users) : "—"}
          hint={
            summary.data
              ? `${formatInt(summary.data.active_users_window)} active`
              : undefined
          }
          sparklineSeries={filledSeries}
          sparklineKey="messages"
          sparklineColor="#0ea5e9"
        />
        <StatCard
          label={`Tokens (${days}d)`}
          icon={<MessageSquare className="h-4 w-4" />}
          loading={summary.isLoading}
          value={
            summary.data ? formatInt(summary.data.total_tokens_window) : "—"
          }
          hint={
            summary.data
              ? `${formatInt(summary.data.messages_window)} messages`
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

      <Card>
        <CardHeader
          title={`Daily ${METRIC_LABELS[metric].toLowerCase()}`}
          subtitle={
            chartOrgId
              ? `Filtered to ${selectedOrgName ?? "the selected org"}.`
              : "Summed across every organisation."
          }
          right={
            <div className="flex flex-wrap items-center gap-2">
              <OrgFilter
                value={chartOrgId}
                onChange={setChartOrgId}
                orgs={orgRows}
                loading={orgs.isLoading}
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
          ) : (
            <UsageTrendChart series={filledSeries} metric={metric} />
          )}
        </div>
        <ChartSummaryRow series={filledSeries} metric={metric} />
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Cost by organisation"
            subtitle="Top 10 tenants in the window. Click a row below for the per-org trend."
          />
          <div className="h-72 w-full px-2 pb-3">
            {orgs.isLoading ? (
              <ChartLoading />
            ) : orgRows.length === 0 ? (
              <EmptyState message="No organisations yet." />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={orgRows.slice(0, 10)}
                  margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--border)"
                    opacity={0.4}
                  />
                  <XAxis
                    dataKey="org_name"
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
                    formatter={(value) => [
                      formatAud(Number(value ?? 0)),
                      "Cost",
                    ]}
                  />
                  <Bar dataKey="cost_usd_window" radius={[4, 4, 0, 0]}>
                    {orgRows.slice(0, 10).map((row, i) => (
                      <Cell
                        key={row.org_id}
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
            subtitle="Fleet-wide spend split per model."
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
                    <th className="px-2 py-1.5 font-semibold text-right">
                      Msgs
                    </th>
                    <th className="px-2 py-1.5 font-semibold text-right">
                      Tokens
                    </th>
                    <th className="px-2 py-1.5 font-semibold text-right">
                      Cost
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
          title="Per organisation"
          subtitle="Sorted by cost. Click a row for the per-org trend and model split."
        />
        <div className="overflow-x-auto">
          {orgs.isLoading ? (
            <div className="px-4 py-8">
              <ChartLoading />
            </div>
          ) : orgRows.length === 0 ? (
            <EmptyState message="No organisations yet." />
          ) : (
            <OrgTable rows={orgRows} onPick={(id) => setDrillOrgId(id)} />
          )}
        </div>
      </Card>

      <OrgDrillDialog
        orgId={drillOrgId}
        days={days}
        org={orgRows.find((o) => o.org_id === drillOrgId)}
        onClose={() => setDrillOrgId(null)}
      />
    </div>
  );
}

// --------------------------------------------------------------------
// Per-org drill-down dialog — trend + model split for one tenant
// --------------------------------------------------------------------
function OrgDrillDialog({
  orgId,
  days,
  org,
  onClose,
}: {
  orgId: string | null;
  days: RangeDays;
  org?: AnalyticsOrgRow;
  onClose: () => void;
}) {
  const series = useAnalyticsOrgTimeseries(orgId, days);
  const byModel = useAnalyticsOrgByModel(orgId, days);
  const filled = useMemo(
    () => fillMissingDays(series.data ?? [], days),
    [series.data, days]
  );

  return (
    <Modal
      open={orgId !== null}
      onClose={onClose}
      title={org ? `Usage — ${org.org_name}` : "Usage"}
      widthClass="max-w-3xl"
    >
      <div className="space-y-4">
        {org && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-[var(--text-muted)]">
            <span>
              Plan:{" "}
              <span className="font-medium text-[var(--text)]">
                {org.plan ?? "—"}
              </span>
            </span>
            <span>
              Seats:{" "}
              <span className="font-medium text-[var(--text)]">
                {org.member_count}
                {org.seat_limit != null ? ` / ${org.seat_limit}` : ""}
              </span>
            </span>
            <span>
              Cost ({days}d):{" "}
              <span className="font-medium text-[var(--text)]">
                {formatAud(org.cost_usd_window)}
              </span>
            </span>
          </div>
        )}

        <div className="h-64 w-full">
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

        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            By model
          </div>
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
                  <th className="px-2 py-1.5 font-semibold text-right">
                    Tokens
                  </th>
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
                      <span className="block max-w-[24ch] truncate">
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
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------------
// Per-org table
// --------------------------------------------------------------------
function OrgTable({
  rows,
  onPick,
}: {
  rows: AnalyticsOrgRow[];
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<keyof AnalyticsOrgRow>(
    "cost_usd_window"
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? rows.filter(
          (r) =>
            r.org_name.toLowerCase().includes(q) ||
            (r.plan ?? "").toLowerCase().includes(q)
        )
      : rows;
    const sorted = [...list].sort((a, b) => {
      const av = a[sortKey] as number | string | null;
      const bv = b[sortKey] as number | string | null;
      const an = typeof av === "number" ? av : av === null ? -Infinity : 0;
      const bn = typeof bv === "number" ? bv : bv === null ? -Infinity : 0;
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === "asc" ? an - bn : bn - an;
    });
    return sorted;
  }, [rows, query, sortKey, sortDir]);

  const flipSort = (key: keyof AnalyticsOrgRow) => {
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
          placeholder="Search organisations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={cn(
            "h-8 w-full max-w-xs rounded-input border bg-[var(--surface)] px-2 text-xs",
            "border-[var(--border)] text-[var(--text)]",
            "focus:border-[var(--accent)] focus:outline-none"
          )}
        />
        <div className="text-[11px] text-[var(--text-muted)]">
          {filtered.length} {filtered.length === 1 ? "org" : "orgs"}
        </div>
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-[var(--border)] bg-black/[0.02] text-left text-[10px] uppercase tracking-wider text-[var(--text-muted)] dark:bg-white/[0.03]">
            <SortableHeader
              label="Organisation"
              col="org_name"
              currentKey={sortKey}
              currentDir={sortDir}
              onClick={flipSort}
            />
            <SortableHeader
              label="Members"
              col="member_count"
              currentKey={sortKey}
              currentDir={sortDir}
              onClick={flipSort}
              align="right"
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
              key={r.org_id}
              className="cursor-pointer border-t border-[var(--border)] first:border-t-0 hover:bg-[var(--surface-hover)]"
              onClick={() => onPick(r.org_id)}
            >
              <td className="px-3 py-2">
                <div className="text-xs font-medium text-[var(--text)]">
                  {r.org_name}
                </div>
                {r.plan && (
                  <div className="text-[10px] text-[var(--text-muted)]">
                    {r.plan}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {r.member_count}
                {r.seat_limit != null && (
                  <span className="text-[var(--text-muted)]">
                    {" "}
                    / {r.seat_limit}
                  </span>
                )}
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
  col: keyof AnalyticsOrgRow;
  currentKey: keyof AnalyticsOrgRow;
  currentDir: "asc" | "desc";
  onClick: (col: keyof AnalyticsOrgRow) => void;
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

/** Dropdown that scopes the main trend chart to a single organisation. */
function OrgFilter({
  value,
  onChange,
  orgs,
  loading,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  orgs: AnalyticsOrgRow[];
  loading: boolean;
}) {
  const sorted = useMemo(() => {
    return [...orgs].sort((a, b) => {
      if (b.cost_usd_window !== a.cost_usd_window) {
        return b.cost_usd_window - a.cost_usd_window;
      }
      return a.org_name.localeCompare(b.org_name);
    });
  }, [orgs]);

  return (
    <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
      <Building2 className="h-3 w-3" />
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
        <option value="">All organisations</option>
        {sorted.map((o) => (
          <option key={o.org_id} value={o.org_id}>
            {o.org_name}
          </option>
        ))}
      </select>
    </label>
  );
}
