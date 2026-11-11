import { AlarmClock, BellRing, CalendarDays, ExternalLink, Repeat, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { cn } from "@/utils/cn";

import { notesActions } from "../store";
import type { Note, NoteReminder, ReminderIn, ReminderRepeat } from "../types";
import { Pop } from "./Pop";

/**
 * Reminders on a note are tasks in your Tasks (``backend/app/notes/reminders.py``):
 * the chip shows yours, read live from the task, and goes when it's ticked
 * off (Done on the push, in Tasks, Today or a widget).
 */

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The moment a reminder is due, on this device's clock. */
export function reminderMoment(r: Pick<NoteReminder, "at" | "due" | "time">): Date {
  if (r.at) {
    const d = new Date(r.at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(`${r.due}T${r.time ?? "09:00"}:00`);
}

export type ReminderWhen = "overdue" | "today" | "upcoming";

export function reminderWhen(r: Pick<NoteReminder, "at" | "due" | "time">, now = new Date()): ReminderWhen {
  const today = isoDay(now);
  if (r.due < today) return "overdue";
  if (r.due === today) return r.time && reminderMoment(r).getTime() < now.getTime() ? "overdue" : "today";
  return "upcoming";
}

const REPEAT_WORDS: Record<ReminderRepeat, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" };

/** "Today, 6:00 pm" · "Tomorrow" · "Mon, 8:00 am" · "12 Dec, 9:00 am". */
export function reminderLabel(r: Pick<NoteReminder, "at" | "due" | "time">, now = new Date()): string {
  const at = reminderMoment(r);
  const day = new Date(`${r.due}T00:00:00`);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  let d: string;
  if (diff === 0) d = "Today";
  else if (diff === 1) d = "Tomorrow";
  else if (diff === -1) d = "Yesterday";
  else if (diff > 1 && diff < 7) d = day.toLocaleDateString(undefined, { weekday: "short" });
  else d = day.toLocaleDateString(undefined, { day: "numeric", month: "short", year: day.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  if (!r.time) return d;
  return `${d}, ${at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/** The chip on a card or in a note. */
export function ReminderChip({
  reminder,
  onOpen,
  onRemove,
  className,
}: {
  reminder: NoteReminder;
  onOpen?: () => void;
  onRemove?: () => void;
  className?: string;
}) {
  const when = reminderWhen(reminder);
  const label = reminderLabel(reminder);
  const words = `${when === "overdue" ? "Overdue reminder" : "Reminder"}: ${label}${reminder.repeat ? `, ${REPEAT_WORDS[reminder.repeat].toLowerCase()}` : ""}`;
  const body = (
    <>
      <AlarmClock className="h-3 w-3 shrink-0" aria-hidden />
      <span className={cn("truncate", when === "overdue" && "line-through decoration-1")}>{label}</span>
      {reminder.repeat && <Repeat className="h-3 w-3 shrink-0" aria-hidden />}
    </>
  );
  const pill = cn(
    "inline-flex h-6 max-w-[14rem] items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--note-text)_9%,transparent)] px-2 text-xs",
    when === "overdue" && "text-[var(--danger)]",
    className,
  );
  if (!onOpen) {
    return (
      <span className={pill} data-note-reminder="">
        <span className="sr-only">{words}</span>
        <span aria-hidden className="contents">
          {body}
        </span>
      </span>
    );
  }
  return (
    <span className={cn(pill, "pr-0.5")} data-note-reminder="">
      <button type="button" onClick={onOpen} aria-label={`${words}. Change it`} className="inline-flex min-w-0 items-center gap-1 rounded-full">
        {body}
      </button>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label="Remove reminder" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full note-hover">
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

function nextMonday(from: Date): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const add = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + add);
  return d;
}

const timeWords = (hh: number, mm = 0) => new Date(2000, 0, 1, hh, mm).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "Remind me": Later today, Tomorrow, Next week, or a day and time of your
 *  own with a repeat. The reminder goes to your Tasks (Done and Snooze on
 *  its push), and only you see it, even on a shared note. */
export function ReminderPicker({ note, anchor, onClose }: { note: Note; anchor: HTMLElement | null; onClose: () => void }) {
  const now = new Date();
  const cur = note.reminder ?? null;
  const [custom, setCustom] = useState(false);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const [day, setDay] = useState(cur?.due ?? isoDay(tomorrow));
  const [time, setTime] = useState(cur?.time ?? "08:00");
  const [repeat, setRepeat] = useState<ReminderRepeat | "">(cur?.repeat ?? "");
  const [error, setError] = useState<string | null>(null);

  const set = (r: ReminderIn) => {
    notesActions.remind(note.id, r);
    onClose();
  };
  const quick: { key: string; label: string; hint: string; r: ReminderIn }[] = [];
  if (now.getHours() < 17) quick.push({ key: "later", label: "Later today", hint: timeWords(18), r: { due: isoDay(now), time: "18:00", repeat: null } });
  quick.push({ key: "tomorrow", label: "Tomorrow", hint: timeWords(8), r: { due: isoDay(tomorrow), time: "08:00", repeat: null } });
  const mon = nextMonday(now);
  quick.push({ key: "week", label: "Next week", hint: `${mon.toLocaleDateString(undefined, { weekday: "short" })}, ${timeWords(8)}`, r: { due: isoDay(mon), time: "08:00", repeat: null } });

  const save = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return setError("Pick a day.");
    const r: ReminderIn = { due: day, time: time || null, repeat: repeat || null };
    if (reminderMoment({ at: null, due: r.due, time: r.time }).getTime() < Date.now() - 60_000 && !r.repeat) return setError("That time has already passed. Pick a later one.");
    set(r);
  };

  const row = "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none";
  const field = "h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]";

  return (
    <Pop anchor={anchor} label="Remind me" onClose={onClose} width={300}>
      <p className="px-2.5 pb-1 pt-1 text-sm font-semibold">Remind me</p>
      {!custom ? (
        <>
          {quick.map((q) => (
            <button key={q.key} type="button" className={row} onClick={() => set(q.r)}>
              <span className="flex-1">{q.label}</span>
              <span className="text-xs text-[var(--text-muted)]">{q.hint}</span>
            </button>
          ))}
          <button type="button" className={row} onClick={() => setCustom(true)}>
            <CalendarDays className="h-4 w-4 opacity-70" aria-hidden />
            <span className="flex-1">Pick a day and time</span>
          </button>
        </>
      ) : (
        <form
          className="flex flex-col gap-2.5 px-2.5 pb-1 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            Day
            <input data-autofocus type="date" className={field} value={day} min={isoDay(now)} onChange={(e) => (setDay(e.target.value), setError(null))} required />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            Time
            <input type="time" className={field} value={time} onChange={(e) => (setTime(e.target.value), setError(null))} required />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            Repeat
            <select className={field} value={repeat} onChange={(e) => setRepeat(e.target.value as ReminderRepeat | "")}>
              <option value="">Doesn't repeat</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
              <option value="yearly">Every year</option>
            </select>
          </label>
          {error && (
            <p role="alert" className="text-xs text-[var(--danger)]">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={() => setCustom(false)} className="h-9 rounded-full px-3 text-sm font-medium hover:bg-[var(--hover)]">
              Back
            </button>
            <button type="submit" className="h-9 rounded-full bg-[var(--accent-strong)] px-4 text-sm font-medium text-white">
              Save
            </button>
          </div>
        </form>
      )}
      {cur && !custom && (
        <div className="mt-1 border-t border-[var(--border)] pt-1">
          {cur.href && (
            <Link to={cur.href} className={row} onClick={onClose}>
              <ExternalLink className="h-4 w-4 opacity-70" aria-hidden />
              <span className="flex-1">Open in Tasks</span>
            </Link>
          )}
          <button
            type="button"
            className={cn(row, "text-[var(--danger)]")}
            onClick={() => {
              notesActions.remind(note.id, null);
              onClose();
            }}
          >
            <X className="h-4 w-4" aria-hidden />
            <span className="flex-1">Remove reminder</span>
          </button>
        </div>
      )}
      <p className="flex gap-2 px-2.5 pb-1.5 pt-2 text-xs text-[var(--text-muted)]">
        <BellRing className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>It goes in your Tasks too, with Done and Snooze on the reminder.{note.shared || !note.is_owner ? " Only you get it." : ""}</span>
      </p>
    </Pop>
  );
}
