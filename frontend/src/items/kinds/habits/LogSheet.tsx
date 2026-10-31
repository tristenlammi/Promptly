import { Pause, Play, RotateCcw, SkipForward, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Chip, Field, ItemButton, Sheet, Stepper, TextArea, TextInput, fmtDay } from "@/items/ui";

import { configOn, dayState, describeGoal, describeSchedule, dn } from "./engine";
import { HabitBadge } from "./parts";
import type { Habit, HabitLog, HabitsData } from "./types";
import { getLog } from "./util";

const REASONS = ["Sick", "Travelling", "Rest day", "Busy day", "Injured"];

export interface LogChange {
  habitId: string;
  day: string;
  before: HabitLog | undefined;
  after: Partial<HabitLog> | null;
  /** Add this to the day's value instead of setting it (counts, minutes,
   *  slips) — so a change made on another device meanwhile is kept. */
  delta?: number;
  text: string;
}

/**
 * Everything about one habit on one day: a count / minutes / slips, a note,
 * or a skip with a reason. The long-press (or secondary tap) panel.
 */
export function LogSheet({
  open,
  onClose,
  habit,
  day,
  data,
  today,
  onCommit,
  onTimer,
  readOnly,
}: {
  open: boolean;
  onClose: () => void;
  habit: Habit | null;
  day: string;
  data: HabitsData;
  today: string;
  onCommit: (c: LogChange) => void;
  onTimer?: (habitId: string, day: string, op: "start" | "stop" | "cancel") => void;
  readOnly?: boolean;
}) {
  const log = habit ? getLog(habit, day) : undefined;
  const [value, setValue] = useState(0);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [skipOpen, setSkipOpen] = useState(false);
  // What the sheet opened with: saves send only what changed from it.
  const initial = useRef<{ value: number; note: string; had: boolean }>({ value: 0, note: "", had: false });
  // The duration timer lives in the file (habit.active_timer).
  const timer = habit?.active_timer ?? null;
  const running = !!timer;
  const [now, setNow] = useState(() => Date.now());
  const rules = habit ? configOn(habit, dn(day)) : null;

  useEffect(() => {
    if (!open || !habit) return;
    const l = getLog(habit, day);
    const r = configOn(habit, dn(day));
    const had = !!l && !l.skipped;
    const v = l && had ? l.value : r.type === "yes_no" ? 1 : r.type === "avoid" ? 0 : r.type === "duration" ? r.target : 0;
    initial.current = { value: l && had ? l.value : 0, note: l?.note ?? "", had };
    setValue(v);
    setNote(l?.note ?? "");
    setReason(l?.skipped ? l.reason : "");
    setSkipOpen(!!l?.skipped);
    // Only when the sheet opens (or moves to another habit / day) — not on
    // every save from elsewhere, which would wipe what's being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, habit?.id, day]);

  useEffect(() => {
    if (!running || !open) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [running, open]);
  const elapsed = timer ? Math.max(0, Math.floor((now - Date.parse(timer.started_at)) / 1000)) : 0;

  const state = useMemo(
    () => (habit ? dayState(habit, dn(day), dn(today), data.settings.week_start) : null),
    [habit, day, today, data.settings.week_start],
  );

  if (!habit || !rules) return null;
  const isFuture = day > today;
  const commit = (after: Partial<HabitLog> | null, text: string, delta?: number) => {
    onCommit({ habitId: habit.id, day, before: log, after, text, delta });
    onClose();
  };
  const save = () => {
    const v = rules.type === "yes_no" ? (value > 0 ? 1 : 0) : value;
    const n = note.trim();
    if (rules.type !== "avoid" && v <= 0 && !n) {
      commit(null, `${habit.name}: cleared`);
      return;
    }
    const noteChanged = n !== initial.current.note.trim();
    // Counts, minutes and slips: send the difference from what the sheet
    // opened with, so additions made elsewhere in the meantime add up.
    if (rules.type !== "yes_no" && initial.current.had) {
      const delta = v - initial.current.value;
      if (!delta && !noteChanged) {
        onClose();
        return;
      }
      commit(noteChanged ? { note: n } : {}, `${habit.name}: saved`, delta);
      return;
    }
    commit({ value: v, ...(noteChanged || !log ? { note: n } : {}), skipped: false, reason: "" }, `${habit.name}: saved`);
  };
  const skip = () => commit({ value: 0, note: note.trim(), skipped: true, reason: reason.trim() }, `${habit.name}: skipped${reason ? ` (${reason})` : ""}`);

  const toggleTimer = () => {
    if (!onTimer) return;
    if (running && timer) {
      // The minutes go straight into the timer's day in the file; move the
      // sheet's baseline and value with them so Save doesn't add them twice.
      const mins = Math.max(1, Math.round(elapsed / 60));
      onTimer(habit.id, timer.day, "stop");
      if (timer.day === day) {
        initial.current = { ...initial.current, value: initial.current.value + mins, had: true };
        setValue((v) => v + mins);
      }
    } else onTimer(habit.id, day, "start");
  };
  const hours = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);
  const secs = String(elapsed % 60).padStart(2, "0");
  const mm = hours ? `${hours}:${String(mins).padStart(2, "0")}:${secs}` : `${mins}:${secs}`;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <HabitBadge habit={habit} size={28} />
          <span className="truncate">{habit.name}</span>
          <span className="text-sm font-normal text-[var(--text-muted)]">· {fmtDay(day)}</span>
        </span>
      }
      footer={
        readOnly ? undefined : (
          <>
            {log && (
              <ItemButton
                variant="ghost"
                icon={<Trash2 className="h-4 w-4" />}
                onClick={() => commit(null, `${habit.name}: cleared`)}
                aria-label="Clear this day"
              >
                Clear
              </ItemButton>
            )}
            <ItemButton variant="primary" block disabled={isFuture} onClick={save}>
              {rules.type === "avoid" ? (value > rules.limit ? "Log slip" : "Save clean day") : "Save"}
            </ItemButton>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4 pt-1">
        {habit.intention && (
          <p className="rounded-xl bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)] px-3 py-2 text-sm text-[var(--text)]">
            {habit.intention}
          </p>
        )}
        {isFuture ? (
          <p className="text-sm text-[var(--text-muted)]">This day hasn't happened yet — you can plan a skip for it.</p>
        ) : rules.type === "count" ? (
          <div className="flex flex-col gap-2">
            <Stepper label={`How many ${habit.unit || "times"} (goal ${rules.target})`} value={value} onChange={setValue} min={0} max={100000} />
            <div className="flex flex-wrap gap-2">
              {[1, 2, 5].map((n) => (
                <Chip key={n} onClick={() => setValue((v) => v + n)}>
                  +{n}
                </Chip>
              ))}
              <Chip onClick={() => setValue(rules.target)} active={value === rules.target}>
                Goal ({rules.target})
              </Chip>
            </div>
          </div>
        ) : rules.type === "duration" ? (
          <div className="flex flex-col gap-2">
            <Stepper label={`Minutes (goal ${rules.target})`} value={value} onChange={setValue} step={5} min={0} max={1440} unit="min" />
            <div className="flex flex-wrap items-center gap-2">
              {[5, 10, 15, 30].map((n) => (
                <Chip key={n} onClick={() => setValue(n)} active={value === n}>
                  {n} min
                </Chip>
              ))}
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] px-3 py-2">
              <span className="flex-1 text-sm text-[var(--text-muted)]">
                {timer && timer.day !== day ? `Timer (for ${fmtDay(timer.day)})` : running ? "Running — keeps going if you close this" : "Timer"}{" "}
                <span className="ml-1 font-semibold tabular-nums text-[var(--text)]" aria-live="polite">{mm}</span>
              </span>
              {running && !readOnly && (
                <ItemButton size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => onTimer?.(habit.id, day, "cancel")}>
                  Discard
                </ItemButton>
              )}
              {!readOnly && (
                <ItemButton size="sm" variant={running ? "secondary" : "primary"} icon={running ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />} onClick={toggleTimer}>
                  {running ? "Stop & add" : "Start"}
                </ItemButton>
              )}
            </div>
          </div>
        ) : rules.type === "avoid" ? (
          <div className="flex flex-col gap-2">
            <Stepper label={`Slips${rules.limit ? ` (up to ${rules.limit} is fine)` : ""}`} value={value} onChange={setValue} min={0} max={1000} />
            <div className="flex gap-2">
              <Chip active={value === 0} onClick={() => setValue(0)}>
                Clean day
              </Chip>
              <Chip onClick={() => setValue((v) => v + 1)}>I slipped (+1)</Chip>
            </div>
            {value > rules.limit && (
              <p className="text-xs text-[var(--text-muted)]">
                A slip is information, not failure. What triggered it? A note helps you spot the pattern.
              </p>
            )}
          </div>
        ) : (
          <div className="flex gap-2">
            <Chip active={value > 0} onClick={() => setValue(1)}>
              Done
            </Chip>
            <Chip active={value === 0} onClick={() => setValue(0)}>
              Not done
            </Chip>
          </div>
        )}

        <Field label="Note">
          <TextArea value={note} onChange={(e) => setNote(e.target.value)} placeholder="How did it go? What helped?" maxLength={1000} className="min-h-[72px]" />
        </Field>

        {!readOnly && (
          <div className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] p-3">
            <button type="button" className="flex items-center justify-between text-left" onClick={() => setSkipOpen((o) => !o)} aria-expanded={skipOpen}>
              <span className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
                <SkipForward className="h-4 w-4 text-[var(--text-muted)]" />
                {state?.skipped ? `Skipped${log?.reason ? ` · ${log.reason}` : ""}` : "Skip this day"}
              </span>
              <span className="text-xs text-[var(--text-muted)]">Skips never break a streak</span>
            </button>
            {skipOpen && (
              <>
                <div className="flex flex-wrap gap-2">
                  {REASONS.map((r) => (
                    <Chip key={r} active={reason === r} onClick={() => setReason(reason === r ? "" : r)}>
                      {r}
                    </Chip>
                  ))}
                </div>
                <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" maxLength={200} aria-label="Skip reason" />
                <ItemButton icon={<SkipForward className="h-4 w-4" />} onClick={skip}>
                  {state?.skipped ? "Update skip" : `Skip ${fmtDay(day).toLowerCase() === "today" ? "today" : fmtDay(day)}`}
                </ItemButton>
              </>
            )}
          </div>
        )}
        <p className="text-xs text-[var(--text-muted)]">{[describeGoal(habit), describeSchedule(habit)].filter(Boolean).join(" · ")}</p>
      </div>
    </Sheet>
  );
}
