import { useCallback, useEffect, useState, type ReactNode } from "react";

import { ItemButton, uid } from "@/items/ui";
import { cn } from "@/utils/cn";

import { SCALE_FACES, SCALE_WORDS, momentAt } from "./metrics";
import type { HealthData, Reading } from "./types";
import { CAPS } from "./types";
import { nowISO, todayISO } from "./zone";

/* Small shared pieces for Body & Health's views. */

/** The rendered width of an element (callback ref + ResizeObserver).
 *  Layouts key off this, not the viewport: on desktop the Ask panel and the
 *  sidebar can leave the app only ~700 px, where viewport breakpoints
 *  (``lg:``) would still split it into crushed columns. */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((es) => setW(es[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [useCallback((n: T | null) => setEl(n), []), w];
}

/** Insert keeping ``readings`` sorted by time. Never trims old readings at
 *  the cap — the server refuses past it and the shell offers archiving
 *  (see {@link capacityWarning}). */
export function insertReading(d: HealthData, r: Omit<Reading, "id"> & { id?: string }) {
  const row: Reading = { ...r, id: r.id ?? uid("r") } as Reading;
  const arr = d.readings;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].at <= row.at) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, row);
  return row.id;
}

/** "This file is nearly full" — when a list is ≥ 90% of its ceiling. */
export function capacityWarning(d: HealthData): string | null {
  const parts: string[] = [];
  const check = (n: number, cap: number, what: string) => {
    if (n >= cap * 0.9) parts.push(`${n.toLocaleString()} of ${cap.toLocaleString()} ${what}`);
  };
  check(d.readings.length, CAPS.readings, "readings");
  check(d.doses.length, CAPS.doses, "dose records");
  check(d.symptoms.length, CAPS.symptoms, "symptoms");
  check(d.periods.length, CAPS.periods, "period days");
  return parts.length ? parts.join(" · ") : null;
}

export function blankReading(metric: string, at = nowISO()): Omit<Reading, "id"> {
  return { metric, at, value: null, sys: null, dia: null, pulse: null, arm: null, position: null, context: null, bed: null, quality: null, note: "" };
}

/** ``YYYY-MM-DDTHH:MM`` (for a datetime-local input) from an ISO moment, in its own offset. */
export function toLocalInput(iso: string): string {
  return iso.slice(0, 16);
}

export function fromLocalInput(v: string): string {
  if (!v || v.length < 16) return nowISO();
  return momentAt(v.slice(0, 10), v.slice(11, 16));
}

export function WhenInput({ value, onChange, label = "When" }: { value: string; onChange: (iso: string) => void; label?: string }) {
  const [text, setText] = useState(toLocalInput(value));
  useEffect(() => setText(toLocalInput(value)), [value]);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-[var(--text-muted)]">{label}</span>
      <input
        type="datetime-local"
        value={text}
        max={`${todayISO()}T23:59`}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.length >= 16) onChange(fromLocalInput(e.target.value));
        }}
        className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-base tabular-nums text-[var(--text)] outline-none focus:border-[var(--item-accent)] md:h-10 md:text-sm"
      />
    </label>
  );
}

export function ScalePicker({
  value,
  onChange,
  label,
  words = SCALE_WORDS,
}: {
  value: number | null;
  onChange: (v: number) => void;
  label: string;
  words?: string[];
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-5 gap-2">
      {SCALE_FACES.map((f, i) => {
        const v = i + 1;
        const on = value === v;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`${v} — ${words[i]}`}
            onClick={() => onChange(v)}
            className={cn(
              "flex h-16 flex-col items-center justify-center gap-0.5 rounded-2xl border text-2xl transition active:scale-95",
              on
                ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)]"
                : "border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--hover)]",
            )}
          >
            <span aria-hidden>{f}</span>
            <span className="text-[10px] font-medium text-[var(--text-muted)]">{words[i]}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Badge({ color, children, className }: { color: string; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold", className)}
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {children}
    </span>
  );
}

export function Callout({ tone, title, children }: { tone: "danger" | "warning" | "info"; title: ReactNode; children?: ReactNode }) {
  const c = tone === "danger" ? "var(--danger)" : tone === "warning" ? "var(--warning)" : "var(--item-accent)";
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className="rounded-2xl border px-4 py-3 text-sm"
      style={{ borderColor: `color-mix(in srgb, ${c} 45%, transparent)`, background: `color-mix(in srgb, ${c} 9%, var(--surface))` }}
    >
      <p className="font-semibold" style={{ color: c }}>
        {title}
      </p>
      {children && <div className="mt-1 text-[var(--text)]">{children}</div>}
    </div>
  );
}

/** A delete button that asks once ("Delete" → "Tap again to delete"). */
export function DeleteButton({ onDelete, label = "Delete" }: { onDelete: () => void; label?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(t);
  }, [armed]);
  return (
    <ItemButton variant={armed ? "danger" : "ghost"} onClick={() => (armed ? onDelete() : setArmed(true))}>
      {armed ? "Tap again to delete" : label}
    </ItemButton>
  );
}

/** Comma-separated text ↔ list. */
export function ListInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => setText(value.join(", ")), [value]);
  return (
    <input
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() =>
        onChange(
          text
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .filter((s, i, a) => a.findIndex((x) => x.toLowerCase() === s.toLowerCase()) === i)
            .slice(0, 60),
        )
      }
      className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-base text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--item-accent)] md:h-10 md:text-sm"
    />
  );
}

export function NumberInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => {
    setText((t) => (parseNum(t) === value ? t : value === null ? "" : String(value)));
  }, [value]);
  return (
    <input
      inputMode="decimal"
      aria-label={ariaLabel}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseNum(e.target.value));
      }}
      className={cn(
        "h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-base tabular-nums text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--item-accent)] md:h-10 md:text-sm",
        className,
      )}
    />
  );
}

export function parseNum(s: string): number | null {
  const n = parseFloat(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function round(v: number, dp: number) {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** A row of small numbers in one bordered strip (Apple Health's highlight
 *  stats) — denser than a grid of Stat cards on a phone. */
export function StatStrip({ items }: { items: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" }[] }) {
  return (
    <dl className="grid overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((x, i) => (
        <div key={x.label} className={cn("flex min-w-0 flex-col gap-0.5 px-3 py-2.5", i > 0 && "border-l border-[var(--border)]")}>
          <dt className="truncate text-[11px] font-medium text-[var(--text-muted)]">{x.label}</dt>
          <dd className="truncate text-lg font-semibold tabular-nums text-[var(--text)]">{x.value}</dd>
          {x.sub && (
            <dd className={cn("truncate text-[11px]", x.tone === "good" ? "text-[var(--success)]" : x.tone === "bad" ? "text-[var(--danger)]" : "text-[var(--text-muted)]")}>{x.sub}</dd>
          )}
        </div>
      ))}
    </dl>
  );
}
