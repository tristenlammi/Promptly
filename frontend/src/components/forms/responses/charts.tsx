import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/*
 * The Responses summary's two charts, one series each in the app's accent:
 * horizontal bars for choices (count and % at the bar's end) and columns
 * for scales and ratings. Text stays in the text colours; the bars carry
 * the accent. Each chart is drawn for sighted readers only — the same
 * numbers are in a table for screen readers right beside it.
 */

export interface ChoiceRow {
  key: string;
  label: string;
  count: number;
  /** "2/2 (full)" for an option with places. */
  note?: string;
  muted?: boolean;
}

const tick = { fill: "var(--text-muted)", fontSize: 12 } as const;

function pct(n: number, of: number): string {
  return of > 0 ? `${Math.round((n / of) * 100)}%` : "0%";
}

function short(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function ChoiceTip({ active, payload, of }: { active?: boolean; payload?: { payload: ChoiceRow }[]; of: number }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="max-w-[16rem] rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs shadow-[var(--shadow-md)]">
      <div className="break-words text-[var(--text)]">{row.label}</div>
      <div className="font-semibold tabular-nums text-[var(--text)]">
        {row.count} · {pct(row.count, of)}
        {row.note ? <span className="font-normal text-[var(--text-muted)]"> · {row.note}</span> : null}
      </div>
    </div>
  );
}

/** Horizontal bars: one per option, with "count · %" at the end. ``of`` is
 *  how many answered the question (percentages are of those). */
export function ChoiceBars({ rows, of, narrow }: { rows: ChoiceRow[]; of: number; narrow: boolean }) {
  const labelWidth = narrow ? 104 : 168;
  const data = rows.map((r) => ({ ...r, axis: short(r.note ? `${r.label} · ${r.note}` : r.label, narrow ? 15 : 26), end: `${r.count} · ${pct(r.count, of)}` }));
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div aria-hidden="true" style={{ height: rows.length * 34 + 8 }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart accessibilityLayer={false} data={data} layout="vertical" margin={{ top: 4, right: 72, bottom: 4, left: 0 }} barCategoryGap={8}>
          <XAxis type="number" hide domain={[0, max]} allowDecimals={false} />
          <YAxis type="category" dataKey="axis" width={labelWidth} tick={tick} tickLine={false} axisLine={false} interval={0} />
          <Tooltip content={<ChoiceTip of={of} />} cursor={{ fill: "var(--hover)" }} />
          <Bar dataKey="count" radius={[0, 4, 4, 0]} minPointSize={2} isAnimationActive={false}>
            {data.map((r) => (
              <Cell key={r.key} fill={r.muted ? "var(--text-muted)" : "var(--accent)"} fillOpacity={r.muted ? 0.45 : 1} />
            ))}
            <LabelList dataKey="end" position="right" style={{ fill: "var(--text)", fontSize: 12 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ColumnTip({ active, payload, of }: { active?: boolean; payload?: { payload: { value: number | string; count: number } }[]; of: number }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs shadow-[var(--shadow-md)]">
      <div className="text-[var(--text-muted)]">{p.value}</div>
      <div className="font-semibold tabular-nums text-[var(--text)]">
        {p.count} · {pct(p.count, of)}
      </div>
    </div>
  );
}

/** Columns for a scale or rating: one per value, counts on top. */
export function ScaleColumns({ bins, of }: { bins: { value: number; count: number }[]; of: number }) {
  const max = Math.max(1, ...bins.map((b) => b.count));
  return (
    <div aria-hidden="true" className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart accessibilityLayer={false} data={bins} margin={{ top: 18, right: 4, bottom: 0, left: 4 }} barCategoryGap="18%">
          <XAxis dataKey="value" tick={tick} tickLine={false} axisLine={{ stroke: "var(--border)" }} interval={0} />
          <YAxis hide domain={[0, max]} allowDecimals={false} />
          <Tooltip content={<ColumnTip of={of} />} cursor={{ fill: "var(--hover)" }} />
          <Bar dataKey="count" fill="var(--accent)" radius={[4, 4, 0, 0]} minPointSize={2} isAnimationActive={false}>
            <LabelList dataKey="count" position="top" style={{ fill: "var(--text)", fontSize: 12 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** A quiz's histogram: one column per score (or range of scores). */
export function HistogramColumns({ bins, of }: { bins: { label: string; count: number }[]; of: number }) {
  const max = Math.max(1, ...bins.map((b) => b.count));
  const data = bins.map((b) => ({ value: b.label, count: b.count }));
  return (
    <div aria-hidden="true" className="mt-2 h-36 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart accessibilityLayer={false} data={data} margin={{ top: 18, right: 4, bottom: 0, left: 4 }} barCategoryGap="14%">
          <XAxis dataKey="value" tick={tick} tickLine={false} axisLine={{ stroke: "var(--border)" }} interval={0} />
          <YAxis hide domain={[0, max]} allowDecimals={false} />
          <Tooltip content={<ColumnTip of={of} />} cursor={{ fill: "var(--hover)" }} />
          <Bar dataKey="count" fill="var(--accent)" radius={[4, 4, 0, 0]} minPointSize={2} isAnimationActive={false}>
            <LabelList dataKey="count" position="top" style={{ fill: "var(--text)", fontSize: 12 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export { pct };
