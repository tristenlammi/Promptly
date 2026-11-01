import { fmtDay, nowISO, todayISO, uid } from "@/items/ui";

import { nextDue, plusDays } from "./recur";
import { INBOX, type Done, type Task, type TaskList, type TasksData } from "./types";

/* Task helpers shared by the views. Mirrors the backend's logic.py where
 * it matters (completing, buckets). */

const MAX_LOG = 5000;

export const LIST_COLORS = ["#3B7DD8", "#E2725B", "#4E9F5B", "#7B6CD9", "#D9902F", "#C2557A", "#2C9CC8", "#8A6F5A"];

export function sortKey(a: Task, b: Task): number {
  const ka = `${a.due ?? "9999"} ${a.time ?? "99:99"}`;
  const kb = `${b.due ?? "9999"} ${b.time ?? "99:99"}`;
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.order - b.order;
}

/** Manual order (a list's own view): priority doesn't reshuffle it. */
export function orderKey(a: Task, b: Task): number {
  return a.order - b.order || (a.created_at ?? "").localeCompare(b.created_at ?? "");
}

export interface Buckets {
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
  later: Task[];
  someday: Task[];
}

export function buckets(tasks: Task[], today: string, days = 7): Buckets {
  const end = plusDays(today, days);
  const out: Buckets = { overdue: [], today: [], upcoming: [], later: [], someday: [] };
  for (const t of tasks) {
    if (t.done) continue;
    if (!t.due) out.someday.push(t);
    else if (t.due < today) out.overdue.push(t);
    else if (t.due === today) out.today.push(t);
    else if (t.due <= end) out.upcoming.push(t);
    else out.later.push(t);
  }
  for (const v of Object.values(out)) v.sort(sortKey);
  return out;
}

export function isLate(t: Task, today: string, nowClock: string): boolean {
  if (t.done || !t.due) return false;
  return t.due < today || (t.due === today && !!t.time && t.time < nowClock);
}

export function nowClock(): string {
  return nowISO().slice(11, 16);
}

/** What a tap on the circle does, made outside the mutator (ids, times)
 *  and applied inside it to the newest state — plus its exact inverse
 *  (the toast's Undo), which puts back only what completing changed. */
export function completeChange(task: Task): { apply: (d: TasksData) => void; undo: (d: TasksData) => void; next: string | null } {
  const at = nowISO();
  const day = todayISO();
  const logId = uid("d");
  const prevDue = task.due;
  const prevSteps = task.steps.filter((s) => s.done).map((s) => s.id);
  const next = task.repeat ? nextDue(task.repeat, task.due, day) : null;
  return {
    next,
    apply: (d) => {
      const t = d.tasks.find((x) => x.id === task.id);
      if (!t || t.done) return;
      const entry: Done = { id: logId, task_id: t.id, title: t.title, list_id: t.list_id, at, due: t.due };
      d.log.push(entry);
      if (d.log.length > MAX_LOG) d.log.splice(0, d.log.length - MAX_LOG);
      if (t.repeat) {
        const n = nextDue(t.repeat, t.due, day);
        if (n) {
          t.due = n;
          for (const s of t.steps) s.done = false;
          return;
        }
      }
      t.done = true;
      t.done_at = at;
    },
    undo: (d) => {
      const i = d.log.findIndex((x) => x.id === logId);
      if (i < 0) return;
      d.log.splice(i, 1);
      const t = d.tasks.find((x) => x.id === task.id);
      if (!t) return;
      t.done = false;
      t.done_at = null;
      t.due = prevDue;
      for (const s of t.steps) if (prevSteps.includes(s.id)) s.done = true;
    },
  };
}

export function reopenChange(taskId: string): (d: TasksData) => void {
  return (d) => {
    const t = d.tasks.find((x) => x.id === taskId);
    if (!t || !t.done) return;
    t.done = false;
    t.done_at = null;
    for (let i = d.log.length - 1; i >= 0; i--) {
      if (d.log[i].task_id === taskId) {
        d.log.splice(i, 1);
        break;
      }
    }
  };
}

export function newTask(p: Partial<Task> & { title: string }, data: TasksData): Task {
  const top = Math.min(0, ...data.tasks.map((t) => t.order));
  const timed = !!(p.time && p.due);
  return {
    id: uid("t"),
    notes: "",
    list_id: INBOX,
    due: null,
    time: null,
    alerts: timed && data.settings.alert_timed ? [0] : [],
    repeat: null,
    priority: 0,
    tags: [],
    steps: [],
    done: false,
    done_at: null,
    created_at: nowISO(),
    order: top - 1,
    ...p,
  };
}

export function listOf(data: TasksData, id: string): TaskList | undefined {
  return data.lists.find((l) => l.id === id);
}

export function listColor(data: TasksData, id: string): string {
  return listOf(data, id)?.color ?? "var(--text-muted)";
}

export const PRIORITY = [
  { value: 0, label: "None", color: "var(--text-muted)" },
  { value: 1, label: "Low", color: "#3B7DD8" },
  { value: 2, label: "Medium", color: "#D9902F" },
  { value: 3, label: "High", color: "#DB4C3F" },
];

export const ALERTS = [
  { value: 0, label: "At the time" },
  { value: 10, label: "10 min before" },
  { value: 30, label: "30 min before" },
  { value: 60, label: "1 hour before" },
  { value: 120, label: "2 hours before" },
  { value: 1440, label: "1 day before" },
  { value: 2880, label: "2 days before" },
  { value: 10080, label: "1 week before" },
];

export function alertLabel(m: number, timed: boolean, defaultTime: string): string {
  if (m === 0) return timed ? "At the time" : `On the day, ${defaultTime}`;
  const hit = ALERTS.find((a) => a.value === m);
  if (hit) return hit.label;
  if (m % 1440 === 0) return `${m / 1440} days before`;
  if (m % 60 === 0) return `${m / 60} hours before`;
  return `${m} min before`;
}

/** "Today 15:00", "Tomorrow", "Mon 3 Nov". */
export function fmtDue(t: Pick<Task, "due" | "time">): string {
  if (!t.due) return "";
  return `${fmtDay(t.due)}${t.time ? ` ${fmtClock(t.time)}` : ""}`;
}

const clockFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
export function fmtClock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return clockFmt.format(new Date(2000, 0, 1, h, m));
}

/** Completions on ``day`` (repeats included), newest first. */
export function doneOn(data: TasksData, day: string): Done[] {
  return data.log.filter((x) => x.at.slice(0, 10) === day).reverse();
}
