import { useMemo, type ReactNode } from "react";

import type { ItemHandle } from "@/items/useItem";
import { cn } from "@/utils/cn";

import { useCatalog, useLibrary, type Library } from "./catalog";
import { useNow } from "./RestTimer";
import { historyIndex, recordBook, type Pr, type Records, type Session } from "./science";
import type { Exercise, SetLog, WorkoutData } from "./types";

export interface Ctx {
  lib: Library;
  hist: Map<string, Session[]>;
  records: Map<string, Records>;
  prs: Map<string, Pr[]>;
}

/** The library + history index + record book, memoised on the data. The
 *  library is bundled (works offline), so this never waits on the network. */
export function useWorkoutCtx(item: ItemHandle<WorkoutData>): { ctx: Ctx } {
  const catalog = useCatalog();
  const lib = useLibrary(item.data, catalog);
  const hist = useMemo(() => historyIndex(item.data), [item.data]);
  const book = useMemo(() => recordBook(item.data, lib), [item.data, lib]);
  const ctx = useMemo(() => ({ lib, hist, records: book.records, prs: book.prs }), [lib, hist, book]);
  return { ctx };
}

/** Exercise ids they've logged, most recently done first (for the picker). */
export function recentIds(ctx: Ctx, max = 40): string[] {
  return [...ctx.hist.entries()]
    .map(([id, sessions]) => ({ id, last: sessions[sessions.length - 1]?.workout.date ?? "" }))
    .sort((a, b) => b.last.localeCompare(a.last))
    .slice(0, max)
    .map((x) => x.id);
}

/** "Bench Press (Barbell)" → "BP", "Pull-Up" → "PU", "Plank" → "Pl" — the
 *  exercise's own initials read better than movement-pattern codes. */
export function exerciseInitials(name: string): string {
  const words = name.replace(/\(.*?\)/g, "").split(/[\s-]+/).filter((w) => /^[A-Za-z0-9]/.test(w));
  if (!words.length) return name.slice(0, 2);
  if (words.length === 1) return words[0].slice(0, 2);
  return (words[0][0] + words[1][0]).toUpperCase();
}
const GROUP_TINT: Record<string, string> = { push: "#E2725B", pull: "#3B7DD8", legs: "#4E9F5B", core: "#C08B2C" };

export function ExerciseBadge({ ex, lib, size = 40 }: { ex: Exercise; lib: Library; size?: number }) {
  const group = lib.catalog.muscles[ex.primary[0]]?.group ?? (ex.pattern === "cardio" ? "core" : "push");
  const tint = ex.pattern === "cardio" ? "#7B6CD9" : GROUP_TINT[group] ?? "#E2725B";
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-xl text-[11px] font-bold"
      style={{ width: size, height: size, background: `color-mix(in srgb, ${tint} 16%, transparent)`, color: tint }}
    >
      {exerciseInitials(ex.name)}
    </span>
  );
}

export function muscleLine(ex: Exercise, lib: Library): string {
  const m = (id: string) => lib.catalog.muscles[id]?.label ?? id;
  const prim = ex.primary.map(m).join(", ");
  return prim || (ex.pattern === "cardio" ? "Cardio" : lib.catalog.patterns[ex.pattern] ?? "");
}

export const SET_LABEL: Record<string, string> = { warmup: "W", drop: "D", failure: "F" };
export const SET_NAME: Record<string, string> = { warmup: "Warm-up", working: "Working", drop: "Drop set", failure: "To failure" };

export function SetBadge({ s, n, onClick, className }: { s: SetLog; n: number; onClick?: () => void; className?: string }) {
  const t = s.type ?? "working";
  const label = t === "working" ? String(n) : SET_LABEL[t];
  const cls = cn(
    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold tabular-nums",
    t === "warmup" && "bg-[color-mix(in_srgb,#C08B2C_16%,transparent)] text-[#B07A1C]",
    t === "working" && "bg-[var(--surface-2)] text-[var(--text)]",
    t === "drop" && "bg-[color-mix(in_srgb,#7B6CD9_16%,transparent)] text-[#6B5CD0]",
    t === "failure" && "bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] text-[var(--danger)]",
    className,
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]")} aria-label={`Set type: ${SET_NAME[t]} — change`}>
      {label}
    </button>
  ) : (
    <span className={cls} aria-label={SET_NAME[t]}>
      {label}
    </span>
  );
}

export function Pill({ children, tone = "muted", className }: { children: ReactNode; tone?: "muted" | "accent" | "good" | "warn" | "bad"; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px] font-semibold tabular-nums",
        tone === "muted" && "bg-[var(--surface-2)] text-[var(--text-muted)]",
        tone === "accent" && "bg-[color-mix(in_srgb,var(--item-accent)_15%,transparent)] text-[var(--item-accent)]",
        tone === "good" && "bg-[color-mix(in_srgb,var(--success)_15%,transparent)] text-[var(--success)]",
        tone === "warn" && "bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-[var(--warning)]",
        tone === "bad" && "bg-[color-mix(in_srgb,var(--danger)_15%,transparent)] text-[var(--danger)]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Shown on the other tabs while a workout is running. */
export function ActiveBanner({ data, goTo }: { data: WorkoutData; goTo: (t: string) => void }) {
  const a = data.active;
  if (!a) return null;
  return <LiveBanner a={a} goTo={goTo} />;
}

/** The running workout — with the rest countdown, so it's visible from any tab. */
function LiveBanner({ a, goTo }: { a: NonNullable<WorkoutData["active"]>; goTo: (t: string) => void }) {
  const now = useNow(1000);
  const restLeft = a.rest_until ? Math.max(0, Math.ceil((new Date(a.rest_until).getTime() - now) / 1000)) : 0;
  const done = a.exercises.reduce((n, we) => n + we.sets.filter((x) => x.done && (x.type ?? "working") !== "warmup").length, 0);
  return (
    <button
      type="button"
      onClick={() => goTo("today")}
      className="flex w-full items-center gap-3 rounded-2xl bg-[var(--item-accent-fill)] px-4 py-3 text-left text-white shadow-[var(--shadow-sm)]"
    >
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-60 motion-reduce:hidden" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{a.name} in progress</span>
        <span className="block text-xs opacity-90">{done} set{done === 1 ? "" : "s"} done — tap to resume</span>
      </span>
      {restLeft > 0 && (
        <span className="shrink-0 rounded-full bg-white/20 px-2.5 py-1 text-sm font-semibold tabular-nums" aria-label={`Rest: ${restLeft} seconds left`}>
          Rest {Math.floor(restLeft / 60)}:{String(restLeft % 60).padStart(2, "0")}
        </span>
      )}
    </button>
  );
}

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
