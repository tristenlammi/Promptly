import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/*
 * Thin, themed wrappers over recharts so every item's charts look alike:
 * no chart junk, the item's accent, tabular tooltips that work by touch.
 * ``data`` is ``{ x: string; y: number; y2?: number }[]``.
 */

export interface Point {
  x: string;
  y: number | null;
  y2?: number | null;
}

const axis = { stroke: "var(--text-muted)", fontSize: 11, tickLine: false, axisLine: false } as const;

function Tip({ active, payload, label, unit }: { active?: boolean; payload?: { value: number; name: string }[]; label?: string; unit?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs shadow-[var(--shadow-md)]">
      <div className="text-[var(--text-muted)]">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="font-semibold tabular-nums text-[var(--text)]">
          {Number(p.value).toLocaleString(undefined, { maximumFractionDigits: 1 })}
          {unit ? ` ${unit}` : ""}
        </div>
      ))}
    </div>
  );
}

export function TrendChart({
  data,
  height = 180,
  unit,
  area = true,
  color = "var(--item-accent)",
  secondColor = "var(--text-muted)",
  yDomain,
}: {
  data: Point[];
  height?: number;
  unit?: string;
  area?: boolean;
  color?: string;
  secondColor?: string;
  yDomain?: [number | "auto" | "dataMin" | "dataMax", number | "auto" | "dataMin" | "dataMax"];
}) {
  const hasSecond = data.some((d) => d.y2 !== undefined && d.y2 !== null);
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        {area ? (
          <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="itemTrendFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="x" {...axis} minTickGap={24} />
            <YAxis {...axis} width={48} domain={yDomain ?? ["auto", "auto"]} />
            <Tooltip content={<Tip unit={unit} />} cursor={{ stroke: "var(--border)" }} />
            <Area type="monotone" dataKey="y" stroke={color} strokeWidth={2} fill="url(#itemTrendFill)" connectNulls dot={false} />
            {hasSecond && <Line type="monotone" dataKey="y2" stroke={secondColor} strokeDasharray="4 4" dot={false} connectNulls />}
          </AreaChart>
        ) : (
          <LineChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="x" {...axis} minTickGap={24} />
            <YAxis {...axis} width={48} domain={yDomain ?? ["auto", "auto"]} />
            <Tooltip content={<Tip unit={unit} />} cursor={{ stroke: "var(--border)" }} />
            <Line type="monotone" dataKey="y" stroke={color} strokeWidth={2} dot={{ r: 2.5 }} connectNulls />
            {hasSecond && <Line type="monotone" dataKey="y2" stroke={secondColor} strokeDasharray="4 4" dot={false} connectNulls />}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

export function Bars({
  data,
  height = 160,
  unit,
  color = "var(--item-accent)",
  yDomain,
}: {
  data: Point[];
  height?: number;
  unit?: string;
  color?: string;
  /** A fixed scale (e.g. [1, 5] for a mood average) instead of 0–max. */
  yDomain?: [number, number];
}) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="x" {...axis} minTickGap={8} />
          <YAxis {...axis} width={48} domain={yDomain ?? [0, "auto"]} />
          <Tooltip content={<Tip unit={unit} />} cursor={{ fill: "var(--hover)" }} />
          <Bar dataKey="y" fill={color} radius={[6, 6, 0, 0]} maxBarSize={36} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** A tiny inline trend (no axes) for stat cards and rows. */
export function Sparkline({ values, width = 80, height = 24, color = "var(--item-accent)" }: { values: number[]; width?: number; height?: number; color?: string }) {
  const v = values.filter((n) => Number.isFinite(n));
  if (v.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = max - min || 1;
  const pts = v.map((n, i) => `${(i / (v.length - 1)) * width},${height - 2 - ((n - min) / span) * (height - 4)}`).join(" ");
  return (
    <svg width={width} height={height} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** A GitHub-style year of days, coloured by ``level`` 0..4. */
export function Heatmap({
  days,
  weeks = 26,
  end,
  label,
}: {
  days: Record<string, number>; // YYYY-MM-DD → 0..4
  weeks?: number;
  end?: Date;
  label?: (day: string, level: number) => string;
}) {
  const last = end ? new Date(end) : new Date();
  const start = new Date(last);
  start.setDate(start.getDate() - (weeks * 7 - 1) - ((start.getDay() + 6) % 7 === 6 ? 0 : 6 - ((start.getDay() + 6) % 7)));
  const cols: { day: string; level: number }[][] = [];
  const cur = new Date(start);
  while (cur <= last) {
    const col: { day: string; level: number }[] = [];
    for (let i = 0; i < 7 && cur <= last; i++) {
      const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
      col.push({ day: key, level: days[key] ?? 0 });
      cur.setDate(cur.getDate() + 1);
    }
    cols.push(col);
  }
  const shade = ["var(--surface-2)", "color-mix(in srgb, var(--item-accent) 30%, var(--surface-2))", "color-mix(in srgb, var(--item-accent) 55%, var(--surface-2))", "color-mix(in srgb, var(--item-accent) 78%, var(--surface-2))", "var(--item-accent)"];
  return (
    <div
      ref={(el) => {
        if (el) el.scrollLeft = el.scrollWidth;
      }}
      className="flex gap-[3px] overflow-x-auto"
      role="img"
      aria-label="Activity by day"
    >
      {cols.map((col, i) => (
        <div key={i} className="flex flex-col gap-[3px]">
          {col.map((c) => (
            <span
              key={c.day}
              title={label ? label(c.day, c.level) : c.day}
              className="h-3 w-3 rounded-[3px]"
              style={{ background: shade[Math.max(0, Math.min(4, c.level))] }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
