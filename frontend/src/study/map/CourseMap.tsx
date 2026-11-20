import { CalendarClock, Check, ClipboardCheck, FastForward, Lock, Play, Plus } from "lucide-react";
import { useMemo } from "react";

import type { Concept, SubjectFull } from "@/api/study";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/utils/cn";

import { Ring } from "../ui/bits";
import { BAND_WORDS, bandOf, edgePath, layoutMap, stubPath, UNIT_HEAD_H, type Band } from "./layout";

/*
 * The course as a map: units are regions down the page, concepts are stops
 * on a winding route, lines join an idea to what it builds on. Each stop
 * wears how well you know it; ideas added for a gap look different and say
 * why; the stop to do next glows.
 */

const RING_COLOR: Record<Band, string> = {
  known: "var(--st-good)",
  mastered: "var(--st-good)",
  nearly: "var(--st-accent)",
  learning: "var(--st-accent)",
  new: "var(--st-line)",
  locked: "var(--st-line)",
};

export function CourseMap({ subject, nextId, onPick }: { subject: SubjectFull; nextId: string | null; onPick: (c: Concept) => void }) {
  const phone = useIsMobile(640);
  const layout = useMemo(() => layoutMap(subject.units, phone ? 2 : 3), [subject.units, phone]);
  const concepts = useMemo(() => new Map(subject.units.flatMap((u) => u.concepts).map((c) => [c.id, c])), [subject.units]);
  const units = useMemo(() => [...subject.units].sort((a, b) => a.position - b.position), [subject.units]);

  return (
    <div className="relative mx-auto w-full max-w-2xl" style={{ height: layout.height }} data-testid="study-map">
      {/* Unit regions. */}
      {layout.units.map((u, i) => {
        const unit = units[i];
        const done = unit.concepts.filter((c) => c.state === "mastered" || c.state === "known").length;
        return (
          <section key={u.id} aria-label={`Part ${i + 1}: ${unit.title}`} className="absolute inset-x-0 rounded-3xl border border-[var(--border)] bg-[var(--surface)]" style={{ top: u.top, height: u.height }}>
            <header className="flex items-start gap-3 px-4 pt-3.5" style={{ height: UNIT_HEAD_H }}>
              <span aria-hidden className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--st-soft)] text-xs font-bold text-[var(--st-accent-text)]">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[15px] font-semibold text-[var(--text)]">{unit.title}</h2>
                <p className="line-clamp-2 text-xs leading-snug text-[var(--text-muted)]">{unit.summary}</p>
              </div>
              <span className="flex shrink-0 items-center gap-1.5 pt-1">
                {unit.concepts.length >= 2 && (unit.capstone || done === unit.concepts.length) && (
                  <span
                    data-testid="study-unit-task"
                    data-status={unit.capstone?.status ?? "due"}
                    title={unit.capstone?.status === "passed" ? "Unit task done" : unit.capstone?.status === "closed" ? "Unit task left for now" : "Unit task to do"}
                    className={cn(
                      "flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                      unit.capstone?.status === "passed" ? "bg-[var(--st-good-bg)] text-[var(--st-good)]" : "bg-[var(--st-soft)] text-[var(--st-accent-text)]"
                    )}
                  >
                    <ClipboardCheck className="h-3 w-3" aria-hidden />
                    {unit.capstone?.status === "passed" ? "Task done" : unit.capstone?.status === "closed" ? "Task left" : "Task"}
                  </span>
                )}
                <span className="text-xs tabular-nums text-[var(--text-muted)]" aria-label={`${done} of ${unit.concepts.length} learned`}>
                  {done}/{unit.concepts.length}
                </span>
              </span>
            </header>
          </section>
        );
      })}

      {/* The route. x is 0..100 across, y is px, so the lines stretch with the page. */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 100 ${Math.max(1, layout.height)}`} preserveAspectRatio="none" aria-hidden>
        {layout.edges.map((e, i) => (
          <path
            key={i}
            d={e.kind === "stub" ? stubPath(layout.byId[e.to]) : edgePath(layout.byId[e.from], layout.byId[e.to])}
            fill="none"
            vectorEffect="non-scaling-stroke"
            stroke={e.gap ? "var(--st-gap)" : e.done ? "var(--st-good)" : "var(--st-line)"}
            strokeWidth={e.done ? 3 : 2.5}
            strokeDasharray={e.gap ? "2 7" : e.done ? undefined : "1 8"}
            strokeLinecap="round"
            opacity={e.done ? 0.7 : 1}
          />
        ))}
      </svg>

      {/* The stops. */}
      {layout.nodes.map((n) => {
        const c = concepts.get(n.id);
        if (!c) return null;
        return <Stop key={n.id} concept={c} x={n.x} y={n.y} next={n.id === nextId} onPick={() => onPick(c)} />;
      })}
    </div>
  );
}

function Stop({ concept: c, x, y, next, onPick }: { concept: Concept; x: number; y: number; next: boolean; onPick: () => void }) {
  const band = bandOf(c);
  const gap = c.origin === "gap";
  const done = band === "known" || band === "mastered";
  const pct = Math.round(c.mastery * 100);
  const due = done && c.due;
  const words = `${c.title}. ${gap ? "Added for you. " : ""}${BAND_WORDS[band]}${band === "learning" || band === "nearly" ? `, ${pct}%` : ""}${next ? ". Up next" : ""}${due ? ". Due for review" : ""}`;
  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={words}
      data-testid="study-stop"
      data-band={band}
      data-gap={gap || undefined}
      data-next={next || undefined}
      data-due={due || undefined}
      className="group absolute flex w-[8.5rem] -translate-x-1/2 flex-col items-center gap-1 rounded-2xl px-1 pb-1 pt-1 text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]"
      style={{ left: `${x * 100}%`, top: y - 40 }}
    >
      <span className={cn("relative flex h-[60px] w-[60px] items-center justify-center rounded-full bg-[var(--surface)] transition-transform group-hover:scale-105 group-active:scale-95", next && "study-halo")}>
        <Ring value={done ? 1 : c.mastery} size={60} stroke={5} color={gap && !done ? "var(--st-gap)" : RING_COLOR[band]} dashed={gap}>
          <span
            className={cn(
              "flex h-[42px] w-[42px] items-center justify-center rounded-full",
              done && "bg-[var(--st-good)] text-white",
              !done && next && "bg-[var(--accent-strong)] text-white",
              !done && !next && band === "locked" && "bg-[var(--hover-strong)] text-[var(--text-muted)]",
              !done && !next && band !== "locked" && (gap ? "bg-[var(--st-gap-bg)] text-[var(--st-gap)]" : "bg-[var(--st-soft)] text-[var(--st-accent-text)]")
            )}
          >
            {band === "known" ? (
              <FastForward className="h-5 w-5" aria-hidden />
            ) : band === "mastered" ? (
              <Check className="h-5 w-5" aria-hidden />
            ) : next ? (
              <Play className="h-5 w-5 translate-x-px" aria-hidden />
            ) : band === "locked" ? (
              <Lock className="h-4 w-4" aria-hidden />
            ) : gap ? (
              <Plus className="h-5 w-5" aria-hidden />
            ) : band === "new" ? (
              <span className="h-2 w-2 rounded-full bg-current" aria-hidden />
            ) : (
              <span className="text-xs font-bold tabular-nums" aria-hidden>
                {pct}
              </span>
            )}
          </span>
        </Ring>
        {due && (
          <span aria-hidden className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent-strong)] text-white ring-2 ring-[var(--surface)]">
            <CalendarClock className="h-3 w-3" />
          </span>
        )}
      </span>
      <span className={cn("line-clamp-2 rounded-md bg-[var(--surface)] px-1 text-xs font-medium leading-tight", band === "locked" ? "text-[var(--text-muted)]" : "text-[var(--text)]")}>{c.title}</span>
      {gap ? (
        <span className="rounded-full bg-[var(--st-gap-bg)] px-1.5 py-px text-[10px] font-semibold text-[var(--st-gap)]">Added for you</span>
      ) : next ? (
        <span className="rounded-full bg-[var(--st-soft)] px-1.5 py-px text-[10px] font-semibold text-[var(--st-accent-text)]">Up next</span>
      ) : band === "known" ? (
        <span className="text-[10px] text-[var(--text-muted)]">Knew it</span>
      ) : null}
    </button>
  );
}
