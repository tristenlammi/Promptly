import { AlignLeft, Bell, Check, ChevronRight, Flag, Hash, ListChecks, Plus, Repeat as RepeatIcon, SendHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Chip, Sheet, fmtDay, todayISO } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { completeChange, fmtClock, fmtDue, isLate, listOf, newTask, nowClock, PRIORITY, reopenChange } from "./logic";
import { parseQuick, type Parsed } from "./quickadd";
import { describeRepeat } from "./recur";
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
      if (e.key !== "q" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (document.querySelector("[role=dialog]")) return;
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

/** Tick a task off (or re-open it), with an Undo toast. */
export function useToggle(item: ItemHandle<TasksData>) {
  return (t: Task) => {
    if (!item.canEdit) return;
    if (t.done) {
      item.update(reopenChange(t.id));
      return;
    }
    const c = completeChange(t);
    item.update(c.apply);
    try {
      navigator.vibrate?.(12);
    } catch {
      /* not supported */
    }
    const when = c.next ? fmtDay(c.next) : "";
    toast.success(c.next ? `“${t.title}” done — next due ${/^(Today|Tomorrow)$/.test(when) ? when.toLowerCase() : when}` : `Completed “${t.title}”`, {
      duration: 4000,
      action: { label: "Undo", onClick: () => item.update(c.undo) },
    });
  };
}

/* ------------------------------------------------------------ the row */

export function TaskCheck({ task, onToggle, disabled }: { task: Task; onToggle: () => void; disabled?: boolean }) {
  const color = PRIORITY[task.priority]?.color ?? "var(--text-muted)";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={task.done}
      aria-label={task.done ? `Mark “${task.title}” not done` : `Complete “${task.title}”`}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="tasks-check group flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] disabled:cursor-default"
    >
      <span
        className={cn(
          "flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 transition",
          task.done ? "border-transparent bg-[var(--item-accent)] text-white" : "group-hover:bg-[color-mix(in_srgb,currentColor_12%,transparent)]",
        )}
        style={task.done ? undefined : { borderColor: color, color, background: task.priority ? `color-mix(in srgb, ${color} 10%, transparent)` : undefined }}
      >
        <Check className={cn("h-3.5 w-3.5 transition", task.done ? "opacity-100" : "opacity-0 group-hover:opacity-60")} strokeWidth={3} />
      </span>
    </button>
  );
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
}: {
  task: Task;
  data: TasksData;
  onToggle: () => void;
  onOpen: () => void;
  canEdit: boolean;
  showList?: boolean;
  showDue?: boolean;
  handle?: ReactNode;
}) {
  const today = todayISO();
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
  return (
    <div className={cn("tasks-row flex items-start gap-0.5 pl-1 pr-2", task.done && "opacity-60")}>
      {handle}
      <TaskCheck task={task} onToggle={onToggle} disabled={!canEdit} />
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-[44px] min-w-0 flex-1 flex-col justify-center py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
      >
        <span className={cn("break-words text-[15px] leading-snug text-[var(--text)] md:text-sm", task.done && "line-through decoration-[var(--text-muted)]")}>{task.title}</span>
        {meta.length > 0 && <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--text-muted)]">{meta}</span>}
      </button>
      {task.priority === 3 && !task.done && <Flag className="mt-3.5 h-3.5 w-3.5 shrink-0 text-[#DB4C3F]" aria-label="High priority" />}
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
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--item-accent)] text-white transition disabled:opacity-30"
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
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-h-[36px] items-center gap-1 text-sm font-semibold text-[var(--text-muted)] hover:text-[var(--text)]">
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
        <h2 className={cn("truncate text-sm font-semibold", tone === "danger" ? "text-[var(--danger)]" : tone === "accent" ? "text-[var(--item-accent)]" : "text-[var(--text)]")}>{title}</h2>
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
          {n ? `Added ${n} — keep typing, or close when you're done.` : "Try “Bins out every Tue 7pm”, “Rego in March !3”, “Milk #shopping”."}
        </p>
      </div>
    </Sheet>
  );
}
