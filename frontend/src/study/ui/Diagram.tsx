import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { Diagram as DiagramSpec, DiagramNode } from "@/api/study";
import { cn } from "@/utils/cn";

/*
 * The teacher's diagrams, drawn by the app from a small checked spec (never
 * markup from the model): flow, cycle, tree, timeline, compare, bars.
 * Boxes are real elements (text wraps, a tap shows the note); the lines
 * between them are one SVG underneath.
 */

export interface Placed {
  id: string;
  /** Centre, px. */
  x: number;
  y: number;
}

const BOX_H = 58;
const ROW_GAP = 44;

/** Rows for a flow: each node one row below the furthest thing that leads to
 *  it. An edge that loops back to something earlier doesn't push it down. */
export function flowRows(nodes: { id: string }[], edges: { from: string; to: string }[]): string[][] {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, string[]>();
  for (const e of edges) if (ids.has(e.from) && ids.has(e.to) && e.from !== e.to) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  // Walk from each node in the order given; an edge to a node still being
  // walked is a loop back and is left out.
  const into = new Map<string, string[]>();
  const state = new Map<string, 1 | 2>();
  const walk = (id: string) => {
    state.set(id, 1);
    for (const to of out.get(id) ?? []) {
      if (state.get(to) === 1) continue;
      into.set(to, [...(into.get(to) ?? []), id]);
      if (!state.has(to)) walk(to);
    }
    state.set(id, 2);
  };
  for (const n of nodes) if (!state.has(n.id)) walk(n.id);
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    const d = depth.get(id);
    if (d !== undefined) return d;
    let best = 0;
    for (const p of into.get(id) ?? []) best = Math.max(best, depthOf(p) + 1);
    depth.set(id, best);
    return best;
  };
  const rows: string[][] = [];
  for (const n of nodes) (rows[depthOf(n.id)] ??= []).push(n.id);
  return rows.filter(Boolean);
}

/** Rows for a tree, each row in an order that keeps children under their parent. */
export function treeRows(nodes: { id: string; parent: string | null }[]): string[][] {
  const kids = new Map<string | null, string[]>();
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const p = n.parent && ids.has(n.parent) && n.parent !== n.id ? n.parent : null;
    kids.set(p, [...(kids.get(p) ?? []), n.id]);
  }
  const rows: string[][] = [];
  const seen = new Set<string>();
  const walk = (id: string, d: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    (rows[d] ??= []).push(id);
    for (const k of kids.get(id) ?? []) walk(k, d + 1);
  };
  for (const r of kids.get(null) ?? []) walk(r, 0);
  return rows.filter(Boolean);
}

function placeRows(rows: string[][], width: number, boxW: number): { placed: Record<string, Placed>; height: number } {
  const placed: Record<string, Placed> = {};
  rows.forEach((row, r) => {
    const y = r * (BOX_H + ROW_GAP) + BOX_H / 2;
    row.forEach((id, i) => {
      const slot = width / row.length;
      placed[id] = { id, x: Math.max(boxW / 2, Math.min(width - boxW / 2, slot * (i + 0.5))), y };
    });
  });
  return { placed, height: Math.max(BOX_H, rows.length * (BOX_H + ROW_GAP) - ROW_GAP) };
}

function placeCycle(ids: string[], width: number, boxW: number): { placed: Record<string, Placed>; height: number } {
  const n = ids.length;
  const rx = Math.max(40, width / 2 - boxW / 2 - 2);
  const ry = Math.max(70, Math.min(170, n * 30));
  const placed: Record<string, Placed> = {};
  ids.forEach((id, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    placed[id] = { id, x: width / 2 + rx * Math.cos(a), y: ry + BOX_H / 2 + ry * Math.sin(a) };
  });
  return { placed, height: ry * 2 + BOX_H };
}

/** Where the line from ``a`` towards ``b`` leaves a box centred on ``a``. */
export function clipToBox(a: Placed, b: Placed, w: number, h: number): { x: number; y: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return { x: a.x, y: a.y };
  const sx = dx === 0 ? Infinity : w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: a.x + dx * s, y: a.y + dy * s };
}

function useWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function Graph({ spec }: { spec: Extract<DiagramSpec, { type: "flow" | "cycle" | "tree" }> }) {
  const [ref, width] = useWidth();
  const [picked, setPicked] = useState<string | null>(null);
  const marker = useId().replace(/:/g, "");
  const nodes: DiagramNode[] = spec.nodes;
  const edges = useMemo(
    () =>
      spec.type === "tree"
        ? spec.nodes.filter((n) => n.parent).map((n) => ({ from: n.parent as string, to: n.id, label: "" }))
        : spec.edges,
    [spec]
  );
  const widest = useMemo(() => {
    if (spec.type === "cycle") return 2;
    const rows = spec.type === "tree" ? treeRows(spec.nodes) : flowRows(spec.nodes, spec.edges);
    return Math.max(1, ...rows.map((r) => r.length));
  }, [spec]);
  const w = width || 320;
  const boxW = Math.max(74, Math.min(168, spec.type === "cycle" ? w * 0.3 : (w - 8 * (widest - 1)) / widest));
  const { placed, height } = useMemo(() => {
    if (spec.type === "cycle") return placeCycle(spec.nodes.map((n) => n.id), w, boxW);
    return placeRows(spec.type === "tree" ? treeRows(spec.nodes) : flowRows(spec.nodes, spec.edges), w, boxW);
  }, [spec, w, boxW]);
  const note = nodes.find((n) => n.id === picked)?.note;

  return (
    <div>
      <div ref={ref} className="relative w-full" style={{ height }}>
        <svg width={w} height={height} className="absolute inset-0" aria-hidden>
          <defs>
            <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--st-accent)" />
            </marker>
          </defs>
          {width > 0 &&
            edges.map((e, i) => {
              const a = placed[e.from];
              const b = placed[e.to];
              if (!a || !b) return null;
              const p = clipToBox(a, b, boxW, BOX_H);
              const q = clipToBox(b, a, boxW + 8, BOX_H + 8);
              const len = Math.hypot(q.x - p.x, q.y - p.y);
              return (
                <g key={i}>
                  <line
                    className="study-draw"
                    style={{ ["--len" as string]: len, animationDelay: `${120 + i * 70}ms` }}
                    x1={p.x}
                    y1={p.y}
                    x2={q.x}
                    y2={q.y}
                    stroke="var(--st-accent)"
                    strokeWidth={1.75}
                    markerEnd={spec.type === "tree" ? undefined : `url(#${marker})`}
                  />
                  {e.label && (
                    <text
                      x={(p.x + q.x) / 2}
                      y={(p.y + q.y) / 2 - 4}
                      textAnchor="middle"
                      fontSize="11"
                      fill="var(--text-muted)"
                      stroke="var(--surface)"
                      strokeWidth={3}
                      paintOrder="stroke"
                    >
                      {e.label}
                    </text>
                  )}
                </g>
              );
            })}
        </svg>
        {width > 0 &&
          nodes.map((n, i) => {
            const p = placed[n.id];
            if (!p) return null;
            const Tag = n.note ? "button" : "div";
            return (
              <Tag
                key={n.id}
                {...(n.note ? { type: "button" as const, onClick: () => setPicked(picked === n.id ? null : n.id), "aria-expanded": picked === n.id } : {})}
                className={cn(
                  "study-in absolute flex items-center justify-center rounded-xl border bg-[var(--surface)] px-2 text-center text-xs font-medium leading-tight text-[var(--text)]",
                  picked === n.id ? "border-[var(--st-accent)] ring-2 ring-[var(--st-soft)]" : "border-[var(--st-line)]",
                  n.note && "cursor-pointer hover:border-[var(--st-accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]"
                )}
                style={{ left: p.x - boxW / 2, top: p.y - BOX_H / 2, width: boxW, height: BOX_H, animationDelay: `${i * 60}ms` }}
              >
                <span className="line-clamp-3">{n.label}</span>
              </Tag>
            );
          })}
      </div>
      <p aria-live="polite" className={cn("mt-2 min-h-[1.25rem] text-center text-xs text-[var(--text-muted)]", !note && nodes.some((n) => n.note) && "italic")}>
        {note ?? (nodes.some((n) => n.note) ? "Tap a box to see more" : "")}
      </p>
    </div>
  );
}

function Timeline({ spec }: { spec: Extract<DiagramSpec, { type: "timeline" }> }) {
  return (
    <ol className="relative ml-2 border-l-2 border-[var(--st-line)] pl-5">
      {spec.items.map((it, i) => (
        <li key={i} className="study-in relative pb-4 last:pb-0" style={{ animationDelay: `${i * 70}ms` }}>
          <span aria-hidden className="absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-[var(--surface)] bg-[var(--st-accent)]" />
          {it.when && <p className="text-xs font-semibold uppercase tracking-wide text-[var(--st-accent-text)]">{it.when}</p>}
          <p className="text-sm font-medium text-[var(--text)]">{it.label}</p>
          {it.note && <p className="text-xs text-[var(--text-muted)]">{it.note}</p>}
        </li>
      ))}
    </ol>
  );
}

function Compare({ spec }: { spec: Extract<DiagramSpec, { type: "compare" }> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className="w-[26%] p-2" />
            {spec.columns.map((c, i) => (
              <th key={i} scope="col" className="rounded-t-lg bg-[var(--st-soft)] p-2 text-left font-semibold text-[var(--st-accent-text)]">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((r, i) => (
            <tr key={i} className="study-in" style={{ animationDelay: `${i * 60}ms` }}>
              <th scope="row" className="border-t border-[var(--border)] p-2 text-left text-xs font-semibold text-[var(--text-muted)]">
                {r.label}
              </th>
              {spec.columns.map((_, c) => (
                <td key={c} className="border-t border-[var(--border)] p-2 align-top text-[var(--text)]">
                  {r.cells[c] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bars({ spec }: { spec: Extract<DiagramSpec, { type: "bars" }> }) {
  const max = Math.max(1e-9, ...spec.bars.map((b) => Math.abs(b.value)));
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));
  return (
    <ul className="flex flex-col gap-2">
      {spec.bars.map((b, i) => (
        <li key={i} className="grid grid-cols-[minmax(0,34%)_1fr_auto] items-center gap-2 text-sm">
          <span className="truncate text-[var(--text)]">{b.label}</span>
          <span className="study-bar block h-4 overflow-hidden rounded-md bg-[var(--hover-strong)]">
            <BarFill pct={(Math.abs(b.value) / max) * 100} />
          </span>
          <span className="tabular-nums text-xs text-[var(--text-muted)]">
            {fmt(b.value)}
            {spec.unit ? ` ${spec.unit}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Starts at nothing and grows to its size, so the bars feel alive. */
function BarFill({ pct }: { pct: number }) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setW(pct));
    return () => cancelAnimationFrame(id);
  }, [pct]);
  return <i style={{ width: `${w}%`, background: "var(--st-accent)" }} />;
}

/** What the picture shows, in words, for a screen reader. */
export function describeDiagram(spec: DiagramSpec): string {
  switch (spec.type) {
    case "flow":
    case "cycle": {
      const name = new Map(spec.nodes.map((n) => [n.id, n.label]));
      const steps = spec.edges.map((e) => `${name.get(e.from)} leads to ${name.get(e.to)}${e.label ? ` (${e.label})` : ""}`);
      return `${spec.type === "cycle" ? "A cycle" : "A flow"}: ${steps.join("; ") || spec.nodes.map((n) => n.label).join(", ")}.`;
    }
    case "tree": {
      const name = new Map(spec.nodes.map((n) => [n.id, n.label]));
      return `A tree: ${spec.nodes.map((n) => (n.parent ? `${n.label} under ${name.get(n.parent)}` : `${n.label} at the top`)).join("; ")}.`;
    }
    case "timeline":
      return `A timeline: ${spec.items.map((i) => `${i.when ? `${i.when}, ` : ""}${i.label}`).join("; ")}.`;
    case "compare":
      return `A comparison of ${spec.columns.join(" and ")}.`;
    case "bars":
      return `A bar chart: ${spec.bars.map((b) => `${b.label} ${b.value}${spec.unit ? ` ${spec.unit}` : ""}`).join("; ")}.`;
  }
}

export function Diagram({ spec }: { spec: DiagramSpec }) {
  const graph = spec.type === "flow" || spec.type === "cycle" || spec.type === "tree";
  return (
    <figure className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:p-4" data-testid={`diagram-${spec.type}`}>
      {spec.title && <figcaption className="mb-3 text-sm font-semibold text-[var(--text)]">{spec.title}</figcaption>}
      {graph && <p className="sr-only">{describeDiagram(spec)}</p>}
      {spec.type === "timeline" ? (
        <Timeline spec={spec} />
      ) : spec.type === "compare" ? (
        <Compare spec={spec} />
      ) : spec.type === "bars" ? (
        <Bars spec={spec} />
      ) : (
        <Graph spec={spec} />
      )}
    </figure>
  );
}
