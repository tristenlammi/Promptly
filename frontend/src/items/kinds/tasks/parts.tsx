import { AlignLeft, Bell, CalendarClock, ChevronRight, Flag, Hash, ListChecks, Plus, Repeat as RepeatIcon, SendHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Chip, Sheet, fmtDay, todayISO } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { completeChange, fmtClock, fmtDue, isLate, listOf, newTask, nowClock, PRIORITY, reopenChange } from "./logic";
import { parseQuick, type Parsed } from "./quickadd";
import { describeRepeat } from "./recur";
import { ReschedulePopover, RescheduleSheet } from "./reschedule";
import { SwipeRow } from "./swipe";
import { INBOX, type Task, type TasksData } from "./types";

/* ------------------------------------------------------------ requests */

// The header's "New task" (and the "q" shortcut) open the quick add of
// whichever view is showing.
const quickListeners = new Set<() => void>();
let quickPending = false;

export function requestQuickAdd(): boolean {
  if (quickListeners.size) {
    quickListeners.forEach((f) => f());
    return true;
  }
  quickPending = true;
  return false;
}

export function useQuickAddRequest(open: () => void) {
  const ref = useRef(open);
  ref.current = open;
  useEffect(() => {
    const f = () => ref.current();
    quickListeners.add(f);
    if (quickPending) {
      quickPending = false;
      f();
    }
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (document.querySelector("[role=dialog], [role=menu]")) return;
      // Nothing focused yet: Down / Up step into the task rows.
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && (!el || el === document.body)) {
        e.preventDefault();
        stepRowFocus(null, e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key !== "q") return;
      e.preventDefault();
      f();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      quickListeners.delete(f);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}

/* ------------------------------------------------------------ completing */

/* Ticking a task plays out before it's written: the tick draws and the
 * title strikes through ("tick"), the row folds away ("fold"), and only
 * then does the task move to Done and the Undo toast appear. A task in
 * the middle of that is "leaving". Tapping its circle again calls it off;
 * leaving a view, hiding the tab or closing the page writes it at once,
 * so a tick is never lost to the animation. */
type Phase = "tick" | "fold";
const TICK_MS = 380;
const FOLD_MS = 230;
const leaving = new Map<string, { phase: Phase; commit: () => void; timers: number[] }>();
const leavingSubs = new Set<() => void>();
const emitLeaving = () => leavingSubs.forEach((f) => f());
const subscribeLeaving = (f: () => void) => {
  leavingSubs.add(f);
  return () => void leavingSubs.delete(f);
};

function finishLeaving(id: string, write: boolean) {
  const e = leaving.get(id);
  if (!e) return;
  e.timers.forEach((t) => window.clearTimeout(t));
  leaving.delete(id);
  if (write) e.commit();
  emitLeaving();
}

function flushLeaving() {
  for (const id of [...leaving.keys()]) finishLeaving(id, true);
}

function useLeaving(id: string): Phase | null {
  return useSyncExternalStore(
    subscribeLeaving,
    () => leaving.get(id)?.phase ?? null,
    () => null,
  );
}

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Tick a task off (or re-open it), with an Undo toast. ``instant`` skips
 *  the row animation (the editor's own circle: there's no row to fold). */
export function useToggle(item: ItemHandle<TasksData>, { instant = false }: { instant?: boolean } = {}) {
  const itemRef = useRef(item);
  itemRef.current = item;
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flushLeaving();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushLeaving);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flushLeaving);
      flushLeaving();
    };
  }, []);
  return (t: Task) => {
    if (!item.canEdit) return;
    if (t.done) {
      item.update(reopenChange(t.id));
      return;
    }
    if (leaving.has(t.id)) {
      // A second tap while it's still on screen: never mind.
      finishLeaving(t.id, false);
      return;
    }
    const commit = () => {
      const c = completeChange(t);
      itemRef.current.update(c.apply);
      const when = c.next ? fmtDay(c.next) : "";
      toast.success(c.next ? `“${t.title}” done — next due ${/^(Today|Tomorrow)$/.test(when) ? when.toLowerCase() : when}` : `Completed “${t.title}”`, {
        duration: 4000,
        action: { label: "Undo", onClick: () => itemRef.current.update(c.undo) },
      });
    };
    try {
      navigator.vibrate?.(12);
    } catch {
      /* not supported */
    }
    if (instant || reducedMotion()) {
      commit();
      return;
    }
    const entry = { phase: "tick" as Phase, commit, timers: [] as number[] };
    entry.timers.push(
      window.setTimeout(() => {
        entry.phase = "fold";
        emitLeaving();
      }, TICK_MS),
      window.setTimeout(() => finishLeaving(t.id, true), TICK_MS + FOLD_MS),
    );
    leaving.set(t.id, entry);
    emitLeaving();
  };
}

/* ------------------------------------------------------------ the row */

export function TaskCheck({ task, onToggle, disabled, ticking }: { task: Task; onToggle: () => void; disabled?: boolean; ticking?: boolean }) {
  const color = PRIORITY[task.priority]?.color ?? "var(--text-muted)";
  // Draw the tick only for a completion made here, not for a task that
  // was already done when it came on screen.
  const [drawn, setDrawn] = useState(false);
  const done = task.done || !!ticking;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={done ? `Mark “${task.title}” not done` : `Complete “${task.title}”`}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        setDrawn(!task.done);
        onToggle();
      }}
      className={cn(
        "tasks-check group flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] disabled:cursor-default",
        done && "is-done",
        (ticking || (drawn && task.done)) && "is-drawing",
      )}
    >
      <span
        className={cn(
          "tasks-check-ring flex h-[22px] w-[22px] items-center justify-center rounded-full border-2",
          done ? "border-transparent bg-[var(--item-accent)] text-white" : "group-hover:bg-[color-mix(in_srgb,currentColor_12%,transparent)]",
        )}
        style={done ? undefined : { borderColor: color, color, background: task.priority ? `color-mix(in srgb, ${color} 10%, transparent)` : undefined }}
      >
        <TickMark className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

/** The tick as one stroke, so it can be drawn (see tasks.css). */
export function TickMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path className="tasks-tick" pathLength={1} d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** Just made (or just ticked off): the row eases in rather than popping. */
function isFresh(t: Task): boolean {
  const at = t.done ? t.done_at : t.created_at;
  if (!at) return false;
  const age = Date.now() - new Date(at).getTime();
  return age >= 0 && age < 1500;
}

/** Up / Down walk the task rows on the page, in the order they're shown. */
function stepRowFocus(from: HTMLElement | null, dir: 1 | -1) {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-task-open]")];
  if (!rows.length) return;
  const at = from ? rows.indexOf(from) : -1;
  const next = at < 0 ? (dir > 0 ? rows[0] : rows[rows.length - 1]) : rows[at + dir];
  next?.focus();
  next?.scrollIntoView({ block: "nearest" });
}

export function TaskRow({
  task,
  data,
  onToggle,
  onOpen,
  canEdit,
  showList = true,
  showDue = true,
  handle,
  onReschedule,
}: {
  task: Task;
  data: TasksData;
  onToggle: () => void;
  onOpen: () => void;
  canEdit: boolean;
  showList?: boolean;
  showDue?: boolean;
  handle?: ReactNode;
  /** Move it to another day: turns on the left swipe, the row's
   *  "another day" button and the T key. */
  onReschedule?: (due: string) => void;
}) {
  const today = todayISO();
  const phase = useLeaving(task.id);
  const [fresh, setFresh] = useState(() => isFresh(task));
  const [menuAt, setMenuAt] = useState<DOMRect | null>(null);
  const [later, setLater] = useState(false);
  const canMove = canEdit && !task.done && !!onReschedule;
  const late = isLate(task, today, nowClock());
  const list = listOf(data, task.list_id);
  const stepsDone = task.steps.filter((s) => s.done).length;
  const meta: ReactNode[] = [];
  if (showDue && task.due)
    meta.push(
      <span key="due" className={cn("tabular-nums", late ? "font-medium text-[var(--danger)]" : task.due === today ? "font-medium text-[var(--success)]" : "")}>
        {fmtDue(task)}
      </span>,
    );
  else if (!showDue && task.time)
    meta.push(
      <span key="time" className={cn("tabular-nums", late && "font-medium text-[var(--danger)]")}>
        {fmtClock(task.time)}
      </span>,
    );
  if (task.repeat) meta.push(<RepeatIcon key="rep" className="h-3 w-3" aria-label={describeRepeat(task.repeat)} />);
  if (task.alerts.length && task.due && !task.done) meta.push(<Bell key="bell" className="h-3 w-3" aria-label="Has a reminder" />);
  if (task.steps.length)
    meta.push(
      <span key="steps" className="inline-flex items-center gap-0.5 tabular-nums">
        <ListChecks className="h-3 w-3" />
        {stepsDone}/{task.steps.length}
      </span>,
    );
  if (task.notes) meta.push(<AlignLeft key="notes" className="h-3 w-3" aria-label="Has notes" />);
  for (const tag of task.tags.slice(0, 3)) meta.push(<span key={`tag-${tag}`}>#{tag}</span>);
  if (showList && list && list.id !== INBOX)
    meta.push(
      <span key="list" className="inline-flex items-center gap-1">
        <span className="h-2 w-2 rounded-full" style={{ background: list.color }} />
        {list.name}
      </span>,
    );
  const body = (
    <div className={cn("flex items-start gap-0.5 pl-1 pr-2", task.done && "opacity-60")}>
      {handle}
      <TaskCheck task={task} onToggle={onToggle} disabled={!canEdit} ticking={!!phase} />
      <button
        type="button"
        data-task-open
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          const k = e.key.toLowerCase();
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            stepRowFocus(e.currentTarget, e.key === "ArrowDown" ? 1 : -1);
          } else if (k === "e") {
            e.preventDefault();
            onOpen();
          } else if (k === "t" && canMove) {
            e.preventDefault();
            onReschedule?.(today);
          }
        }}
        className="flex min-h-[44px] min-w-0 flex-1 flex-col justify-center py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
      >
        <span className={cn("break-words text-[15px] leading-snug text-[var(--text)] md:text-sm", task.done && "line-through decoration-[var(--text-muted)]")}>
          <span className="tasks-title">{task.title}</span>
        </span>
        {meta.length > 0 && <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--text-muted)]">{meta}</span>}
      </button>
      {canMove && (
        <button
          type="button"
          aria-label={`Move “${task.title}” to another day`}
          title="Move to another day"
          aria-haspopup="menu"
          aria-expanded={!!menuAt}
          onClick={(e) => setMenuAt(menuAt ? null : e.currentTarget.getBoundingClientRect())}
          className="tasks-row-action mt-1.5 h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
        >
          <CalendarClock className="h-4 w-4" />
        </button>
      )}
      {task.priority === 3 && !task.done && <Flag className="mt-3.5 h-3.5 w-3.5 shrink-0 text-[#DB4C3F]" aria-label="High priority" />}
    </div>
  );
  return (
    <div
      className={cn("tasks-row", phase && "is-ticking", phase === "fold" && "is-folding", fresh && "is-new")}
      onAnimationEnd={fresh ? (e) => e.target === e.currentTarget && setFresh(false) : undefined}
    >
      <div className="tasks-row-inner">
        {canEdit && !task.done ? (
          <SwipeRow enabled={!phase} onDone={onToggle} onLater={canMove ? () => setLater(true) : onOpen}>
            {body}
          </SwipeRow>
        ) : (
          body
        )}
      </div>
      {canMove && (
        <>
          <ReschedulePopover anchor={menuAt} task={task} weekStart={data.settings.week_start} onPick={(d) => onReschedule?.(d)} onClose={() => setMenuAt(null)} />
          <RescheduleSheet open={later} task={task} weekStart={data.settings.week_start} onPick={(d) => onReschedule?.(d)} onClose={() => setLater(false)} />
        </>
      )}
    </div>
  );
}

/** A group of rows on a card (hairline dividers). */
export function TaskGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]", className)}>{children}</div>;
}

/* ------------------------------------------------------------ quick add */

function ParsedChips({ p, data }: { p: Parsed; data: TasksData }) {
  const chips: ReactNode[] = [];
  if (p.due) chips.push(<Chip key="due" active>{fmtDue({ due: p.due, time: p.time })}</Chip>);
  if (p.repeat) chips.push(<Chip key="rep" active icon={<RepeatIcon className="h-3 w-3" />}>{describeRepeat(p.repeat)}</Chip>);
  if (p.listId) {
    const l = listOf(data, p.listId);
    if (l)
      chips.push(
        <Chip key="list" active icon={<span className="h-2 w-2 rounded-full" style={{ background: l.color }} />}>
          {l.name}
        </Chip>,
      );
  }
  if (p.priority) chips.push(<Chip key="pri" active icon={<Flag className="h-3 w-3" style={{ color: PRIORITY[p.priority].color }} />}>{PRIORITY[p.priority].label}</Chip>);
  for (const t of p.tags) chips.push(<Chip key={`t${t}`} active icon={<Hash className="h-3 w-3" />}>{t}</Chip>);
  if (!chips.length) return null;
  return <div className="flex flex-wrap gap-1.5" aria-live="polite">{chips}</div>;
}

/** Type a task the way you'd say it; Enter adds it and keeps the box open
 *  for the next. ``due`` / ``listId`` are the view's defaults (Today adds
 *  for today, a list adds to that list). */
export function QuickAdd({
  item,
  due = null,
  listId = null,
  autoFocus,
  onAdded,
  placeholder,
  className,
  inputRef,
}: {
  item: ItemHandle<TasksData>;
  due?: string | null;
  listId?: string | null;
  autoFocus?: boolean;
  onAdded?: (t: Task) => void;
  placeholder?: string;
  className?: string;
  inputRef?: React.RefObject<HTMLInputElement>;
}) {
  const [text, setText] = useState("");
  const own = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? own;
  const data = item.data;
  const parsed = useMemo(() => parseQuick(text, data.lists, todayISO(), data.settings.week_start), [text, data.lists, data.settings.week_start]);
  useEffect(() => {
    if (autoFocus) window.setTimeout(() => ref.current?.focus(), 80);
  }, [autoFocus, ref]);
  const add = () => {
    if (!parsed.title) return;
    const t = newTask(
      {
        title: parsed.title,
        due: parsed.due ?? due,
        time: parsed.time,
        repeat: parsed.repeat,
        priority: parsed.priority ?? 0,
        list_id: parsed.listId ?? listId ?? INBOX,
        tags: parsed.tags,
      },
      data,
    );
    item.update((d) => {
      d.tasks.push(t);
    });
    setText("");
    onAdded?.(t);
    ref.current?.focus();
  };
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] pl-3 pr-1.5 focus-within:border-[var(--item-accent)] focus-within:ring-2 focus-within:ring-[color-mix(in_srgb,var(--item-accent)_25%,transparent)]">
        <Plus className="h-4 w-4 shrink-0 text-[var(--item-accent)]" />
        <input
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            }
          }}
          enterKeyHint="done"
          aria-label="New task"
          placeholder={placeholder ?? "Add a task — e.g. “Call mum tomorrow 6pm”"}
          className="h-12 min-w-0 flex-1 bg-transparent text-base text-[var(--text)] !outline-none placeholder:text-[var(--text-muted)] md:h-11 md:text-sm"
        />
        <button
          type="button"
          onClick={add}
          disabled={!parsed.title}
          aria-label="Add task"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--item-accent)] text-white transition disabled:opacity-30"
        >
          <SendHorizontal className="h-4 w-4" />
        </button>
      </div>
      {text.trim() && <ParsedChips p={parsed} data={data} />}
    </div>
  );
}

/* ------------------------------------------------------------ misc */

/** A section header that folds ("Done today (3)"). */
export function Fold({ title, count, children, open: initial = false, action }: { title: string; count: number; children: ReactNode; open?: boolean; action?: ReactNode }) {
  const [open, setOpen] = useState(initial);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-h-[40px] items-center gap-1 text-sm font-semibold text-[var(--text-muted)] hover:text-[var(--text)]">
          <ChevronRight className={cn("h-4 w-4 transition", open && "rotate-90")} />
          {title} <span className="tabular-nums">({count})</span>
        </button>
        {action}
      </div>
      {open && children}
    </section>
  );
}

export function SectionHead({ title, hint, action, tone }: { title: ReactNode; hint?: ReactNode; action?: ReactNode; tone?: "danger" | "accent" }) {
  return (
    <div className="flex items-end justify-between gap-2 px-1">
      <div className="min-w-0">
        <h2 className={cn("truncate text-sm font-semibold", tone === "danger" ? "text-[var(--danger)]" : tone === "accent" ? "text-[var(--accent-text)]" : "text-[var(--text)]")}>{title}</h2>
        {hint && <p className="text-xs text-[var(--text-muted)]">{hint}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ phone add */

/** The phone's add: a bottom sheet with the quick-add box, open for a
 *  run of tasks until it's closed. */
export function AddSheet({ item, open, onClose, due, listId }: { item: ItemHandle<TasksData>; open: boolean; onClose: () => void; due?: string | null; listId?: string | null }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (open) setN(0);
  }, [open]);
  return (
    <Sheet open={open} onClose={onClose} title="New task" size="sm">
      <div className="flex flex-col gap-2 pb-2">
        <QuickAdd item={item} due={due} listId={listId} autoFocus={open} onAdded={() => setN((x) => x + 1)} />
        <p className="px-1 text-xs text-[var(--text-muted)]" aria-live="polite">
          {n ? `Added ${n} — keep typing, or close when you're done.` : "Try “Bins out every Tue 7pm”, “Rego in March !!!”, “Milk #shopping”."}
        </p>
      </div>
    </Sheet>
  );
}
