import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import type { TaskPriority, WorkspaceTask } from "@/api/workspaces";
import { cn } from "@/utils/cn";

/**
 * Month-grid calendar view of a board's tasks, placed by due date.
 *
 * Overdue (past, not done) cards read red; cards due today or tomorrow read
 * orange; everything else is neutral. Clicking a card opens its detail panel.
 * When the viewer can edit, dragging a card onto another day reschedules it —
 * the original time-of-day is preserved (or defaults to 9:00am for previously
 * undated cards). Tasks with no due date collect in an "Unscheduled" strip
 * below the grid and can be dragged onto a day to schedule them.
 */

const PRIORITY_DOT: Record<TaskPriority, string> = {
  high: "bg-red-500",
  medium: "bg-amber-400",
  low: "bg-slate-400",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** YYYY-MM-DD in local time (stable day key, no timezone drift). */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function WorkspaceBoardCalendar({
  tasks,
  canEdit,
  onOpen,
  onReschedule,
}: {
  tasks: WorkspaceTask[];
  canEdit: boolean;
  onOpen: (taskId: string) => void;
  onReschedule: (taskId: string, dueIso: string | null) => void;
}) {
  // Anchor month, normalised to the 1st so month arithmetic is clean.
  const today = useMemo(() => startOfDay(new Date()), []);
  const [anchor, setAnchor] = useState(
    () => new Date(today.getFullYear(), today.getMonth(), 1)
  );
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);

  // Bucket dated tasks by local day key.
  const { byDay, unscheduled } = useMemo(() => {
    const byDay: Record<string, WorkspaceTask[]> = {};
    const unscheduled: WorkspaceTask[] = [];
    for (const t of tasks) {
      if (!t.due_at) {
        unscheduled.push(t);
        continue;
      }
      const k = dayKey(new Date(t.due_at));
      (byDay[k] ??= []).push(t);
    }
    for (const k of Object.keys(byDay))
      byDay[k].sort((a, b) => Date.parse(a.due_at!) - Date.parse(b.due_at!));
    return { byDay, unscheduled };
  }, [tasks]);

  // Build the 6×7 grid: lead with trailing days of the previous month so the
  // first row starts on Sunday, then fill to a whole number of weeks.
  const cells = useMemo(() => {
    const firstWeekday = anchor.getDay(); // 0 = Sun
    const gridStart = new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      1 - firstWeekday
    );
    const out: Date[] = [];
    for (let i = 0; i < 42; i++) {
      out.push(
        new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i)
      );
    }
    // Trim a trailing all-other-month week if the month fits in 5 rows.
    if (out[35].getMonth() !== anchor.getMonth()) out.length = 35;
    return out;
  }, [anchor]);

  const reschedule = (taskId: string, day: Date) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const prev = task.due_at ? new Date(task.due_at) : null;
    const next = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      prev ? prev.getHours() : 9,
      prev ? prev.getMinutes() : 0
    );
    if (prev && prev.getTime() === next.getTime()) return;
    onReschedule(taskId, next.toISOString());
  };

  const monthLabel = anchor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  return (
    <div>
      {/* Month nav */}
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() =>
            setAnchor((a) => new Date(a.getFullYear(), a.getMonth() - 1, 1))
          }
          className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-1 text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() =>
            setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + 1, 1))
          }
          className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-1 text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <span className="text-sm font-semibold text-[var(--text)]">
          {monthLabel}
        </span>
        <button
          type="button"
          onClick={() => setAnchor(new Date(today.getFullYear(), today.getMonth(), 1))}
          className="ml-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          Today
        </button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-px text-center text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {WEEKDAYS.map((d) => (
          <div key={d} className="py-1">
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--border)]">
        {cells.map((day) => {
          const k = dayKey(day);
          const inMonth = day.getMonth() === anchor.getMonth();
          const isToday = day.getTime() === today.getTime();
          const dayTasks = byDay[k] ?? [];
          return (
            <div
              key={k}
              onDragOver={(e) => {
                if (!canEdit || !dragId) return;
                e.preventDefault();
                setDropKey(k);
              }}
              onDragLeave={() => setDropKey((c) => (c === k ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                setDropKey(null);
                const id = e.dataTransfer.getData("text/plain") || dragId;
                if (id) reschedule(id, day);
                setDragId(null);
              }}
              className={cn(
                "flex min-h-[92px] flex-col gap-1 bg-[var(--bg)] p-1.5 transition",
                !inMonth && "bg-[var(--surface)]/40",
                dropKey === k && "ring-2 ring-inset ring-[var(--accent)]"
              )}
            >
              <div className="flex justify-end">
                <span
                  className={cn(
                    "inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1 text-[11px]",
                    isToday
                      ? "bg-[var(--accent)] font-semibold text-white"
                      : inMonth
                        ? "text-[var(--text)]"
                        : "text-[var(--text-muted)]"
                  )}
                >
                  {day.getDate()}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {dayTasks.map((t) => {
                  const overdue =
                    !t.done && Date.parse(t.due_at!) < Date.now();
                  const soon =
                    !t.done &&
                    !overdue &&
                    Date.parse(t.due_at!) - Date.now() < 24 * 60 * 60 * 1000;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      draggable={canEdit}
                      onDragStart={(e) => {
                        setDragId(t.id);
                        e.dataTransfer.setData("text/plain", t.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setDropKey(null);
                      }}
                      onClick={() => onOpen(t.id)}
                      title={t.title}
                      className={cn(
                        "flex items-center gap-1 rounded border px-1 py-0.5 text-left text-[11px] transition hover:border-[var(--accent)]",
                        overdue
                          ? "border-red-500/40 bg-red-500/10 text-red-500"
                          : soon
                            ? "border-orange-500/40 bg-orange-500/10 text-orange-500"
                            : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
                        t.done && "opacity-60"
                      )}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          PRIORITY_DOT[t.priority]
                        )}
                      />
                      <span
                        className={cn(
                          "truncate",
                          t.done && "line-through"
                        )}
                      >
                        {t.title}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Unscheduled strip */}
      {unscheduled.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
            Unscheduled · {unscheduled.length}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {unscheduled.map((t) => (
              <button
                key={t.id}
                type="button"
                draggable={canEdit}
                onDragStart={(e) => {
                  setDragId(t.id);
                  e.dataTransfer.setData("text/plain", t.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropKey(null);
                }}
                onClick={() => onOpen(t.id)}
                title={canEdit ? "Drag onto a day to schedule" : t.title}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] transition hover:border-[var(--accent)]"
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    PRIORITY_DOT[t.priority]
                  )}
                />
                <span className="max-w-[160px] truncate">{t.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
