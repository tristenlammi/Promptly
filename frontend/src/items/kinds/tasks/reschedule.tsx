import { CalendarDays, CalendarPlus, Sun, Sunrise } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";

import type { ItemHandle } from "@/items/useItem";
import { ItemButton, Sheet, TextInput, fmtDay, parseDay, todayISO } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { plusDays, weekday } from "./recur";
import type { Task, TasksData } from "./types";

/*
 * "Not today": move a task to tomorrow, next week or a day you pick. A phone
 * gets these in a sheet (after a left swipe), a computer in a small menu on
 * the row. Every move can be undone from its toast.
 */

/** The first day of next week, by the person's own week start (Mon=0 … Sun=6). */
export function nextWeekDay(today: string, weekStart: number): string {
  return plusDays(today, (7 - weekday(today) + weekStart) % 7 || 7);
}

const hintFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

export interface Choice {
  id: "today" | "tomorrow" | "week";
  label: string;
  hint: string;
  due: string;
  icon: ComponentType<{ className?: string }>;
}

export function rescheduleChoices(task: Pick<Task, "due">, today: string, weekStart: number): Choice[] {
  const tomorrow = plusDays(today, 1);
  const week = nextWeekDay(today, weekStart);
  const out: Choice[] = [];
  const hint = (d: string) => hintFmt.format(parseDay(d));
  if (task.due !== today) out.push({ id: "today", label: "Today", hint: hint(today), due: today, icon: Sun });
  if (task.due !== tomorrow) out.push({ id: "tomorrow", label: "Tomorrow", hint: hint(tomorrow), due: tomorrow, icon: Sunrise });
  if (week !== tomorrow && task.due !== week) out.push({ id: "week", label: "Next week", hint: hint(week), due: week, icon: CalendarPlus });
  return out;
}

function dayWords(due: string): string {
  const s = fmtDay(due);
  return /^(Today|Tomorrow|Yesterday)$/.test(s) ? s.toLowerCase() : s;
}

/** Move a task to another day, with an Undo toast that puts back only the
 *  day (and only if nothing has moved it again since). */
export function useReschedule(item: ItemHandle<TasksData>) {
  return (task: Task, due: string) => {
    if (!item.canEdit || !due || task.due === due) return;
    const prev = task.due;
    item.update((d) => {
      const t = d.tasks.find((x) => x.id === task.id);
      if (t) t.due = due;
    });
    toast.success(`“${task.title}” moved to ${dayWords(due)}`, {
      action: {
        label: "Undo",
        onClick: () =>
          item.update((d) => {
            const t = d.tasks.find((x) => x.id === task.id);
            if (!t || t.due !== due) return;
            t.due = prev;
          }),
      },
    });
  };
}

/** Move several tasks to one day in a single change, with one Undo. */
export function moveMany(item: ItemHandle<TasksData>, tasks: Task[], due: string) {
  const before = new Map(tasks.filter((t) => t.due !== due).map((t) => [t.id, t.due] as const));
  if (!before.size) return;
  item.update((d) => {
    for (const t of d.tasks) if (before.has(t.id) && !t.done) t.due = due;
  });
  const n = before.size;
  toast.success(`Moved ${n} task${n === 1 ? "" : "s"} to ${dayWords(due)}`, {
    action: {
      label: "Undo",
      onClick: () =>
        item.update((d) => {
          for (const t of d.tasks) if (before.has(t.id) && t.due === due) t.due = before.get(t.id) ?? null;
        }),
    },
  });
}

/* ------------------------------------------------------------ the choices */

function PickDate({ task, onPick, big }: { task: Task; onPick: (due: string) => void; big?: boolean }) {
  const [date, setDate] = useState(task.due ?? "");
  const ok = !!date && date !== task.due;
  return (
    <form
      className={cn("flex flex-col gap-1.5", big ? "px-1 pt-2" : "px-2 pb-1.5 pt-2")}
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onPick(date);
      }}
    >
      <label className="flex items-center gap-2 text-xs font-medium text-[var(--text-muted)]">
        <CalendarDays className="h-3.5 w-3.5" />
        Pick a date
      </label>
      <div className="flex items-center gap-2">
        <TextInput type="date" value={date} min={todayISO()} onChange={(e) => setDate(e.target.value)} aria-label="Pick a date" className={big ? undefined : "!h-9 text-sm"} />
        <ItemButton type="submit" variant="primary" size={big ? "md" : "sm"} disabled={!ok} className={big ? undefined : "!h-9"}>
          Move
        </ItemButton>
      </div>
    </form>
  );
}

/** The phone's version: a bottom sheet with big rows. */
export function RescheduleSheet({ open, task, weekStart, onPick, onClose }: { open: boolean; task: Task; weekStart: number; onPick: (due: string) => void; onClose: () => void }) {
  const pick = (due: string) => {
    onClose();
    onPick(due);
  };
  return (
    <Sheet open={open} onClose={onClose} title="Move to another day" size="sm">
      <div className="flex flex-col pb-2">
        <p className="truncate px-1 pb-2 text-sm text-[var(--text-muted)]">{task.title}</p>
        {open &&
          rescheduleChoices(task, todayISO(), weekStart).map((c) => (
            <button key={c.id} type="button" onClick={() => pick(c.due)} className="flex min-h-[48px] items-center gap-3 rounded-xl px-2 text-left text-[15px] text-[var(--text)] hover:bg-[var(--hover)] active:bg-[var(--hover)]">
              <c.icon className="h-5 w-5 shrink-0 text-[var(--accent)]" />
              <span className="flex-1">{c.label}</span>
              <span className="text-sm text-[var(--text-muted)]">{c.hint}</span>
            </button>
          ))}
        <div className="mt-1 border-t border-[var(--border)]">{open && <PickDate task={task} onPick={pick} big />}</div>
      </div>
    </Sheet>
  );
}

/** The computer's version: a small menu hanging off the row's button.
 *  Arrow keys move, Escape closes, focus goes back to the button. */
export function ReschedulePopover({ anchor, task, weekStart, onPick, onClose }: { anchor: DOMRect | null; task: Task; weekStart: number; onPick: (due: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!anchor) return;
    const back = document.activeElement as HTMLElement | null;
    const raf = window.requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>("[role=menuitem], input")?.focus());
    const onDown = (e: MouseEvent | TouchEvent) => {
      // The button that opened it closes it itself (its own click).
      if ((e.target as HTMLElement).closest?.('.tasks-row-action[aria-expanded="true"]')) return;
      if (!ref.current?.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
    };
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current();
    };
    const onResize = () => closeRef.current();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("touchstart", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("touchstart", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [anchor]);

  if (!anchor) return null;
  const W = 248;
  const left = Math.max(8, Math.min(anchor.right - W, window.innerWidth - W - 8));
  const below = window.innerHeight - anchor.bottom > 260;
  const pick = (due: string) => {
    onClose();
    onPick(due);
  };
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={`Move “${task.title}” to another day`}
      style={{ position: "fixed", left, width: W, ...(below ? { top: anchor.bottom + 6 } : { bottom: window.innerHeight - anchor.top + 6 }) }}
      className="tasks-pop z-[80] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow-lg)]"
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        if ((e.target as HTMLElement).tagName === "INPUT") return;
        e.preventDefault();
        const rows = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
        if (!rows.length) return;
        const at = rows.indexOf(document.activeElement as HTMLElement);
        rows[(at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length].focus();
      }}
    >
      {rescheduleChoices(task, todayISO(), weekStart).map((c) => (
        <button
          key={c.id}
          type="button"
          role="menuitem"
          onClick={() => pick(c.due)}
          className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none"
        >
          <c.icon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          <span className="flex-1">{c.label}</span>
          <span className="text-xs text-[var(--text-muted)]">{c.hint}</span>
        </button>
      ))}
      <div className="mt-1 border-t border-[var(--border)]">
        <PickDate task={task} onPick={pick} />
      </div>
    </div>,
    document.body,
  );
}
