import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  TrendingDown,
} from "lucide-react";

import type { ObjectiveMasteryEntry, SessionTimelineEntry, StudyUnitSummary } from "@/api/types";
import { cn } from "@/utils/cn";
import {
  useAssessorStatusQuery,
  useMisconceptionsQuery,
  useObjectiveMasteryQuery,
  useSessionTimelineQuery,
} from "@/hooks/useStudy";

import { CalibrationChart } from "./CalibrationChart";
import { LearnerProfilePanel } from "./LearnerProfilePanel";

// ---- helpers -------------------------------------------------------

function masteryBg(score: number): string {
  if (score >= 0.8) return "bg-emerald-500 dark:bg-emerald-500";
  if (score >= 0.5) return "bg-amber-400 dark:bg-amber-400";
  if (score >= 0.3) return "bg-orange-400 dark:bg-orange-400";
  if (score > 0) return "bg-red-400 dark:bg-red-400";
  return "bg-[var(--border)]/50";
}

function masteryLabel(score: number): string {
  if (score >= 0.8) return "Mastered";
  if (score >= 0.5) return "Familiar";
  if (score >= 0.3) return "Shaky";
  if (score > 0) return "Needs work";
  return "Not started";
}

function formatRelativeDate(dateStr: string): string {
  const ms = new Date(dateStr).getTime() - Date.now();
  const days = Math.ceil(ms / (1000 * 60 * 60 * 24));
  if (days <= 0) return "overdue";
  if (days === 1) return "tomorrow";
  if (days <= 6) return `in ${days} days`;
  if (days <= 13) return "next week";
  return `in ${Math.ceil(days / 7)} weeks`;
}

// ---- sub-components ------------------------------------------------

interface StatChipProps {
  icon: React.ReactNode;
  value: number;
  label: string;
  accent?: string;
}
function StatChip({ icon, value, label, accent }: StatChipProps) {
  return (
    <div className="flex flex-col items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-center">
      <div className={cn("mb-0.5 opacity-60", accent)}>{icon}</div>
      <div className={cn("text-xl font-bold tabular-nums", accent ?? "text-[var(--text)]")}>
        {value}
      </div>
      <div className="text-[10px] text-[var(--text-muted)]">{label}</div>
    </div>
  );
}

interface MasteryDotProps {
  entry: ObjectiveMasteryEntry;
}
function MasteryDot({ entry }: MasteryDotProps) {
  return (
    <span className="group relative inline-block">
      <span
        className={cn(
          "block h-3 w-3 rounded-sm transition-transform group-hover:scale-125",
          masteryBg(entry.mastery_score),
          entry.is_due &&
            entry.mastery_score >= 0.8 &&
            "ring-2 ring-emerald-300 dark:ring-emerald-700"
        )}
      />
      <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[10px] text-[var(--text)] opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
        {entry.objective_text}
        <br />
        <span className="text-[var(--text-muted)]">
          {masteryLabel(entry.mastery_score)} ·{" "}
          {Math.round(entry.mastery_score * 100)}%
          {entry.is_due ? " · due now" : ""}
        </span>
      </span>
    </span>
  );
}

// ---- main component ------------------------------------------------

interface InsightDashboardProps {
  projectId: string;
  units: StudyUnitSummary[];
  isAdmin?: boolean;
}

export function InsightDashboard({ projectId, units, isAdmin }: InsightDashboardProps) {
  const masteryQ = useObjectiveMasteryQuery(projectId);
  const miscQ = useMisconceptionsQuery(projectId, false);
  const assessorQ = useAssessorStatusQuery();
  const timelineQ = useSessionTimelineQuery(projectId);

  const entries = masteryQ.data?.entries ?? [];
  const misconceptions = miscQ.data?.entries ?? [];

  const unitTitleMap = useMemo(
    () => new Map(units.map((u) => [u.id, u.title])),
    [units]
  );

  // ---- stats ----
  const mastered = entries.filter((e) => e.mastery_score >= 0.8).length;
  const familiar = entries.filter(
    (e) => e.mastery_score >= 0.5 && e.mastery_score < 0.8
  ).length;
  const dueNow = entries.filter((e) => e.is_due).length;
  const notStarted = entries.filter((e) => e.mastery_score === 0).length;

  // ---- mastery by unit ----
  const byUnit = useMemo(() => {
    const map = new Map<string, ObjectiveMasteryEntry[]>();
    for (const e of entries) {
      const arr = map.get(e.unit_id) ?? [];
      arr.push(e);
      map.set(e.unit_id, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.objective_index - b.objective_index);
    }
    // Return in unit order
    return units
      .map((u) => ({ unit: u, entries: map.get(u.id) ?? [] }))
      .filter((row) => row.entries.length > 0);
  }, [entries, units]);

  // ---- weak spots ----
  const weakSpots = useMemo(
    () =>
      [...entries]
        .filter((e) => e.mastery_score > 0 && e.mastery_score < 0.75)
        .sort((a, b) => a.mastery_score - b.mastery_score)
        .slice(0, 6),
    [entries]
  );

  // ---- upcoming reviews (next 14 days, not yet due) ----
  const upcoming = useMemo(() => {
    const cutoff = Date.now() + 14 * 24 * 60 * 60 * 1000;
    return [...entries]
      .filter(
        (e) =>
          e.next_review_at &&
          !e.is_due &&
          new Date(e.next_review_at).getTime() <= cutoff
      )
      .sort(
        (a, b) =>
          new Date(a.next_review_at!).getTime() -
          new Date(b.next_review_at!).getTime()
      )
      .slice(0, 8);
  }, [entries]);

  if (masteryQ.isLoading) {
    return (
      <div className="py-10 text-center text-xs text-[var(--text-muted)]">
        Loading insights…
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="py-10 text-center">
        <Brain className="mx-auto mb-2 h-7 w-7 opacity-20" />
        <p className="text-sm text-[var(--text-muted)]">
          Complete your first unit to see insights here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatChip
          icon={<CheckCircle2 className="h-4 w-4" />}
          value={mastered}
          label="mastered"
          accent="text-emerald-600 dark:text-emerald-400"
        />
        <StatChip
          icon={<Brain className="h-4 w-4" />}
          value={familiar}
          label="familiar"
          accent="text-amber-600 dark:text-amber-400"
        />
        <StatChip
          icon={<Clock className="h-4 w-4" />}
          value={dueNow}
          label="due now"
          accent={dueNow > 0 ? "text-rose-600 dark:text-rose-400" : undefined}
        />
        <StatChip
          icon={<TrendingDown className="h-4 w-4" />}
          value={notStarted}
          label="not started"
        />
      </div>

      {/* Mastery heatmap by unit */}
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Mastery by unit
        </h3>
        <div className="space-y-2">
          {byUnit.map(({ unit, entries: ue }) => {
            const unitMastered = ue.filter((e) => e.mastery_score >= 0.8).length;
            const avgScore =
              ue.length > 0
                ? ue.reduce((s, e) => s + e.mastery_score, 0) / ue.length
                : 0;
            return (
              <div
                key={unit.id}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-[var(--text)]">
                    {unit.title}
                  </span>
                  <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
                    {unitMastered}/{ue.length}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {/* Dot grid */}
                  <div className="flex flex-wrap gap-1">
                    {ue.map((e) => (
                      <MasteryDot key={e.id} entry={e} />
                    ))}
                  </div>
                  {/* Mini bar */}
                  <div className="ml-auto h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--border)]/40">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        avgScore >= 0.8
                          ? "bg-emerald-500"
                          : avgScore >= 0.5
                            ? "bg-amber-400"
                            : avgScore >= 0.3
                              ? "bg-orange-400"
                              : "bg-red-400"
                      )}
                      style={{ width: `${Math.round(avgScore * 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-[var(--text-muted)]">
          {(
            [
              ["bg-emerald-500", "Mastered (≥80%)"],
              ["bg-amber-400", "Familiar (50–79%)"],
              ["bg-orange-400", "Shaky (30–49%)"],
              ["bg-red-400", "Needs work (<30%)"],
              ["bg-[var(--border)]/50", "Not started"],
            ] as [string, string][]
          ).map(([cls, label]) => (
            <span key={label} className="flex items-center gap-1">
              <span className={cn("inline-block h-2.5 w-2.5 rounded-sm", cls)} />
              {label}
            </span>
          ))}
        </div>
      </section>

      {/* Weak spots */}
      {weakSpots.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Weak spots
          </h3>
          <div className="space-y-1.5">
            {weakSpots.map((e) => (
              <div
                key={e.id}
                className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
              >
                <span
                  className={cn(
                    "shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium",
                    e.mastery_score >= 0.5
                      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                      : e.mastery_score >= 0.3
                        ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300"
                        : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                  )}
                >
                  {Math.round(e.mastery_score * 100)}%
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-[var(--text)]">
                    {e.objective_text}
                  </p>
                  <p className="truncate text-[10px] text-[var(--text-muted)]">
                    {unitTitleMap.get(e.unit_id) ?? "Unknown unit"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Retention forecast */}
      {upcoming.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Upcoming reviews
          </h3>
          <div className="space-y-1.5">
            {upcoming.map((e) => (
              <div
                key={e.id}
                className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
              >
                <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
                  {formatRelativeDate(e.next_review_at!)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-[var(--text)]">
                    {e.objective_text}
                  </p>
                  <p className="truncate text-[10px] text-[var(--text-muted)]">
                    {unitTitleMap.get(e.unit_id) ?? "Unknown unit"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Open misconceptions */}
      {misconceptions.length > 0 && (
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            <AlertTriangle className="h-3 w-3 text-amber-500" />
            Open misconceptions ({misconceptions.length})
          </h3>
          <div className="space-y-2">
            {misconceptions.map((m) => (
              <div
                key={m.id}
                className="rounded-lg border border-amber-200/60 bg-amber-50/40 px-3 py-2.5 dark:border-amber-800/40 dark:bg-amber-900/10"
              >
                <p className="text-xs font-medium text-[var(--text)]">
                  {m.description}
                </p>
                {m.correction && (
                  <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                    → {m.correction}
                  </p>
                )}
                {m.times_seen > 1 && (
                  <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                    Seen {m.times_seen}×
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Calibration */}
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Confidence calibration
        </h3>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
          <CalibrationChart projectId={projectId} />
        </div>
      </section>

      {/* Learner profile */}
      <LearnerProfilePanel projectId={projectId} />

      {/* Session timeline */}
      {timelineQ.data && timelineQ.data.length > 0 && (
        <SessionTimeline entries={timelineQ.data} />
      )}

      {/* Assessor health — admin only */}
      {isAdmin && assessorQ.data && (
        <AssessorStatusChip status={assessorQ.data} />
      )}
    </div>
  );
}

// ---- Phase label abbreviations for the timeline ---------------

const PHASE_ABBR: Record<string, string> = {
  hook: "Hook",
  activate: "Activate",
  present: "Present",
  guided: "Guided",
  independent: "Practice",
  interleave: "Review",
  teachback: "Teach-back",
  transfer: "Transfer",
  close: "Close",
};

// ---- Session timeline ------------------------------------------

function SessionTimeline({ entries }: { entries: SessionTimelineEntry[] }) {
  const [open, setOpen] = useState(false);

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-2 flex w-full items-center gap-1 text-left"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 text-[var(--text-muted)]" />
        ) : (
          <ChevronRight className="h-3 w-3 text-[var(--text-muted)]" />
        )}
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Session timeline
        </h3>
        <span className="ml-1 text-[10px] text-[var(--text-muted)] opacity-60">
          ({entries.length})
        </span>
      </button>

      {open && (
        <div className="space-y-2">
          {entries.map((entry) => (
            <SessionTimelineRow key={entry.session_id} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
}

function SessionTimelineRow({ entry }: { entry: SessionTimelineEntry }) {
  const date = new Date(entry.updated_at);
  const dateLabel = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  // Deduplicate consecutive phases in the history.
  const phases: string[] = [];
  for (const { phase } of entry.phase_history) {
    if (phases[phases.length - 1] !== phase) phases.push(phase);
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-[var(--text)]">
          {entry.unit_title}
        </span>
        <div className="flex shrink-0 items-center gap-2 text-[10px] text-[var(--text-muted)]">
          {entry.teachback_passed && (
            <CheckCircle2 className="h-3 w-3 text-emerald-500" />
          )}
          <span>{entry.student_turn_count} turns</span>
          <span>{dateLabel}</span>
        </div>
      </div>
      {phases.length > 0 && (
        <div className="flex flex-wrap items-center gap-0.5">
          {phases.map((phase, i) => (
            <span key={i} className="flex items-center gap-0.5">
              {i > 0 && (
                <ChevronRight className="h-2.5 w-2.5 shrink-0 text-[var(--text-muted)]/40" />
              )}
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[9px] font-medium",
                  phase === "close" || phase === "teachback"
                    ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                    : "bg-[var(--surface-muted)] text-[var(--text-muted)]"
                )}
              >
                {PHASE_ABBR[phase] ?? phase}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function AssessorStatusChip({
  status,
}: {
  status: { configured: boolean; total_attempts_24h: number; assessor_attempts_24h: number };
}) {
  const { configured, total_attempts_24h, assessor_attempts_24h } = status;

  let color: string;
  let label: string;
  let detail: string | null = null;

  if (!configured) {
    color = "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300";
    label = "Assessor: not configured";
  } else if (total_attempts_24h === 0) {
    color = "bg-[var(--surface-muted)] text-[var(--text-muted)]";
    label = "Assessor: configured";
    detail = "no activity today";
  } else {
    const pct = Math.round((assessor_attempts_24h / total_attempts_24h) * 100);
    color = pct >= 80
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
      : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300";
    label = "Assessor: active";
    detail = `${assessor_attempts_24h}/${total_attempts_24h} graded today`;
  }

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        Grading
      </h3>
      <div className={cn("inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium", color)}>
        <span>{label}</span>
        {detail && <span className="opacity-75">· {detail}</span>}
      </div>
    </section>
  );
}
