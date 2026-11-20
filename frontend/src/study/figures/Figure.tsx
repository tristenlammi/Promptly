import { Check, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { Control, Figure as FigureSpec, FigureAnswer } from "@/api/study";
import { cn } from "@/utils/cn";

import { compile, evaluate, ExprError, value as exprValue } from "./expr";

/*
 * The figures a learner can work: a plot with sliders, a scale with a point
 * to drag, a picture made of labelled parts, and a "what happens if" table.
 * Each is drawn here from plain data the server has already checked; the
 * formulas go through ./expr (no eval). Every control is a real range input
 * or button, so touch, mouse, keyboard and screen readers all work.
 */

/** Where the learner has the figure set. */
export interface FigureState {
  /** Slider name → value (plot, table). */
  values: Record<string, number>;
  /** The point on a scale. */
  value: number;
  /** The part tapped. */
  partId: string | null;
  /** They have moved something (an untouched figure isn't an answer). */
  touched: boolean;
}

export const controlsOf = (spec: FigureSpec): Control[] => (spec.type === "plot" ? spec.params : spec.type === "table" ? spec.inputs : []);

export function initialFigureState(spec: FigureSpec): FigureState {
  return {
    values: Object.fromEntries(controlsOf(spec).map((c) => [c.name, c.value])),
    value: spec.type === "scale" ? spec.value : 0,
    partId: null,
    touched: false,
  };
}

/** The ``answer`` an explore step sends for this figure. */
export function figureAnswer(spec: FigureSpec, s: FigureState): FigureAnswer {
  if (spec.type === "parts") return { part_id: s.partId ?? "" };
  if (spec.type === "scale") return { value: s.value };
  return { values: Object.fromEntries(controlsOf(spec).map((c) => [c.name, s.values[c.name] ?? c.value])) };
}

/** The state that shows an answer (the learner's own, or the right one). */
export function stateFromAnswer(spec: FigureSpec, a: Record<string, unknown> | null | undefined): FigureState {
  const s = initialFigureState(spec);
  if (!a) return s;
  if (typeof a.part_id === "string") s.partId = a.part_id;
  if (typeof a.value === "number") s.value = a.value;
  if (a.values && typeof a.values === "object") {
    for (const [k, v] of Object.entries(a.values as Record<string, unknown>)) if (typeof v === "number" && k in s.values) s.values[k] = v;
  }
  s.touched = true;
  return s;
}

const tidy = (v: number) => Number(v.toPrecision(10));

/** A number as people write it: no binary tail, no needless zeros. */
export function fmt(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return "–";
  const r = Number(v.toFixed(decimals));
  return (Object.is(r, -0) ? 0 : r).toLocaleString(undefined, { maximumFractionDigits: decimals });
}

/** Round "nice" tick values across a range (4–6 of them). */
export function ticks(min: number, max: number, want = 5): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / want;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= want + 1) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(tidy(v));
  return out;
}

/** The plot's curve as runs of points (a gap where the formula has no value). */
export function curve(spec: Extract<FigureSpec, { type: "plot" }>, values: Record<string, number>, samples = 96): { x: number; y: number }[][] {
  const tree = compile(spec.expr);
  if (!tree) return [];
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const x = spec.x.min + ((spec.x.max - spec.x.min) * i) / samples;
    let y: number | null = null;
    try {
      y = evaluate(tree, { ...values, x });
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
    }
    if (y === null) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push({ x, y });
  }
  if (run.length) runs.push(run);
  return runs;
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

// ------------------------------------------------------------------ slider

function Slider({ c, value, onChange, disabled, ghost }: { c: Control; value: number; onChange: (v: number) => void; disabled?: boolean; ghost?: number }) {
  const id = useId();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
      <label htmlFor={id} className="truncate text-sm font-medium text-[var(--text)]">
        {c.label}
      </label>
      <output htmlFor={id} className="text-sm tabular-nums text-[var(--text)]" data-testid={`fig-value-${c.name}`}>
        {fmt(value, 3)}
        {c.unit ? ` ${c.unit}` : ""}
        {ghost !== undefined && ghost !== value && (
          <span className="ml-2 text-[var(--st-good)]">
            → {fmt(ghost, 3)}
            {c.unit ? ` ${c.unit}` : ""}
          </span>
        )}
      </output>
      <input
        id={id}
        type="range"
        className="study-range col-span-2"
        min={c.min}
        max={c.max}
        step={c.step}
        value={value}
        disabled={disabled}
        data-testid={`fig-slider-${c.name}`}
        aria-valuetext={`${fmt(value, 3)}${c.unit ? ` ${c.unit}` : ""}`}
        onChange={(e) => onChange(tidy(Number(e.target.value)))}
      />
    </div>
  );
}

// -------------------------------------------------------------------- plot

function Plot({
  spec,
  state,
  set,
  locked,
  targets,
  solution,
}: {
  spec: Extract<FigureSpec, { type: "plot" }>;
  state: FigureState;
  set: (s: FigureState) => void;
  locked?: boolean;
  targets?: { x: number; y: number }[];
  solution?: Record<string, number>;
}) {
  const [ref, width] = useWidth();
  const W = Math.max(260, width || 320);
  const H = Math.round(Math.min(300, Math.max(190, W * 0.58)));
  const pad = { l: 42, r: 12, t: 12, b: 34 };
  const sx = (x: number) => pad.l + ((x - spec.x.min) / (spec.x.max - spec.x.min)) * (W - pad.l - pad.r);
  const sy = (y: number) => H - pad.b - ((y - spec.y.min) / (spec.y.max - spec.y.min)) * (H - pad.t - pad.b);
  const path = (runs: { x: number; y: number }[][]) =>
    runs
      .map((run) => run.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(Math.max(spec.y.min - 1e6, Math.min(spec.y.max + 1e6, p.y))).toFixed(1)}`).join(""))
      .join("");
  const mine = useMemo(() => curve(spec, state.values), [spec, state.values]);
  const right = useMemo(() => (solution ? curve(spec, solution) : []), [spec, solution]);
  const xt = ticks(spec.x.min, spec.x.max);
  const yt = ticks(spec.y.min, spec.y.max);
  const clip = useId();
  const words = `A plot of ${spec.y.label} against ${spec.x.label}. ${spec.params.map((p) => `${p.label} is ${fmt(state.values[p.name], 3)}`).join(", ")}.${
    targets?.length ? ` The curve must pass through ${targets.map((t) => `${spec.x.label} ${fmt(t.x)}, ${spec.y.label} ${fmt(t.y)}`).join(" and ")}.` : ""
  }`;
  return (
    <div className="flex flex-col gap-3">
      <div ref={ref}>
        <svg width={W} height={H} role="img" aria-label={words} className="block max-w-full" data-testid="fig-plot">
          <defs>
            <clipPath id={clip}>
              <rect x={pad.l} y={pad.t} width={W - pad.l - pad.r} height={H - pad.t - pad.b} />
            </clipPath>
          </defs>
          {yt.map((v) => (
            <g key={`y${v}`}>
              <line x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} stroke="var(--st-line)" strokeWidth={v === 0 ? 1.2 : 0.5} />
              <text x={pad.l - 6} y={sy(v) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">
                {fmt(v)}
              </text>
            </g>
          ))}
          {xt.map((v) => (
            <g key={`x${v}`}>
              <line x1={sx(v)} x2={sx(v)} y1={pad.t} y2={H - pad.b} stroke="var(--st-line)" strokeWidth={v === 0 ? 1.2 : 0.5} />
              <text x={sx(v)} y={H - pad.b + 14} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
                {fmt(v)}
              </text>
            </g>
          ))}
          <text x={(pad.l + W - pad.r) / 2} y={H - 3} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
            {spec.x.label}
          </text>
          <text x={11} y={(pad.t + H - pad.b) / 2} textAnchor="middle" fontSize="11" fill="var(--text-muted)" transform={`rotate(-90 11 ${(pad.t + H - pad.b) / 2})`}>
            {spec.y.label}
          </text>
          <g clipPath={`url(#${clip})`}>
            {right.length > 0 && <path d={path(right)} fill="none" stroke="var(--st-good)" strokeWidth={2} strokeDasharray="5 4" data-testid="fig-plot-solution" />}
            <path d={path(mine)} fill="none" stroke="var(--st-accent)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
          </g>
          {targets?.map((t, i) => (
            <g key={i} data-testid="fig-plot-target">
              <circle cx={sx(t.x)} cy={sy(t.y)} r={8} fill="none" stroke="var(--text)" strokeWidth={1.5} />
              <circle cx={sx(t.x)} cy={sy(t.y)} r={2.5} fill="var(--text)" />
            </g>
          ))}
        </svg>
      </div>
      {spec.params.map((c) => (
        <Slider
          key={c.name}
          c={c}
          value={state.values[c.name] ?? c.value}
          disabled={locked}
          ghost={solution?.[c.name]}
          onChange={(v) => set({ ...state, values: { ...state.values, [c.name]: v }, touched: true })}
        />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------- scale

function Scale({
  spec,
  state,
  set,
  locked,
  solution,
}: {
  spec: Extract<FigureSpec, { type: "scale" }>;
  state: FigureState;
  set: (s: FigureState) => void;
  locked?: boolean;
  solution?: number;
}) {
  const id = useId();
  const pct = (v: number) => `${((v - spec.min) / (spec.max - spec.min)) * 100}%`;
  const read = spec.readout ? exprValue(spec.readout.expr, { v: state.value }) : null;
  const text = `${fmt(state.value, 3)}${spec.unit ? ` ${spec.unit}` : ""}`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm text-[var(--text-muted)]">
          Drag the point
        </label>
        <output htmlFor={id} className="text-lg font-semibold tabular-nums text-[var(--text)]" data-testid="fig-scale-value">
          {text}
        </output>
      </div>
      <div className="relative px-[11px] pb-9 pt-1">
        <input
          id={id}
          type="range"
          className="study-range study-range-big -mx-[11px] w-[calc(100%+22px)]"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={state.value}
          disabled={locked}
          data-testid="fig-scale"
          aria-valuetext={text}
          onChange={(e) => set({ ...state, value: tidy(Number(e.target.value)), touched: true })}
        />
        <div className="pointer-events-none relative h-8" aria-hidden>
          {[spec.min, spec.max].map((v) => (
            <span key={v} className="absolute top-1 -translate-x-1/2 text-[11px] tabular-nums text-[var(--text-muted)]" style={{ left: pct(v) }}>
              {fmt(v)}
            </span>
          ))}
          {spec.marks
            .filter((m) => m.value !== spec.min && m.value !== spec.max)
            .map((m, i) => (
              <span key={i} className="absolute top-0 flex -translate-x-1/2 flex-col items-center" style={{ left: pct(m.value) }}>
                <i className="h-2 w-px bg-[var(--text-muted)]" />
                <span className="max-w-[7rem] truncate text-[11px] text-[var(--text-muted)]">{m.label}</span>
              </span>
            ))}
          {solution !== undefined && (
            <span className="absolute -top-[26px] flex -translate-x-1/2 flex-col items-center" style={{ left: pct(solution) }} data-testid="fig-scale-solution">
              <i className="h-5 w-[3px] rounded bg-[var(--st-good)]" />
            </span>
          )}
        </div>
        {spec.marks.some((m) => m.value === spec.min || m.value === spec.max) && (
          <p className="sr-only">{spec.marks.map((m) => `${m.label} at ${fmt(m.value)}`).join(", ")}</p>
        )}
      </div>
      {spec.readout && (
        <p className="text-sm text-[var(--text)]" data-testid="fig-scale-readout">
          <span className="text-[var(--text-muted)]">{spec.readout.label}: </span>
          <span className="font-medium tabular-nums">
            {read === null ? "–" : fmt(read, spec.readout.decimals)}
            {spec.readout.unit ? ` ${spec.readout.unit}` : ""}
          </span>
        </p>
      )}
      {solution !== undefined && (
        <p className="text-sm text-[var(--st-good)]">
          It belongs at {fmt(solution, 3)}
          {spec.unit ? ` ${spec.unit}` : ""}.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- parts

function Parts({
  spec,
  state,
  set,
  locked,
  pick,
  solution,
}: {
  spec: Extract<FigureSpec, { type: "parts" }>;
  state: FigureState;
  set: (s: FigureState) => void;
  locked?: boolean;
  /** An explore step: tapping a part is the answer. Otherwise tapping shows its note. */
  pick?: boolean;
  solution?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = pick ? state.partId : open;
  const n = spec.parts.length;
  const wrap =
    spec.layout === "layers"
      ? "flex flex-col gap-1.5"
      : spec.layout === "row"
        ? "grid gap-1.5 [grid-template-columns:repeat(auto-fit,minmax(5.5rem,1fr))]"
        : spec.layout === "grid"
          ? "grid grid-cols-2 gap-1.5 sm:grid-cols-3"
          : "flex flex-col items-center gap-1.5";
  const note = spec.parts.find((p) => p.id === shown)?.note;
  return (
    <div className="flex flex-col gap-3">
      <div className={wrap} role={pick ? "radiogroup" : "group"} aria-label={spec.title || "Parts"} data-testid="fig-parts">
        {spec.parts.map((p, i) => {
          const chosen = shown === p.id;
          const right = solution === p.id;
          const wrong = solution !== undefined && state.partId === p.id && !right;
          // Rings: outermost first, each one narrower, so they read as nested.
          const style = spec.layout === "rings" ? { width: `${100 - (i * 62) / Math.max(1, n - 1)}%` } : undefined;
          return (
            <button
              key={p.id}
              type="button"
              role={pick ? "radio" : undefined}
              aria-checked={pick ? chosen : undefined}
              aria-pressed={pick ? undefined : chosen}
              disabled={pick ? locked : false}
              style={style}
              data-testid={`fig-part-${p.id}`}
              onClick={() => (pick ? set({ ...state, partId: p.id, touched: true }) : setOpen(chosen ? null : p.id))}
              className={cn(
                "study-press flex min-h-[2.75rem] items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-center text-sm font-medium transition-colors",
                spec.layout === "rings" && "rounded-full",
                right
                  ? "border-[var(--st-good-border)] bg-[var(--st-good-bg)] text-[var(--text)]"
                  : wrong
                    ? "border-[var(--st-bad-border)] bg-[var(--st-bad-bg)] text-[var(--text)]"
                    : chosen
                      ? "border-[var(--st-accent)] bg-[var(--st-soft)] text-[var(--text)]"
                      : "border-[var(--border)] bg-[var(--bg)] text-[var(--text)] hover:bg-[var(--hover)]",
              )}
            >
              {right && <Check aria-hidden className="h-4 w-4 text-[var(--st-good)]" />}
              {wrong && <X aria-hidden className="h-4 w-4 text-[var(--st-bad)]" />}
              <span>{p.label}</span>
              {right && <span className="sr-only"> (the right part)</span>}
              {wrong && <span className="sr-only"> (your pick)</span>}
            </button>
          );
        })}
      </div>
      {note ? (
        <p className="rounded-xl bg-[var(--st-softer)] px-3 py-2 text-sm text-[var(--text)]" aria-live="polite" data-testid="fig-part-note">
          <span className="font-semibold">{spec.parts.find((p) => p.id === shown)?.label}: </span>
          {note}
        </p>
      ) : (
        !pick && <p className="text-xs text-[var(--text-muted)]">Tap a part to see what it does.</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- table

function Table({
  spec,
  state,
  set,
  locked,
  solution,
}: {
  spec: Extract<FigureSpec, { type: "table" }>;
  state: FigureState;
  set: (s: FigureState) => void;
  locked?: boolean;
  solution?: Record<string, number>;
}) {
  return (
    <div className="flex flex-col gap-3">
      {spec.inputs.map((c) => (
        <Slider
          key={c.name}
          c={c}
          value={state.values[c.name] ?? c.value}
          disabled={locked}
          ghost={solution?.[c.name]}
          onChange={(v) => set({ ...state, values: { ...state.values, [c.name]: v }, touched: true })}
        />
      ))}
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 rounded-xl bg-[var(--st-softer)] px-3 py-2.5" aria-live="polite" data-testid="fig-table">
        {spec.outputs.map((o, i) => {
          const v = exprValue(o.expr, state.values);
          return (
            <div key={i} className="contents">
              <dt className="text-sm text-[var(--text-muted)]">{o.label}</dt>
              <dd className="text-right text-base font-semibold tabular-nums text-[var(--text)]" data-testid={`fig-out-${i}`}>
                {v === null ? "–" : fmt(v, o.decimals)}
                {o.unit ? ` ${o.unit}` : ""}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------ figure

export interface FigureProps {
  spec: FigureSpec;
  /** Controlled (an explore step). Left out, the figure keeps its own state (an explanation). */
  state?: FigureState;
  onChange?: (s: FigureState) => void;
  locked?: boolean;
  /** An explore step on a parts figure: tapping a part answers. */
  pick?: boolean;
  targets?: { x: number; y: number }[];
  /** Shown once answered. */
  solution?: FigureAnswer;
}

export function Figure({ spec, state, onChange, locked, pick, targets, solution }: FigureProps) {
  const [own, setOwn] = useState<FigureState>(() => initialFigureState(spec));
  const s = state ?? own;
  const set = (next: FigureState) => (onChange ? onChange(next) : setOwn(next));
  const sol = solution as { values?: Record<string, number>; value?: number; part_id?: string } | undefined;
  return (
    <figure className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:p-4" data-testid={`figure-${spec.type}`}>
      {spec.title && <figcaption className="mb-3 text-sm font-semibold text-[var(--text)]">{spec.title}</figcaption>}
      {spec.type === "plot" ? (
        <Plot spec={spec} state={s} set={set} locked={locked} targets={targets} solution={sol?.values} />
      ) : spec.type === "scale" ? (
        <Scale spec={spec} state={s} set={set} locked={locked} solution={sol?.value} />
      ) : spec.type === "parts" ? (
        <Parts spec={spec} state={s} set={set} locked={locked} pick={pick} solution={sol?.part_id} />
      ) : (
        <Table spec={spec} state={s} set={set} locked={locked} solution={sol?.values} />
      )}
    </figure>
  );
}
