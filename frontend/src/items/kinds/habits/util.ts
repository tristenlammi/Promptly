import { nowISO, uid } from "@/items/ui";

import { configOn, describeSchedule, dn, ds, logicalToday, startOf } from "./engine";
import type { Habit, HabitLog, HabitsData, HabitType, TimeOfDay } from "./types";

export const ACCENT = "#7B6CD9";

export const COLORS = ["#7B6CD9", "#3B7DD8", "#2C9CC8", "#2F8F83", "#4E9F5B", "#C08B2C", "#D9902F", "#E2725B", "#D9506A", "#C2557A", "#8A6F5A", "#5B6DD9"];

export const EMOJIS = [
  "💧", "🏃", "🧘", "📚", "✍️", "🥗", "🍎", "💪", "🚶", "🛏️", "😴", "🦷",
  "🧠", "🎯", "🗣️", "🎸", "🎨", "🧹", "🌱", "☀️", "🙏", "💊", "📵", "🚭",
  "🍷", "🍬", "☕", "💰", "📞", "❤️", "🐕", "🚴", "🏊", "🧴", "📝", "⏰",
];

export const TIMES: { id: TimeOfDay; label: string; hint: string }[] = [
  { id: "morning", label: "Morning", hint: "Until noon" },
  { id: "afternoon", label: "Afternoon", hint: "Noon – 6 pm" },
  { id: "evening", label: "Evening", hint: "After 6 pm" },
  { id: "anytime", label: "Anytime", hint: "Whenever it fits" },
];

export const TYPE_LABEL: Record<HabitType, string> = {
  yes_no: "Yes / no",
  count: "Count",
  duration: "Minutes",
  avoid: "Quit / avoid",
};

export interface Idea {
  name: string;
  emoji: string;
  color: string;
  area: string;
  type: HabitType;
  target?: number;
  unit?: string;
  time_of_day: TimeOfDay;
  intention: string;
  schedule?: Partial<Habit["schedule"]>;
}

/** Starter habits — small, anchored, tested. */
export const IDEAS: Idea[] = [
  { name: "Drink water", emoji: "💧", color: "#2C9CC8", area: "Health", type: "count", target: 8, unit: "glasses", time_of_day: "anytime", intention: "After each bathroom break, I will refill my bottle" },
  { name: "Meditate", emoji: "🧘", color: "#7B6CD9", area: "Mind", type: "duration", target: 2, time_of_day: "morning", intention: "After I pour my coffee, I will sit and breathe for 2 minutes" },
  { name: "Read", emoji: "📚", color: "#C08B2C", area: "Learning", type: "count", target: 10, unit: "pages", time_of_day: "evening", intention: "After I get into bed, I will read one page" },
  { name: "Walk", emoji: "🚶", color: "#4E9F5B", area: "Fitness", type: "duration", target: 10, time_of_day: "afternoon", intention: "After lunch, I will walk around the block" },
  { name: "Workout", emoji: "💪", color: "#E2725B", area: "Fitness", type: "yes_no", time_of_day: "morning", intention: "After I wake up, I will put on my gym clothes", schedule: { kind: "per_week", times: 3 } },
  { name: "Journal", emoji: "✍️", color: "#B5835A", area: "Mind", type: "yes_no", time_of_day: "evening", intention: "After I brush my teeth, I will write one line about today" },
  { name: "Floss", emoji: "🦷", color: "#3B7DD8", area: "Health", type: "yes_no", time_of_day: "evening", intention: "After I brush my teeth, I will floss one tooth" },
  { name: "Lights out by 11", emoji: "😴", color: "#5B6DD9", area: "Health", type: "yes_no", time_of_day: "evening", intention: "When my 10:30 alarm goes, I will put my phone on the charger outside the bedroom" },
  { name: "No phone in bed", emoji: "📵", color: "#D9506A", area: "Mind", type: "avoid", time_of_day: "evening", intention: "When I get into bed, my phone stays in the kitchen" },
  { name: "Eat vegetables", emoji: "🥗", color: "#4E9F5B", area: "Health", type: "count", target: 3, unit: "servings", time_of_day: "anytime", intention: "When I plate a meal, I will fill half with veg first" },
  { name: "Gratitude", emoji: "🙏", color: "#D9902F", area: "Mind", type: "yes_no", time_of_day: "morning", intention: "After I sit down for breakfast, I will name one thing I'm grateful for" },
  { name: "No sugary drinks", emoji: "🍬", color: "#C2557A", area: "Health", type: "avoid", time_of_day: "anytime", intention: "When I want a soft drink, I will have sparkling water instead" },
  { name: "Call family", emoji: "📞", color: "#E2725B", area: "Relationships", type: "yes_no", time_of_day: "anytime", intention: "After Sunday lunch, I will call someone I love", schedule: { kind: "per_week", times: 1 } },
  { name: "Tidy for 10 min", emoji: "🧹", color: "#2F8F83", area: "Home", type: "duration", target: 10, time_of_day: "evening", intention: "After dinner, I will set a 10-minute timer and tidy" },
  { name: "Practise an instrument", emoji: "🎸", color: "#C08B2C", area: "Learning", type: "duration", target: 15, time_of_day: "evening", intention: "After I get home, I will pick up my guitar before my phone" },
  { name: "Water the plants", emoji: "🌱", color: "#4E9F5B", area: "Home", type: "yes_no", time_of_day: "morning", intention: "After I make my coffee, I will water the plants", schedule: { kind: "every_n_days", every: 3 } },
];

export function slugId(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "habit";
  if (!taken.has(base)) return base;
  return `${base}-${uid().slice(0, 4)}`;
}

export function blankHabit(data: HabitsData, partial: Partial<Habit> = {}, createdAt: string = nowISO()): Habit {
  const today = logicalToday(data.settings.day_ends_at);
  const name = partial.name ?? "";
  return {
    id: slugId(name || "habit", new Set(data.habits.map((h) => h.id))),
    name,
    emoji: "",
    color: ACCENT,
    area: "",
    type: "yes_no",
    target: 1,
    unit: "",
    limit: 0,
    schedule: { kind: "daily", days: [], times: 3, every: 2 },
    time_of_day: "anytime",
    reminders: [],
    start_date: today,
    archived: false,
    intention: "",
    identity: "",
    why: "",
    notes: "",
    created_at: createdAt,
    logs: [],
    reminder_days: [],
    remind_when_behind: false,
    active_timer: null,
    history: [],
    anchor_date: null,
    end_date: null,
    ...partial,
  };
}

export function habitFromIdea(data: HabitsData, idea: Idea): Habit {
  return blankHabit(data, {
    name: idea.name,
    emoji: idea.emoji,
    color: idea.color,
    area: idea.area,
    type: idea.type,
    target: idea.target ?? 1,
    unit: idea.unit ?? "",
    time_of_day: idea.time_of_day,
    intention: idea.intention,
    schedule: { kind: "daily", days: [], times: 3, every: 2, ...(idea.schedule ?? {}) },
  });
}

// ----------------------------------------------------------- mutations
//
// Everything below runs inside ``item.update`` mutators, which may be
// replayed on someone else's newer state: times and ids come in as
// arguments (made outside), and anything relative (a +1, minutes from a
// timer) is computed here from the draft.

/** Days of history one habit can hold (backend models.MAX_LOGS). */
export const MAX_LOGS = 4000;

/** Would logging ``day`` overflow the habit's history? (Check before the mutator.) */
export function logsFull(h: Habit, day: string): boolean {
  return h.logs.length >= MAX_LOGS && !h.logs.some((l) => l.day === day);
}

/** Logging a day before the start moves the start back — but the every-N-days
 *  cadence stays put (frozen in ``anchor_date``). Mirrors engine.backfill_start. */
function backfillStart(h: Habit, day: string, skipped: boolean | undefined) {
  if (h.start_date && day < h.start_date && !skipped) {
    if (!h.anchor_date) h.anchor_date = h.start_date;
    h.start_date = day;
  }
}

/** Set (or with ``entry === null`` clear) one habit's log for a day. Fields
 *  not in ``entry`` keep what the draft has (a note added elsewhere stays). */
export function writeLog(d: HabitsData, habitId: string, day: string, entry: Partial<HabitLog> | null, at: string): void {
  const h = d.habits.find((x) => x.id === habitId);
  if (!h) return;
  const prev = h.logs.find((l) => l.day === day);
  const rest = h.logs.filter((l) => l.day !== day);
  if (entry) {
    if (rest.length >= MAX_LOGS) return; // refused in the UI before we get here
    rest.push({ day, value: 1, note: "", skipped: false, reason: "", ...(prev ?? {}), at, ...entry });
    rest.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    backfillStart(h, day, entry.skipped);
  }
  h.logs = rest;
}

/** Add ``delta`` to the day's value (a count, minutes, slips) — relative, so
 *  two devices adding at once both count. Clears an emptied non-avoid day. */
export function addToLog(d: HabitsData, habitId: string, day: string, delta: number, at: string, extra: Partial<HabitLog> = {}): void {
  const h = d.habits.find((x) => x.id === habitId);
  if (!h) return;
  const prev = h.logs.find((l) => l.day === day);
  const base = prev && !prev.skipped ? prev.value : 0;
  const v = Math.max(0, Math.min(100_000, Math.round((base + delta) * 1000) / 1000));
  const note = extra.note ?? prev?.note ?? "";
  if (v <= 0 && h.type !== "avoid" && !note) {
    writeLog(d, habitId, day, null, at);
    return;
  }
  writeLog(d, habitId, day, { ...extra, value: v, skipped: false, reason: "" }, at);
}

export function getLog(h: Habit, day: string): HabitLog | undefined {
  return h.logs.find((l) => l.day === day);
}

/** What a single tap means, decided from what the person sees. */
export type TapIntent = "inc" | "fill" | "done" | "confirm" | "clear";

export function tapIntent(h: Habit, day: string): { intent: TapIntent; completes: boolean; value: number } {
  const v = configOn(h, dn(day)); // the rules that day had
  const cur = getLog(h, day);
  const value = cur && !cur.skipped ? cur.value : 0;
  if (v.type === "count") {
    if (value >= v.target) return { intent: "clear", completes: false, value: 0 };
    return { intent: "inc", completes: value + 1 >= v.target, value: value + 1 };
  }
  if (v.type === "duration") {
    if (value >= v.target) return { intent: "clear", completes: false, value: 0 };
    return { intent: "fill", completes: true, value: v.target };
  }
  if (v.type === "avoid") {
    // Tap = "clean today" (confirm); tap again = undo the confirmation.
    if (cur && !cur.skipped) return { intent: "clear", completes: false, value: 0 };
    return { intent: "confirm", completes: true, value: 0 };
  }
  if (cur && !cur.skipped && value > 0) return { intent: "clear", completes: false, value: 0 };
  return { intent: "done", completes: true, value: 1 };
}

/** Apply a tap inside a mutator, relative to the draft. */
export function applyTap(d: HabitsData, habitId: string, day: string, intent: TapIntent, at: string): void {
  const h = d.habits.find((x) => x.id === habitId);
  if (!h) return;
  const cur = h.logs.find((l) => l.day === day);
  const live = cur && !cur.skipped ? cur.value : 0;
  const v = configOn(h, dn(day));
  switch (intent) {
    case "inc":
      addToLog(d, habitId, day, 1, at);
      return;
    case "fill":
      writeLog(d, habitId, day, { value: Math.max(live, v.target), skipped: false, reason: "" }, at);
      return;
    case "done":
      writeLog(d, habitId, day, { value: 1, skipped: false, reason: "" }, at);
      return;
    case "confirm":
      if (!cur || cur.skipped) writeLog(d, habitId, day, { value: 0, skipped: false, reason: "" }, at); // slips logged elsewhere stay
      return;
    case "clear":
      writeLog(d, habitId, day, null, at);
  }
}

/** The inverse of a tap, for Undo. ``before`` = the log as it was seen. */
export function undoTap(d: HabitsData, habitId: string, day: string, intent: TapIntent, before: HabitLog | undefined, at: string): void {
  if (intent === "inc") {
    addToLog(d, habitId, day, -1, at);
    return;
  }
  writeLog(d, habitId, day, before ? { ...before } : null, before?.at ?? at);
}

// ------------------------------------------------------------- timer

/** Start a habit's duration timer (``startedAt`` made outside the mutator). */
export function startTimer(d: HabitsData, habitId: string, day: string, startedAt: string): void {
  const h = d.habits.find((x) => x.id === habitId);
  if (h && !h.active_timer) h.active_timer = { started_at: startedAt, day };
}

/** Whole minutes between a timer's start and ``stopAt`` (at least 1). */
export function timerMinutes(startedAt: string, stopAt: string): number {
  const ms = Date.parse(stopAt) - Date.parse(startedAt);
  return Number.isFinite(ms) ? Math.max(1, Math.round(ms / 60_000)) : 1;
}

/** Stop the timer and add its minutes to its day — from the draft's own
 *  timer, so a timer already stopped on another device isn't added twice. */
export function stopTimer(d: HabitsData, habitId: string, stopAt: string, keep = true): number {
  const h = d.habits.find((x) => x.id === habitId);
  const t = h?.active_timer;
  if (!h || !t) return 0;
  h.active_timer = null;
  if (!keep) return 0;
  const mins = Math.min(1440, timerMinutes(t.started_at, stopAt));
  if (!logsFull(h, t.day)) addToLog(d, habitId, t.day, mins, stopAt);
  return mins;
}

// --------------------------------------------------- editing a habit

const RULE_FIELDS = ["type", "target", "limit", "schedule"] as const;

function rulesKey(h: Pick<Habit, "type" | "target" | "limit" | "schedule">): string {
  const s = h.schedule;
  return JSON.stringify([
    h.type,
    h.type === "yes_no" ? 1 : Number(h.target),
    h.type === "avoid" ? h.limit : 0,
    s.kind,
    s.kind === "weekdays" ? [...s.days].sort() : [],
    s.kind === "per_week" || s.kind === "per_month" ? s.times : 0,
    s.kind === "every_n_days" ? s.every : 0,
  ]);
}

export function rulesChanged(a: Habit, b: Habit): boolean {
  return rulesKey(a) !== rulesKey(b);
}

/** Does the habit have finished days that a rule change would re-judge? */
export function hasPast(h: Habit, today: string): boolean {
  const s = startOf(h);
  return s !== null && s < dn(today);
}

/** The editable fields that differ between what the editor opened with
 *  and what it saves — only these are written (others may have changed
 *  elsewhere since). */
export function changedFields(before: Habit, after: Habit): Partial<Habit> {
  const out: Partial<Habit> = {};
  const keys = Object.keys(after) as (keyof Habit)[];
  for (const k of keys) {
    if (k === "logs" || k === "history" || k === "active_timer" || k === "id" || k === "created_at") continue;
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) (out as Record<string, unknown>)[k] = structuredClone(after[k]);
  }
  return out;
}

/**
 * Apply an editor save to the draft habit: assign only ``patch``'s fields
 * and, when the rules change on a habit with past days, keep the old rules
 * as an era from ``today`` (unless ``applyToPast``). Mirrors
 * engine.note_config_change.
 */
export function applyHabitEdit(h: Habit, patch: Partial<Habit>, today: string, applyToPast: boolean): void {
  const before = { type: h.type, target: h.target, limit: h.limit, schedule: structuredClone(h.schedule), anchor_date: h.anchor_date ?? null };
  Object.assign(h, patch);
  if (h.type === "yes_no") h.target = 1;
  const touched = RULE_FIELDS.some((k) => k in patch);
  if (!touched || rulesKey(before as Habit) === rulesKey(h)) return;
  if (applyToPast) {
    h.history = [];
    return;
  }
  const start = startOf(h);
  const t = dn(today);
  if (start === null || start >= t) return;
  const anchor = h.anchor_date ?? ds(start);
  const hist = (h.history = [...(h.history ?? [])]);
  const last = hist[hist.length - 1];
  if (!(last && last.until >= today)) {
    hist.push({ ...before, until: today, anchor_date: before.anchor_date ?? anchor });
    hist.sort((a, b) => (a.until < b.until ? -1 : 1));
    while (hist.length > 60) hist.shift();
  }
  const os = before.schedule;
  const ns = h.schedule;
  if (ns.kind === "every_n_days" && (os.kind !== "every_n_days" || os.every !== ns.every)) h.anchor_date = today;
  else if (!h.anchor_date) h.anchor_date = anchor;
}

// ------------------------------------------------------------- export

function csvCell(v: string | number | boolean): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Every log of every habit as CSV — the format import_history reads back. */
export function exportCsv(data: HabitsData): string {
  const rows = [["habit", "habit_id", "date", "value", "note", "skipped", "reason"].join(",")];
  for (const h of data.habits) {
    for (const l of h.logs) rows.push([h.name, h.id, l.day, l.value, l.note, l.skipped, l.reason].map(csvCell).join(","));
  }
  return rows.join("\n") + "\n";
}

/** The habits themselves (set-up, not history) as CSV. */
export function exportHabitsCsv(data: HabitsData): string {
  const rows = [["id", "name", "type", "target", "unit", "limit", "schedule", "time_of_day", "area", "start_date", "archived", "intention"].join(",")];
  for (const h of data.habits) {
    rows.push(
      [h.id, h.name, h.type, h.target, h.unit, h.limit, describeSchedule(h), h.time_of_day, h.area, h.start_date ?? "", h.archived, h.intention].map(csvCell).join(","),
    );
  }
  return rows.join("\n") + "\n";
}

export function downloadText(name: string, text: string, type = "text/csv"): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// --------------------------------------------- the header's "New habit"

/** The shell renders the header button; the views listen here (a module
 *  signal rather than a window event). A request made before a view
 *  mounts (after ``goTo``) waits for it. */
let newRequested = false;
const newListeners = new Set<() => void>();

/** True when an open view took it; false = queued for the next one to mount. */
export function requestNewHabit(): boolean {
  if (newListeners.size) {
    newListeners.forEach((f) => f());
    return true;
  }
  newRequested = true;
  return false;
}

export function onNewHabitRequest(f: () => void): () => void {
  newListeners.add(f);
  if (newRequested) {
    newRequested = false;
    f();
  }
  return () => {
    newListeners.delete(f);
  };
}

export function buzz(pattern: number | number[] = 12): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported */
  }
}

export function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`;
}

export function todayNum(data: HabitsData): number {
  return dn(logicalToday(data.settings.day_ends_at));
}

export function habitLabel(h: Habit): string {
  return `${h.emoji ? `${h.emoji} ` : ""}${h.name}`;
}

export const reducedMotion = () => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};
