import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";

import { daysBetween, fmtDay, parseDay } from "@/items/ui";

/*
 * Body & Health's chart — a small themed SVG, because health charts need
 * things the shared kit doesn't draw: raw readings as dots under a smoothed
 * trend line, goal lines, a shaded healthy band, and blood-pressure
 * readings as sys↕dia bars coloured by AHA category. Touch/hover shows the
 * nearest day. All values arrive in display units.
 */

export interface ChartPoint {
  day: string;
  v: number;
  color?: string;
}
export interface ChartBar {
  day: string;
  hi: number;
  lo: number;
  color: string;
  label: string;
}

export function HealthChart({
  start,
  end,
  raw = [],
  trend = [],
  bars = [],
  columns = [],
  goals = [],
  band,
  height = 220,
  fmt,
  label,
  trendLabel = "Trend",
}: {
  start: string;
  end: string;
  raw?: ChartPoint[];
  trend?: ChartPoint[];
  bars?: ChartBar[];
  /** Daily totals drawn as columns from zero (water, steps, sleep). */
  columns?: ChartPoint[];
  goals?: { y: number; label: string }[];
  band?: { lo: number; hi: number; label: string };
  height?: number;
  fmt: (v: number) => string;
  label: string;
  trendLabel?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(200, Math.round(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const padL = 44;
  const padR = 10;
  const padT = 10;
  const padB = 24;
  const span = Math.max(1, daysBetween(start, end));
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const { yMin, yMax, ticks } = useMemo(() => {
    const vals: number[] = [];
    raw.forEach((p) => vals.push(p.v));
    trend.forEach((p) => vals.push(p.v));
    bars.forEach((b) => vals.push(b.hi, b.lo));
    columns.forEach((p) => vals.push(p.v));
    goals.forEach((g) => vals.push(g.y));
    if (band) vals.push(band.lo, band.hi);
    if (columns.length) vals.push(0);
    if (!vals.length) return { yMin: 0, yMax: 1, ticks: [0, 1] };
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (lo === hi) {
      lo -= 1;
      hi += 1;
    }
    const pad = (hi - lo) * 0.08;
    if (!columns.length) lo -= pad;
    hi += pad;
    const step = niceStep((hi - lo) / 4);
    const t0 = Math.ceil(lo / step) * step;
    const ts: number[] = [];
    for (let t = t0; t <= hi + 1e-9; t += step) ts.push(Number(t.toFixed(6)));
    return { yMin: lo, yMax: hi, ticks: ts };
  }, [raw, trend, bars, columns, goals, band]);

  const x = (day: string) => padL + (daysBetween(start, day) / span) * innerW;
  const y = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const xTicks = useMemo(() => {
    const n = Math.max(2, Math.min(6, Math.floor(innerW / 90)));
    const out: string[] = [];
    for (let i = 0; i <= n; i++) {
      const d = parseDay(start);
      d.setDate(d.getDate() + Math.round((span * i) / n));
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    }
    return out;
  }, [start, span, innerW]);

  const tickLabel = (day: string) => {
    const d = parseDay(day);
    return span > 200
      ? d.toLocaleDateString(undefined, { month: "short" })
      : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  };

  const days = useMemo(() => {
    const s = new Set<string>();
    raw.forEach((p) => s.add(p.day));
    bars.forEach((p) => s.add(p.day));
    columns.forEach((p) => s.add(p.day));
    trend.forEach((p) => s.add(p.day));
    return [...s].sort();
  }, [raw, bars, columns, trend]);

  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    if (!days.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = days[0];
    let bestD = Infinity;
    for (const d of days) {
      const dd = Math.abs(x(d) - px);
      if (dd < bestD) {
        bestD = dd;
        best = d;
      }
    }
    setHover(best);
  };

  const trendPath = trend.length > 1 ? trend.map((p, i) => `${i ? "L" : "M"}${x(p.day).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ") : "";
  const colW = Math.max(2, Math.min(18, (innerW / (span + 1)) * 0.7));
  const dotR = raw.length > 120 ? 2 : raw.length > 40 ? 2.5 : 3.5;
  const hovered = hover
    ? {
        raw: raw.filter((p) => p.day === hover),
        trend: trend.find((p) => p.day === hover),
        bars: bars.filter((p) => p.day === hover),
        col: columns.find((p) => p.day === hover),
      }
    : null;

  const empty = !raw.length && !trend.length && !bars.length && !columns.length;

  return (
    <div ref={box} className="relative w-full select-none" style={{ height }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={label}
        className="touch-pan-y"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {/* grid */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)" className="tabular-nums">
              {fmt(t)}
            </text>
          </g>
        ))}
        {xTicks.map((d, i) => (
          <text
            key={d + i}
            x={x(d)}
            y={height - 6}
            textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
            fontSize={11}
            fill="var(--text-muted)"
          >
            {tickLabel(d)}
          </text>
        ))}
        {band && (
          <rect
            x={padL}
            width={innerW}
            y={y(Math.min(yMax, band.hi))}
            height={Math.max(0, y(Math.max(yMin, band.lo)) - y(Math.min(yMax, band.hi)))}
            fill="color-mix(in srgb, var(--success) 10%, transparent)"
          />
        )}
        {goals.map((g) => (
          <g key={g.label + g.y}>
            <line x1={padL} x2={width - padR} y1={y(g.y)} y2={y(g.y)} stroke="var(--item-accent)" strokeWidth={1.5} strokeDasharray="5 4" />
            <text x={width - padR - 2} y={y(g.y) - 4} textAnchor="end" fontSize={10.5} fontWeight={600} fill="var(--item-accent)">
              {g.label}
            </text>
          </g>
        ))}
        {columns.map((p) => (
          <rect
            key={p.day}
            x={x(p.day) - colW / 2}
            width={colW}
            y={y(Math.max(0, p.v))}
            height={Math.max(0, y(0) - y(Math.max(0, p.v)))}
            rx={Math.min(4, colW / 2)}
            fill={p.color ?? "var(--item-accent)"}
            opacity={hover && hover !== p.day ? 0.55 : 0.9}
          />
        ))}
        {bars.map((b, i) => (
          <g key={b.day + i}>
            <line x1={x(b.day)} x2={x(b.day)} y1={y(b.hi)} y2={y(b.lo)} stroke={b.color} strokeWidth={Math.max(2.5, Math.min(6, colW * 0.6))} strokeLinecap="round" opacity={0.9} />
          </g>
        ))}
        {raw.map((p, i) => (
          <circle
            key={p.day + i}
            cx={x(p.day)}
            cy={y(p.v)}
            r={dotR}
            fill={p.color ?? (trend.length ? "var(--surface)" : "var(--item-accent)")}
            stroke={p.color ?? "var(--item-accent)"}
            strokeWidth={trend.length ? 1.5 : 0}
            opacity={trend.length ? 0.8 : 1}
          />
        ))}
        {trendPath && <path d={trendPath} fill="none" stroke="var(--item-accent)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />}
        {hover && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + innerH} stroke="var(--text-muted)" strokeOpacity={0.4} strokeDasharray="3 3" />}
      </svg>
      {empty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-[var(--text-muted)]">
          Nothing logged in this range yet
        </div>
      )}
      {hovered && hover && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-[120px] rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs shadow-[var(--shadow-md)]"
          style={x(hover) > width / 2 ? { right: width - x(hover) + 8 } : { left: x(hover) + 8 }}
          aria-live="polite"
        >
          <div className="text-[var(--text-muted)]">{fmtDay(hover)}</div>
          {hovered.bars.map((b, i) => (
            <div key={i} className="flex items-center gap-1.5 font-semibold tabular-nums text-[var(--text)]">
              <span className="h-2 w-2 rounded-full" style={{ background: b.color }} />
              {b.label}
            </div>
          ))}
          {hovered.col && <div className="font-semibold tabular-nums text-[var(--text)]">{fmt(hovered.col.v)}</div>}
          {hovered.raw.map((p, i) => (
            <div key={i} className="font-semibold tabular-nums text-[var(--text)]">
              {fmt(p.v)}
            </div>
          ))}
          {hovered.trend && (
            <div className="tabular-nums text-[var(--item-accent)]">
              {trendLabel} {fmt(hovered.trend.v)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
